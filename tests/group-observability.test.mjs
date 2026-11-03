import test from 'node:test';import assert from 'node:assert/strict';
import {recordUsage,budgetObservation,parallelConfiguration,strengthObservation} from '../src/group-observability.mjs';
test('delivery usage retains partial known lower bounds and deduplicates receipts',()=>{
 const u={calls:0,unknownCalls:0,knownTokens:0};
 recordUsage(u,'a',{usage:{totalTokens:10},usageScope:'lastModelCall'});
 recordUsage(u,'b',{usage:null});recordUsage(u,'c',{usage:{totalTokens:20}});
 assert.equal(recordUsage(u,'a',{usage:{totalTokens:999}}),false);
 assert.deepEqual([u.calls,u.unknownCalls,u.knownTokens],[3,2,30]);
 const b=budgetObservation(u);assert.equal(b.partialDeliveries,1);assert.equal(b.completeDeliveries,1);assert.equal(b.unknownDeliveries,1);assert.equal(b.incompleteDeliveryRatio,2/3);assert.equal(b.threshold,null);
});
test('legacy history is never silently reclassified and zero denominator stays unknown',()=>{
 const b=budgetObservation({calls:5,unknownCalls:3,knownTokens:40});assert.equal(b.legacyUnclassifiedDeliveries,5);assert.equal(b.knownTokensLowerBound,40);assert.equal(b.state,'uncalibrated');assert.equal(budgetObservation().incompleteDeliveryRatio,null);
});
test('parallel configuration validates without claiming a scheduler or occupancy',()=>{
 assert.equal(parallelConfiguration().maxExecutors,2);assert.equal(parallelConfiguration(3).occupancy,null);assert.equal(parallelConfiguration(2).schedulingImplemented,false);
 for(const v of [0,-1,17,2.5,'2',null])assert.throws(()=>parallelConfiguration(v));
});
test('strength configuration cannot fabricate a request or confirmation',()=>{
 const s=strengthObservation('high','harness');assert.equal(s.expected,'high');assert.equal(s.requested,null);assert.equal(s.confirmed,null);assert.equal(s.confirmation,null);
});

test('HTTP configuration round trips and rejects invalid limits without mutation',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {GroupStore}=await import('../src/group-store.mjs');const {startGroupService}=await import('../src/group-service.mjs');const {localFetch}=await import('../src/group-http.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b1-observation-'));const store=new GroupStore(path.join(dir,'test.sqlite'));
 const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});
 const service=await startGroupService({store,runtime:{},schedule:false});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true})});
 const url='/api/groups/'+group.id;
 const initial=await localFetch(service.descriptor,url);assert.equal(initial.parallel.maxExecutors,2);
 await localFetch(service.descriptor,url+'/execution-settings',{maxExecutors:4});
 assert.equal((await localFetch(service.descriptor,url)).parallel.maxExecutors,4);
 await assert.rejects(localFetch(service.descriptor,url+'/execution-settings',{maxExecutors:0}));
 assert.equal(store.group(group.id).executionSettings.maxExecutors,4);
});
