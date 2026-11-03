import test from 'node:test';import assert from 'node:assert/strict';
import {migrateLegacyLane,settleLane,checkpointLegacyLane,activateTaskLane} from '../src/task-lanes.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
test('migration snapshots the original delivery without changing legacy readers or duplicating a lane',()=>{
 const r={id:'r',revision:0,deliveryId:'original',actions:[{member:'codex'}],results:{'work:codex':{status:'done'}}};
 const l=migrateLegacyLane(r);assert.equal(l.deliveryId,'original');assert.equal(r.deliveryId,'original');
 assert.equal(migrateLegacyLane(r),l);r.actions[0].member='harness';assert.equal(l.actions[0].member,'codex');
 assert.equal(migrateLegacyLane(JSON.parse(JSON.stringify(r))).deliveryId,'original');
});
test('snapshot survives SQLite reopen and resolves the original delivery identity',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lane-checkpoint-')),db=path.join(dir,'test.sqlite');let store=new GroupStore(db);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{}});
 const {request:r}=store.input(g.id,{content:'task',origin:{adapter:'test',sessionId:'s',messageId:'h'}});
 r.deliveryId='original';r.actions=[{phase:'work',member:'codex'}];store.saveRequest(r);
 const lane=checkpointLegacyLane(store,r.id);store.close();store=new GroupStore(db);
 const restored=store.request(r.id);assert.equal(restored.lanes[lane.key].deliveryId,'original');assert.equal(restored.deliveryId,'original');
 assert.equal(checkpointLegacyLane(store,r.id).key,lane.key);assert.equal(Object.keys(store.request(r.id).lanes).length,1);
});
test('unknown and stale receipts keep the original reservation; completion is idempotent',()=>{
 const l=migrateLegacyLane({id:'r',revision:0,deliveryId:'d'});
 const receipt={requestId:'r',revision:0,deliveryId:'d',eventId:'e',verified:true,state:'received'};
 assert.equal(settleLane(l,{...receipt,state:'unknown'}),false);assert.equal(l.deliveryId,'d');
 assert.equal(settleLane(l,{...receipt,revision:1}),false);
 assert.equal(settleLane(l,receipt),true);assert.equal(settleLane(l,receipt),false);assert.equal(l.receipts.length,1);
});
test('task switching retains separate actions and results and cannot switch an in-flight lane',()=>{
 const r={id:'r',revision:0};const first=activateTaskLane(r,'a');r.results={proof:'first'};r.actions=[{phase:'work',member:'codex'}];r.deliveryId='original';
 assert.throws(()=>activateTaskLane(r,'b'));delete r.deliveryId;
 const second=activateTaskLane(r,'b');r.results={proof:'second'};r.actions=[{phase:'work',member:'harness'}];
 assert.equal(first.results.proof,'first');assert.equal(first.actions[0].member,'codex');assert.equal(second.results.proof,'second');
});
test('legacy in-flight delivery recovers after reopen using lane identity, never a stale mirror',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lane-recovery-')),db=path.join(dir,'test.sqlite');let store=new GroupStore(db);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});
 g.status='active';g.contexts={codex:'c',harness:'h'};g.worktrees={codex:dir,harness:dir};
 const {request:r}=store.input(g.id,{content:'Inspect',origin:{adapter:'test',sessionId:'s',messageId:'h'}});
 const raw=JSON.parse(JSON.stringify(r));delete raw.lanes;delete raw.activeLaneKey;raw.deliveryId='original';raw.currentTaskId='original-task';
 store.db.prepare('UPDATE requests SET value=? WHERE id=?').run(JSON.stringify(raw),r.id);
 store.saveDelivery({id:'original',groupId:g.id,requestId:r.id,revision:r.revision,epoch:g.epoch,phase:'planning',member:'codex',started:true,status:'pending',prompt:'{}',cursor:0});
 checkpointLegacyLane(store,r.id);const persisted=JSON.parse(store.db.prepare('SELECT value FROM requests WHERE id=?').get(r.id).value);
 persisted.deliveryId='stale-mirror';persisted.currentTaskId='unrelated';
 store.db.prepare('UPDATE requests SET value=? WHERE id=?').run(JSON.stringify(persisted),r.id);
 g.activeRequestId=r.id;store.save(g);store.close();store=new GroupStore(db);
 assert.equal(store.request(r.id).currentTaskId,'original-task');assert.equal(store.request(r.id).deliveryId,'original');assert.equal(store.requests(g.id)[0].deliveryId,'original');assert.equal(store.recentRequests(g.id)[0].deliveryId,'original');
 let sends=0,recovers=0;const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{sends++;throw Error('must not resend');},recover:async(_g,d)=>{recovers++;assert.equal(d.id,'original');return {text:JSON.stringify({message:'Verified',summary:'Verified',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};}});
 await engine.tick(g.id);assert.equal(sends,0);assert.equal(recovers,1);assert.equal(store.delivery('original').status,'received');
 assert.equal(store.request(r.id).deliveryId,undefined);assert.equal(store.request(r.id).usage.calls,1);
 // The existing receipt remains bound to the original delivery even after the
 // singleton mirror is poisoned. No old approval ID is turned into a new grant.
 store.savePermission({id:'old-approval',groupId:g.id,requestId:r.id,deliveryId:'original',status:'rejected'});
 assert.equal(store.permission('old-approval').deliveryId,'original');assert.equal(store.permission('old-approval').status,'rejected');
});
