import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {groupActivity} from '../src/group-service.mjs';
const response=(status,extra={})=>({status,message:'具体证据与下一步',summary:'有依据',verification:['当前检查结果'],...extra});
function fixture(t){
 const store=new GroupStore(':memory:');t.after(()=>store.close());const group=store.create({repo:process.cwd(),models:{codex:{},harness:{}}});group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:process.cwd(),harness:process.cwd()};group.status='awaiting_review';
 const {request}=store.input(group.id,{content:'完成真实内容入口的验收'});group.activeRequestId=request.id;store.save(group);request.status='awaiting_review';request.phase='execution';request.agreement={owner:'both',integrator:'codex',review:true};request.actions=[{phase:'work',member:'harness',task:'独立验收'},{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}];request.deferred=[{phase:'work',member:'codex',task:'补齐样本证据',why:'blocked',reason:'代码和测试已完成，样本证据不足；你现在不需要操作'}];request.results={'work:codex':{status:'blocked',messageId:'saved-code',needsUser:false}};store.saveRequest(request);return{store,group,request};
}
test('no-human-action blocker gets independent triage and resumes only unfinished work',async t=>{
 const f=fixture(t),calls=[];const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{const p=JSON.parse(d.prompt);calls.push({member:d.member,phase:d.phase,p});return{text:JSON.stringify(response(p.assignment.blockerTriage?'changes_requested':'done'))};}});
 await e.tick(f.group.id);assert.equal(calls[0].phase,'review');assert.equal(calls[0].member,'harness');assert.match(calls[0].p.instruction,/不能返回done/);
 let r=f.store.request(f.request.id);assert.equal(r.actions[0].member,'codex');assert.ok(r.actions[0].blockedRecovery);assert.equal(r.deferred.length,0);
 await e.tick(f.group.id);r=f.store.request(r.id);assert.equal(calls[1].phase,'work');assert.match(calls[1].p.instruction,/仅补齐未完成项/);assert.equal(r.status,'active');assert.ok(r.actions.some(a=>a.phase==='review'));assert.ok(r.actions.some(a=>a.phase==='integrate'));
});
test('unchanged unresolved evidence cannot cause unlimited diagnosis and retry',async t=>{
 const f=fixture(t);let calls=0;const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls++;return{text:JSON.stringify(response(JSON.parse(d.prompt).assignment.blockerTriage?'changes_requested':'blocked',{message:'仍缺证据；你现在不需要操作',needsUser:false}))};}});
 for(let i=0;i<8;i++)await e.tick(f.group.id);assert.equal(calls,4);assert.equal(f.store.request(f.request.id).status,'awaiting_review');assert.equal(f.store.request(f.request.id).blockerTriageBudget.count,2);
});
test('real external requirement stays blocked and never starts work from triage',async t=>{
 const f=fixture(t);let calls=0;const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>{calls++;return{text:JSON.stringify(response('blocked',{message:'外部接口不可用，现有授权内没有替代路径'}))};}});
 await e.tick(f.group.id);await e.tick(f.group.id);assert.equal(calls,1);assert.equal(f.store.request(f.request.id).status,'blocked');assert.equal(f.store.request(f.request.id).deferred.length,1);
});
test('triage cannot waive missing acceptance by declaring done',async t=>{
 const f=fixture(t);let calls=0;const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>{calls++;return{text:JSON.stringify(response('done'))};}});
 for(let i=0;i<4;i++)await e.tick(f.group.id);assert.equal(calls,2);assert.equal(f.store.request(f.request.id).status,'blocked');assert.equal(f.store.request(f.request.id).results['work:codex'].status,'blocked');
});

test('activity identifies diagnosis rather than claiming normal acceptance is running',t=>{
 const f=fixture(t);f.group.status='active';f.store.save(f.group);f.request.status='active';f.request.actions.unshift({phase:'review',member:'harness',blockerTriage:{consumer:'codex'}});f.request.deliveryId='diagnosis';f.store.saveRequest(f.request);f.store.saveDelivery({id:'diagnosis',groupId:f.group.id,requestId:f.request.id,member:'harness',phase:'review',status:'pending',started:true,revision:f.request.revision});
 const e=new GroupEngine(f.store,{});e.running.set(f.group.id,new AbortController());const a=groupActivity(f.store,e,f.group.id);assert.equal(a.members[1].label,'排查阻塞');assert.match(a.detail,/已有成果和验收要求保留/);
});
