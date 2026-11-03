import test from 'node:test';import assert from 'node:assert/strict';
import {makeTaskList,startNextTask,finishTask,invalidateTasks,taskListView} from '../src/task-list.mjs';
const definition=[{key:'a',title:'First',task:'Implement A',owner:'codex',acceptance:'Tests pass'},{key:'b',title:'Second',task:'Implement B',owner:'harness',acceptance:'Tests pass',deps:['a']}];
const fixture=()=>{const r={id:'r',revision:0,agreement:{integrator:'codex'},results:{}};r.taskList=makeTaskList(r,definition);r.taskListRevision=0;return r;};
const accepted=r=>{r.actions=[];r.results={'review:harness':{status:'done',verification:['review evidence']},'integrate:codex':{status:'done',verification:['integration evidence']}};};
test('each subtask uses the original work review integrate queue and cannot skip acceptance',()=>{
 const r=fixture();startNextTask(r);assert.deepEqual(r.actions.map(a=>a.phase),['work','review','integrate']);assert.throws(()=>startNextTask(r));r.actions=[];assert.equal(finishTask(r),false);accepted(r);finishTask(r);assert.equal(r.taskList[0].status,'done');assert.equal(r.taskList[0].evidenceRefs[0],'integration evidence');startNextTask(r);assert.equal(r.actions[0].member,'harness');assert.equal(r.currentTaskId,r.taskList[1].taskId);
});
test('unknown outcomes and pending checkpoints cannot finish or advance',()=>{
 for(const status of ['blocked','needs_recovery','needs_decision','paused']){const r=fixture();startNextTask(r);accepted(r);r.status=status;assert.equal(finishTask(r),false);assert.equal(taskListView(r).tasks[0].status,'blocked');}
 const r=fixture();startNextTask(r);accepted(r);r.deliveryId='original';assert.equal(finishTask(r),false);
});
test('correction retains history and invalidates only once per revision',()=>{
 const r=fixture();startNextTask(r);r.revision++;invalidateTasks(r);invalidateTasks(r);assert.equal(r.taskListHistory.length,1);assert.ok(taskListView(r).tasks.every(t=>t.status==='invalidated'));assert.throws(()=>startNextTask(r));
});
test('stable IDs survive persisted checkpoint and duplicate completion is inert',()=>{
 let r=fixture();startNextTask(r);const id=r.currentTaskId;r=JSON.parse(JSON.stringify(r));assert.equal(r.currentTaskId,id);accepted(r);finishTask(r);assert.equal(finishTask(r),false);startNextTask(r);assert.notEqual(r.currentTaskId,id);
});
test('invalid dependencies and cycles are rejected',()=>{
 const r=fixture();assert.throws(()=>makeTaskList(r,[{...definition[0],deps:['b']},definition[1]]));
});

test('task checkpoint persists across database reopen and engine advances only after integration',async t=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
 const {GroupStore}=await import('../src/group-store.mjs');const {GroupEngine}=await import('../src/group-engine.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-checkpoint-'));const file=path.join(dir,'db.sqlite');let store=new GroupStore(file);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
 const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});group.status='active';
 const r=fixture();r.groupId=group.id;r.messageId='m';startNextTask(r);store.saveRequest(r);store.close();store=new GroupStore(file);
 const resumed=store.request('r');assert.equal(resumed.currentTaskId,r.currentTaskId);accepted(resumed);
 const engine=new GroupEngine(store,{});engine.finishOrAudit(group,resumed);store.saveRequest(resumed);
 assert.equal(resumed.taskList[0].status,'done');assert.equal(resumed.taskList[1].status,'running');assert.equal(resumed.actions[0].member,'harness');
});

test('read-only task accepts explicit empty integration scope with independent review evidence',()=>{
 const r=fixture();r.taskList[0].readOnly=true;startNextTask(r);accepted(r);
 r.results['integrate:codex']={status:'done',integrationFiles:[]};
 assert.equal(finishTask(r),true);assert.deepEqual(r.taskList[0].evidenceRefs,['review evidence']);
 const missing=fixture();missing.taskList[0].readOnly=true;startNextTask(missing);accepted(missing);missing.results['integrate:codex']={status:'done'};assert.equal(finishTask(missing),false);
 const writable=fixture();startNextTask(writable);accepted(writable);writable.results['integrate:codex']={status:'done',integrationFiles:[]};assert.equal(finishTask(writable),false);
});
test('integration completion racing with original delivery settlement leaves checkpoint untouched',async()=>{
 const {GroupEngine}=await import('../src/group-engine.mjs');
 const r=fixture();startNextTask(r);accepted(r);r.deliveryId='still-settling';const before=structuredClone(r);
 const engine=new GroupEngine({pendingPermissions:()=>[]},{});const group={id:'g',status:'active'};
 assert.doesNotThrow(()=>engine.finishOrAudit(group,r));assert.deepEqual(r,before);assert.equal(group.status,'active');
 delete r.deliveryId;engine.finishOrAudit(group,r);assert.equal(r.taskList[1].status,'running');
});
