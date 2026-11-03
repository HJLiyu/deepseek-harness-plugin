import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
const feedback={status:'changes_requested',message:'仅修复实现方的测试环境处理',summary:'验收反馈',verification:['已核验失败原因'],repairMembers:['codex']};
test('received provider feedback releases only its matching consumer dependency',async t=>{
 const f=fixture(t),id=randomUUID();
 const raw=f.store.message(f.group.id,{sender:'harness',channel:'collaboration',requestId:f.request.id,protocol:true,content:JSON.stringify(feedback),origin:{adapter:'harness-reply',sessionId:'ht',messageId:id}});
 f.store.saveDelivery({id,groupId:f.group.id,requestId:f.request.id,status:'received',phase:'work',member:'harness',revision:f.request.revision,epoch:f.group.epoch,responseMessageId:raw.id});
 f.request.results['work:harness']={...feedback,messageId:raw.id};f.request.actions.unshift({phase:'work',member:'codex',task:'修复实现',repair:{reviewMessageId:raw.id}});
 f.request.deferred=[{phase:'work',member:'codex',why:'dependency',waitingFor:'harness'}];f.store.saveRequest(f.request);
 const calls=[];const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls.push(d.member);return{text:JSON.stringify({status:'done',message:'已修复',summary:'完成',verification:['测试通过']})};}});
 await e.tick(f.group.id);assert.deepEqual(calls,['codex']);assert.equal(f.store.request(f.request.id).deferred.length,0);
});
function fixture(t){const store=new GroupStore(':memory:');t.after(()=>store.close());const group=store.create({repo:process.cwd(),models:{codex:{},harness:{}}});group.status='active';group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:process.cwd(),harness:process.cwd()};const {request}=store.input(group.id,{content:'完成隔离登录态只读验收'});group.activeRequestId=request.id;store.save(group);request.status='active';request.phase='execution';request.agreement={owner:'both',integrator:'codex',review:true,tasks:{codex:'修复实现',harness:'独立验收'}};request.actions=[{phase:'work',member:'harness'},{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}];request.results={'work:codex':{status:'done'}};request.reviewRepairRounds=1;store.saveRequest(request);return{store,group,request};}
test('validation feedback from work resumes the assigned producer rather than failing protocol',async t=>{
 const f=fixture(t);let calls=0;const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>{calls++;return{text:JSON.stringify(feedback)};}});await e.tick(f.group.id);const r=f.store.request(f.request.id);assert.equal(calls,1);assert.equal(r.status,'active');assert.equal(r.actions[0].member,'codex');assert.equal(r.actions[1].member,'harness');assert.equal(r.reviewRepairRounds,2);assert.equal(r.results['work:harness'].status,'changes_requested');
});
test('retained valid feedback is rebound without rewriting the rejected raw message or rerunning reviewer work',async t=>{
 const f=fixture(t),id=randomUUID();const raw=f.store.message(f.group.id,{sender:'harness',channel:'collaboration',requestId:f.request.id,protocol:false,content:JSON.stringify({...feedback,responseScope:id}),origin:{adapter:'harness-reply',sessionId:'ht',messageId:id}});f.store.saveDelivery({id,groupId:f.group.id,requestId:f.request.id,status:'received',phase:'work',member:'harness',revision:f.request.revision,epoch:f.group.epoch,responseScope:id,responseMessageId:raw.id});f.request.status='blocked';f.request.error='Invalid work result.';f.store.saveRequest(f.request);f.group.status='blocked';f.store.save(f.group);
 const calls=[];const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls.push(d.member);return{text:JSON.stringify({status:'done',message:'修复已验证',summary:'完成',verification:['测试通过']})};}});await e.tick(f.group.id);const r=f.store.request(f.request.id);assert.deepEqual(calls,['codex']);assert.equal(r.status,'active');assert.equal(r.actions[0].member,'harness');assert.deepEqual(r.workFeedbackRepairs,[raw.id]);assert.equal(f.store.messageById(raw.id).protocol,false);
});
test('targeted review does not unnecessarily repeat an unchanged validator work task',async t=>{
 const f=fixture(t);f.request.actions.shift();f.request.reviewRepairRounds=0;f.store.saveRequest(f.request);const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>({text:JSON.stringify(feedback)})});await e.tick(f.group.id);const r=f.store.request(f.request.id);assert.deepEqual(r.actions.map(a=>a.phase+':'+a.member),['work:codex','review:harness','integrate:codex']);
});
test('work feedback cannot add a new executor or exceed the repair budget',async t=>{
 const f=fixture(t);f.request.reviewRepairRounds=2;f.store.saveRequest(f.request);const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>({text:JSON.stringify(feedback)})});await e.tick(f.group.id);assert.equal(f.store.request(f.request.id).status,'needs_decision');assert.equal(f.store.request(f.request.id).actions[0].member,'harness');
});
