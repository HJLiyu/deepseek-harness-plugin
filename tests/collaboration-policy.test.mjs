import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {collaborationPolicy,roleSuggestions,reviewerFor} from '../src/collaboration-policy.mjs';
import {enqueueInitialReview,recordInitialJudgment} from '../src/independent-review.mjs';
import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
const plan={message:'Plan',summary:'Plan',owner:'codex',integrator:'codex',review:false,tasks:{codex:'Implement',harness:''}};
function fixture(t,policy){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'modes-'));const store=new GroupStore(path.join(dir,'test.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{codex:{model:'c'},harness:{model:'h'}}});Object.assign(group,{status:'active',contexts:{codex:'c',harness:'h'},collaboration:policy});
 const {request}=store.input(group.id,{content:'Implement',origin:{adapter:'test',sessionId:'s',messageId:'h'}});group.activeRequestId=request.id;store.save(group);return {store,group,request};}
test('default mixed and peer mode use two planners; coordinator mode uses one original session then independent review',async t=>{
 assert.equal(collaborationPolicy().mode,'mixed');
 for(const mode of ['mixed','peers','coordinator']){
  const f=fixture(t,{mode,coordinator:'harness'}),seen=[];
  const runtime={appOpen:async()=>true,turn:async(_g,d)=>{seen.push(d.member);return {text:JSON.stringify(plan)};}};
  const e=new GroupEngine(f.store,runtime);await e.tick(f.group.id);
  if(mode==='coordinator'){
   const r=f.store.request(f.request.id);assert.deepEqual(seen,['harness']);assert.equal(r.phase,'execution');assert.equal(r.plans.codex,undefined);assert.equal(r.agreement.review,true);assert.equal(r.actions.find(a=>a.phase==='review').member,'harness');
  }else{assert.equal(f.store.request(f.request.id).phase,'planning');await e.tick(f.group.id);assert.equal(seen.length,2);assert.equal(new Set(seen).size,2);}
  assert.deepEqual(f.store.group(f.group.id).contexts,{codex:'c',harness:'h'});
 }
});
test('mode switch during native planning is deferred and does not repeat or replace the admitted delivery',async t=>{
 const f=fixture(t,{mode:'mixed'});const service=await startGroupService({store:f.store,runtime:{},schedule:false});
 try{
  let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let sends=0;
  const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>{sends++;entered();await gate;return {text:JSON.stringify(plan)};}});
  const running=e.tick(f.group.id);await started;
  const before=f.store.request(f.request.id).deliveryId;
  await localFetch(service.descriptor,'/api/groups/'+f.group.id+'/collaboration',{mode:'coordinator',coordinator:'harness',roles:{implementer:'harness',reviewer:'codex'}});
  assert.equal(f.store.request(f.request.id).deliveryId,before);release();await running;
  assert.equal(sends,1);assert.equal(f.store.request(f.request.id).collaboration.mode,'mixed');assert.equal(f.store.group(f.group.id).collaboration.mode,'coordinator');
  await assert.rejects(localFetch(service.descriptor,'/api/groups/'+f.group.id+'/collaboration',{roles:{implementer:'codex',reviewer:'codex'}}));assert.equal(f.store.group(f.group.id).collaboration.mode,'coordinator');
 }finally{await service.close();}
});
test('human role override is enforced while reviewer excludes the executor',async t=>{
 const f=fixture(t,{mode:'coordinator',roles:{implementer:'harness',reviewer:'codex',integrator:'harness'}});
 await new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>({text:JSON.stringify(plan)})}).tick(f.group.id);
 const r=f.store.request(f.request.id);assert.equal(r.agreement.owner,'harness');assert.equal(r.actions[0].member,'harness');assert.equal(r.actions[1].member,'codex');assert.equal(r.agreement.integrator,'harness');assert.equal(reviewerFor('codex',{roles:{reviewer:'codex'}}),'harness');
});
test('role suggestions expose comparable accepted receipt evidence and preserve unknown/tied outcomes',t=>{
 const f=fixture(t);assert.equal(roleSuggestions(f.store,f.group).suggestedMember,null);
 const msg=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'verified work'});
 f.store.saveDelivery({id:'work',groupId:f.group.id,requestId:f.request.id,member:'harness',phase:'work',status:'received',responseMessageId:msg.id});
 const r=f.store.request(f.request.id);r.taskList=[{taskId:'task',status:'done',owner:'harness',readOnly:false,evidenceRefs:['review + integration'],receipts:{'work:harness':{status:'done',messageId:msg.id}}}];r.taskListRevision=r.revision;f.store.saveRequest(r);
 const s=roleSuggestions(f.store,f.group);assert.equal(s.suggestedMember,'harness');assert.equal(s.evidence.harness[0].deliveryId,'work');assert.equal(roleSuggestions(f.store,f.group,'research').suggestedMember,null);
});
test('two executors receive separate peer-only reviews and initial payload binding excludes own work',()=>{
 const store={requests:()=>[],messageById:()=>null},e=new GroupEngine(store,{}),r={id:'r',revision:0,supplements:[],discussionRounds:0,maxDiscussionRounds:1,plans:{codex:{...plan,owner:'both',review:true},harness:{...plan,owner:'both',review:true}}};
 e.converge({collaboration:{mode:'peers'}},r);const reviews=r.actions.filter(a=>a.phase==='review');assert.equal(reviews.length,2);for(const a of reviews)assert.deepEqual(a.reviewTargets,[a.member==='codex'?'harness':'codex']);
 r.actions=reviews;r.results={'work:codex':{status:'done',messageId:'cw'},'work:harness':{status:'done',messageId:'hw'}};
 assert.equal(enqueueInitialReview(r),true);recordInitialJudgment(r,{status:'done',initialJudgment:{verdict:'done',evidence:['peer checked']}},'initial','d');assert.deepEqual(Object.values(r.independentJudgments)[0].work,[['work:harness','hw']]);
});

test('reviewer and integrator suggestions retain their distinct resolution and delivery evidence',t=>{
 const f=fixture(t),w=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:f.request.id,content:'work'}),im=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:f.request.id,content:'integrated'}),rm=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:f.request.id,content:'confirmed defect'});
 f.store.saveDelivery({id:'w',groupId:f.group.id,requestId:f.request.id,member:'codex',phase:'work',status:'received',responseMessageId:w.id});f.store.saveDelivery({id:'i',groupId:f.group.id,requestId:f.request.id,member:'codex',phase:'integrate',status:'received',responseMessageId:im.id});
 const r=f.store.request(f.request.id);r.taskList=[{taskId:'t',status:'done',owner:'codex',evidenceRefs:['accepted'],receipts:{'work:codex':{status:'done',messageId:w.id},'integrate:codex':{status:'done',messageId:im.id}}}];r.taskListRevision=r.revision;r.reviewOutcomes={review:{taskId:'t',member:'harness',messageId:'review',resolution:{messageId:rm.id,category:'true_defect'}}};f.store.saveRequest(r);
 const s=roleSuggestions(f.store,f.group);assert.equal(s.roles.integrator.suggestedMember,'codex');assert.equal(s.roles.reviewer.suggestedMember,'harness');assert.equal(s.roles.reviewer.evidence.harness[0].resolutionMessageId,rm.id);
});
