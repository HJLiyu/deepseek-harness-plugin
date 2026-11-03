import test from'node:test';import assert from'node:assert/strict';import{projectTaskContext}from'../src/task-context.mjs';
const id='00000000-0000-4000-8000-000000000001';
const resolved={resolveEvidence:value=>value===id?{id,groupId:'g',requestId:'r'}:null,groupId:'g',requestId:'r'};
const fixture=()=>[{taskId:'a',key:'task-a',title:'字幕 task-specific risk-based',task:'保留所有约束',owner:'codex',status:'done',deps:[],acceptance:'检查真实证据',revision:1,resources:{reads:['src'],writes:[]},evidenceRefs:['long evidence '.repeat(1000)],receipts:{'work:codex':{messageId:id,summary:'long output '.repeat(1000)},'review:harness':{messageId:id}},privateField:'not an instruction'}];
test('compact metadata keeps authoritative message references without repeating entire receipts',()=>{
  const input=fixture(),snapshot=structuredClone(input),out=projectTaskContext(input,resolved);assert.deepEqual(out.tasks[0].evidenceRefs,[id]);assert.equal(out.tasks[0].receipts,undefined);assert.equal(out.tasks[0].privateField,undefined);assert.deepEqual(input,snapshot);assert.ok(out.observation.after<out.observation.before);
});
test('assignment, acceptance, resources and dependencies survive compact projection',()=>{
  const input=fixture();input[0].deps=['earlier'];const out=projectTaskContext(input).tasks[0];for(const key of ['task','acceptance','resources','deps','title','status','owner','revision'])assert.deepEqual(out[key],input[0][key]);
});
test('legacy evidence with no resolvable message identity remains complete',()=>{
  const input=fixture();input[0].receipts={work:{messageId:'not-a-canonical-reference'}};const out=projectTaskContext(input).tasks[0];assert.deepEqual(out.evidenceRefs,input[0].evidenceRefs);assert.equal(out.evidenceMode,'legacy_evidence_preserved');
});
test('full mode is selectable and clones records rather than modifying original storage',()=>{
  const input=fixture(),out=projectTaskContext(input,{mode:'full'});assert.deepEqual(out.tasks,input);out.tasks[0].receipts['work:codex'].summary='changed';assert.notEqual(input[0].receipts['work:codex'].summary,'changed');assert.equal(out.observation.delta,0);
});
test('measured material reduction never claims token or billing savings or an extra model call',()=>{
  const out=projectTaskContext(fixture(),resolved).observation;assert.equal(out.unit,'characters');assert.equal(out.delta,out.after-out.before);assert.equal(out.tokenSavings,null);assert.equal(out.providerUsageCompared,false);assert.equal(out.extraModelCalls,0);
});
test('empty task list is valid while unknown policies and malformed records are rejected',()=>{
  assert.deepEqual(projectTaskContext([]).tasks,[]);assert.throws(()=>projectTaskContext(fixture(),{mode:'guess'}));assert.throws(()=>projectTaskContext(null));assert.throws(()=>projectTaskContext([null]));
});
test('missing, cross-request or partially unresolved originals keep the full receipt evidence',()=>{
  for(const options of [{},{...resolved,requestId:'other'},{...resolved,resolveEvidence:()=>null},{...resolved,resolveEvidence:()=>{throw Error('unavailable');}}]){
    const input=fixture(),out=projectTaskContext(input,options);assert.deepEqual(out.tasks[0].receipts,input[0].receipts);assert.deepEqual(out.tasks[0].evidenceRefs,input[0].evidenceRefs);
  }
});
