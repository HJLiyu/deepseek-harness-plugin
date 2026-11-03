import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {enqueueInitialReview,initialReviewPayload,judgmentIssue,recordInitialJudgment} from '../src/independent-review.mjs';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
const fixture=()=>({id:'r',revision:1,currentTaskId:'t',actions:[{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}],results:{'work:codex':{messageId:'w1'}},agreement:{owner:'codex',tasks:{codex:'Inspect implementation'}}});
const initial={status:'done',initialJudgment:{verdict:'changes_requested',evidence:['file:12 fails boundary']}};

test('initial payload is a whitelist, including after task-list/currentTask injection',()=>{
 const r=fixture();assert.equal(enqueueInitialReview(r),true);
 const p=initialReviewPayload({member:'harness',requirement:'human task',results:'SECRET',delta:['SECRET'],summary:'SECRET',taskList:[{receipts:'SECRET'}],currentTask:{assignment:{repair:'SECRET'},outputContract:{required:[]}}},r,{repo:'repo',worktrees:{codex:'c',harness:'h'}});
 assert.doesNotMatch(JSON.stringify(p),/SECRET/);assert.equal(p.isolation.mode,'partial');assert.match(p.isolation.notice,/不是盲评/);assert.equal(p.currentTask.assignment,p.assignment);
});
test('judgment persists before cross review; change needs new evidence; stale revision rejected',()=>{
 const r=fixture();enqueueInitialReview(r);const key=r.actions[0].initialReviewKey;
 assert.equal(judgmentIssue(r,{status:'done'}).includes('initialJudgment'),true);
 assert.equal(recordInitialJudgment(r,initial,'m1','d1'),true);
 assert.equal(r.actions[0].crossReviewKey,key);assert.equal(r.results['review:harness'],undefined);
 assert.ok(judgmentIssue(r,{status:'done'}));assert.ok(judgmentIssue(r,{status:'done',judgmentChange:{evidence:initial.initialJudgment.evidence}}));
 assert.equal(judgmentIssue(r,{status:'done',judgmentChange:{evidence:['new test now passes']}}),null);
 assert.equal(judgmentIssue(r,{status:'changes_requested'}),null);
 assert.equal(recordInitialJudgment(r,initial,'m2','d2'),false);assert.equal(r.independentJudgments[key].messageId,'m1');
 r.revision++;assert.ok(judgmentIssue(r,{status:'changes_requested'}));
});
test('specialty reviews and in-flight delivery remain untouched; new work receipt changes key',()=>{
 for(const extra of [{deliveryId:'original'},{}]){const r=fixture();Object.assign(r,extra);if(!r.deliveryId)r.actions[0].goalAudit=true;const before=structuredClone(r);assert.equal(enqueueInitialReview(r),false);assert.deepEqual(r,before);}
 const a=fixture(),b=fixture();b.results['work:codex'].messageId='w2';enqueueInitialReview(a);enqueueInitialReview(b);assert.notEqual(a.actions[0].initialReviewKey,b.actions[0].initialReviewKey);
});

test('engine journals initial stage, resumes cross review after restart and rejects unsupported change',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'initial-review-'));let store=new GroupStore(path.join(dir,'test.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});
 group.status='active';group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:dir,harness:dir};
 const {request}=store.input(group.id,{content:'Inspect boundary',origin:{adapter:'test',sessionId:'s',messageId:'human1'}});
 const work=store.message(group.id,{sender:'codex',channel:'group',requestId:request.id,content:'SECRET_PEER_CONCLUSION'});
 Object.assign(request,{phase:'execution',status:'active',agreement:{owner:'codex',integrator:'codex',review:true,tasks:{codex:'Inspect boundary',harness:''}},actions:[{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}],results:{'work:codex':{messageId:work.id,status:'done',summary:'SECRET_PEER_CONCLUSION'}}});
 group.activeRequestId=request.id;store.transaction(()=>{store.save(group);store.saveRequest(request);});
 const prompts=[];const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>{const p=JSON.parse(d.prompt);prompts.push(p);return {text:JSON.stringify({responseScope:d.id,message:'Recorded',summary:'Recorded',verification:['artifact checked'],...initial})};}};
 await new GroupEngine(store,runtime).tick(group.id);
 let r=store.request(request.id);assert.equal(r.actions[0].crossReviewKey,Object.keys(r.independentJudgments)[0]);assert.equal(r.results['review:harness'],undefined);assert.doesNotMatch(JSON.stringify(prompts[0]),/SECRET_PEER_CONCLUSION/);
 store.close();store=new GroupStore(path.join(dir,'test.sqlite'));
 runtime.turn=async(_g,d)=>{const p=JSON.parse(d.prompt);prompts.push(p);return {text:JSON.stringify({responseScope:d.id,message:'Changed without evidence',summary:'Changed',status:'done',verification:['artifact checked']})};};
 await new GroupEngine(store,runtime).tick(group.id);r=store.request(request.id);
 assert.match(JSON.stringify(prompts[1]),/SECRET_PEER_CONCLUSION/);assert.equal(prompts[1].independentJudgment.verdict,'changes_requested');
 assert.equal(r.results['review:harness'],undefined);assert.notEqual(r.actions[0].phase,'integrate');assert.equal(Object.keys(r.independentJudgments).length,1);
 runtime.turn=async(_g,d)=>({text:JSON.stringify({responseScope:d.id,message:'Verified correction',summary:'Verified',status:'done',verification:['boundary test passes'],judgmentChange:{evidence:['new boundary test confirms correction']}})});
 await new GroupEngine(store,runtime).tick(group.id);r=store.request(request.id);
 assert.equal(r.results['review:harness'].status,'done');assert.equal(r.actions[0].phase,'integrate');
 assert.equal(Object.values(r.independentJudgments)[0].verdict,'changes_requested');
});

test('rework, task switch and revision require a fresh initial judgment while old records remain',()=>{
 for(const change of [r=>r.results['work:codex'].messageId='w2',r=>r.currentTaskId='other',r=>r.revision++]){
  const r=fixture();enqueueInitialReview(r);recordInitialJudgment(r,initial,'m1','d1');const oldKey=r.actions[0].crossReviewKey;change(r);
  assert.ok(judgmentIssue(r,{status:'changes_requested'}));assert.equal(enqueueInitialReview(r),true);assert.notEqual(r.actions[0].initialReviewKey,oldKey);
  assert.equal(recordInitialJudgment(r,initial,'m2','d2'),true);assert.equal(judgmentIssue(r,{status:'changes_requested'}),null);assert.equal(r.independentJudgments[oldKey].messageId,'m1');assert.equal(Object.keys(r.independentJudgments).length,2);
 }
});
test('receipt change while initial judgment is pending rejects stale delivery and rebinds without duplicate stages',()=>{
 const r=fixture();enqueueInitialReview(r);const old=r.actions[0].initialReviewKey;r.results['work:codex'].messageId='w2';
 assert.equal(recordInitialJudgment(r,initial,'stale','old'),false);assert.equal(enqueueInitialReview(r),true);assert.notEqual(r.actions[0].initialReviewKey,old);assert.equal(r.actions.length,3);assert.equal(enqueueInitialReview(r),false);
});
