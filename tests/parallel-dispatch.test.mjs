import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';import {makeTaskList,startNextTask,finishTask} from '../src/task-list.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'parallel-dispatch-')),file=path.join(dir,'test.sqlite');let store=new GroupStore(file);t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});group.status='active';group.contexts={codex:'c',harness:'h'};group.worktrees={codex:dir,harness:dir};
 const {request}=store.input(group.id,{content:'Two independent tasks',origin:{adapter:'test',sessionId:'s',messageId:'h'}});request.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'A',harness:''}};
 request.taskList=makeTaskList(request,[{key:'a',title:'A',task:'A',owner:'codex',acceptance:'Tests',resources:{reads:[],writes:['a']}},{key:'b',title:'B',task:'B',owner:'harness',acceptance:'Tests',resources:{reads:[],writes:['b']}}]);request.taskListRevision=request.revision;startNextTask(request);group.activeRequestId=request.id;store.saveRequest(request);store.save(group);
 return {store,group,request,file,reopen(){store.close();store=new GroupStore(file);this.store=store;return store;}};
}
const reply=d=>({text:JSON.stringify({responseScope:d.id,status:'done',message:'Verified '+d.member,summary:'Verified',verification:['artifact '+d.member],integrationFiles:[]})});
test('two native work turns overlap through existing engine and retain separate checkpoints/results',async t=>{
 const f=fixture(t);let entered=0,release;const barrier=new Promise(r=>release=r),seen=[];
 const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(g,d)=>{
  seen.push(d);entered++;assert.equal(f.store.requestForDelivery(d.requestId,d.id).deliveryId,d.id);assert.equal(f.store.delivery(d.id).laneKey,d.laneKey);
  fs.writeFileSync(path.join(f.group.repo,d.member==='codex'?'a':'b'),'result '+d.member);
  assert.equal(f.store.admissions().observation(g.id).occupancy,2);
  if(entered===2)release();await barrier;return reply(d);
 }};
 const engine=new GroupEngine(f.store,runtime);await engine.tick(f.group.id);
 assert.equal(entered,2);assert.equal(new Set(seen.map(d=>d.member)).size,2);assert.equal(new Set(seen.map(d=>d.id)).size,2);
 const r=f.store.request(f.request.id);for(const d of seen){const lane=r.lanes[d.laneKey];assert.equal(lane.results['work:'+d.member].status,'done');assert.equal(lane.deliveryId,undefined);assert.equal(lane.actions[0].phase,'review');}
 assert.equal(r.usage.calls,2);assert.equal(f.store.admissions().observation(f.group.id).held,0);
 assert.equal(fs.readFileSync(path.join(f.group.repo,'a'),'utf8'),'result codex');assert.equal(fs.readFileSync(path.join(f.group.repo,'b'),'utf8'),'result harness');
 // Accept task A; task B must start at review without resending its work.
 r.actions=[];r.results['review:harness']={status:'done',verification:['review']};r.results['integrate:codex']={status:'done',verification:['integration']};
 assert.equal(finishTask(r),true);assert.equal(startNextTask(r),true);assert.equal(r.actions[0].phase,'review');assert.equal(r.results['work:harness'].status,'done');
});
test('unknown lane survives restart without resending; successful sibling results remain',async t=>{
 const f=fixture(t);let turns=0;
 const runtime={appOpen:async()=>true,turn:async(_g,d)=>{turns++;if(d.member==='harness')throw Error('transport unknown');return reply(d);}};
 await new GroupEngine(f.store,runtime).tick(f.group.id);assert.equal(turns,2);
 let r=f.store.request(f.request.id);const pending=Object.values(r.lanes).find(l=>l.deliveryId);assert.ok(pending);const id=pending.deliveryId;
 assert.equal(Object.values(r.lanes).find(l=>l.results?.['work:codex'])?.results['work:codex'].status,'done');assert.equal(f.store.admissions().observation(f.group.id).held,1);
 pending.nextRecoveryAt=0;f.store.saveRequest(r);
 const store=f.reopen();runtime.recover=async(_g,d)=>{assert.equal(d.id,id);return reply(d);};
 await new GroupEngine(store,runtime).tick(f.group.id);r=store.request(f.request.id);assert.equal(turns,2);assert.equal(store.delivery(id).status,'received');assert.equal(store.admissions().observation(f.group.id).held,0);
 assert.equal(Object.values(r.lanes).find(l=>l.results?.['work:codex'])?.results['work:codex'].status,'done');
});
test('historical blocked request does not prevent a new active request admission',t=>{
 const f=fixture(t);const {request:old}=f.store.input(f.group.id,{content:'Historical',origin:{adapter:'test',sessionId:'s',messageId:'old'}});old.status='blocked';f.store.saveRequest(old);
 const group=f.store.group(f.group.id);group.activeRequestId=f.request.id;group.status='active';f.store.save(group);
 const result=f.store.admissions().reserve({groupId:group.id,requestId:f.request.id,taskId:f.request.currentTaskId,member:'codex',deliveryId:'fresh'});assert.equal(result.admitted,true);
});
test('approval waiting or human pause before admission never starts either turn',async t=>{
 for(const mode of ['approval','pause']){
  const f=fixture(t);let sends=0,changed=false;
  const runtime={appOpen:async()=>{if(!changed){changed=true;if(mode==='approval')f.store.savePermission({id:'p',groupId:f.group.id,requestId:f.request.id,status:'pending'});else{const g=f.store.group(f.group.id);g.status='paused';f.store.save(g);}}return true;},turn:async()=>{sends++;throw Error('must not start');}};
  await new GroupEngine(f.store,runtime).tick(f.group.id);assert.equal(sends,0);
 }
});
test('correction during two in-flight calls preserves the new plan and never adopts old results',async t=>{
 const f=fixture(t);let entered=0,release;const gate=new Promise(r=>release=r);
 const runtime={appOpen:async()=>true,turn:async(_g,d)=>{if(++entered===2){f.store.input(f.group.id,{content:'Correct implementation',mode:'supplement',requestId:f.request.id,origin:{adapter:'test',sessionId:'s',messageId:'correction'}});release();}await gate;return reply(d);}};
 await new GroupEngine(f.store,runtime).tick(f.group.id);const r=f.store.request(f.request.id);
 assert.equal(entered,2);assert.equal(r.revision,1);assert.equal(r.phase,'planning');assert.ok(r.taskList.every(x=>x.status==='invalidated'));assert.equal(f.store.admissions().observation(f.group.id).held,0);
});
test('failed sibling keeps success and proceeds to serial review, not a second work dispatch',async t=>{
 const f=fixture(t);let entered=0,release;const gate=new Promise(r=>release=r);
 const runtime={appOpen:async()=>true,turn:async(_g,d)=>{if(++entered===2)release();await gate;const result=reply(d);if(d.member==='harness'){const body=JSON.parse(result.text);body.status='blocked';body.message='Needs artifact review';result.text=JSON.stringify(body);}return result;}};
 await new GroupEngine(f.store,runtime).tick(f.group.id);const r=f.store.request(f.request.id);
 assert.equal(r.parallelDisabled,true);assert.equal(r.parallelStop,false);assert.equal(r.results['work:codex'].status,'done');
 r.actions=[];r.results['review:harness']={status:'done',verification:['review']};r.results['integrate:codex']={status:'done',verification:['integration']};
 finishTask(r);startNextTask(r);assert.equal(r.actions[0].phase,'review');assert.equal(r.results['work:harness'].status,'blocked');assert.equal(r.deferred[0].why,'blocked');assert.equal(entered,2);
});
test('HTTP state includes coordinator occupancy and the two-session effective ceiling',async t=>{
 const f=fixture(t);const {startGroupService}=await import('../src/group-service.mjs'),{localFetch}=await import('../src/group-http.mjs');
 const service=await startGroupService({store:f.store,runtime:{},schedule:false});
 try{
  const url='/api/groups/'+f.group.id;const result=await localFetch(service.descriptor,url+'/execution-settings',{maxExecutors:8});
  assert.equal(result.schedulingImplemented,false);assert.equal(result.effectiveMaxExecutors,2);
  const state=await localFetch(service.descriptor,url);assert.equal(state.parallel.occupancy,null);assert.equal(state.parallel.schedulingImplemented,false);assert.equal(state.parallel.occupancyUnit,'heldReservations');assert.equal(state.parallel.validatedWith,'mockRuntime');assert.equal(state.parallel.reservedOccupancy,0);
 }finally{await service.close();}
});
test('second-lane approval binds its own delivery and cannot consume a rejected old approval',async t=>{
 const f=fixture(t);const {GroupPermissions}=await import('../src/group-permissions.mjs');
 const permissions=new GroupPermissions(f.store,{permissionSnapshot:async()=>({seq:0})});
 f.store.savePermission({id:'old',groupId:f.group.id,requestId:f.request.id,status:'rejected',member:'harness'});
 let entered=0,release;const both=new Promise(r=>release=r);let decision,record;
 const engine=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(g,d,signal)=>{
  if(++entered===2)release();await both;
  if(d.member==='harness'){
    const pending=permissions.request(g,d,{method:'harness/tool',params:{callId:'new-call',arguments:{command:'local fixture only'}}},signal);
    await new Promise(setImmediate);record=f.store.permissions(g.id).find(p=>p.status==='pending');
    assert.ok(record);assert.equal(record.deliveryId,d.id);assert.notEqual(record.id,'old');engine.interrupt(g.id,'test_cancel');decision=await pending;
  }
  return reply(d);
 }});
 await engine.tick(f.group.id);assert.equal(entered,2);assert.equal(decision,false);assert.equal(f.store.permission('old').status,'rejected');assert.notEqual(f.store.permission(record.id).status,'approved');
});
test('restart after terminal journal but before capacity release never dispatches a review under the old ID',async t=>{
 const f=fixture(t);let sends=0;const runtime={appOpen:async()=>true,turn:async(_g,d)=>{sends++;return reply(d);}};
 await new GroupEngine(f.store,runtime).tick(f.group.id);assert.equal(sends,2);
 const row=f.store.admissions().rows()[0];row.state='held';row.release=null;f.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(row),row.id);
 const store=f.reopen();await new GroupEngine(store,runtime).tick(f.group.id);assert.equal(sends,2);assert.equal(store.delivery(row.id).phase,'work');assert.equal(store.admissions().observation(f.group.id).held,0);
});
test('missing foreground declarations force ordinary serial execution without skipping to a later task',async t=>{
 const f=fixture(t);const r=f.store.request(f.request.id);delete r.taskList[0].resources;f.store.saveRequest(r);const seen=[];
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{seen.push(d.member);return reply(d);}}).tick(f.group.id);
 assert.deepEqual(seen,['codex']);assert.equal(f.store.admissions().observation(f.group.id).held,0);
});
test('unsettled legacy execution cannot bypass a refused reservation through ordinary serial dispatch',async t=>{
 const f=fixture(t);f.store.saveDelivery({id:'legacy',groupId:f.group.id,requestId:'old',member:'codex',phase:'work',started:true,status:'unknown'});let sent=0;
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{sent++;return reply(d);}}).tick(f.group.id);
 assert.equal(sent,0);assert.equal(f.store.admissions().observation(f.group.id).held,0);assert.equal(f.store.delivery('legacy').status,'unknown');
});
test('parallel quota failure clears only its proved terminal session and retains peer work before retry',async t=>{
 const f=fixture(t);let sends=0;const runtime={appOpen:async()=>true,turn:async(g,d)=>{sends++;if(d.member==='harness')return reply(d);const saved=d;Object.assign(saved,{nativeTurnId:'turn',nativeAdmission:{threadId:g.contexts.codex,turnId:'turn',promptHash:f.store.hash(`[Group delivery ${d.id}]\n${d.prompt}`)}});f.store.saveDelivery(saved);return {text:'quota',nativeFailure:{kind:'usage_limit',turnId:'turn'}};}};
 const e=new GroupEngine(f.store,runtime);await e.tick(f.group.id);assert.equal(sends,2);await e.tick(f.group.id);assert.equal(sends,2);assert.equal(f.store.admissions().observation(f.group.id).held,0,JSON.stringify(f.store.admissions().rows().map(row=>({id:row.id,state:row.state,status:f.store.delivery(row.deliveryId)?.status}))));const r=f.store.request(f.request.id);assert.equal(r.parallelStop,false);assert.equal(r.status,'blocked');assert.equal(Object.values(r.lanes).find(l=>l.results?.['work:harness'])?.results['work:harness'].status,'done');
});
test('repairing the foreground does not rerun a prefetched sibling or run its review concurrently',async t=>{
 const f=fixture(t),seen=[];const runtime={appOpen:async()=>true,turn:async(_g,d)=>{seen.push([d.member,d.phase]);return reply(d);}};
 const engine=new GroupEngine(f.store,runtime);await engine.tick(f.group.id);
 const r=f.store.request(f.request.id);r.actions.unshift({phase:'work',member:'codex',task:'Repair A',repair:{round:1}});f.store.saveRequest(r);
 await engine.tick(f.group.id);assert.deepEqual(seen,[['codex','work'],['harness','work'],['codex','work']]);
});
test('configured ceiling one reaches only one native work turn',async t=>{
 const f=fixture(t);f.group.executionSettings={maxExecutors:1};f.store.save(f.group);const seen=[];
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{seen.push(d.member);return reply(d);}}).tick(f.group.id);
 assert.deepEqual(seen,['codex']);assert.equal(f.store.admissions().observation(f.group.id).held,0);
});

test('stale usage views merge by delivery identity and retain historical lower bound',async()=>{
 const {mergeUsage}=await import('../src/parallel-dispatch.mjs');
 const legacy={calls:3,knownTokens:70,unknownCalls:1};
 const a={calls:4,knownTokens:80,unknownCalls:1,observation:{samples:{a:{tokens:10,classification:'complete'}}}};
 const b={calls:4,knownTokens:90,unknownCalls:1,observation:{samples:{b:{tokens:20,classification:'complete'}}}};
 let u=mergeUsage(mergeUsage(legacy,a),b);assert.equal(u.calls,5);assert.equal(u.knownTokens,100);assert.equal(u.unknownCalls,1);
 assert.deepEqual(mergeUsage(u,a),u);assert.deepEqual(mergeUsage(u,b),u);
});
test('final native dispatch redacts credentials injected via task metadata',async t=>{
 const f=fixture(t),secret='sk-fixture-only-123456';f.request.taskList[0].acceptance=secret;f.store.saveRequest(f.request);
 let count=0;await new GroupEngine(f.store,{responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>{count++;assert.equal(d.prompt.includes(secret),false);return reply(d);}}).tick(f.group.id);
 assert.equal(count,2);assert.equal(f.store.request(f.request.id).taskList[0].acceptance,secret);
});

test('two unknown lanes reconcile original identities after urgent steering, pause and reopen',async t=>{
 const f=fixture(t);let sends=0;const ids=[];
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{sends++;ids.push(d.id);throw Error('unknown');}}).tick(f.group.id);
 assert.equal(sends,2);
 f.store.input(f.group.id,{content:'Supplement',mode:'supplement',requestId:f.request.id,origin:{adapter:'test',sessionId:'s',messageId:'supp'}});
 f.store.input(f.group.id,{content:'Urgent',mode:'urgent',origin:{adapter:'test',sessionId:'s',messageId:'urgent'}});
 const g=f.store.group(f.group.id);g.status='paused';f.store.save(g);
 const old=f.store.request(f.request.id);for(const lane of Object.values(old.lanes))lane.nextRecoveryAt=0;f.store.saveRequest(old);
 const store=f.reopen();const recovered=[];const runtime={appOpen:async()=>true,turn:async()=>{throw Error('unexpected replay');},recover:async(_g,d)=>{recovered.push(d.id);return reply(d);}};
 await new GroupEngine(store,runtime).tick(f.group.id);
 await new GroupEngine(store,runtime).tick(f.group.id);assert.deepEqual(new Set(recovered),new Set(ids));assert.equal(store.admissions().observation(g.id).held,0);assert.equal(store.group(g.id).status,'paused');assert.equal(sends,2);
});

test('mock validation never claims native readiness and occupancy separates untracked deliveries',t=>{
 const f=fixture(t);f.store.saveDelivery({id:'untracked',groupId:f.group.id,requestId:f.request.id,member:'codex',started:true,status:'unknown'});
 const o=f.store.admissions().observation(f.group.id);assert.equal(o.occupancy,0);assert.equal(o.unsettledDeliveries,1);assert.equal(o.schedulingImplemented,false);assert.equal(o.validatedWith,'mockRuntime');
});
