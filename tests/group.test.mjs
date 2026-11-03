import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { startGroupService, routeNative, groupActivity, nativeMode } from '../src/group-service.mjs';
import { localFetch } from '../src/group-http.mjs';
import { recoveredHarnessResult, apply as applyCompanion } from '../companion/index.mjs';
import { GroupRuntime, groupSessionTitle, codexWriterRefusal } from '../src/group-runtime.mjs';
import http from 'node:http';
import { equalSecret, readBody, sendJson } from '../src/group-http.mjs';
import { captureProjectSnapshot } from '../src/git.mjs';
import { captureIntegrationConsent, integrationPreflight, verifyIntegration } from '../src/group-integration.mjs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-group-test-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const group = store.create({ repo: dir, models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  group.status = 'idle'; group.contexts = { codex: 'ct', harness: 'ht' }; group.worktrees = { codex: dir, harness: dir }; store.transaction(() => store.save(group));
  return { dir, store, group };
}
function input(store, group, content = '实现这个需求并验证', options = {}) {
  return store.input(group.id, { content, origin: { adapter: 'test', sessionId: 's', messageId: randomUUID() }, ...options });
}

test('desktop connection outage queues unadmitted work and automatically continues once connected',async t=>{
 const {store,group}=fixture(t);let calls=0;
 const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{if(++calls===1)throw Object.assign(Error('desktop unavailable'),{code:'GROUP_NOT_ADMITTED',admissionFailure:'codex_connection'});return {text:JSON.stringify(proposal('none'))}}});
 const {request}=input(store,group);await engine.tick(group.id);let r=store.request(request.id);
 assert.equal(r.status,'queued');assert.equal(r.deliveryId,undefined);assert.equal(r.usage.calls,0);assert.ok(r.admissionRetryAt>Date.now());
 const a=groupActivity(store,engine,group.id);assert.match(a.detail,/连接.*自动|自动.*连接/);assert.equal(a.needsUser,false);
 await engine.tick(group.id);assert.equal(calls,1);
 store.transaction(()=>{r=store.request(request.id);r.admissionRetryAt=0;store.saveRequest(r)});await engine.tick(group.id);
 r=store.request(request.id);assert.ok(r.plans.codex);assert.equal(calls,2);assert.equal(r.admissionWait,undefined);
});

test('unavailable recovery reads back off without spending outcome budget or resending',async t=>{
 const {store,group}=fixture(t);let sends=0,reads=0;
 const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{sends++;throw Error('unknown admitted result')},recover:async()=>{reads++;throw Object.assign(Error('desktop disconnected'),{code:'GROUP_RECOVERY_UNAVAILABLE'})}},{maxRecoveryAttempts:1});
 const {request}=input(store,group);await engine.tick(group.id);const id=store.request(request.id).deliveryId;
 for(let i=0;i<3;i++){store.transaction(()=>{const r=store.request(request.id);r.nextRecoveryAt=0;store.saveRequest(r)});await engine.tick(group.id);assert.equal(store.delivery(id).recoveryAttempts,0);assert.equal(store.request(request.id).status,'needs_recovery')}
 assert.equal(sends,1);assert.equal(reads,3);const a=groupActivity(store,engine,group.id);assert.equal(a.needsUser,true);assert.match(a.detail,/请刷新协作连接/);
});

test('persisted desktop preflight proves no send only with exact coordinator bindings and no admission',async t=>{
 const {store,group}=fixture(t),{request}=input(store,group),id=randomUUID(),prompt='new delivery';
 const base={id,groupId:group.id,requestId:request.id,member:'codex',phase:'planning',revision:request.revision,epoch:group.epoch,prompt,status:'pending',started:true};
 const journal={stage:'preflight',route:'desktop',threadId:group.contexts.codex,deliveryId:id,requestId:request.id,revision:request.revision,epoch:group.epoch,promptHash:store.hash(`[Group delivery ${id}]\n${prompt}`)};
 const rt=new GroupRuntime(store);
 const result=await rt.recover(group,{...base,nativeDispatch:journal});assert.equal(result.notAdmitted,true);assert.equal(result.proof.kind,'desktop-preflight');
 // Invalid receipts must reach native recovery, not fabricate non-admission.
 assert.equal(rt.preflightNonAdmission?.(group,{...base,nativeDispatch:{...journal,stage:'send_attempted'}}),null);
 assert.equal(rt.preflightNonAdmission?.(group,{...base,nativeDispatch:{...journal,promptHash:'wrong'}}),null);
 assert.equal(rt.preflightNonAdmission?.(group,{...base,nativeDispatch:journal,nativeAdmission:{turnId:'admitted'}}),null);
});

test('new desktop connection rearms only outcome inspection, at most once per connection',async t=>{
 const {store,group}=fixture(t);let sends=0,reads=0,key='first';
 const engine=new GroupEngine(store,{appOpen:async()=>true,recoveryConnectionKey:()=>key,
  turn:async()=>{sends++;throw Error('unknown')},recover:async()=>{reads++;return null}},{maxRecoveryAttempts:1});
 const {request}=input(store,group);await engine.tick(group.id);
 const tick=async()=>{store.transaction(()=>{const r=store.request(request.id);r.nextRecoveryAt=0;store.saveRequest(r)});await engine.tick(group.id)};
 await tick();await tick();assert.equal(store.request(request.id).status,'needs_decision');assert.equal(reads,1);
 await tick();assert.equal(reads,1);key='reopened';await tick();assert.equal(reads,2);assert.equal(sends,1);
 await tick();assert.equal(reads,2);assert.equal(store.request(request.id).status,'needs_decision');
 const activity=groupActivity(store,engine,group.id);assert.equal(activity.needsUser,false);assert.match(activity.detail,/维护方/);
 engine.control(group.id,'pause');key='third';await engine.tick(group.id);assert.equal(reads,2);assert.equal(store.group(group.id).status,'paused');
});

test('missing readiness file list is repaired by the reviewer without rerunning implementation',async t=>{
 const {store,group}=fixture(t),{request}=input(store,group);const phases=[],contracts=[];
 store.transaction(()=>{const r=store.request(request.id);r.phase='execution';r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'existing work',harness:'review'}};r.actions=[{phase:'review',member:'harness',integrationReadiness:true},{phase:'integrate',member:'codex'}];store.saveRequest(r)});
 const engine=new GroupEngine(store,{responseScopeProtocol:1,appOpen:async()=>true,turn:async(g,d)=>{phases.push(d.phase);contracts.push(JSON.parse(d.prompt).currentTask.outputContract);return {text:JSON.stringify({responseScope:d.id,message:'No writes',summary:'Verified',status:'done',verification:['existing evidence'],...(phases.length>1?{integrationFiles:[]}:{} )})}}});
 await engine.tick(group.id);let r=store.request(request.id);assert.equal(r.actions[0].phase,'review');assert.ok(r.actions[0].responseRepair);assert.equal(r.reviewRepairRounds??0,0);
 await engine.tick(group.id);r=store.request(request.id);assert.deepEqual(phases,['review','review']);assert.ok(contracts.every(c=>c.required.includes('integrationFiles')));assert.equal(r.actions[0].phase,'integrate');assert.deepEqual(r.integrationScope.targets,{});
});

test('automatic human input steers the unfinished request, explicit new stays queued and retries deduplicate', async t => {
  const {store,group}=fixture(t);const first=input(store,group,'original');
  const rt=runtime(()=>proposal('none'));const engine=new GroupEngine(store,rt);await engine.tick(group.id);
  const options={mode:'auto',origin:{adapter:'test',sessionId:'s',messageId:'steer-once'}};
  const next=input(store,group,'请按新要求调整',options);
  assert.equal(next.request.id,first.request.id);assert.equal(next.message.inputMode,'supplement');
  assert.equal(store.request(first.request.id).revision,1);
  store.transaction(()=>{const r=store.request(first.request.id);r.status='completed';store.saveRequest(r)});
  assert.equal(input(store,group,'请按新要求调整',options).duplicate,true);
  const queued=input(store,group,'另一个任务',{mode:'new'});assert.notEqual(queued.request.id,first.request.id);
});

test('human supplement retires an old proven-unadmitted prompt before sending the new revision', async t => {
  const {store,group}=fixture(t);const first=input(store,group,'original');let count=0;
  const rt={appOpen:async()=>true,turn:async(g,d)=>{count++;if(count===1)throw Error('unknown');return {text:JSON.stringify(proposal('none'))}},recover:async()=>({notAdmitted:true})};
  const engine=new GroupEngine(store,rt);await engine.tick(group.id);const old=store.request(first.request.id).deliveryId;
  input(store,group,'changed requirement',{mode:'supplement'});
  await engine.tick(group.id); // prove old was not admitted
  await engine.tick(group.id); // send current revision
  assert.equal(count,2);assert.equal(store.delivery(old).status,'superseded');
  assert.equal(store.request(first.request.id).revision,1);assert.ok(store.request(first.request.id).plans.codex);
});

test('urgent input cannot reuse a context until an older uncertain native delivery settles', async t => {
  const {store,group}=fixture(t);let executions=0,recovered=0;const rt={appOpen:async()=>true,turn:async()=>{executions++;throw Error('lost')},recover:async()=>{recovered++;return null}};
  const engine=new GroupEngine(store,rt);input(store,group);await engine.tick(group.id);
  input(store,group,'urgent',{mode:'urgent'});await engine.tick(group.id);
  assert.equal(executions,1);assert.equal(recovered,1);
});

test('native steering recognizes a copied Markdown instruction without treating quoted examples as commands', () => {
  for (const text of ['补充：继续', '**补充：继续已授权的优化任务**  \n', ' `纠正：采用新需求` ']) assert.equal(nativeMode(text), 'supplement');
  assert.equal(nativeMode('__紧急：先处理故障__'), 'urgent');
  for (const text of ['> 补充：这是引用', '说明：**补充：继续**', '批准 group request', '普通需求']) assert.equal(nativeMode(text), 'auto');
  assert.equal(nativeMode('/new independent request'), 'new');
});
test('member activity follows admitted delivery and distinguishes idle, approval, recovery and pause', () => {
  const group = { status: 'idle', activeRequestId: 'r' }, request = { id: 'r', status: 'completed', deliveryId: 'd' };
  const delivery = { member: 'harness', phase: 'planning', status: 'pending', started: true };
  const approvals = [], engine = { running: new Map() };
  const store = { group: () => group, request: () => request, hasOpenRequests: () => !['completed', 'cancelled'].includes(request.status), delivery: () => delivery, pendingPermissions: () => approvals };
  assert.deepEqual(groupActivity(store, engine, 'g').members.map(m => m.label), ['待命', '待命']);
  group.status = 'active'; request.status = 'active'; engine.running.set('g', {});
  assert.deepEqual(groupActivity(store, engine, 'g').members.map(m => m.state), ['idle', 'busy']);
  assert.equal(groupActivity(store, engine, 'g').members[1].label, '思考回复中');
  delivery.member = 'codex'; delivery.phase = 'review';
  assert.equal(groupActivity(store, engine, 'g').members[0].label, '复核中');
  approvals.push({ status: 'pending', member: 'codex' });
  assert.equal(groupActivity(store, engine, 'g').members[0].label, '等待你批准');
  approvals.length = 0; group.status = 'needs_recovery';
  assert.equal(groupActivity(store, engine, 'g').members[0].label, '回复待核对');
  assert.ok(groupActivity(store, engine, 'g').members.every(m => m.state !== 'busy'));
  group.status = 'paused'; engine.running.clear();
  assert.ok(groupActivity(store, engine, 'g').members.every(m => m.label === '已暂停'));
  group.status = 'active';
  assert.ok(groupActivity(store, engine, 'g').members.every(m => m.state === 'idle'));
});
test('native titles use the group topic and member identity, with project fallback', () => {
  assert.equal(groupSessionTitle({ title: 'writer', repo: 'E:/projects/writer' }, 'codex'), 'writer · Codex');
  assert.equal(groupSessionTitle({ title: '插件设计\n与验证' }, 'harness'), '插件设计 与验证 · Harness');
  assert.equal(groupSessionTitle({ title: '项目协作群', repo: 'E:\\projects\\我的应用' }, 'harness'), '我的应用 · Harness');
});

test('blocked prerequisite shows the actual cause instead of promising automatic dependency recovery', () => {
  const group = { status: 'awaiting_review', activeRequestId: 'r' };
  const request = { id: 'r', status: 'awaiting_review', deferred: [{ phase: 'work', member: 'harness', why: 'blocked' }], results: { 'work:harness': { summary: '命令启动失败 0xC0000142' } } };
  const store = { group: () => group, request: () => request, hasOpenRequests: () => true, pendingPermissions: () => [] };
  const activity = groupActivity(store, { running: new Map() }, 'g');
  assert.equal(activity.members[1].state, 'attention');
  assert.equal(activity.members[0].label, '等待前置修复');
  assert.match(activity.detail, /0xC0000142/);
  assert.match(activity.detail, /当前没有运行/);
  assert.doesNotMatch(activity.detail, /自动接续/);
  group.status = 'paused';
  assert.equal(groupActivity(store, { running: new Map() }, 'g').members[1].label, '已暂停');
});
const proposal = (owner = 'codex', integrator = owner === 'none' ? 'codex' : owner) => ({ message: '分工依据：相关任务由对应成员完成', owner, integrator, tasks: { codex: '实现并验证', harness: '独立审查或子任务' }, review: false, summary: '固定约束与当前决定' });
const done = { message: '完成实际任务，验证通过', status: 'done', summary: '实现结果与下一步', verification: ['node check.mjs: exit 0'], review: false };

test('explicit retry rearms an exhausted goal audit without disabling its automatic bound', t => {
 const {store,group}=fixture(t),{request}=input(store,group),engine=new GroupEngine(store,{});
 const item={id:'R01',title:'完成项目命令验证',status:'pending',evidence:[],task:'运行原生项目命令',executor:'harness'};
 const r=store.request(request.id);Object.assign(r,{status:'active',phase:'execution',agreement:{owner:'harness',integrator:'codex'},actions:[{phase:'review',member:'harness',goalAudit:true}],goal:{requirements:[{id:item.id,title:item.title}],cycles:0,history:[]}});
 const g=store.group(group.id);g.activeRequestId=r.id;g.status='active';
 for(let i=0;i<4;i++)engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[item]},'audit-'+i);
 assert.equal(r.status,'blocked');assert.equal(r.goal.noProgress,3);
 r.actions=[{phase:'review',member:'harness',goalAudit:true}];store.transaction(()=>{store.saveRequest(r);g.status='blocked';store.save(g)});
 engine.control(group.id,'retry');const retried=store.request(r.id);
 assert.equal(retried.goal.noProgress,0);assert.equal(retried.goal.lastDoneIds,undefined);assert.equal(retried.revision,r.revision);
 engine.finishGoalAudit(g,retried,{status:'done',completionChecklist:[item]},'fresh-audit');
 assert.equal(retried.status,'active');assert.equal(retried.actions[0].member,'harness');assert.equal(retried.actions[0].phase,'work');
 for(let i=0;i<3;i++)engine.finishGoalAudit(g,retried,{status:'done',completionChecklist:[item]},'unchanged-'+i);
 assert.equal(retried.status,'blocked');assert.equal(retried.goal.noProgress,3);
});

test('full-goal handoff admits the untried executor and cannot alternate away exhausted budgets', t => {
 const {store,group}=fixture(t),{request}=input(store,group),engine=new GroupEngine(store,{});
 const item={id:'R01',title:'恢复默认项目命令',status:'pending',evidence:['管道客户端访问被拒'],task:'检查宿主现有窄接口',executor:'harness'};
 const r=store.request(request.id);Object.assign(r,{status:'active',phase:'execution',agreement:{owner:'harness',integrator:'harness'},actions:[{phase:'review',member:'codex',goalAudit:true}],goal:{requirements:[{id:item.id,title:item.title}],cycles:0,history:[]}});
 const g=store.group(group.id);
 for(let i=0;i<3;i++)engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[item]},'harness-'+i);
 // The next audit assigns a genuinely different executor before that member
 // has performed any work on the still-open requirement.
 engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[{...item,executor:'codex'}]},'handoff');
 assert.equal(r.status,'active');assert.equal(r.actions[0].member,'codex');assert.equal(r.goal.noProgress,3);
 assert.equal(r.goal.stalledExecutors.harness,3);
 for(let i=0;i<2;i++)engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[{...item,executor:'codex'}]},'codex-'+i);
 assert.equal(r.status,'active');
 engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[item]},'alternate-back');
 assert.equal(r.status,'blocked');assert.equal(r.goal.stalledExecutors.codex,3);
 assert.equal(r.goal.stalledExecutors.harness,3);assert.match(r.error,/不是等待批准/);
});

test('legacy full-goal stall counters permit only the other executor and reset on verified completion progress', t => {
 const {store,group}=fixture(t),{request}=input(store,group),engine=new GroupEngine(store,{});
 const first={id:'R01',title:'检查接口',status:'pending',evidence:[],task:'只读检查接口',executor:'codex'};
 const second={id:'R02',title:'准备真实验收',status:'blocked',evidence:[],task:'需要真人实际关闭应用'};
 const r=store.request(request.id);Object.assign(r,{status:'active',agreement:{owner:'harness',integrator:'harness'},actions:[],goal:{requirements:[first,second].map(({id,title})=>({id,title})),cycles:3,history:[],lastDoneIds:'',noProgress:3}});
 const g=store.group(group.id);
 engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[first,second]},'legacy-handoff');
 assert.equal(r.status,'active');assert.equal(r.actions[0].member,'codex');assert.equal(r.goal.stalledExecutors.harness,3);
 // Genuine checked completion permits a new bounded attempt on the next item.
 engine.finishGoalAudit(g,r,{status:'done',completionChecklist:[{...first,status:'done',evidence:['接口检查已完成']},{...second,status:'pending',executor:'harness',task:'准备无副作用步骤'}]},'progress');
 assert.equal(r.status,'active');assert.equal(r.actions[0].member,'harness');assert.equal(r.goal.noProgress,0);
 assert.deepEqual(r.goal.stalledExecutors,{});
});

test('scoped native review rejects stale task replies and corrects once without replaying work', async t => {
 const {store,group}=fixture(t),{request}=input(store,group);let calls=0;
 const rt=runtime((_g,d)=>{calls++;const p=JSON.parse(d.prompt);assert.equal(Object.keys(p).at(-1),'currentTask');assert.equal(p.currentTask.responseScope,d.id);assert.match(p.currentTask.instruction,/上下文压缩/);return calls===1?{...done,message:'旧UI任务完成',responseScope:'old-delivery'}:{...done,responseScope:d.id};});
 rt.responseScopeProtocol=1;
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'active',phase:'execution',agreement:{owner:'harness',integrator:'harness'},actions:[{phase:'review',member:'codex',task:'只读核对管道证据'}]});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;g.status='active';store.save(g);});
 const e=new GroupEngine(store,rt);await e.tick(group.id);
 let r=store.request(request.id);assert.equal(r.status,'active');assert.equal(r.results['review:codex'],undefined);assert.ok(r.actions[0].responseRepair);
 const raw=store.messages(group.id).messages.find(m=>m.content.includes('旧UI任务完成'));assert.equal(raw.protocol,false);
 await e.tick(group.id);r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.results['review:codex'].status,'done');
 assert.deepEqual(rt.calls.map(x=>x.delivery.phase),['review','review']);assert.notEqual(rt.calls[0].delivery.responseScope,rt.calls[1].delivery.responseScope);
});

test('scope correction is bounded and mismatched work is retained without automatic reexecution', async t => {
 for(const phase of ['review','work']){
  const {store,group}=fixture(t),{request}=input(store,group),rt=runtime(()=>done);rt.responseScopeProtocol=1;
  store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'active',phase:'execution',agreement:{owner:'codex',integrator:'codex'},actions:[{phase,member:'codex',task:'当前任务'}]});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;g.status='active';store.save(g);});
  const e=new GroupEngine(store,rt);for(let i=0;i<4;i++)await e.tick(group.id);
  const r=store.request(request.id);assert.equal(r.status,'blocked');assert.equal(store.group(group.id).status,'blocked');assert.match(r.error,/任务标识/);
  assert.equal(rt.calls.length,phase==='review'?2:1);assert.equal(r.deliveryId,undefined);assert.deepEqual(r.results,{});
 }
});

test('goal audit automatically corrects a planning-shaped response once and returns the required checklist',async t=>{
 const {store,group}=fixture(t),{request}=input(store,group,'核对完整目标',{goalRequirements:['需要检查']}),calls=[];
 const rt=runtime((_g,d)=>{
  calls.push(d.phase);const contract=JSON.parse(d.prompt).currentTask.outputContract;
  assert.ok(contract.required.includes('completionChecklist'));assert.equal(contract.requirements[0].id,'R01');
  return calls.length===1?{...proposal('harness'),responseScope:d.id}:{...done,responseScope:d.id,completionChecklist:[{id:'R01',title:'需要检查',status:'done',evidence:['只读复核实际证据']}]};
 });rt.responseScopeProtocol=1;
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{phase:'execution',status:'active',agreement:{owner:'harness',integrator:'harness'},actions:[{phase:'review',member:'codex',goalAudit:true}]});store.saveRequest(r);const g=store.group(group.id);g.status='active';g.activeRequestId=r.id;store.save(g)});
 const engine=new GroupEngine(store,rt);await engine.tick(group.id);
 let r=store.request(request.id);assert.equal(r.status,'active');assert.ok(r.actions[0].responseRepair);assert.equal(r.results['review:codex'],undefined);
 await engine.tick(group.id);r=store.request(request.id);assert.equal(r.status,'completed');assert.deepEqual(calls,['review','review']);
 assert.equal(r.goal.checklist.length,1);assert.equal(store.messages(group.id).messages.filter(m=>m.protocol===false&&m.sender==='codex').length,1);
});

test('only superseded read-only planning can be quarantined after authoritative idle recovery',async t=>{
 for(const phase of ['planning','work','integrate']){
  const {store,group}=fixture(t),{request}=input(store,group),id=randomUUID();
  store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{revision:1,status:'needs_recovery',deliveryId:id});store.saveRequest(r);store.saveDelivery({id,groupId:group.id,requestId:r.id,member:'codex',phase,revision:0,started:true,status:'pending',prompt:'original',cursor:0});const g=store.group(group.id);g.activeRequestId=r.id;g.status='needs_recovery';store.save(g);});
  let sends=0;const e=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{sends++;throw Error('must not resend');},recover:async()=>({supersededReadOnly:true,proof:{kind:'superseded-readonly-unmatched',threadId:'ct',completeNativeTurnCount:1,desktopStatus:'notLoaded'}})});
  await e.tick(group.id,{recoveryOnly:true});const r=store.request(request.id),d=store.delivery(id);
  assert.equal(sends,0);assert.equal(d.started,true);
  if(phase==='planning'){assert.equal(d.status,'unmatched_superseded_readonly');assert.equal(r.unresolvedReadOnlyDelivery,id);assert.equal(r.deliveryId,undefined);assert.equal(r.status,'queued');assert.equal(d.nonAdmissionProof,undefined);}
  else{assert.equal(d.status,'pending');assert.equal(r.deliveryId,id);assert.equal(r.status,'needs_recovery');}
 }
});

test('verified integration and loaded version grant one new bounded attempt, prose and repeated hashes do not',t=>{
 const {store,group}=fixture(t),{request}=input(store,group),rt={progressVersion:'loaded-v1'},e=new GroupEngine(store,rt);
 const item={id:'R01',title:'真实验收',status:'pending',evidence:['新摘要不算进展'],task:'核验真实行为',executor:'codex'};
 const r=store.request(request.id);Object.assign(r,{status:'active',agreement:{owner:'codex',integrator:'codex'},actions:[],goal:{requirements:[{id:item.id,title:item.title}],cycles:0,history:[]}});const g=store.group(group.id);
 const audit=()=>e.finishGoalAudit(g,r,{status:'done',completionChecklist:[item]},randomUUID());
 for(let i=0;i<4;i++)audit();assert.equal(r.status,'blocked');
 rt.progressVersion='loaded-v2';audit();assert.equal(r.status,'active');assert.equal(r.goal.noProgress,0);
 for(let i=0;i<3;i++)audit();assert.equal(r.status,'blocked');
 r.integrationCheck={verified:{'src/fix.mjs':'verified-byte-hash'}};audit();assert.equal(r.status,'active');assert.equal(r.goal.noProgress,0);
 for(let i=0;i<3;i++)audit();assert.equal(r.status,'blocked');
 item.evidence=['又一份文字摘要'];audit();assert.equal(r.status,'blocked');
 assert.equal(r.goal.verifiedIntegrationProgress.length,1);
});

test('plain continue and approval preserve stage receipts and never authorize host permissions',t=>{
 const {store,group}=fixture(t),{request}=input(store,group);
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'active',phase:'execution',revision:2,actions:[{phase:'integrate',member:'codex'}],results:{'work:codex':{status:'done'},'review:harness':{status:'done'}},integrationScope:{revision:2,marker:'keep'},integrationReadyReceipt:{revision:2,marker:'keep'}});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;store.save(g);store.savePermission({id:'p',groupId:group.id,status:'pending',member:'codex'})});
 const before=store.request(request.id),e=new GroupEngine(store,{});
 for(const content of ['继续','补充：继续']){const result=input(store,group,content,{mode:'auto'});assert.equal(result.continuationOnly,true);e.continueRequest(group.id);assert.deepEqual(store.request(request.id),before);assert.equal(store.permission('p').status,'pending')}
 assert.throws(()=>input(store,group,'批准',{mode:'auto'}),/未绑定具体审批/);assert.deepEqual(store.request(request.id),before);assert.equal(store.permission('p').status,'pending');
 input(store,group,'继续，并新增真实功能',{mode:'supplement'});const r=store.request(request.id);assert.equal(r.revision,3);assert.deepEqual(r.results,{});assert.equal(r.integrationReadyReceipt,undefined);
});

test('integration stage convergence needs versioned peer readiness rather than a magic human phrase',async t=>{
 const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?{...proposal(),startPhase:'integrate'}:{...done,integrationFiles:[]}),e=new GroupEngine(store,rt),{request}=input(store,group,'落实已授权项目');
 for(let i=0;i<4;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'completed');assert.deepEqual(rt.calls.map(c=>c.delivery.phase),['planning','planning','review','integrate']);assert.equal(r.integrationReadyReceipt.reviewer,'harness');assert.equal(r.integrationConsent,undefined);
 assert.equal(JSON.parse(rt.calls[2].delivery.prompt).assignment.integrationReadiness,true);
});

test('legacy blocked stage is repaired without changing revision, round cap or asking for another approval',async t=>{
 const {store,group}=fixture(t),rt=runtime(()=>({...done,integrationFiles:[]})),e=new GroupEngine(store,rt),{request}=input(store,group,'继续项目');
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'needs_decision',revision:4,discussionRounds:1,plans:{codex:{...proposal(),startPhase:'integrate'},harness:{...proposal(),startPhase:'integrate'}},error:'整合起点缺少真人明确指令，或仍需执行与复核；请先完成前置工作。'});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;g.status='needs_decision';store.save(g)});
 await e.tick(group.id,{recoveryOnly:true});assert.equal(rt.calls.length,0);await e.tick(group.id);await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.revision,4);assert.equal(r.discussionRounds,1);assert.deepEqual(rt.calls.map(c=>c.delivery.phase),['review','integrate']);
});

test('continue migrates a settled legacy installation failure to read-only readiness without replanning',async t=>{
 const {store,group}=fixture(t),rt=runtime(()=>({...done,integrationFiles:[]})),e=new GroupEngine(store,rt),{request}=input(store,group,'继续已授权的整合');
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{phase:'execution',status:'blocked',revision:6,discussionRounds:1,plans:{codex:{...proposal(),startPhase:'integrate'},harness:{...proposal(),startPhase:'integrate'}},actions:[{phase:'integrate',member:'codex'}],error:'旧安装器拒绝访问',results:{'work:codex':{status:'done'},'review:harness':{status:'done'}}});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;g.status='paused';store.save(g)});
 e.continueRequest(group.id);assert.equal(store.request(request.id).actions[0].integrationReadiness,true);
 await e.tick(group.id);await e.tick(group.id);const r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.revision,6);assert.deepEqual(rt.calls.map(c=>c.delivery.phase),['review','integrate']);assert.equal(r.results['work:codex'].status,'done');
});

test('full-goal acceptance continues remaining original requirements on the same contexts',async t=>{
 const {store,group}=fixture(t);let audits=0;
 const rt=runtime((_g,d)=>{
  const p=JSON.parse(d.prompt);if(d.phase==='planning')return proposal();
  if(!p.assignment?.goalAudit)return done;
  audits++;return {...done,completionChecklist:[{id:'R01',title:'原始功能A',status:'done',evidence:['A验证通过']},{id:'R02',title:'原始功能B',status:audits===1?'pending':'done',evidence:audits===1?[]:['B验证通过'],task:'实现原始功能B并验证'}]};
 });
 const e=new GroupEngine(store,rt),{request}=input(store,group,'继续完成全部原始需求，全部完成前不要停',{goalRequirements:['原始功能A','原始功能B']});
 for(let i=0;i<10;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.goal.cycles,1);assert.equal(audits,2);assert.equal(r.goal.checklist.every(x=>x.status==='done'),true);
 assert.deepEqual(rt.calls.map(c=>c.delivery.phase),['planning','planning','work','integrate','review','work','review','integrate','review']);
 assert.match(JSON.parse(rt.calls[5].delivery.prompt).assignment.task,/原始功能B/);assert.doesNotMatch(JSON.parse(rt.calls[5].delivery.prompt).assignment.task,/原始功能A/);
 assert.ok(rt.calls.every(c=>c.contexts.codex==='ct'&&c.contexts.harness==='ht'));
});

test('full-goal completion rejects an omitted requirement or unsupported done claim',async t=>{
 for(const checklist of [[{id:'R01',title:'原始功能A',status:'done',evidence:['通过']}],[{id:'R01',title:'原始功能A',status:'done',evidence:[]},{id:'R02',title:'原始功能B',status:'done',evidence:['通过']}],[null]]){
  const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?proposal('none'):{...done,completionChecklist:checklist}),e=new GroupEngine(store,rt),{request}=input(store,group,'全部完成前不要停',{goalRequirements:['原始功能A','原始功能B']});
  for(let i=0;i<4;i++)await e.tick(group.id);
  const r=store.request(request.id);assert.equal(r.status,'blocked');assert.match(r.error,/完整目标验收清单/);assert.equal(rt.calls.length,4);
 }
});

test('full-goal blocked requirements preserve concrete reasons instead of reporting completion',async t=>{
 const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?proposal('none'):{...done,completionChecklist:[{id:'R01',title:'原始功能A',status:'blocked',evidence:[],task:'缺少真人提供的外部服务地址'}]}),e=new GroupEngine(store,rt),{request}=input(store,group,'全部完成前不要停',{goalRequirements:['原始功能A']});
 for(let i=0;i<4;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'blocked');assert.match(r.error,/外部服务地址/);assert.equal(r.goal.checklist[0].status,'blocked');
});

test('full-goal auto-continuation is bounded when repeated work makes no measurable progress',async t=>{
 const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?proposal():{...done,...(JSON.parse(d.prompt).assignment?.goalAudit?{completionChecklist:[{id:'R01',title:'原始功能A',status:'pending',evidence:[],task:'继续修复A'}]}:{})}),e=new GroupEngine(store,rt),{request}=input(store,group,'全部完成前不要停',{goalRequirements:['原始功能A']});
 for(let i=0;i<25;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'blocked');assert.match(r.error,/连续三轮/);assert.equal(r.goal.cycles,3);
});

test('blocked work permits only mutually declared independent work and gates review and integration', async t => {
  const { store, group } = fixture(t); let blocked = true;
  const rt = runtime((_g, d) => d.phase === 'planning' ? { ...proposal('both', 'codex'), review: true, independentWork: ['codex', 'harness'] } : d.member === 'codex' && d.phase === 'work' && blocked ? { ...done, status: 'blocked', message: 'need human decision' } : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let i = 0; i < 6; i++) await engine.tick(group.id);
  let r = store.request(request.id); assert.equal(r.status, 'awaiting_review'); assert.equal(r.deferred[0].why, 'blocked');
  assert.match(r.error, /need human decision/);
  assert.equal(r.results['work:harness'].status, 'done'); assert.equal(r.results['work:codex'].status, 'blocked');
  assert.deepEqual(rt.calls.slice(2).map(c => c.delivery.phase), ['work', 'work']);
  const calls = rt.calls.length; await engine.tick(group.id); assert.equal(rt.calls.length, calls);
  blocked = false; engine.control(group.id, 'retry');
  for (let i = 0; i < 4; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.equal(rt.calls.filter(c => c.delivery.member === 'harness' && c.delivery.phase === 'work').length, 1);
});

test('unavailable work resumes once while independent peer completes and dependent actions wait', async t => {
  const { store, group } = fixture(t); let available = false;
  const rt = runtime((_g, d) => d.phase === 'planning' ? { ...proposal('both', 'codex'), independentWork: ['codex', 'harness'] } : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  await engine.tick(group.id); await engine.tick(group.id);
  rt.canTurn = async (_g, m) => m !== 'codex' || available;
  await engine.tick(group.id); await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'awaiting_review'); assert.equal(rt.calls.length, 3);
  available = true; for (let i = 0; i < 4; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.equal(rt.calls.filter(c => c.delivery.phase === 'work' && c.delivery.member === 'codex').length, 1);
});

test('absent mutual independence never bypasses blocked work; supplement clears deferrals', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((_g, d) => d.phase === 'planning' ? { ...proposal('both', 'codex'), independentWork: d.member === 'codex' ? ['harness'] : [] } : { ...done, status: 'blocked' });
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let i = 0; i < 6; i++) await engine.tick(group.id);
  assert.equal(rt.calls.length, 3); assert.equal(store.request(request.id).status, 'awaiting_review');
  engine.control(group.id, 'retry'); for (let i = 0; i < 3; i++) await engine.tick(group.id);
  assert.equal(rt.calls.length, 4); assert.equal(store.request(request.id).status, 'awaiting_review');
  input(store, group, 'new scope', { mode: 'supplement' }); assert.deepEqual(store.request(request.id).deferred, []);
});

test('an admitted work checkpoint is recovered even when member availability is false', async t => {
  const { store, group } = fixture(t); let writes = 0, recoveries = 0;
  const rt = runtime((_g, d) => d.phase === 'planning' ? { ...proposal('both', 'codex'), independentWork: ['codex', 'harness'] } : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  await engine.tick(group.id); await engine.tick(group.id);
  rt.turn = async () => { writes++; throw Error('receipt lost after side effect'); }; await engine.tick(group.id);
  const id = store.request(request.id).deliveryId;
  rt.canTurn = async () => false; rt.recover = async () => { recoveries++; return null; };
  store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
  await engine.tick(group.id);
  assert.equal(writes, 1); assert.equal(recoveries, 1); assert.equal(store.request(request.id).deliveryId, id);
  assert.equal(store.delivery(id).started, true); assert.deepEqual(store.request(request.id).deferred, []);
});

test('supplement during availability check cannot overwrite the new revision', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((_g, d) => d.phase === 'planning' ? proposal('both', 'codex') : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  await engine.tick(group.id); await engine.tick(group.id);
  rt.canTurn = async () => { input(store, group, 'changed scope', { mode: 'supplement' }); return false; };
  await engine.tick(group.id);
  const saved = store.request(request.id); assert.equal(saved.revision, 1); assert.equal(saved.phase, 'planning');
  assert.deepEqual(saved.deferred, []); assert.equal(saved.deliveryId, undefined); assert.equal(rt.calls.length, 2);
});

test('supplement removes accepted results from current revision but preserves history', t => {
  const { store, group } = fixture(t); const { request } = input(store, group);
  store.transaction(() => { const r = store.request(request.id); r.results = { 'work:codex': done }; store.saveRequest(r); });
  input(store, group, 'new revision', { mode: 'supplement' });
  assert.deepEqual(store.request(request.id).results, {});
  assert.equal(store.request(request.id).revision, 1);
});

test('lost receipt recovery is bounded and never repeats an existing file side effect', async t => {
  const { store, group, dir } = fixture(t); const file = path.join(dir, 'effect'); let turns = 0, recoveries = 0;
  const rt = { appOpen: async () => true, turn: async () => { turns++; fs.appendFileSync(file, 'once'); throw Error('lost receipt'); }, recover: async () => { recoveries++; return null; } };
  const engine = new GroupEngine(store, rt, { maxRecoveryAttempts: 2 }); const { request } = input(store, group);
  await engine.tick(group.id); const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const id = store.request(request.id).deliveryId;
  for (let i = 0; i < 4; i++) {
    store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
    await engine.tick(group.id);
  }
  assert.equal(turns, 1); assert.equal(recoveries, 2);
  assert.equal(store.request(request.id).status, 'needs_decision'); assert.equal(store.request(request.id).deliveryId, id);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest);
  engine.control(group.id, 'retry'); await engine.tick(group.id);
  assert.equal(turns, 1); assert.equal(recoveries, 3); assert.equal(store.request(request.id).deliveryId, id);
});

test('recovered duplicate delivery does not repeat file writes', async t => {
  const { store, group, dir } = fixture(t); const file = path.join(dir, 'effect'); let calls = 0;
  const rt = { appOpen: async () => true, turn: async () => { calls++; fs.appendFileSync(file, 'once'); throw Error('lost'); }, recover: async () => ({ text: JSON.stringify(proposal('none')) }) };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group); await engine.tick(group.id);
  const before = fs.readFileSync(file);
  store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
  await engine.tick(group.id);
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(file), before);
});

test('single executor can choose the other member as integrator', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((_g, delivery) => delivery.phase === 'planning' ? proposal('harness', 'codex') : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let i = 0; i < 4; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.deepEqual(rt.calls.slice(2).map(c => [c.delivery.member, c.delivery.phase]), [['harness', 'work'], ['codex', 'integrate']]);
});

test('cross-member integration with review never assigns executor self-review', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((_g, delivery) => delivery.phase === 'planning' ? { ...proposal('harness', 'codex'), review: true } : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let i = 0; i < 5; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.deepEqual(rt.calls.slice(2).map(c => [c.delivery.member, c.delivery.phase]), [['harness', 'work'], ['codex', 'review'], ['codex', 'integrate']]);
  assert.match(JSON.parse(rt.calls.at(-1).delivery.prompt).instruction, /遇冲突不得自行 merge/);
});

test('human supplement reopens exhausted recovery without readmitting the old turn', async t => {
  const { store, group } = fixture(t); let turns = 0, recoveries = 0;
  const rt = { appOpen: async () => true, turn: async () => { turns++; throw Error('lost'); }, recover: async () => { recoveries++; return null; } };
  const engine = new GroupEngine(store, rt, { maxRecoveryAttempts: 1 }); const { request } = input(store, group);
  await engine.tick(group.id); const id = store.request(request.id).deliveryId;
  for (let i = 0; i < 2; i++) {
    store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
    await engine.tick(group.id);
  }
  assert.equal(store.request(request.id).status, 'needs_decision');
  input(store, group, 'continue checking original turn', { mode: 'supplement' }); await engine.tick(group.id);
  assert.equal(turns, 1); assert.equal(recoveries, 2); assert.equal(store.request(request.id).deliveryId, id);
  assert.equal(store.request(request.id).revision, 1);
});

test('integration conflict preserves main files and index; completed copy verifies bytes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-integrate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'main'), peer = path.join(dir, 'peer'); fs.mkdirSync(repo);
  const g = (root, ...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  g(repo, 'init'); fs.writeFileSync(path.join(repo, 'file'), 'baseline'); g(repo, 'add', '.');
  g(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  const commit = g(repo, 'rev-parse', 'HEAD').toString().trim(); g(repo, 'worktree', 'add', '--detach', peer, commit);
  fs.writeFileSync(path.join(peer, 'file'), 'peer'); fs.writeFileSync(path.join(repo, 'file'), 'human');
  const group = { repo, baseline: { commit }, worktrees: { codex: peer } }, index = g(repo, 'diff', '--cached', '--binary');
  assert.throws(() => integrationPreflight(group), { reason: 'main_conflict' });
  assert.equal(fs.readFileSync(path.join(repo, 'file'), 'utf8'), 'human'); assert.deepEqual(g(repo, 'diff', '--cached', '--binary'), index);
  fs.writeFileSync(path.join(repo, 'file'), 'baseline'); const check = integrationPreflight(group);
  assert.throws(() => verifyIntegration(repo, check), /verification failed/);
  fs.copyFileSync(path.join(peer, 'file'), path.join(repo, 'file')); verifyIntegration(repo, check);
});

test('successive integrations use verified peer checkpoints without replaying old work', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-sequential-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'main'), peer = path.join(dir, 'peer'); fs.mkdirSync(repo);
  const g = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  g('init'); fs.writeFileSync(path.join(repo, 'file'), 'baseline'); g('add', '.');
  g('-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base');
  const commit=g('rev-parse','HEAD').toString().trim(); g('worktree','add','--detach',peer,commit);
  const harness=path.join(dir,'harness'); g('worktree','add','--detach',harness,commit);
  const group={repo,baseline:{commit},worktrees:{codex:peer,harness}};
  fs.writeFileSync(path.join(harness,'earlier-review.txt'),'previous result');
  fs.writeFileSync(path.join(peer,'file'),'first'); const first=integrationPreflight(group);
  fs.copyFileSync(path.join(peer,'file'),path.join(repo,'file'));
  fs.copyFileSync(path.join(harness,'earlier-review.txt'),path.join(repo,'earlier-review.txt')); verifyIntegration(repo,first);
  group.integrationState={main:first.expected,peers:first.peers};
  fs.writeFileSync(path.join(peer,'file'),'second'); const second=integrationPreflight(group); assert.deepEqual(Object.keys(second.expected),['file']);
  fs.copyFileSync(path.join(peer,'file'),path.join(repo,'file')); verifyIntegration(repo,second);
  group.integrationState={main:{...first.expected,...second.expected},peers:second.peers};
  fs.writeFileSync(path.join(repo,'file'),'human'); assert.deepEqual(integrationPreflight(group).expected,{});
  fs.writeFileSync(path.join(peer,'file'),'third'); assert.throws(()=>integrationPreflight(group),{reason:'main_conflict'});
});

test('disconnected peer is shown as offline while a completed proposal waits for its actual reply', async t => {
  const { store, group } = fixture(t); input(store, group);
  const rt = runtime(() => proposal('none')); rt.adapter = () => null; rt.canTurn = async (g, member) => member !== 'harness';
  const engine = new GroupEngine(store, rt); await engine.tick(group.id); await engine.tick(group.id);
  const activity = groupActivity(store, engine, group.id);
  assert.equal(activity.members.find(m => m.id === 'harness').label, '未连接');
  assert.equal(activity.members.find(m => m.id === 'codex').label, '已回复，等对方');
  assert.match(activity.detail, /DeepSeek.*连接/); assert.equal(rt.calls.length, 1);
});

test('explicit human peer addressing chooses that peer first, including the latest supplement', async t => {
  const { store, group } = fixture(t), rt = runtime(() => proposal('none')), engine = new GroupEngine(store, rt);
  input(store, group, '与deepseek确认分工'); await engine.tick(group.id);
  assert.equal(rt.calls[0].delivery.member, 'harness'); await engine.tick(group.id);
  const second = input(store, group, '请 Harness 先确认');
  input(store, group, '@Codex 请检查这个决定', { mode: 'supplement', requestId: second.request.id });
  await engine.tick(group.id); assert.equal(rt.calls[2].delivery.member, 'codex');
});

test('collaboration retains source demand and peer reply links without duplicating canonical messages', async t => {
  const { store, group } = fixture(t), rt = runtime(() => proposal('harness')), engine = new GroupEngine(store, rt);
  const first = input(store, group); await engine.tick(group.id); await engine.tick(group.id);
  const replies = store.messages(group.id).messages.filter(m => m.protocol);
  assert.equal(replies[0].replyTo, first.message.id); assert.equal(replies[1].replyTo, replies[0].id);
  assert.equal(replies[1].phase, 'planning');
  assert.ok(store.messages(group.id, { channel: 'collaboration' }).messages.some(m => m.id === first.message.id));
  assert.equal(JSON.parse(rt.calls[1].delivery.prompt).replyTo, replies[0].id);
});

test('adapter update leases block new admissions, preserve groups and wait for pending native checkpoints', async t => {
  const { store, group } = fixture(t); group.harnessAdapterId = 'harness-desktop'; store.save(group);
  const { request } = input(store, group); const rt = new GroupRuntime(store);
  const service = await startGroupService({ store, runtime: rt, schedule: false });
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); });
  const body = { adapterId: 'harness-desktop', action: 'begin' };
  const lease = await localFetch(service.descriptor, '/api/admin/adapter-update', body);
  assert.equal(lease.ready, true); assert.equal(await rt.canTurn(group, 'codex'), false);
  assert.equal(store.request(request.id).status, 'queued'); assert.equal(store.group(group.id).status, 'idle');
  const delivery = { id: randomUUID(), groupId: group.id, requestId: request.id, member: 'harness', started: true, status: 'pending' };
  store.saveDelivery(delivery); request.deliveryId = delivery.id; store.saveRequest(request);
  const check = { adapterId: body.adapterId, leaseId: lease.leaseId, action: 'check' };
  assert.equal((await localFetch(service.descriptor, '/api/admin/adapter-update', check)).ready, false);
  await assert.rejects(localFetch(service.descriptor, '/api/admin/adapter-update', { ...check, action: 'end', leaseId: 'other' }), /owner/);
  await localFetch(service.descriptor, '/api/admin/adapter-update', { ...check, action: 'end' });
  assert.equal(await rt.canTurn(group, 'codex'), true); assert.equal(store.request(request.id).deliveryId, delivery.id);
});

test('stale native heartbeat cannot replace the latest adapter, including after coordinator restart', t => {
  const { store } = fixture(t); const started = Date.now(), instanceId = randomUUID();
  const disk = { instanceStartedAt: started, instanceId };
  const rt = new GroupRuntime(store, { adapterDescriptor: () => disk });
  const base = { adapterId: 'harness-desktop', protocol: 'codex-harness-group/v2', token: 'x'.repeat(32), url: 'http://127.0.0.1:1111' };
  assert.equal(rt.registerHarness(base), false, 'old live instance must not win a cold coordinator race');
  assert.equal(rt.registerHarness({ ...base, instanceStartedAt: started, instanceId }), true);
  assert.equal(rt.registerHarness({ ...base, instanceStartedAt: started - 1, instanceId: randomUUID(), url: 'http://127.0.0.1:2222' }), false);
  assert.equal(rt.registerHarness({ ...base, instanceStartedAt: started, instanceId: randomUUID() }), false);
  assert.equal(rt.harnessAdapters.get(base.adapterId).url, base.url);
});

test('legacy heartbeat cannot override the current descriptor even without generation metadata', t => {
  const { store } = fixture(t);
  const latest = { adapterId: 'harness-desktop', url: 'http://127.0.0.1:3333', token: 'n'.repeat(32) };
  const rt = new GroupRuntime(store, { adapterDescriptor: () => latest });
  assert.equal(rt.registerHarness({ ...latest, protocol: 'codex-harness-group/v2', url: 'http://127.0.0.1:1111', token: 'o'.repeat(32) }), false);
  assert.equal(rt.registerHarness({ ...latest, protocol: 'codex-harness-group/v2' }), true);
});

test('legacy refusal proof requires the first original system audit, exact context and unchanged revision', t => {
  const { store, group } = fixture(t); const { request, message } = input(store, group);
  const delivery = { id: randomUUID(), member: 'codex', status: 'pending', started: true, cursor: message.seq, requestId: request.id, revision: 0 };
  const error = JSON.stringify({ code: -32600, message: 'thread ct already has an active writer' });
  assert.equal(codexWriterRefusal(store, group, delivery), null);
  const audit = store.message(group.id, { sender: 'system', channel: 'group', requestId: request.id, content: error });
  assert.equal(codexWriterRefusal(store, group, delivery).auditMessageId, audit.id);
  assert.equal(codexWriterRefusal(store, { ...group, contexts: { codex: 'other' } }, delivery), null);
  assert.equal(codexWriterRefusal(store, group, { ...delivery, nativeTurnId: 'admitted' }), null);
  assert.equal(codexWriterRefusal(store, group, { ...delivery, revision: 1 }), null);
  const other = input(store, group);
  store.message(group.id, { sender: 'human', channel: 'group', requestId: other.request.id, content: error });
  store.message(group.id, { sender: 'system', channel: 'group', requestId: other.request.id, content: error });
  assert.equal(codexWriterRefusal(store, group, { ...delivery, requestId: other.request.id, cursor: other.message.seq }), null);
});

test('setup refusal releases unexecuted delivery and offers safe retry instead of uncertain recovery', async t => {
  const { store, group } = fixture(t); const { request } = input(store, group);
  const engine = new GroupEngine(store, { appOpen: async () => true, turn: async () => {
    const error = Error('already has an active writer'); error.code = 'GROUP_NOT_ADMITTED'; error.admissionFailure = 'codex_setup'; throw error;
  } });
  await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'blocked'); assert.equal(store.group(group.id).status, 'blocked');
  assert.equal(store.request(request.id).deliveryId, undefined); assert.equal(store.request(request.id).usage.calls, 0);
  engine.control(group.id, 'retry'); assert.equal(store.request(request.id).status, 'queued');
});

test('pre-admission writer occupancy waits with backoff and resumes without a human retry or model replay',async t=>{
 const {store,group}=fixture(t),{request}=input(store,group);let calls=0;
 const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{calls++;if(calls===1)throw Object.assign(Error('active writer'),{code:'GROUP_NOT_ADMITTED',admissionFailure:'codex_busy'});return {text:JSON.stringify(proposal('none'))};}});
 await engine.tick(group.id);let r=store.request(request.id);assert.equal(r.status,'queued');assert.equal(r.deliveryId,undefined);assert.equal(r.usage.calls,0);assert.ok(r.admissionRetryAt>Date.now());
 assert.equal(groupActivity(store,engine,group.id).members[0].label,'等待会话空闲');
 await engine.tick(group.id);assert.equal(calls,1);
 store.transaction(()=>{r.admissionRetryAt=0;store.saveRequest(r)});await engine.tick(group.id);assert.equal(calls,2);r=store.request(request.id);assert.ok(r.plans.codex);assert.equal(r.admissionRetryAt,undefined);
});

test('settling proven legacy non-admission while paused keeps original delivery, contexts and queue without model calls', async t => {
  const { store, group } = fixture(t); const first = input(store, group), second = input(store, group, '另一个需求');
  let calls = 0;
  const engine = new GroupEngine(store, { appOpen: async () => true, turn: async () => { calls++; throw Error('uncertain'); },
    recover: async () => ({ notAdmitted: true, proof: { kind: 'codex-writer-refusal', auditMessageId: 'audit' } }) });
  await engine.tick(group.id); engine.control(group.id, 'pause');
  const deliveryId = store.request(first.request.id).deliveryId;
  const request = store.request(first.request.id); delete request.nextRecoveryAt; store.saveRequest(request);
  await engine.tick(group.id, { recoveryOnly: true });
  assert.equal(calls, 1); assert.equal(store.group(group.id).status, 'paused');
  assert.deepEqual(store.group(group.id).contexts, group.contexts);
  assert.equal(store.request(first.request.id).deliveryId, deliveryId); assert.equal(store.request(first.request.id).status, 'queued');
  assert.equal(store.delivery(deliveryId).started, false); assert.equal(store.delivery(deliveryId).nonAdmissionProof.auditMessageId, 'audit');
  assert.equal(store.request(second.request.id).status, 'queued'); assert.equal(store.request(first.request.id).usage.calls, 0);
});
function runtime(reply) {
  const calls = [];
  return { calls, appOpen: async () => true, async turn(group, delivery, signal) {
    calls.push({ contexts: { ...group.contexts }, delivery: structuredClone(delivery), signal });
    return { text: JSON.stringify(await reply(group, delivery, signal)), usage: { totalTokens: 10 } };
  } };
}
test('canonical origins deduplicate across connections, preserve identical text with distinct origin, and reject content substitution', t => {
  const { store, group, dir } = fixture(t);
  const origin = { adapter: 'codex', sessionId: 'ct', messageId: 'turn-item' };
  const first = input(store, group, '相同需求', { origin });
  const secondStore = new GroupStore(path.join(dir, 'groups.sqlite'));
  try {
    assert.equal(secondStore.input(group.id, { content: '相同需求', origin }).duplicate, true);
    assert.throws(() => secondStore.input(group.id, { content: '不同内容', origin }), /different content/);
    assert.equal(secondStore.requests(group.id).length, 1);
    assert.equal(secondStore.messageById(first.message.id).content, '相同需求');
    input(secondStore, group, '相同需求'); assert.equal(store.requests(group.id).length, 2);
  } finally { secondStore.close(); }
});
test('persistent contexts are reused across demands; both initially read but only one concise answer is published', async t => {
  const { store, group } = fixture(t); const rt = runtime(() => proposal('none'));
  const engine = new GroupEngine(store, rt);
  for (let n = 0; n < 2; n++) {
    const { request } = input(store, group, `只回答第${n}个问题`);
    await engine.tick(group.id); await engine.tick(group.id);
    assert.equal(store.request(request.id).status, 'completed');
  }
  assert.equal(rt.calls.length, 4);
  for (const call of rt.calls) assert.deepEqual(call.contexts, { codex: 'ct', harness: 'ht' });
  assert.equal(store.messages(group.id, { channel: 'group' }).messages.filter(m => m.sender === 'codex').length, 2);
  assert.equal(JSON.parse(rt.calls[2].delivery.prompt).rules, undefined);
});
test('routine scheduling disagreement uses prior proposals then selects a reviewed schedule within the round cap', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((g, d) => proposal(d.member)); const engine = new GroupEngine(store, rt);
  const { request } = input(store, group, undefined, { maxDiscussionRounds: 2 });
  for (let i = 0; i < 4; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'active');
  assert.equal(store.request(request.id).schedulingResolution.kind, 'routine_division');
  assert.equal(store.request(request.id).discussionRounds, 2);
  assert.equal(JSON.parse(rt.calls[2].delivery.prompt).proposals.harness.owner, 'harness');
});

test('one-round scheduling keeps review separate from execution and finishes without human mediation',async t=>{
 const {store,group}=fixture(t);const rt=runtime((_g,d)=>d.phase==='planning'?{...proposal(d.member==='codex'?'codex':'both','codex'),review:true}:done);
 const e=new GroupEngine(store,rt),{request}=input(store,group,'continue authorized work',{maxDiscussionRounds:1});
 for(let i=0;i<6;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.discussionRounds,1);
 assert.deepEqual(rt.calls.slice(2).map(c=>[c.delivery.phase,c.delivery.member]),[['work','codex'],['review','harness'],['integrate','codex']]);
 assert.equal(r.schedulingResolution.selectedProposal,'codex');assert.equal(r.integrationConsent,undefined);
 assert.match(JSON.parse(rt.calls[2].delivery.prompt).schedulingResolution.instruction,/不代表.*共识/);
});

test('an explicit project decision remains human-owned even when division matches',async t=>{
 const {store,group}=fixture(t);const decision={question:'是否删除旧数据？',options:['保留旧数据','删除旧数据']};
 const rt=runtime(()=>({...proposal(),decision})),e=new GroupEngine(store,rt),{request}=input(store,group,undefined,{maxDiscussionRounds:1});
 for(let i=0;i<5;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'needs_decision');assert.equal(rt.calls.length,2);
 assert.match(r.error,/是否删除旧数据/);assert.match(r.error,/保留旧数据/);assert.equal(r.humanDecisions[0].member,'codex');assert.equal(r.actions.length,0);
});

test('a legacy division-only deadlock resumes its exact plans once without replanning or changing revision',async t=>{
 const {store,group}=fixture(t),rt=runtime(()=>done),e=new GroupEngine(store,rt),{request}=input(store,group,undefined,{maxDiscussionRounds:1});
 const plans={codex:{...proposal('codex','codex'),review:true},harness:{...proposal('both','codex'),review:true}};
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'needs_decision',plans,discussionRounds:1});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;g.status='needs_decision';store.save(g)});
 await e.tick(group.id,{recoveryOnly:true});assert.equal(rt.calls.length,0);assert.equal(store.request(request.id).status,'needs_decision');
 for(let i=0;i<4;i++)await e.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,'completed');assert.equal(r.revision,0);assert.equal(r.discussionRounds,1);assert.deepEqual(r.plans,plans);assert.equal(rt.calls.filter(c=>c.delivery.phase==='planning').length,0);
});
test('work is delegated after agreement; only chosen executor works and its integrator reports verification', async t => {
  const { store, group } = fixture(t); const rt = runtime((g, d) => d.phase === 'planning' ? proposal('harness') : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let i = 0; i < 4; i++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.deepEqual(rt.calls.slice(2).map(c => [c.delivery.member, c.delivery.phase]), [['harness', 'work'], ['harness', 'integrate']]);
});
test('a single author can have a different reviewer and integrator without reviewing its own change', async t => {
  const { store, group } = fixture(t);
  const rt = runtime((g, d) => d.phase === 'planning' ? { ...proposal('harness', 'codex'), review: true } : done);
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  for (let step = 0; step < 5; step++) await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'completed');
  assert.deepEqual(rt.calls.map(c => [c.delivery.member, c.delivery.phase]), [
    ['codex', 'planning'], ['harness', 'planning'], ['harness', 'work'], ['codex', 'review'], ['codex', 'integrate'],
  ]);
});
test('urgent demand interrupts and preempts; supplement resets only the referenced current request', async t => {
  const { store, group } = fixture(t); let resolveTurn; let began;
  const started = new Promise(r => { began = r; });
  const rt = runtime(async (g, d, signal) => { began(); return new Promise(resolve => { resolveTurn = () => resolve(proposal('none')); }); });
  const engine = new GroupEngine(store, rt); const first = input(store, group);
  const running = engine.tick(group.id); await started;
  const urgent = input(store, group, '紧急修复', { mode: 'urgent' }); engine.interrupt(group.id);
  assert.equal(rt.calls[0].signal.aborted, true); resolveTurn(); await running;
  assert.equal(store.group(group.id).activeRequestId, null);
  const rt2 = runtime(() => proposal('none')); const engine2 = new GroupEngine(store, rt2);
  await engine2.tick(group.id); assert.equal(store.group(group.id).activeRequestId, urgent.request.id);
  input(store, group, '补充修改验收条件', { mode: 'supplement' });
  assert.equal(store.request(urgent.request.id).revision, 1); assert.equal(store.request(first.request.id).revision, 0);
});
test('both apps closed means no model admission; reopening resumes same contexts', async t => {
  const { store, group } = fixture(t); const rt = runtime(() => proposal('none')); rt.appOpen = async () => false;
  const engine = new GroupEngine(store, rt); input(store, group); await engine.tick(group.id);
  assert.equal(rt.calls.length, 0); assert.equal(store.group(group.id).status, 'apps_closed');
  rt.appOpen = async () => true; await engine.tick(group.id); assert.equal(rt.calls.length, 1);
});

test('scheduled HTTP steering and lifecycle interruption retain checkpoints without replaying stale work', async t => {
  for (const scenario of ['supplement', 'apps-closed']) await t.test(scenario, async t => {
    const { store, group } = fixture(t); let open = true, calls = 0, cancelled = 0;
    const until = async predicate => {
      const deadline = Date.now() + 10000;
      while (!predicate()) { assert.ok(Date.now() < deadline, 'scheduled transition timed out'); await new Promise(resolve => setTimeout(resolve, 40)); }
    };
    const rt = { appOpen: async () => open, async turn(g, delivery, signal) {
      calls++;
      if (calls === 1) return new Promise(resolve => signal.addEventListener('abort', () => {
        cancelled++; resolve({ text: 'native interruption confirmed', interrupted: true, usage: null });
      }, { once: true }));
      return { text: JSON.stringify(proposal('none')), usage: null };
    } };
    const service = await startGroupService({ store, runtime: rt });
    try {
    const first = await localFetch(service.descriptor, `/api/groups/${group.id}/input`, {
      content: 'original', origin: { adapter: 'test', sessionId: 's', messageId: randomUUID() },
    });
    await until(() => calls === 1);
    const originalDelivery = store.request(first.request.id).deliveryId;
    if (scenario === 'supplement') await localFetch(service.descriptor, `/api/groups/${group.id}/input`, {
      content: 'new acceptance', mode: 'auto',
      origin: { adapter: 'test', sessionId: 's', messageId: randomUUID() },
    });
    else open = false;
    await until(() => cancelled === 1 && !service.engine.running.size);
    assert.equal(store.delivery(originalDelivery).status, 'received');
    assert.deepEqual(store.request(first.request.id).plans, {});
    assert.equal(store.request(first.request.id).revision, 1);
    if (!open) {
      await new Promise(resolve => setTimeout(resolve, 1200));
      assert.equal(calls, 1); assert.equal(store.group(group.id).status, 'apps_closed');
      open = true;
    }
    await until(() => store.request(first.request.id).status === 'completed');
    assert.equal(calls, 3);
    assert.deepEqual(store.group(group.id).contexts, { codex: 'ct', harness: 'ht' });
    assert.equal(store.requests(group.id).length, 1);
    } finally { await service.close(); }
  });
});
test('uncertain transport execution is recovered without resending a model turn', async t => {
  const { store, group } = fixture(t); let executions = 0;
  const rt = { appOpen: async () => true, async turn() { executions++; throw Error('transport dropped after tools'); }, recover: async () => ({ text: JSON.stringify(proposal('none')), usage: null }) };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  await engine.tick(group.id); assert.equal(store.request(request.id).status, 'needs_recovery');
  store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); const g = store.group(group.id); g.error = 'Old host failure'; store.save(g); });
  await engine.tick(group.id); assert.equal(executions, 1); assert.equal(store.request(request.id).plans.codex.owner, 'none');
  assert.equal(store.request(request.id).usage.unknownCalls, 1);
  assert.equal(store.group(group.id).error, undefined);
});
test('strict unsupported token limit blocks before any model call', async t => {
  const { store, group } = fixture(t); const rt = runtime(() => proposal('none')); const engine = new GroupEngine(store, rt);
  const { request } = input(store, group, undefined, { hardTokenLimit: 100 }); await engine.tick(group.id);
  assert.equal(rt.calls.length, 0); assert.equal(store.request(request.id).status, 'blocked');
});
test('confirmed native interruption clears stale dispatch and replans supplements without replaying old work', async t => {
  const { store, group } = fixture(t);
  const rt = runtime(() => proposal('none')); rt.turn = async () => { throw Error('turn interrupted'); };
  rt.recover = async () => ({ text: '原生 turn 已确认中断', interrupted: true, usage: null });
  const engine = new GroupEngine(store, rt); const { request } = input(store, group);
  await engine.tick(group.id); input(store, group, '纠正验收目标', { mode: 'supplement' });
  store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
  await engine.tick(group.id);
  const recovered = store.request(request.id); assert.equal(recovered.status, 'queued'); assert.equal(recovered.deliveryId, undefined);
  assert.equal(recovered.revision, 1); assert.equal(recovered.supplements.length, 1); assert.equal(recovered.interrupted, true);
});
test('bounded delta compaction preserves original history and per-member unread watermark', t => {
  const { store, group } = fixture(t); group.compactThresholdChars = 1000; store.transaction(() => store.save(group));
  for (let i = 0; i < 30; i++) store.transaction(() => store.message(group.id, { sender: 'harness', channel: 'collaboration', content: `${i}:` + 'a'.repeat(100) }));
  const { request } = input(store, group); const engine = new GroupEngine(store, {});
  const built = engine.prompt(group, request, 'codex', 'planning');
  assert.equal(built.compacted, true); assert.ok(JSON.parse(built.text).delta.length < 12);
  assert.equal(store.messages(group.id, { limit: 200 }).messages.length, 31);
});
test('native admission distinguishes controller dispatch from genuine human text and deduplicates retries', t => {
  const { store, group } = fixture(t); const engine = new GroupEngine(store, {});
  const base = { adapter: 'codex', sessionId: 'ct', turnId: 't1', messageId: 't1', content: '[DeepSeek Harness] 这依然是我的真人文字' };
  assert.equal(routeNative(store, engine, base).block, true);
  assert.equal(routeNative(store, engine, base).duplicate, true);
  const id = randomUUID(); store.transaction(() => store.saveDelivery({ id, groupId: group.id, member: 'codex', started: true, status: 'pending', prompt: 'controller body' }));
  assert.equal(routeNative(store, engine, { ...base, turnId: 'dispatch-turn', content: `[Group delivery ${id}]\ncontroller body` }).dispatch, true);
  assert.equal(routeNative(store, engine, { ...base, turnId: 'another-turn', content: `[Group delivery ${id}]\ncontroller body` }).duplicateDispatch, true);
  store.transaction(() => { const d = store.delivery(id); d.status = 'received'; d.promptHash = store.hash(d.prompt); delete d.prompt; store.saveDelivery(d); });
  assert.equal(routeNative(store, engine, { ...base, turnId: 'replayed-turn', content: `[Group delivery ${id}]\ncontroller body` }).duplicateDispatch, true);
  assert.equal(store.requests(group.id).length, 1);
  assert.equal(routeNative(store, engine, { ...base, sessionId: 'unbound' }).bound, false);
  assert.throws(() => routeNative(store, engine, { ...base, content: [{ type: 'image' }] }), /attachment/);
});
test('shared HTTP service authenticates reads/writes, rejects cross-origin and exposes one canonical input', async t => {
  const { store, group } = fixture(t);
  const service = await startGroupService({ store, runtime: {}, schedule: false });
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); });
  const descriptor = service.descriptor;
  assert.deepEqual((await localFetch(descriptor, `/api/groups/${group.id}`)).activity.members.map(m => m.label), ['待命', '待命']);
  assert.equal((await fetch(descriptor.url + '/api/projects/defaults')).status, 401);
  assert.equal((await localFetch(descriptor, '/api/projects/defaults')).projectsRoot, path.dirname(group.repo));
  const preview = await localFetch(descriptor, '/api/projects/preview', { projectsRoot: group.repo, projectName: '新项目' });
  assert.equal(preview.workspacePath, path.join(group.repo, '新项目'));
  assert.equal(preview.exists, false);
  assert.equal(fs.existsSync(preview.workspacePath), false);
  assert.equal((await fetch(descriptor.url + '/api/groups')).status, 401);
  assert.equal((await fetch(descriptor.url + '/api/groups', { headers: { authorization: `Bearer ${descriptor.token}`, origin: 'https://untrusted.example' } })).status, 403);
  const body = { content: '测试共享页', origin: { adapter: 'shared-page', sessionId: group.id, messageId: 'input-1' } };
  await localFetch(descriptor, `/api/groups/${group.id}/input`, body);
  const repeated = await localFetch(descriptor, `/api/groups/${group.id}/input`, body); assert.equal(repeated.duplicate, true);
  assert.equal((await localFetch(descriptor, `/api/groups/${group.id}`)).requests[0].contentPreview, '测试共享页');
  assert.equal((await localFetch(descriptor, `/api/groups/${group.id}/messages`)).messages.length, 1);
  assert.match(await (await fetch(descriptor.url)).text(), /协作交流/);
});
test('Harness recovery binds plugin provenance and completed native turn; usage covers all model steps', () => {
  const id = randomUUID();
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'codex-group' }, content: [{ type: 'text', text: `[Group delivery ${id}]\nbody` }] } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'result' }] }, usage: { totalTokens: 12 } } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  assert.equal(recoveredHarnessResult(events, id).usage.totalTokens, 12);
  assert.equal(recoveredHarnessResult(events.slice(0, -1), id), null);
  assert.equal(recoveredHarnessResult(events, randomUUID()), null);
  events[1].data.source = { kind: 'user', rpcId: `group-${id}` };
  assert.equal(recoveredHarnessResult(events, id).text, 'result');
  events[1].data.source = { kind: 'user', rpcId: 'real-ui-input' };
  assert.equal(recoveredHarnessResult(events, id), null);
});
test('Harness desktop and web registrations cannot overwrite a group’s pinned profile', t => {
  const { store, group } = fixture(t); const rt = new GroupRuntime(store);
  rt.registerHarness({ adapterId: 'harness-desktop', protocol: 'codex-harness-group/v2', url: 'http://127.0.0.1:10001', token: 'd'.repeat(64) });
  rt.registerHarness({ adapterId: 'harness-web', protocol: 'codex-harness-group/v2', url: 'http://127.0.0.1:10002', token: 'w'.repeat(64) });
  group.harnessAdapterId = 'harness-desktop';
  assert.equal(rt.adapter(group).url, 'http://127.0.0.1:10001');
  rt.harnessAdapters.get('harness-desktop').at = 0;
  assert.equal(rt.adapter(group), null);
  assert.throws(() => rt.adapter({}), /legacy/);
  assert.throws(() => rt.registerHarness({ url: 'http://127.0.0.1:10003', token: 'x'.repeat(64) }), /stable profile/);
});
test('two coordinator instances share a durable lease and cannot dispatch the same demand concurrently', async t => {
  const { store, group, dir } = fixture(t); let began, finish;
  const started = new Promise(resolve => { began = resolve; });
  const rt = runtime(async () => { began(); await new Promise(resolve => { finish = resolve; }); return proposal('none'); });
  input(store, group); const first = new GroupEngine(store, rt); const otherStore = new GroupStore(path.join(dir, 'groups.sqlite'));
  try {
    const second = new GroupEngine(otherStore, rt); const pending = first.tick(group.id); await started;
    assert.equal(await second.tick(group.id), false); assert.equal(rt.calls.length, 1);
    finish(); await pending;
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM worker_leases').get().n, 0);
  } finally { otherStore.close(); }
});
test('human pause between availability and native admission cannot start a model turn', async t => {
  const { store, group } = fixture(t); let checked, finish; const ready = new Promise(resolve => { checked = resolve; });
  const rt = runtime(() => proposal('none')); rt.canTurn = async () => { checked(); await new Promise(resolve => { finish = resolve; }); return true; };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group); const pending = engine.tick(group.id); await ready;
  engine.control(group.id, 'pause'); finish(); await pending;
  assert.equal(rt.calls.length, 0); assert.equal(store.group(group.id).status, 'paused'); assert.equal(store.request(request.id).deliveryId, undefined);
});
test('verified native non-admission reuses its delivery ID; a mere transport failure never resets it', async t => {
  const { store, group } = fixture(t); let turnCalls = 0;
  const rt = { appOpen: async () => true, turn: async () => { turnCalls++; throw Error('connection failed'); }, recover: async () => ({ notAdmitted: true }) };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group); await engine.tick(group.id);
  let saved = store.request(request.id); const deliveryId = saved.deliveryId;
  assert.equal(store.delivery(deliveryId).started, true);
  store.transaction(() => { saved.nextRecoveryAt = 0; store.saveRequest(saved); }); await engine.tick(group.id);
  assert.equal(turnCalls, 1); assert.equal(store.delivery(deliveryId).started, false); assert.equal(store.request(request.id).deliveryId, deliveryId);
});
test('malformed native result preserves checkpoint and reports its shape instead of throwing a message-store error', async t => {
  const { store, group } = fixture(t); const rt = { appOpen: async () => true, turn: async () => ({ accepted: true }) };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group); await engine.tick(group.id);
  assert.equal(store.request(request.id).status, 'needs_recovery');
  assert.match(store.request(request.id).error, /fields=accepted/); assert.ok(store.request(request.id).deliveryId);
});
test('checkpoint settlement while paused reads native recovery without admitting another model turn', async t => {
  const { store, group } = fixture(t); let turns = 0;
  const rt = { appOpen: async () => true, turn: async () => { turns++; throw Error('lost receipt'); }, recover: async () => ({ text: JSON.stringify(proposal('none')), usage: null }) };
  const engine = new GroupEngine(store, rt); const { request } = input(store, group); await engine.tick(group.id); engine.control(group.id, 'pause');
  store.transaction(() => { const r = store.request(request.id); r.nextRecoveryAt = 0; store.saveRequest(r); });
  await engine.tick(group.id, { recoveryOnly: true });
  assert.equal(turns, 1); assert.equal(store.group(group.id).status, 'paused'); assert.equal(store.request(request.id).deliveryId, undefined);
});
test('HTTP update handshake drains without killing an owner PID and rejects shutdown before drain', async t => {
  const { store } = fixture(t); let shutdown = false;
  const service = await startGroupService({ store, runtime: {}, schedule: false, onShutdown: () => { shutdown = true; } });
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); });
  const health = await localFetch(service.descriptor, '/api/health'); assert.equal(health.protocol, 'codex-harness-group/v2'); assert.equal(health.buildHash.length, 64);
  await assert.rejects(localFetch(service.descriptor, '/api/admin/shutdown', {}), /Drain/);
  await localFetch(service.descriptor, '/api/admin/prepare-update', {}); await localFetch(service.descriptor, '/api/admin/shutdown', {});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(shutdown, true);
});

test('abandoned update drain expires and reports its real state instead of a fake peer wait', async t => {
  const {store,group}=fixture(t);let clock=1000;
  const service=await startGroupService({store,runtime:{},schedule:false,onShutdown:()=>{},now:()=>clock});
  t.after(async()=>{await new Promise(resolve=>service.server.close(resolve))});
  await localFetch(service.descriptor,'/api/admin/prepare-update',{});
  const snapshot=await localFetch(service.descriptor,`/api/groups/${group.id}`);
  assert.equal(snapshot.activity.members[0].label,'切换版本中');
  assert.equal((await localFetch(service.descriptor,'/api/health')).draining,true);
  clock+=45001;
  assert.equal((await localFetch(service.descriptor,'/api/health')).draining,false);
  assert.notEqual((await localFetch(service.descriptor,`/api/groups/${group.id}`)).activity.members[0].label,'切换版本中');
});

test('update preparation gates new work but does not abort an existing native turn or its approval signal',async t=>{
 const {store,group}=fixture(t);let started,finish,signal;const admitted=new Promise(r=>{started=r;});
 const rt={appOpen:async()=>true,turn:async(_g,_d,s)=>{signal=s;started();await new Promise(r=>{finish=r;});return{text:JSON.stringify(proposal('none'))};}};
 const service=await startGroupService({store,runtime:rt,schedule:false,onShutdown:()=>{}});t.after(async()=>new Promise(r=>service.server.close(r)));
 input(store,group);const turn=service.engine.tick(group.id);await admitted;
 const h=await localFetch(service.descriptor,'/api/admin/prepare-update',{});assert.equal(h.running,1);assert.equal(signal.aborted,false);
 await assert.rejects(localFetch(service.descriptor,'/api/admin/shutdown',{}),/checkpoint/);
 finish();await turn;assert.equal(signal.aborted,false);assert.equal((await localFetch(service.descriptor,'/api/health')).running,0);
});

test('correlated native work still running does not exhaust unknown-recovery budget or resend', async t=>{
  const {store,group}=fixture(t);let calls=0;
  const rt={appOpen:async()=>true,turn:async()=>{calls++;throw Error('poll released')},recover:async()=>({pending:true,turnId:'native'})};
  const engine=new GroupEngine(store,rt,{maxRecoveryAttempts:1});const first=input(store,group);await engine.tick(group.id);
  for(let i=0;i<3;i++){
    store.transaction(()=>{const r=store.request(first.request.id);delete r.nextRecoveryAt;store.saveRequest(r)});
    await engine.tick(group.id);
    assert.equal(store.request(first.request.id).status,'needs_recovery');
  }
  assert.equal(calls,1);assert.equal(store.delivery(store.request(first.request.id).deliveryId).recoveryAttempts,0);
});
test('safe update waits for in-flight native context initialization, not only model workers', async t => {
  const { store } = fixture(t); let began, finish; const started = new Promise(resolve => { began = resolve; });
  const service = await startGroupService({ store, runtime: { create: async () => { began(); await new Promise(resolve => { finish = resolve; }); return { id: 'setup-complete' }; } }, schedule: false, onShutdown: () => {} });
  t.after(async () => { await new Promise(resolve => service.server.close(resolve)); });
  const setup = localFetch(service.descriptor, '/api/groups', {}); await started;
  assert.equal((await localFetch(service.descriptor, '/api/admin/prepare-update', {})).running, 1);
  await assert.rejects(localFetch(service.descriptor, '/api/admin/shutdown', {}), /checkpoint/);
  finish(); await setup;
  assert.equal((await localFetch(service.descriptor, '/api/health')).running, 0);
});
test('immediate supplements attach to a queued requirement before its first model admission', t => {
  const { store, group } = fixture(t); const first = input(store, group);
  const added = input(store, group, '补充：追加验收条件', { mode: 'supplement' });
  assert.equal(added.request.id, first.request.id); assert.equal(store.requests(group.id).length, 1);
});
test('bearer comparisons handle non-ASCII invalid input without a crypto length exception', () => {
  assert.equal(equalSecret('é', 'x'), false); assert.equal(equalSecret('token', 'token'), true);
});
test('real companion HTTP and pre-step route host-native prompt IDs without importing a foreign message factory', async t => {
  const { store, group, dir } = fixture(t);
  group.harnessAdapterId = 'harness-desktop'; store.transaction(() => store.save(group));
  const first = input(store, group); const delivery = { id: randomUUID(), groupId: group.id, requestId: first.request.id, member: 'harness', phase: 'planning', prompt: 'native protocol fixture', started: true, status: 'pending' };
  store.transaction(() => store.saveDelivery(delivery));
  const rt = new GroupRuntime(store);
  const descriptorFile = path.join(dir, 'group-service.json');
  const hub = await startGroupService({ store, runtime: rt, schedule: false, descriptorFile });
  const listeners = new Map(), effects = [], events = [], renamed = []; let prompts = 0;
  const agent = { id: 'ht', status: 'idle', inbox: { nextTurn: [], nextStep: [] }, session: {}, ctx: { parallel: async () => {} }, whenIdle: async () => {}, cancel: () => {} };
  const ctx = {
    on(event, handler) { const list = listeners.get(event) ?? []; list.push(handler); listeners.set(event, list); },
    effect(factory) { effects.push(factory()); }, webServer: { register: () => () => {} },
    agents: { get: () => agent }, permissionPresets: { set: () => {} },
    sessionController: {
      async rename(request) { renamed.push(request); return { title: request.title, seq: 1 }; },
      resolveAgent: async () => ({ agent }), inspect: async () => ({ events }),
      async prompt(request, signal) {
        assert.ok(signal instanceof AbortSignal);
        signal.throwIfAborted();
        prompts++;
        assert.equal(request.requestId, `group-${delivery.id}`);
        const message = { id: 'native-host-minted-id', role: 'user', content: request.content, source: { kind: 'user', rpcId: request.requestId } };
        const decision = await listeners.get('agent/pre-step')[0]({ agent, messages: [message], signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [message] }));
        assert.equal(decision.kind, 'enter');
        const approval = await listeners.get('approval/request')[0]({ agent, callId: 'missing-native-call', toolName: 'pwsh' }, () => { throw Error('Bound delivery must use its verified relay'); });
        assert.equal(approval, 'unavailable');
        events.push({ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: message },
          { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify(proposal('none')) }] }, usage: { totalTokens: 7 } } },
          { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
        return { accepted: true };
      },
    },
  };
  try {
    await applyCompanion(ctx, { descriptorFile, adapterId: 'harness-desktop', dshInstallRoot: path.join(dir, 'must-not-import-foreign-sdk') });
    assert.deepEqual(renamed, [{ sessionId: 'ht', title: groupSessionTitle(group, 'harness') }]);
    const adapter = rt.adapter(group);
    const body = { sessionId: 'ht', delivery, model: group.models.harness };
    const firstReply = await localFetch(adapter, '/turn', body); assert.equal(firstReply.usage.totalTokens, 7);
    const diagnostic = await localFetch(adapter, '/diagnostics', { sessionId: 'ht' });
    assert.equal(diagnostic.permissionRelay.state, 'unavailable');
    assert.match(diagnostic.permissionRelay.error, /尚未找到对应模型工具调用/);
    assert.equal(store.permissions(group.id).length, 0);
    const recovered = await localFetch(adapter, '/turn', body); assert.equal(recovered.text, firstReply.text); assert.equal(prompts, 1);
    const genuine = { id: 'real-native-input', role: 'user', source: { kind: 'user', rpcId: 'ui-generated-id' }, content: [{ type: 'text', text: '补充：只校验输入接管' }] };
    const routed = await listeners.get('agent/pre-step')[0]({ agent, messages: [genuine], signal: new AbortController().signal }, async () => { throw Error('Native execution must not continue.'); });
    assert.equal(routed.kind, 'reject'); assert.equal(prompts, 1);
    assert.equal(store.request(first.request.id).supplements.length, 1);
    assert.equal(store.group(group.id).capabilities.harnessNative, 'input_observed');
  } finally {
    for (const handler of listeners.get('dispose') ?? []) handler(); for (const dispose of effects) dispose?.();
    await hub.close();
  }
});
test('private group baseline includes current dirty and untracked code while preserving main HEAD and staged content', t => {
  const { dir } = fixture(t); const repo = path.join(dir, 'project'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@localhost']);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'HEAD version\n'); git(['add', '.']); git(['commit', '-m', 'fixture baseline']);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'staged version\n'); git(['add', '.']);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'current working version\n'); fs.writeFileSync(path.join(repo, 'new.mjs'), 'export const feature = true;\n');
  const head = git(['rev-parse', 'HEAD']); const staged = git(['show', ':code.txt']);
  const captured = captureProjectSnapshot(repo, path.join(dir, 'private-indexes'));
  assert.equal(captured.dirty, true); assert.equal(git(['rev-parse', 'HEAD']), head); assert.equal(git(['show', ':code.txt']), staged);
  assert.equal(git(['show', `${captured.commit}:code.txt`]), 'current working version');
  assert.match(git(['show', `${captured.commit}:new.mjs`]), /feature = true/);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'private-indexes')), []);
});


test('review changes request returns findings to executor then re-reviews before integration', async t => {
 const {store,group}=fixture(t);let reviews=0;
 const rt=runtime((_g,d)=>d.phase==='planning'?{...proposal(),review:true}:d.phase==='review'&&++reviews===1?{...done,status:'changes_requested',message:'Add missing regression test'}:done);
 const engine=new GroupEngine(store,rt);const {request}=input(store,group);
 for(let i=0;i<8;i++)await engine.tick(group.id);
 assert.equal(store.request(request.id).status,'completed');
 assert.deepEqual(rt.calls.slice(2).map(c=>c.delivery.phase),['work','review','work','review','integrate']);
 const repair=JSON.parse(rt.calls[4].delivery.text ?? rt.calls[4].delivery.prompt);assert.match(JSON.stringify(repair),/Add missing regression test/);
});
test('review repairs are bounded and a genuine blocked review never starts repair', async t => {
 for(const status of ['changes_requested','blocked']){
 const {store,group}=fixture(t);const rt=runtime((_g,d)=>d.phase==='planning'?{...proposal(),review:true}:d.phase==='review'?{...done,status,message:'review findings'}:done);
 const engine=new GroupEngine(store,rt);const {request}=input(store,group);
 for(let i=0;i<14;i++)await engine.tick(group.id);
 const r=store.request(request.id);assert.equal(r.status,status==='blocked'?'blocked':'needs_decision');
 assert.equal(rt.calls.filter(c=>c.delivery.phase==='work').length,status==='blocked'?1:3);
 assert.equal(rt.calls.filter(c=>c.delivery.phase==='integrate').length,0);
 }
});


test('integration accepts source CRLF conversion, records actual bytes and rejects changed content', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-eol-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'main'),peer=path.join(dir,'peer');fs.mkdirSync(repo);
 const g=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
 g('init');fs.writeFileSync(path.join(repo,'file.mjs'),'old\n');g('add','.');g('-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base');
 const commit=g('rev-parse','HEAD').toString().trim();g('worktree','add','--detach',peer,commit);
 const group={repo,baseline:{commit},worktrees:{codex:peer}};
 fs.writeFileSync(path.join(peer,'file.mjs'),'new\r\n');const check=integrationPreflight(group);
 fs.writeFileSync(path.join(repo,'file.mjs'),'new\n');const actual=verifyIntegration(repo,check);
 assert.notEqual(actual['file.mjs'],check.expected['file.mjs']);
 assert.doesNotThrow(()=>integrationPreflight(group));
 group.integrationState={main:actual,peers:check.peers};fs.writeFileSync(path.join(peer,'file.mjs'),'next\r\n');assert.doesNotThrow(()=>integrationPreflight(group));
 fs.writeFileSync(path.join(repo,'file.mjs'),'changed\n');assert.throws(()=>verifyIntegration(repo,check),/verification failed/);
 fs.writeFileSync(path.join(repo,'file.mjs'),'new \n');assert.throws(()=>verifyIntegration(repo,check),/verification failed/);
});


test('human scoped integration consent pins both versions, preserves unrelated files and expires', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'integration-consent-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const repo=path.join(dir,'main'),peer=path.join(dir,'peer');fs.mkdirSync(repo);
 const g=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});g('init');fs.writeFileSync(path.join(repo,'file'),'base');fs.writeFileSync(path.join(repo,'other'),'keep');g('add','.');g('-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base');const commit=g('rev-parse','HEAD').toString().trim();g('worktree','add','--detach',peer,commit);
 const group={repo,baseline:{commit},worktrees:{codex:peer}};fs.writeFileSync(path.join(repo,'file'),'human');fs.writeFileSync(path.join(peer,'file'),'candidate');fs.writeFileSync(path.join(peer,'other'),'unrelated old work');
 assert.throws(()=>integrationPreflight(group),{reason:'main_conflict'});
 const consent=captureIntegrationConsent(group,{member:'codex',files:['file'],requestId:'r',revision:1,sourceMessageId:'h'});
 const check=integrationPreflight(group,consent);assert.deepEqual(Object.keys(check.expected),['file']);assert.equal(check.peers.codex.other,undefined);
 assert.throws(()=>integrationPreflight(group,{...consent,expiresAt:0}),{reason:'consent_expired'});
 fs.writeFileSync(path.join(repo,'file'),'new human');assert.throws(()=>integrationPreflight(group,consent),{reason:'consent_files_changed'});fs.writeFileSync(path.join(repo,'file'),'human');
 fs.writeFileSync(path.join(peer,'file'),'changed candidate');assert.throws(()=>integrationPreflight(group,consent),{reason:'consent_files_changed'});fs.writeFileSync(path.join(peer,'file'),'candidate');
 fs.copyFileSync(path.join(peer,'file'),path.join(repo,'file'));verifyIntegration(repo,check);fs.writeFileSync(path.join(repo,'other'),'lost');assert.throws(()=>verifyIntegration(repo,check),/verification failed/);
});

test('integration consent requires an explicit current human supplement and no pending delivery', t => {
 const {store,group}=fixture(t);const {request}=input(store,group);const human=input(store,group,'直接覆盖',{mode:'supplement',requestId:request.id}).message;
 store.transaction(()=>{const r=store.request(request.id);r.status='blocked';r.actions=[{phase:'integrate',member:'codex'}];r.agreement={integrator:'codex'};store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;store.save(g)});
 const engine=new GroupEngine(store,{}),options={requestId:request.id,sourceMessageId:human.id,files:['file']};
 assert.doesNotThrow(()=>engine.authorizeIntegration(group.id,options));
 const peer=store.message(group.id,{sender:'harness',channel:'collaboration',requestId:request.id,content:'直接覆盖'});assert.throws(()=>engine.authorizeIntegration(group.id,{...options,sourceMessageId:peer.id}),/human/);
 store.transaction(()=>{const r=store.request(request.id);r.deliveryId='pending';store.saveRequest(r)});assert.throws(()=>engine.authorizeIntegration(group.id,options),/in-flight/);
});


test('human reply inspection resets exhausted read budget, never dispatches a model and remains paused',async t=>{
 const {store,group}=fixture(t);let turns=0,reads=0;
 const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{turns++;throw Error('lost')},recover:async()=>{reads++;return {text:JSON.stringify(proposal('none'))}}});
 const {request}=input(store,group);await engine.tick(group.id);
 store.transaction(()=>{const r=store.request(request.id),d=store.delivery(r.deliveryId);d.recoveryAttempts=5;store.saveDelivery(d);r.status='needs_decision';r.hardTokenLimit=1;store.saveRequest(r)});
 const result=await engine.inspectReply(group.id);assert.equal(result.inspected,true);assert.equal(turns,1);assert.equal(reads,1);assert.equal(store.group(group.id).status,'paused');assert.equal(store.request(request.id).deliveryId,undefined);
 await engine.inspectReply(group.id);assert.equal(turns,1);assert.equal(reads,1);
});


test('explicit human integrate stage verifies readiness before integration and never grants wider scope',async t=>{
 const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?proposal():{...done,integrationFiles:[]}),engine=new GroupEngine(store,rt);const {request}=input(store,group,'直接进入integrate');
 for(let i=0;i<4;i++)await engine.tick(group.id);
 assert.deepEqual(rt.calls.map(c=>c.delivery.phase),['planning','planning','review','integrate']);assert.equal(store.request(request.id).status,'completed');
});
test('peer integrate shortcut without a human stage instruction cannot skip implementation',async t=>{
 const {store,group}=fixture(t),rt=runtime((_g,d)=>d.phase==='planning'?({...proposal(),startPhase:'integrate'}):d.phase==='review'?({...done,status:'changes_requested',message:'尚未实现功能，需要先实现'}):done),engine=new GroupEngine(store,rt);const {request}=input(store,group,'implement feature');
 for(let i=0;i<4;i++)await engine.tick(group.id);
 assert.equal(store.request(request.id).status,'active');assert.equal(rt.calls.filter(c=>c.delivery.phase==='integrate').length,0);assert.ok(rt.calls.some(c=>c.delivery.phase==='work'));
});
test('legacy phase mismatch repairs its queue once but permissions and unknown failures stay blocked',async t=>{
 for(const reason of ['当前阻塞是调度阶段不匹配','需要权限','未知错误']){
 const {store,group}=fixture(t),rt=runtime(()=>done),engine=new GroupEngine(store,rt),{request}=input(store,group,'直接进入integrate');
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{status:'awaiting_review',phase:'execution',plans:{codex:proposal(),harness:proposal()},agreement:{owner:'codex',integrator:'codex',review:false,tasks:{codex:'integrate'}},actions:[{phase:'integrate',member:'codex'}],deferred:[{phase:'work',member:'codex',why:'blocked'}],results:{'work:codex':{status:'blocked',summary:reason,messageId:'old'}}});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;store.save(g)});
 await engine.tick(group.id);const r=store.request(request.id);
 if(reason.includes('阶段')){assert.equal(r.status,'completed');assert.equal(r.scheduleRepairs.length,1);assert.equal(r.results['work:codex'].status,'blocked');assert.equal(rt.calls[0].delivery.phase,'integrate')}
 else {assert.equal(rt.calls.length,0);assert.equal(r.status,'awaiting_review')}
 }
});


test('idle supplements report a readable missing-task error instead of binding undefined to SQLite',t=>{
 const {store,group}=fixture(t);
 assert.throws(()=>input(store,group,'follow up',{mode:'supplement'}),/当前没有可补充的任务/);
 assert.equal(store.requests(group.id).length,0);
 for(const method of ['request','delivery','permission','messageById']){assert.equal(store[method](undefined),null);assert.equal(store[method](null),null);assert.throws(()=>store[method]({id:'bad'}),/编号/)}
});


test('status and UI diagnosis queries preserve revision, division, results and scoped consent',t=>{
 const {store,group}=fixture(t),{request}=input(store,group,'直接进入 integrate');
 store.transaction(()=>{const r=store.request(request.id);Object.assign(r,{revision:2,status:'blocked',plans:{codex:proposal(),harness:proposal()},actions:[{phase:'integrate',member:'codex'}],results:{'work:codex':{status:'done'}},integrationConsent:{revision:2,marker:'retain'}});store.saveRequest(r);const g=store.group(group.id);g.activeRequestId=r.id;store.save(g)});
 const before=store.request(request.id);const q=input(store,group,'补充：请先排查当前受阻原因，用通俗中文说明卡在哪一步、由谁处理、有哪些选项及推荐方案；能在现有授权内解决的继续处理，需要额外权限则列出具体操作。不要重复执行结果未知的操作。',{mode:'auto'});
 assert.equal(q.progressOnly,true);assert.equal(store.request(request.id).revision,2);assert.deepEqual(store.request(request.id).integrationConsent,before.integrationConsent);assert.deepEqual(store.request(request.id).plans,before.plans);assert.deepEqual(store.request(request.id).results,before.results);
 assert.equal(input(store,group,'目前的情况',{mode:'auto'}).progressOnly,true);
 input(store,group,'新增功能',{mode:'supplement'});assert.equal(store.request(request.id).revision,3);assert.equal(store.request(request.id).integrationConsent,undefined);
});
test('human integration intent survives neutral legacy messages but a changed requirement revokes it',t=>{
 const {store,group}=fixture(t),{request}=input(store,group,'直接进入 integrate');const e=new GroupEngine(store,{});
 input(store,group,'目前的情况',{mode:'supplement',requestId:request.id});assert.equal(e.humanRequestedIntegration(store.request(request.id)),true);
 input(store,group,'直接覆盖',{mode:'supplement',requestId:request.id});assert.equal(e.humanRequestedIntegration(store.request(request.id)),true);
 input(store,group,'不要整合，先修改交互',{mode:'supplement',requestId:request.id});assert.equal(e.humanRequestedIntegration(store.request(request.id)),false);
});


test('HTTP progress query never aborts an admitted operation and retries stay read-only',async t=>{
 const {store,group}=fixture(t),{request}=input(store,group);store.transaction(()=>{const g=store.group(group.id);g.activeRequestId=request.id;store.save(g)});
 const service=await startGroupService({store,runtime:{},schedule:false});t.after(async()=>{service.engine.running.delete(group.id);service.server.closeIdleConnections();await new Promise(resolve=>service.server.close(resolve))});const controller=new AbortController();service.engine.running.set(group.id,controller);
 const body={mode:'auto',content:'目前的情况',origin:{adapter:'test',sessionId:'s',messageId:'status-once'}};
 const first=await localFetch(service.descriptor,'/api/groups/'+group.id+'/input',body);assert.equal(first.progressOnly,true);assert.equal(controller.signal.aborted,false);
 const again=await localFetch(service.descriptor,'/api/groups/'+group.id+'/input',body);assert.equal(again.duplicate,true);assert.equal(again.progressOnly,true);assert.equal(controller.signal.aborted,false);assert.equal(store.request(request.id).revision,0);service.engine.running.delete(group.id);
});


test('known native failure settles checkpoint without resetting completed work or auto-retrying',async t=>{
 const {store,group}=fixture(t);let failures=0;
 const rt=runtime((_g,d)=>d.phase==='planning'?{...proposal(),review:true}:done);
 const engine=new GroupEngine(store,rt),{request}=input(store,group);await engine.tick(group.id);await engine.tick(group.id);await engine.tick(group.id);
 rt.turn=async()=>{failures++;return {text:'Codex 额度不足',usage:null,interrupted:true,turnId:'failed-turn',nativeFailure:{kind:'usage_limit',message:'usage limit'}}};
 await engine.tick(group.id);let r=store.request(request.id);assert.equal(r.status,'blocked');assert.equal(r.phase,'execution');assert.equal(r.results['work:codex'].status,'done');assert.equal(r.actions[0].phase,'review');assert.equal(r.deliveryId,undefined);assert.equal(r.nativeFailure.kind,'usage_limit');
 await engine.tick(group.id);assert.equal(failures,1);engine.control(group.id,'retry');rt.turn=async()=>({text:JSON.stringify(done)});await engine.tick(group.id);assert.equal(store.request(request.id).results['review:harness'].status,'done');
});


test('frontend hot reload preserves worker, running delivery and legacy compatibility',async t=>{
 const {store,group,dir}=fixture(t),file=path.join(dir,'page.html');fs.writeFileSync(file,'<html>FIRST</html>');
 const service=await startGroupService({store,runtime:{},schedule:false,htmlFile:file});t.after(async()=>{service.engine.running.delete(group.id);service.server.closeIdleConnections();await new Promise(resolve=>service.server.close(resolve))});
 const controller=new AbortController();service.engine.running.set(group.id,controller);const a=await localFetch(service.descriptor,'/api/health');
 fs.writeFileSync(file,'<html>SECOND</html>');assert.match(await(await fetch(service.descriptor.url)).text(),/SECOND/);const b=await localFetch(service.descriptor,'/api/health');
 assert.equal(a.pid,b.pid);assert.equal(a.runtimeHash,b.runtimeHash);assert.notEqual(a.frontendHash,b.frontendHash);assert.notEqual(a.buildHash,b.buildHash);assert.equal(b.draining,false);assert.equal(controller.signal.aborted,false);
 const {serviceBuildMatches}=await import('../src/group-client.mjs');assert.equal(serviceBuildMatches(b),true);assert.equal(serviceBuildMatches({...b,runtimeHash:'wrong'}),false);
 fs.writeFileSync(file,'<html>incomplete');assert.match(await(await fetch(service.descriptor.url)).text(),/SECOND/);assert.match((await localFetch(service.descriptor,'/api/health')).frontendError,/未写入完整/);
});


test('goal continuation routes member-specific proof to that member without mixing executors or grants',async t=>{
 const {store,group}=fixture(t);const {request}=input(store,group,'全部完成前不要停',{goalRequirements:['Harness实际执行','Codex后续实现']});
 const r=store.request(request.id);r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'old',harness:'review'}};r.goal.history=[];
 const e=new GroupEngine(store,{});const audit={status:'done',completionChecklist:[{id:'R01',title:'Harness实际执行',status:'pending',executor:'harness',evidence:[],task:'在自己的工作树执行UTF8项目命令'},{id:'R02',title:'Codex后续实现',status:'pending',executor:'codex',evidence:[],task:'Codex自己的任务'}]};
 e.finishGoalAudit(group,r,audit,'audit');
 assert.equal(r.actions[0].member,'harness');assert.equal(r.agreement.owner,'harness');assert.equal(r.agreement.integrator,'harness');assert.equal(r.actions[1].member,'codex');
 assert.match(r.actions[0].task,/UTF8项目命令/);assert.doesNotMatch(r.actions[0].task,/Codex自己的任务/);assert.equal(r.actions[2].member,'harness');assert.equal(r.integrationConsent,undefined);
 assert.equal(r.goal.checklist.length,2);assert.equal(r.goal.checklist[1].status,'pending');assert.deepEqual(group.contexts,{codex:'ct',harness:'ht'});
});
test('goal continuation rejects an unknown executor instead of dispatching outside the group',t=>{
 const {store,group}=fixture(t);const {request}=input(store,group,'全部完成前不要停',{goalRequirements:['执行']});const r=store.request(request.id),e=new GroupEngine(store,{});
 e.finishGoalAudit(group,r,{status:'done',completionChecklist:[{id:'R01',title:'执行',status:'pending',executor:'admin',evidence:[],task:'execute'}]},'audit');
 assert.equal(r.status,'blocked');assert.match(r.error,/验收清单/);assert.equal(r.goal.cycles,0);
});
