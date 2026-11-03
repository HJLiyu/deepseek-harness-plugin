import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {GroupStore} from '../src/group-store.mjs';
import {GroupPermissions,pendingPermissionIntents,settlePermissionIntents} from '../src/group-permissions.mjs';
import {GroupEngine} from '../src/group-engine.mjs';

function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'approval-lifecycle-')),db=path.join(dir,'groups.sqlite');
 let store=new GroupStore(db);t.after(()=>{try{store.close()}catch{}fs.rmSync(dir,{recursive:true,force:true})});
 const group=store.create({repo:dir,title:'lifecycle',models:{codex:{},harness:{}}});group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:dir,harness:dir};
 const {request}=store.input(group.id,{content:'one fixed operation'});
 const delivery={id:randomUUID(),groupId:group.id,requestId:request.id,member:'codex',phase:'work',revision:request.revision,started:true,status:'pending',nativeTurnId:'old-turn',prompt:'original',cursor:0};
 request.phase='execution';request.actions=[{phase:'work',member:'codex',task:'one fixed operation'}];request.agreement={owner:'codex',integrator:'codex',review:false,tasks:{codex:'one fixed operation',harness:''}};request.status='active';request.deliveryId=delivery.id;group.activeRequestId=request.id;group.status='active';
 store.transaction(()=>{store.save(group);store.saveRequest(request);store.saveDelivery(delivery)});
 const runtime={permissionSnapshot:async()=>({seq:10}),permissionProof:async()=>null};
 let permissions=new GroupPermissions(store,runtime);
 const details=turn=>({method:'item/commandExecution/requestApproval',params:{threadId:'ct',turnId:turn,command:'Write-Output fixed',cwd:dir}});
 const controller=new AbortController();
 return {get store(){return store},group,request,delivery,runtime,get permissions(){return permissions},details,controller,
 async start(){const result=permissions.request(store.group(group.id),delivery,details('old-turn'),controller.signal);await new Promise(setImmediate);return {result,record:store.permissions(group.id).at(-1)}},
 closeApps(){store.transaction(()=>{const g=store.group(group.id);permissions.suspendForAppsClosed(g);g.epoch++;g.status='apps_closed';store.save(g)});controller.abort()},
 restart(){try{store.close()}catch{}store=new GroupStore(db);permissions=new GroupPermissions(store,runtime);permissions.recoverAbandoned()},
 reopen(){store.transaction(()=>{const g=store.group(group.id);g.status='active';store.save(g)})},
 fresh(){const d={...delivery,id:randomUUID(),nativeTurnId:randomUUID()};store.transaction(()=>{const r=store.request(request.id);r.deliveryId=d.id;r.status='active';store.saveRequest(r);store.saveDelivery(d)});return d}
 };
}

test('close/reopen persists unexecuted intent; confirmed recovery retains action and requires fresh native request and proof',async t=>{
 const f=fixture(t),old=await f.start();f.closeApps();assert.equal(await old.result,false);f.restart();f.reopen();
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_checkpoint');
 let turns=0;f.runtime.appOpen=async()=>true;f.runtime.recover=async()=>({interrupted:true,text:'confirmed native turn ended'});f.runtime.turn=async()=>{turns++;throw Error('must not execute during recovery')};
 const engine=new GroupEngine(f.store,f.runtime);await engine.tick(f.group.id);
 const r=f.store.request(f.request.id),g=f.store.group(f.group.id);
 assert.equal(turns,0);assert.equal(r.revision,f.request.revision);assert.equal(r.actions[0].phase,'work');assert.equal(r.deliveryId,undefined);
 assert.equal(pendingPermissionIntents(f.store,g,r,'codex').length,1);
 const prompt=JSON.parse(engine.prompt(g,r,'codex','work').text);assert.equal(prompt.permissionRecovery.intents[0].oldPermissionId,old.record.id);
 const d=f.fresh(),c=new AbortController();const pending=f.permissions.request(f.store.group(g.id),d,f.details(d.nativeTurnId),c.signal);await new Promise(setImmediate);
 const next=f.store.permissions(g.id).at(-1);assert.notEqual(next.id,old.record.id);assert.equal(next.resumesPermissionId,old.record.id);assert.equal(next.ownerReceiptId,undefined);
 assert.equal(f.permissions.candidate(g,{adapter:'harness',sessionId:'ht',content:old.record.allowPhrase}).approvalCandidate,undefined);
 let allowed=false;pending.then(v=>allowed=v);await f.permissions.active.get(next.id).check();assert.equal(allowed,false);
 f.runtime.permissionProof=async()=>({adapter:'harness',sessionId:'ht',messageId:'new-human-record'});
 f.permissions.candidate(g,{adapter:'harness',sessionId:'ht',messageId:'new-human-record',content:next.allowPhrase});await f.permissions.active.get(next.id).check();assert.equal(await pending,true);
 assert.equal(f.store.permission(next.id).status,'allowed_once');assert.equal(f.store.permission(old.record.id).status,'cancelled');
});

test('unknown native outcome never schedules a new turn or reissue',async t=>{
 const f=fixture(t),old=await f.start();f.closeApps();await old.result;f.reopen();let turns=0;
 f.runtime.appOpen=async()=>true;f.runtime.recover=async()=>null;f.runtime.turn=async()=>{turns++};const engine=new GroupEngine(f.store,f.runtime);await engine.tick(f.group.id);
 assert.equal(turns,0);assert.equal(f.store.request(f.request.id).deliveryId,f.delivery.id);assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_checkpoint');
 const d=f.fresh();assert.equal(await f.permissions.request(f.store.group(f.group.id),d,f.details(d.nativeTurnId),new AbortController().signal),false);
});

for(const mismatch of ['epoch','revision','context','operation'])test(`intent recovery rejects changed ${mismatch}`,async t=>{
 const f=fixture(t),old=await f.start();f.closeApps();await old.result;f.reopen();
 f.store.transaction(()=>{const g=f.store.group(f.group.id),r=f.store.request(f.request.id),p=f.store.permission(old.record.id);
 if(mismatch==='epoch')g.epoch++;if(mismatch==='revision')r.revision++;if(mismatch==='context')g.contexts.codex='different';if(mismatch==='operation')p.details.params.command='different effect';f.store.save(g);f.store.saveRequest(r);f.store.savePermission(p);
 assert.equal(settlePermissionIntents(f.store,g,r,f.delivery),false)});
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'stale');assert.equal(pendingPermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id)).length,0);
});

test('fresh reissue rejects a changed operation or recycled native turn and preserves intent',async t=>{
 const f=fixture(t),old=await f.start();f.closeApps();await old.result;f.reopen();f.store.transaction(()=>settlePermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id),f.delivery));
 const d=f.fresh(),c=new AbortController();
 assert.equal(await f.permissions.request(f.store.group(f.group.id),d,{...f.details(d.nativeTurnId),params:{...f.details(d.nativeTurnId).params,command:'different'}},c.signal),false);
 d.nativeTurnId='old-turn';f.store.transaction(()=>f.store.saveDelivery(d));assert.equal(await f.permissions.request(f.store.group(f.group.id),d,f.details('old-turn'),c.signal),false);
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_native_request');
});

test('coordinator restart retains pending intent but cannot revive old approval',async t=>{
 const f=fixture(t),old=await f.start();f.restart();
 assert.equal(f.store.permission(old.record.id).status,'interrupted');assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_checkpoint');
 assert.equal(f.permissions.candidate(f.store.group(f.group.id),{adapter:'harness',sessionId:'ht',content:old.record.allowPhrase}).approvalCandidate,undefined);
 f.controller.abort();await old.result;
});

test('scheduled service closes both apps while awaiting approval and reopens with a distinct native request',async t=>{
 const f=fixture(t);let open=true,calls=0;
 f.store.transaction(()=>{const r=f.store.request(f.request.id);delete r.deliveryId;f.store.saveRequest(r)});
 f.runtime.appOpen=async()=>open;
 f.runtime.turn=async(g,d,signal)=>{
  calls++;d.nativeTurnId='turn-'+calls;f.store.transaction(()=>f.store.saveDelivery(d));
  await f.runtime.requestPermission(g,d,f.details(d.nativeTurnId),signal);
  return {interrupted:true,text:'native interruption confirmed'};
 };
 const {startGroupService}=await import('../src/group-service.mjs');const service=await startGroupService({store:f.store,runtime:f.runtime});
 const until=async predicate=>{const deadline=Date.now()+9000;while(!predicate()){assert.ok(Date.now()<deadline,'scheduled lifecycle timed out');await new Promise(r=>setTimeout(r,25))}};
 try{
  await until(()=>f.store.permissions(f.group.id).some(p=>p.status==='pending'));const old=f.store.permissions(f.group.id).at(-1);open=false;
  await until(()=>!service.engine.running.size&&f.store.permission(old.id).resumeIntent?.status==='awaiting_native_request');
  assert.equal(calls,1);assert.equal(f.store.group(f.group.id).status,'apps_closed');assert.equal(f.store.permission(old.id).status,'cancelled');
  open=true;await until(()=>calls===2&&f.store.permissions(f.group.id).at(-1).status==='pending');const fresh=f.store.permissions(f.group.id).at(-1);
  assert.notEqual(fresh.id,old.id);assert.notEqual(fresh.details.params.turnId,old.details.params.turnId);assert.equal(fresh.resumesPermissionId,old.id);assert.equal(fresh.ownerReceiptId,undefined);
  assert.equal(f.store.request(f.request.id).revision,f.request.revision);
 }finally{service.engine.interrupt(f.group.id);await until(()=>!service.engine.running.size);await service.close()}
 // service.close owns the store; provide a live reopened handle for fixture cleanup.
 f.restart();
});

test('already approved operation with unknown execution outcome is never made a resumable intent',async t=>{
 const f=fixture(t),old=await f.start();f.runtime.permissionProof=async()=>({adapter:'harness',messageId:'human'});
 f.permissions.candidate(f.group,{adapter:'harness',sessionId:'ht',messageId:'human',content:old.record.allowPhrase});await f.permissions.active.get(old.record.id).check();assert.equal(await old.result,true);
 f.closeApps();f.restart();assert.equal(f.store.permission(old.record.id).status,'allowed_once');assert.equal(f.store.permission(old.record.id).resumeIntent,undefined);
 assert.equal(settlePermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id),f.delivery),false);
});

test('requester disconnect before both apps close preserves unapproved intent through checkpoint recovery',async t=>{
 const f=fixture(t),old=await f.start();
 f.controller.abort({cancelSource:'connection_disconnected'});assert.equal(await old.result,false);
 let p=f.store.permission(old.record.id);assert.equal(p.status,'cancelled');assert.equal(p.cancelSource,'connection_disconnected');
 assert.equal(p.resumeIntent.status,'awaiting_checkpoint');assert.equal(p.proof,null);
 // The second app closes after the callback has already disconnected.
 f.closeApps();f.restart();f.reopen();p=f.store.permission(old.record.id);
 assert.equal(p.resumeIntent.epoch,f.store.group(f.group.id).epoch);
 let turns=0;f.runtime.appOpen=async()=>true;f.runtime.recover=async()=>({pending:true,turnId:'old-turn'});f.runtime.turn=async()=>{turns++;};
 const engine=new GroupEngine(f.store,f.runtime);await engine.tick(f.group.id);
 assert.equal(turns,0);assert.equal(f.store.request(f.request.id).deliveryId,f.delivery.id);
 // Advance the persisted retry deadline instead of waiting in this fixture.
 const waiting=f.store.request(f.request.id);delete waiting.nextRecoveryAt;f.store.saveRequest(waiting);
 f.runtime.recover=async()=>({interrupted:true,text:'original native turn ended'});await engine.tick(f.group.id);
 assert.equal(turns,0);assert.equal(pendingPermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id)).length,1);
 assert.equal(f.permissions.candidate(f.store.group(f.group.id),{adapter:'harness',sessionId:'ht',content:old.record.allowPhrase}).approvalCandidate,undefined);
 const d=f.fresh(),controller=new AbortController(),pending=f.permissions.request(f.store.group(f.group.id),d,f.details(d.nativeTurnId),controller.signal);
 await new Promise(setImmediate);const fresh=f.store.permissions(f.group.id).at(-1);
 assert.notEqual(fresh.id,old.record.id);assert.equal(fresh.resumesPermissionId,old.record.id);assert.equal(fresh.status,'pending');assert.equal(fresh.ownerReceiptId,undefined);
 controller.abort();assert.equal(await pending,false);
});

test('a requester disconnect after a changed demand never preserves a stale intent',async t=>{
 const f=fixture(t),old=await f.start();f.store.transaction(()=>{const r=f.store.request(f.request.id);r.revision++;f.store.saveRequest(r)});
 f.controller.abort({cancelSource:'connection_disconnected'});assert.equal(await old.result,false);
 assert.equal(f.store.permission(old.record.id).resumeIntent,undefined);
});


test('revision change expires settled intent once without reviving unknown checkpoints', async t=>{
 const f=fixture(t),old=await f.start();f.controller.abort({cancelSource:'connection_disconnected'});await old.result;
 settlePermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id),f.delivery);
 const r=f.store.request(f.request.id);r.revision++;f.store.saveRequest(r);
 assert.deepEqual(pendingPermissionIntents(f.store,f.store.group(f.group.id),r),[]);
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'expired');
 const notice=f.store.messages(f.group.id).messages.at(-1).content;
 assert.match(notice,/先核对当前要求与原执行检查点/);
 assert.match(notice,/只有确认可以安全重新发起后/);
 assert.match(notice,/新的真人决定/);
 assert.match(notice,/未知执行结果继续保留，不会自动重放/);
 assert.equal(pendingPermissionIntents(f.store,f.store.group(f.group.id),r).length,0);
 assert.equal(f.store.permissions(f.group.id).length,1);
 assert.equal(f.permissions.candidate(f.store.group(f.group.id),{adapter:'harness',sessionId:'ht',messageId:'expired',content:old.record.allowPhrase}).approvalCandidate,undefined);
 const count=f.store.messages(f.group.id).messages.length;
 pendingPermissionIntents(f.store,f.store.group(f.group.id),r);
 assert.equal(f.store.messages(f.group.id).messages.length,count);
 assert.equal(f.store.permission(old.record.id).status,'cancelled');
});

test('late and Markdown decisions give feedback without accepting authority', async t=>{
 const f=fixture(t),old=await f.start();f.controller.abort();await old.result;
 const hint={adapter:'harness',sessionId:'ht',messageId:'late',content:old.record.rejectPhrase};
 const late=f.permissions.candidate(f.store.group(f.group.id),hint);
 assert.match(late.reason,/已失效/);assert.equal(late.approvalCandidate,undefined);
 const wrapped=f.permissions.candidate(f.store.group(f.group.id),{...hint,content:'**'+hint.content+'**  \n'});
 assert.match(wrapped.reason,/已失效/);assert.equal(wrapped.approvalCandidate,undefined);
 assert.equal(f.store.permission(old.record.id).proof,null);
 const before=JSON.stringify(f.store.permission(old.record.id));
 f.permissions.candidate(f.store.group(f.group.id),hint);
 assert.equal(JSON.stringify(f.store.permission(old.record.id)),before);
});

test('revision expiry never releases an unresolved native checkpoint',async t=>{
 const f=fixture(t),old=await f.start();f.controller.abort({cancelSource:'connection_disconnected'});await old.result;
 const r=f.store.request(f.request.id);r.revision++;f.store.saveRequest(r);
 pendingPermissionIntents(f.store,f.store.group(f.group.id),r);
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_checkpoint');
 assert.equal(f.store.permissions(f.group.id).length,1);
 assert.equal(f.store.messages(f.group.id).messages.some(m=>m.content.includes('先核对当前要求与原执行检查点')),false);
});

test('a stale or future query cannot expire the current settled intent',async t=>{
 const f=fixture(t),old=await f.start();f.controller.abort({cancelSource:'connection_disconnected'});await old.result;
 settlePermissionIntents(f.store,f.store.group(f.group.id),f.store.request(f.request.id),f.delivery);
 const current=f.store.request(f.request.id);
 pendingPermissionIntents(f.store,f.store.group(f.group.id),{...current,revision:current.revision+1});
 assert.equal(f.store.permission(old.record.id).resumeIntent.status,'awaiting_native_request');
});
