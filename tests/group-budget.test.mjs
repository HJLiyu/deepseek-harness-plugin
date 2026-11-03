import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {calibrate,budgetDecision,budgetPolicy,usageClass,calibrationFor} from '../src/group-budget.mjs';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
const samples=n=>Array.from({length:n},(_,i)=>({deliveryId:'d'+i,requestId:'r',receivedAt:i,classKey:'c',tokens:i+1,classification:'complete',scope:'delivery'}));
test('calibration uses the last twenty comparable receipts, nearest-rank P75 and ten valid samples',()=>{
 const h=samples(30);const c=calibrate([...h,...h], 'c');assert.equal(c.windowSize,20);assert.equal(c.sampleCount,20);assert.equal(c.threshold,25);assert.equal(c.version,'same-class-nearest-rank-p75-v1');
 assert.equal(calibrate(samples(9),'c').state,'uncalibrated');assert.equal(calibrate(samples(9),'c').threshold,null);
 const mixed=samples(20);for(let i=10;i<20;i++)mixed[i].classification='partial';assert.equal(calibrate(mixed,'c').sampleCount,10);assert.equal(calibrate(mixed,'c').threshold,8);
 mixed[0].classKey='other';assert.equal(calibrate(mixed,'c').threshold,null);
 assert.equal(calibrate([...samples(10),{...samples(10)[0],tokens:999}],'c').sampleCount,9);
});
test('hard limits do not treat unknown or partial usage as zero or estimates as guarantees',()=>{
 const u={calls:1,knownTokens:10,unknownCalls:1,observation:{samples:{a:{tokens:10,classification:'partial'}}}};
 assert.equal(budgetDecision(u,{softTokens:10}).softReminder,true);
 assert.equal(budgetDecision(u,{hardTokens:20}).reason,'hard_usage_unknown');
 assert.equal(budgetDecision(u,{hardTokens:10}).reason,'hard_threshold_reached');
 const complete={calls:1,knownTokens:10,unknownCalls:0,observation:{samples:{a:{tokens:10,classification:'complete'}}}};
 const d=budgetDecision(complete,{hardTokens:20},{state:'calibrated',threshold:1});assert.equal(d.admit,false);assert.equal(d.reason,'host_hard_cap_unavailable');assert.equal(d.estimatedNextTokens,1);assert.equal(d.cost,null);
 assert.equal(budgetDecision({},{}).knownTokensLowerBound,null);assert.equal(budgetDecision({calls:5,knownTokens:90,unknownCalls:0},{hardTokens:100}).usageComplete,false);
 assert.throws(()=>budgetPolicy({hardTokens:0}));assert.throws(()=>budgetPolicy({calibratedReminder:'yes'}));
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'budget-'));const store=new GroupStore(path.join(dir,'test.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});group.status='active';group.contexts={codex:'c',harness:'h'};const {request}=store.input(group.id,{content:'Read only',origin:{adapter:'test',sessionId:'s',messageId:'x'}});group.activeRequestId=request.id;store.save(group);return {store,group,request,dir};}
test('actual settlement persists receipt-bound calibration evidence and restart deduplicates history',async t=>{
 const f=fixture(t);let sends=0;
 const runtime={appOpen:async()=>true,turn:async()=>{sends++;return {text:JSON.stringify({message:'Read result',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false}),usage:{totalTokens:12}};}};
 await new GroupEngine(f.store,runtime).tick(f.group.id);assert.equal(sends,1);
 const c=calibrationFor(f.store,f.group,'codex','planning');assert.equal(c.sampleCount,1);assert.equal(c.threshold,null);assert.equal(c.evidence[0].tokens,12);
 const reopened=new GroupStore(path.join(f.dir,'test.sqlite'));try{assert.deepEqual(calibrationFor(reopened,f.group,'codex','planning'),c);}finally{reopened.close();}
 assert.equal(calibrationFor(f.store,{...f.group,models:{codex:{model:'different'}}},'codex','planning').sampleCount,0);
});
test('HTTP policy validation is atomic and strict configured cap prevents native admission',async t=>{
 const f=fixture(t);let sends=0;const runtime={appOpen:async()=>true,turn:async()=>{sends++;throw Error('unexpected');}};
 const service=await startGroupService({store:f.store,runtime,schedule:false});try {
 const url='/api/groups/'+f.group.id;
 await localFetch(service.descriptor,url+'/budget',{requestId:f.request.id,policy:{softTokens:5,hardTokens:30,calibratedReminder:true}});
 await assert.rejects(localFetch(service.descriptor,url+'/budget',{requestId:f.request.id,policy:{hardTokens:-1}}));assert.equal(f.store.request(f.request.id).budgetPolicy.hardTokens,30);
 await new GroupEngine(f.store,runtime).tick(f.group.id);assert.equal(sends,0);assert.equal(f.store.request(f.request.id).status,'blocked');
 const state=await localFetch(service.descriptor,url);assert.equal(state.requests[0].budgetObservation.admission.admit,false);assert.equal(state.requests[0].budgetObservation.calibrations.codex.threshold,null);
 } finally {await service.close();}
});

test('calibrated reminder uses audited prior receipts, not the current sample, and retains source evidence',async t=>{
 const f=fixture(t),key=usageClass(f.group,'codex','planning');
 for(let i=0;i<10;i++){
  const id='historical-'+i,msg=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:f.request.id,content:'audited'});
  f.store.saveDelivery({id,groupId:f.group.id,requestId:f.request.id,member:'codex',phase:'planning',status:'received',responseMessageId:msg.id,usageClass:key,
   usageObservation:{deliveryId:id,requestId:f.request.id,classKey:key,receivedAt:i,tokens:10,classification:'complete',scope:'delivery'}});
 }
 f.request.budgetPolicy={calibratedReminder:true,softTokens:15};f.store.saveRequest(f.request);
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>({text:JSON.stringify({message:'Done',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false}),usage:{totalTokens:20}})}).tick(f.group.id);
 const deliveries=f.store.db.prepare('SELECT value FROM deliveries').all().map(r=>JSON.parse(r.value));const d=deliveries.find(d=>d.budgetReminder);
 assert.ok(d);assert.equal(d.calibration.sampleCount,10);assert.equal(d.calibration.threshold,10);assert.equal(d.budgetReminder.calibratedOutlier,true);assert.equal(d.budgetReminder.softThreshold,true);
 assert.equal(f.store.request(f.request.id).usage.knownTokens,20);assert.equal(calibrationFor(f.store,f.group,'codex','planning').sampleCount,11);
 assert.equal(f.store.messages(f.group.id).messages.filter(m=>m.content.startsWith('Budget reminder:')).length,1);
});
