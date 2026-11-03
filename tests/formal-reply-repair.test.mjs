import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';

const body={message:'Existing audited result',summary:'Original summary',status:'done',verification:['Original evidence'],review:false};
function fixture(t, transform=x=>x) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'formal-reply-')),store=new GroupStore(path.join(dir,'groups.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{codex:{},harness:{}}});group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:dir,harness:dir};
 const {request}=store.input(group.id,{content:'original task'});group.activeRequestId=request.id;group.status='active';
 request.status='active';request.phase='execution';request.agreement={owner:'harness',integrator:'harness',tasks:{harness:'original task',codex:''}};
 request.actions=[{phase:'work',member:'harness',task:'original task'}];store.save(group);store.saveRequest(request);
 const calls=[];const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(g,d)=>{
  calls.push(d);const payload=JSON.parse(d.prompt);
  assert.ok(payload.currentTask.outputContract.required.includes('responseScope'));
  if(d.replyOnly){
   assert.equal(d.phase,'review');assert.equal(payload.assignment.replyOnly,true);
   assert.equal(payload.requirement,undefined);assert.match(payload.instruction,/禁止调用工具/);
   assert.equal(payload.originalResponse,JSON.stringify(body));
   return transform({text:JSON.stringify({...body,responseScope:d.id})},d,store);
  }
  return transform({text:JSON.stringify(body),proof:{deliveryId:d.id,turn:1,endSeq:20,reason:'completed'}},d,store);
 }};
 return {store,group,request,calls,engine:new GroupEngine(store,runtime)};
}
test('completed work missing scope receives one reply-only review, retaining raw text and original result slot',async t=>{
 const f=fixture(t);await f.engine.tick(f.group.id);
 let r=f.store.request(f.request.id);assert.equal(r.actions[0].phase,'review');assert.ok(r.actions[0].replyOnly);
 const old=f.store.delivery(f.calls[0].id),raw=f.store.messageById(old.responseMessageId);
 assert.equal(old.status,'received');assert.equal(raw.protocol,false);assert.equal(raw.content,JSON.stringify(body));assert.ok(old.terminalReply);
 assert.deepEqual(r.results,{});assert.equal(f.calls.length,1);
 await f.engine.tick(f.group.id);r=f.store.request(r.id);
 assert.equal(r.status,'completed');assert.equal(r.results['work:harness'].summary,body.summary);
 assert.equal(r.results['review:harness'],undefined);assert.deepEqual(f.calls.map(d=>d.phase),['work','review']);
 assert.notEqual(f.calls[0].responseScope,f.calls[1].responseScope);
 assert.deepEqual(f.store.messageById(raw.id),raw);assert.equal(f.store.delivery(old.id).responseScope,old.id);
 await f.engine.tick(f.group.id);assert.equal(f.calls.length,2);
});
for(const failure of ['wrong-scope','no-terminal','new-human','native-unknown'])test(`reply repair fails closed for ${failure}`,async t=>{
 const f=fixture(t,(r,d,store)=>{
  if(failure==='wrong-scope')r.text=JSON.stringify({...body,responseScope:'old-id'});
  if(failure==='no-terminal')delete r.proof;
  if(failure==='new-human')store.message(d.groupId,{sender:'human',channel:'group',requestId:d.requestId,content:'new information'});
  if(failure==='native-unknown')throw Error('unknown transport outcome');
  return r;
 });
 await f.engine.tick(f.group.id);const r=f.store.request(f.request.id);
 assert.equal(r.actions[0].replyOnly,undefined);assert.deepEqual(r.results,{});
 assert.equal(r.status,failure==='native-unknown'?'needs_recovery':'blocked');assert.equal(f.calls.length,1);
});
test('raw mutation prevents reply-only dispatch without modifying the original delivery scope',async t=>{
 const f=fixture(t);await f.engine.tick(f.group.id);const r=f.store.request(f.request.id),repair=r.actions[0].replyOnly;
 const raw=f.store.messageById(repair.messageId);raw.content+=' ';
 f.store.db.prepare('UPDATE messages SET value=? WHERE id=?').run(JSON.stringify(raw),raw.id);
 await f.engine.tick(f.group.id);assert.equal(f.calls.length,1);assert.equal(f.store.request(r.id).status,'blocked');
 assert.equal(f.store.delivery(repair.deliveryId).responseScope,repair.deliveryId);
});
test('a progress-only question does not invalidate a pending reply repair',async t=>{
 const f=fixture(t);await f.engine.tick(f.group.id);
 const reply=f.store.input(f.group.id,{content:'目前的情况',mode:'auto'});assert.equal(reply.progressOnly,true);
 await f.engine.tick(f.group.id);const r=f.store.request(f.request.id);assert.equal(r.status,'completed');assert.equal(f.calls.length,2);
});
test('reply-only cannot change prior conclusions and never enters another work attempt',async t=>{
 const f=fixture(t,(r,d)=>d.replyOnly?{text:JSON.stringify({...body,summary:'Changed conclusion',responseScope:d.id})}:r);
 await f.engine.tick(f.group.id);await f.engine.tick(f.group.id);await f.engine.tick(f.group.id);
 const r=f.store.request(f.request.id);assert.equal(r.status,'blocked');assert.deepEqual(r.results,{});assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls.map(d=>d.phase),['work','review']);
});
test('desktop Codex work is not automatically repaired without enforced read-only permissions',async t=>{
 const f=fixture(t,(result)=>({...result,status:'completed',turnId:'native-completed'}));
 const r=f.store.request(f.request.id);r.actions[0].member='codex';f.store.saveRequest(r);
 await f.engine.tick(f.group.id);await f.engine.tick(f.group.id);
 const saved=f.store.request(r.id);assert.equal(saved.status,'blocked');assert.equal(saved.actions[0].replyOnly,undefined);assert.equal(f.calls.length,1);
});
