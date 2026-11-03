import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';import {startGroupService,groupActivity} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
const html=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('function collaborationView('),html.indexOf('const collaborationStatus='));const context=vm.createContext({});vm.runInContext(code,context);const view=(s,e)=>JSON.parse(JSON.stringify(context.collaborationView(s,e)));
test('dashboard keeps missing usage, calibration and native occupancy unknown',()=>{
 const v=view({group:{activeRequestId:'r'},requests:[{id:'r'}],parallel:{reservedOccupancy:2,schedulingImplemented:false,occupancy:2}});
 assert.equal(v.usage,null);assert.equal(v.unknownRatio,'未知');assert.equal(v.calibration,'未校准');assert.equal(v.occupancy,'尚未确认');
 const live=view({parallel:{schedulingImplemented:true,occupancy:2}});assert.equal(live.occupancy,'2');
});
test('dashboard uses canonical task projection and preserves cancellation versus rejection',()=>{
 const v=view({group:{activeRequestId:'r'},requests:[{id:'r',currentTaskId:'old',taskList:[{taskId:'old',title:'stale'}],budgetObservation:{knownTokensLowerBound:12,incompleteDeliveryRatio:.4,calibration:{state:'uncalibrated'}}}]},{tasks:{requests:[{requestId:'r',currentTaskId:'next',tasks:[{taskId:'done',status:'done'},{taskId:'next',status:'review',title:'independent review',acceptance:'evidence'}]}]},scopes:{grants:[{id:'a',effectiveState:'cancelled'},{id:'b',effectiveState:'rejected'}]}});
 assert.equal(v.next.taskId,'next');assert.equal(v.next.status,'review');assert.equal(v.usage,12);assert.equal(v.unknownRatio,'40%');assert.notEqual(v.grants[0].effectiveState,v.grants[1].effectiveState);
});
test('page scripts parse and all new panel controls have unique IDs',()=>{
 for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);for(const id of ['collaborationDialog','scopeCards','readinessLevels','appearance','executionMetrics','effortPanelForm','collaborationForm','savingsPanelForm'])assert.equal(ids.filter(x=>x===id).length,1,id);
});
test('readiness HTTP uses independent evidence and leaves missing candidate unconfirmed',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'frontend-readiness-')),store=new GroupStore(path.join(dir,'db.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{}});const service=await startGroupService({store,runtime:{},schedule:false,candidateRoot:path.join(dir,'absent-candidate'),installedRoot:path.join(dir,'absent-install')});
 try{const r=await localFetch(service.descriptor,'/api/readiness?groupId='+g.id);assert.equal(r.state,'unknown');assert.equal(r.layers.installed,'unknown');assert.equal(r.layers.runtime,'unknown');assert.equal(r.layers.adapter,'unknown');assert.equal(r.sources.runtime,'loaded_module_snapshot');assert.equal(r.sources.installed,'running_module_directory');assert.equal(r.candidate.runtimeHash,undefined);assert.equal([...store.allGroups()].length,1);}finally{await service.close();}
});
function parallelFixture(t){
 const store=new GroupStore(':memory:');t.after(()=>store.close());const g=store.create({repo:process.cwd(),models:{}}),{request:r}=store.input(g.id,{content:'Two independent local tasks'});
 g.status='active';g.activeRequestId=r.id;g.contexts={codex:'c',harness:'h'};store.save(g);r.status='active';r.phase='execution';r.actions=[{phase:'work',member:'codex'}];r.deliveryId='first';
 const key='second-lane';r.lanes[key]={key,requestId:r.id,revision:r.revision,taskId:'second-task',status:'active',deliveryId:'second',actions:[{phase:'work',member:'harness'}],results:{}};store.saveRequest(r);
 for(const [id,member,laneKey]of [['first','codex',r.activeLaneKey],['second','harness',key]])store.saveDelivery({id,groupId:g.id,requestId:r.id,revision:r.revision,epoch:g.epoch,member,laneKey,phase:'work',status:'pending',started:true});
 return {store,g,r,key,engine:{runtime:{},running:new Map([[g.id,{}]])},activity(){return groupActivity(this.store,this.engine,this.g.id);}};
}
test('two original started deliveries show both members busy without promoting native capability',t=>{
 const f=parallelFixture(t),before=f.store.admissions().observation(f.g.id),result=f.activity();assert.deepEqual(result.members.map(m=>m.state),['busy','busy']);assert.deepEqual(result.members.map(m=>m.deliveryId),['first','second']);assert.equal(f.store.admissions().observation(f.g.id).schedulingImplemented,before.schedulingImplemented);
});
test('reservation references without started execution never show busy',t=>{
 const f=parallelFixture(t);for(const id of ['first','second']){const d=f.store.delivery(id);d.started=false;f.store.saveDelivery(d);}const result=f.activity();assert.ok(result.members.every(m=>m.state!=='busy'));assert.ok(result.members.every(m=>m.executionEvidence==='reservation_only'));
});
test('unknown peer checkpoint keeps the other original delivery busy',t=>{
 const f=parallelFixture(t),d=f.store.delivery('second');d.status='unknown';f.store.saveDelivery(d);const result=f.activity();assert.equal(result.members[0].state,'busy');assert.equal(result.members[1].state,'waiting');assert.equal(result.members[1].executionEvidence,'unsettled_checkpoint');assert.match(result.members[1].label,/核对/);
});
test('a recovery lane is not executing and one member approval preserves the other in-flight state',t=>{
 const f=parallelFixture(t);let r=f.store.request(f.r.id);r.lanes[f.key].status='needs_recovery';f.store.saveRequest(r);assert.equal(f.activity().members[1].state,'waiting');
 r=f.store.request(f.r.id);r.lanes[f.key].status='active';f.store.saveRequest(r);f.store.pendingPermissions=()=>[{member:'codex',status:'pending'}];const result=f.activity();assert.equal(result.members[0].state,'attention');assert.equal(result.members[1].state,'busy');assert.equal(result.needsUser,true);
});
