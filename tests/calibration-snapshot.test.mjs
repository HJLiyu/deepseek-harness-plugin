import test from'node:test';import assert from'node:assert/strict';
import{calibrationSnapshot,calibrationFor,usageClass}from'../src/group-budget.mjs';
test('one projection reads history once across all request classes, next projection sees new receipts',()=>{
 const group={id:'g',models:{codex:{model:'c'},harness:{model:'h'}}};let scans=0;const deliveries=[];
 const add=i=>deliveries.push({id:'d'+i,member:'codex',requestId:'r',status:'received',responseMessageId:'m',usageClass:usageClass(group,'codex','work'),usageObservation:{deliveryId:'d'+i,requestId:'r',classKey:usageClass(group,'codex','work'),receivedAt:i,classification:'complete',scope:'delivery',tokens:100+i}});
 const store={db:{prepare:()=>({all:()=>{scans++;return deliveries.map(d=>({value:JSON.stringify(d)}));}})},messageById:()=>({requestId:'r',groupId:'g',sender:'codex'})};
 for(let i=0;i<9;i++)add(i);const view=calibrationSnapshot(store,group);
 for(let i=0;i<50;i++)for(const member of ['codex','harness'])for(const phase of ['work','review'])view(member,phase);
 assert.equal(scans,1);assert.equal(view('codex','work').state,'uncalibrated');add(9);
 assert.equal(view('codex','work').sampleCount,9);const next=calibrationSnapshot(store,group);assert.equal(scans,2);assert.equal(next('codex','work').state,'calibrated');assert.deepEqual(next('codex','work'),calibrationFor(store,group,'codex','work'));
});
