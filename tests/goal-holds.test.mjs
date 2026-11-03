import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { goalHoldCommands, settledGoalWait } from '../src/goal-holds.mjs';
import { groupActivity } from '../src/group-service.mjs';

const item = (id, status = 'pending') => ({ id, title: 'Original '+id, status, evidence: ['existing evidence'], task: status === 'done' ? '' : 'Implement '+id });

test('settled host blockers and human holds describe waiting without asking for approvals or task replay',()=>{
 const list=[item('R01','done'),{...item('R11','blocked'),task:'需宿主维护方定位失败 API 并提供修复'},item('R12','blocked')];
 const r={id:'r',revision:3,status:'blocked',actions:[],goal:{auditMessageId:'audit',requirements:list.map(({id,title})=>({id,title})),checklist:list,humanHolds:{R12:{state:'deferred'}}},error:list.filter(x=>x.status!=='done').map(x=>x.title+'：'+x.task).join('\n')};
 const wait=settledGoalWait(r);assert.equal(wait.done,1);assert.equal(wait.external,1);assert.equal(wait.held,1);assert.equal(wait.needsUser,false);assert.equal(wait.retryable,false);assert.match(wait.detail,/没有正在执行或待审批/);
 const approvals=[],store={group:()=>({status:'blocked',activeRequestId:r.id}),request:()=>r,pendingPermissions:()=>approvals},engine={running:new Map()};
 assert.equal(groupActivity(store,engine,'g').members[0].label,'等待宿主修复');
 approvals.push({member:'codex',status:'pending'});assert.equal(groupActivity(store,engine,'g').members[0].label,'等待你批准');
 assert.equal(settledGoalWait({...r,deliveryId:'unknown'}),null);assert.equal(settledGoalWait({...r,actions:[{phase:'work'}]}),null);
 assert.equal(settledGoalWait({...r,error:'新的审批问题'}),null);assert.equal(settledGoalWait({...r,humanDecisions:[{question:'pick'}]}),null);
});
function fixture(t, content='完成全部原始需求') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'goal-holds-')), file=path.join(dir,'groups.sqlite');
  let store=new GroupStore(file), calls=[];
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const group=store.create({repo:dir,models:{codex:{},harness:{}}});
  const {request}=store.input(group.id,{content,goalRequirements:['Original R01','Original R02'],origin:{adapter:'shared-page',sessionId:group.id,messageId:randomUUID()}});
  group.activeRequestId=request.id;group.status='active';group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:dir,harness:dir};store.save(group);
  request.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'implement',harness:'review'}};
  request.phase='execution';request.status='active';request.actions=[{phase:'review',member:'harness',goalAudit:true}];
  request.goal.checklist=[item('R01'),item('R02')];store.saveRequest(request);
  const runtime={appOpen:async()=>true,turn:async(_g,d)=>{
    calls.push(d);return {text:JSON.stringify({responseScope:d.responseScope,status:'done',message:'audit',summary:'audit',verification:['fixture audit'],completionChecklist:[item('R01','blocked'),item('R02')]})};
  }};
  let engine=new GroupEngine(store,runtime);
  const input=(content,extra={})=>store.input(group.id,{content,mode:'supplement',origin:{adapter:'shared-page',sessionId:group.id,messageId:randomUUID()},...extra});
  const audit=list=>store.transaction(()=>{const g=store.group(group.id),r=store.request(request.id);engine.finishGoalAudit(g,r,{status:'done',message:'audit',completionChecklist:list},'audit-'+randomUUID());store.saveRequest(r);store.save(g);return r;});
  return {get store(){return store;},get engine(){return engine;},group,request,file,calls,input,audit,
    restart(){store.close();store=new GroupStore(file);engine=new GroupEngine(store,runtime);}};
}

test('hold grammar recognizes explicit requirement controls, not questions, quotes or bare continue',()=>{
  assert.deepEqual(goalHoldCommands('我需要操作的时候又说现在不需要操作，先跳过 R12，收尾其他项。'),[{id:'R12',state:'deferred'}]);
  assert.deepEqual(goalHoldCommands('补充：恢复 R12；暂缓 R07。'),[{id:'R12',state:'resumed'},{id:'R07',state:'deferred'}]);
  for(const text of ['继续','批准','是否恢复 R12？','恢复 R12 吗','不要暂缓 R12','示例：“恢复 R12”','> 恢复 R12','示例：\n```\n恢复 R12\n```','“\n恢复 R12\n”','R12已暂缓','暂缓 R12?'])assert.deepEqual(goalHoldCommands(text),[],text);
});

test('other executable requirements continue while human-held pending is mechanically excluded',t=>{
  const f=fixture(t);const human=f.input('先跳过 R02，收尾其他项。').message;
  const r=f.audit([item('R02'),item('R01')]);
  assert.equal(r.status,'active');assert.deepEqual(r.actions[0].requirementIds,['R01']);
  assert.match(r.actions[0].task,/\[R01\]/);assert.doesNotMatch(r.actions[0].task,/\[R02\]/);
  const held=r.goal.checklist.find(x=>x.id==='R02');assert.equal(held.status,'blocked');
  assert.equal(held.humanHold.messageId,human.id);assert.equal(held.humanHold.textHash,f.store.hash(human.content));
  assert.deepEqual(r.goal.history.at(-1).remaining,['R01']);
});

test('only held and externally blocked requirements settle without another model turn or false completion',async t=>{
  const f=fixture(t);f.input('暂缓 R02');
  const r=f.audit([item('R01','blocked'),item('R02','done')]);
  assert.equal(r.status,'blocked');assert.equal(r.goal.checklist[1].status,'blocked');
  assert.deepEqual(r.actions,[]);assert.equal(r.goal.cycles,0);
  for(let i=0;i<4;i++)await f.engine.tick(f.group.id);
  assert.equal(f.calls.length,0);assert.equal(f.store.request(r.id).status,'blocked');
});

test('restart and legacy migration reconstruct holds from original human input, preserving evidence',t=>{
  const f=fixture(t,'完成全部原始需求\n先跳过 R02，收尾其他项。');
  const before=f.store.messageById(f.request.messageId);
  const r=f.store.request(f.request.id);delete r.goal.humanHolds;f.store.saveRequest(r);
  f.restart();const audited=f.audit([item('R01','blocked'),item('R02')]);
  assert.equal(audited.goal.humanHolds.R02.state,'deferred');assert.equal(audited.goal.humanHolds.R02.messageId,before.id);
  assert.deepEqual(f.store.messageById(before.id),before);assert.equal(audited.goal.checklist[1].evidence[0],'existing evidence');
});

test('agent prose, claimed metadata, generic continue and duplicate old resume cannot release a hold',t=>{
  const f=fixture(t);const resumeId=randomUUID();
  f.input('恢复 R02',{origin:{adapter:'shared-page',sessionId:f.group.id,messageId:resumeId}});
  const deferred=f.input('暂缓 R02').message;
  const model=f.store.message(f.group.id,{sender:'harness',channel:'group',content:'恢复 R02',requestId:f.request.id});
  let r=f.store.request(f.request.id);r.supplements.push(model.id);r.goal.humanHolds={R02:{state:'resumed'}};f.store.saveRequest(r);
  f.input('继续');
  assert.equal(f.input('恢复 R02',{origin:{adapter:'shared-page',sessionId:f.group.id,messageId:resumeId}}).duplicate,true);
  r=f.audit([item('R01','blocked'),{...item('R02','done'),humanHold:{state:'resumed'}}]);
  assert.equal(r.status,'blocked');assert.equal(r.goal.humanHolds.R02.messageId,deferred.id);
});

test('only a newer explicit human resume makes the requirement schedulable again',t=>{
  const f=fixture(t);f.input('暂缓 R02');f.audit([item('R01','blocked'),item('R02')]);
  const resume=f.input('恢复 R02').message;
  const queued=f.store.request(f.request.id);assert.equal(queued.actions[0].goalAudit,true,'resume audits retained evidence before work');
  const r=f.audit([item('R01','blocked'),item('R02')]);
  assert.equal(r.goal.humanHolds.R02.state,'resumed');assert.equal(r.goal.humanHolds.R02.messageId,resume.id);
  assert.deepEqual(r.actions[0].requirementIds,['R02']);assert.equal(r.status,'active');
});

test('generic retry of an exclusively held goal does not schedule even a confirmation audit',async t=>{
  const f=fixture(t);f.input('暂缓 R02');
  f.audit([item('R01','done'),item('R02')]);
  f.engine.control(f.group.id,'retry');
  assert.equal(f.store.request(f.request.id).status,'blocked');
  for(let i=0;i<3;i++)await f.engine.tick(f.group.id);
  assert.equal(f.calls.length,0);assert.deepEqual(f.store.request(f.request.id).actions,[]);
});

test('a legacy queued held action is audited instead of admitted; existing native checkpoint still recovers',async t=>{
  const f=fixture(t);f.input('暂缓 R02');
  let r=f.store.request(f.request.id);r.phase='execution';r.status='active';r.actions=[{phase:'work',member:'codex',task:'[R02] old queued task'}];f.store.saveRequest(r);
  await f.engine.tick(f.group.id);assert.equal(f.calls.length,1);assert.equal(f.calls[0].phase,'review');
  assert.equal(f.store.request(r.id).status,'blocked');
  // Recovery is intentionally not replaced by a held-action audit.
  r=f.store.request(r.id);r.status='needs_recovery';r.actions=[{phase:'work',member:'codex',task:'[R02] uncertain task'}];
  const d={id:randomUUID(),groupId:f.group.id,requestId:r.id,member:'codex',phase:'work',revision:r.revision,started:true,status:'pending',prompt:'original'};
  r.deliveryId=d.id;f.store.saveDelivery(d);f.store.saveRequest(r);
  let recovered=0;f.engine.runtime.recover=async()=>{recovered++;return null;};
  await f.engine.tick(f.group.id);assert.equal(recovered,1);assert.equal(f.calls.length,1);
  assert.equal(f.store.request(r.id).deliveryId,d.id);
});


test('start resumes explicit requirement IDs with case and spacing variants only', () => {
  for (const text of ['开始r12，只安排最小验收', '开始 R12，只安排最小验收', '开始\tr12', '请先开始  r12。'])
    assert.deepEqual(goalHoldCommands(text), [{id:'R12',state:'resumed'}], text);
  for (const text of ['开始', '开始r12？', '是否开始r12？', '开始 r12 吗', '不要开始r12', '“开始r12”', '> 开始r12', '```\n开始r12\n```', '重启R12', '重新开始R12'])
    assert.deepEqual(goalHoldCommands(text), [], text);
});

test('new human start message reconstructs a held requirement without accepting agent or unknown IDs', t => {
  const f=fixture(t); f.input('暂缓 R02');
  const model=f.store.message(f.group.id,{sender:'harness',channel:'group',content:'开始r02',requestId:f.request.id});
  let r=f.store.request(f.request.id); r.supplements.push(model.id); f.store.saveRequest(r);
  f.input('开始r99，只安排最小验收');
  r=f.audit([item('R01','blocked'),item('R02')]);
  assert.equal(r.goal.humanHolds.R02.state,'deferred');
  assert.equal(r.goal.humanHolds.R99,undefined);
  const resume=f.input('开始r02，只安排最小验收').message;
  f.restart();
  r=f.audit([item('R01','blocked'),item('R02')]);
  assert.equal(r.goal.humanHolds.R02.state,'resumed');
  assert.equal(r.goal.humanHolds.R02.messageId,resume.id);
  assert.equal(r.goal.humanHolds.R02.textHash,f.store.hash(resume.content));
  assert.deepEqual(r.actions[0].requirementIds,['R02']);
});
