import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {enqueueInitialReview,recordInitialJudgment} from '../src/independent-review.mjs';
import {recordCrossOutcome,recordQualityResolutions,qualityMetrics} from '../src/review-quality.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'quality-'));const store=new GroupStore(path.join(dir,'test.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{}});group.status='active';group.contexts={codex:'c',harness:'h'};
 const {request:r}=store.input(group.id,{content:'Check boundary',origin:{adapter:'test',sessionId:'s',messageId:'human'}});
 const w=store.message(group.id,{sender:'codex',requestId:r.id,channel:'group',content:'work'});
 Object.assign(r,{phase:'execution',status:'active',agreement:{owner:'codex',integrator:'codex',review:true,tasks:{codex:'Check',harness:''}},actions:[{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}],results:{'work:codex':{messageId:w.id,status:'done'}}});
 group.activeRequestId=r.id;store.save(group);store.saveRequest(r);return {store,group,r,dir};}
function reviewed(f,verdict='changes_requested'){
 const {store,group,r}=f;enqueueInitialReview(r);
 const im=store.message(group.id,{sender:'harness',requestId:r.id,channel:'group',content:'initial evidence'});
 recordInitialJudgment(r,{status:'done',initialJudgment:{verdict,evidence:['boundary case']}},im.id,'initial');
 const cm=store.message(group.id,{sender:'harness',requestId:r.id,channel:'group',content:'cross review'});
 recordCrossOutcome(r,{status:verdict},cm.id,'cross');return {im,cm};
}
test('true defect and false opposition require explicit other-member evidence; unknown has its own denominator',t=>{
 for(const category of ['true_defect','false_opposition']){
  const f=fixture(t),{im,cm}=reviewed(f);assert.equal(qualityMetrics(f.r).unknown,1);
  const msg=f.store.message(f.group.id,{sender:'codex',requestId:f.r.id,channel:'group',content:'test evidence'});
  f.store.saveDelivery({id:'resolve',groupId:f.group.id,requestId:f.r.id,member:'codex',status:'received',responseMessageId:msg.id});
  const value={status:'done',qualityResolutions:[{reviewDeliveryId:'cross',category,evidence:['boundary fixture confirms classification'],evidenceMessageIds:[im.id,cm.id,msg.id]}]};
  recordQualityResolutions(f.store,f.r,value,msg.id,'resolve');recordQualityResolutions(f.store,f.r,value,msg.id,'resolve');f.store.saveRequest(f.r);
  const m=qualityMetrics(f.store.request(f.r.id));assert.equal(m.denominator,1);assert.equal(m.unknown,0);assert.equal(m[category==='true_defect'?'trueDefects':'falseOppositions'],1);assert.equal(m.evidence[0].resolution.messageId,msg.id);
 }
});
test('unsupported following is traceable while agreement and unconfirmed semantic claims remain unknown',t=>{
 const f=fixture(t);reviewed(f);const r=f.r;
 assert.equal(recordCrossOutcome(r,{status:'done'},'unsupported','follow','new evidence required'),true);
 assert.equal(recordCrossOutcome(r,{status:'done'},'duplicate','follow'),false);
 assert.equal(recordCrossOutcome(r,{status:'done',judgmentChange:{evidence:['new test']}},'new','new'),true);
 const m=qualityMetrics(r);assert.equal(m.denominator,3);assert.equal(m.unsubstantiatedFollowing,1);assert.equal(m.unknown,2);assert.equal(m.trueDefects,0);assert.equal(m.evidence.find(x=>x.deliveryId==='follow').accepted,false);
});
test('self-resolution, absent evidence and cross-request references cannot create a confirmed metric',t=>{
 const f=fixture(t),{im,cm}=reviewed(f);const msg=f.store.message(f.group.id,{sender:'harness',requestId:f.r.id,channel:'group',content:'self'});
 f.store.saveDelivery({id:'self',groupId:f.group.id,requestId:f.r.id,member:'harness',status:'received',responseMessageId:msg.id});
 recordQualityResolutions(f.store,f.r,{status:'done',qualityResolutions:[{reviewDeliveryId:'cross',category:'true_defect',evidence:['claim'],evidenceMessageIds:[im.id,cm.id]}]},msg.id,'self');assert.equal(qualityMetrics(f.r).unknown,1);
});
test('native engine path stores initial, cross outcome and peer resolution across restart',async t=>{
 const f=fixture(t);let stage=0;const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>{
  stage++;const base={responseScope:d.id,status:'done',message:'Verified',summary:'Evidence',verification:['boundary test']};
  if(stage===1)return {text:JSON.stringify({...base,initialJudgment:{verdict:'changes_requested',evidence:['boundary concern']}})};
  if(stage===2)return {text:JSON.stringify({...base,judgmentChange:{evidence:['boundary test passes']}})};
  const r=f.store.request(f.r.id),o=Object.values(r.reviewOutcomes)[0];
  return {text:JSON.stringify({...base,integrationFiles:[],qualityResolutions:[{reviewDeliveryId:o.deliveryId,category:'false_opposition',evidence:['original boundary test proves concern incorrect'],evidenceMessageIds:[o.initialMessageId,o.messageId]}]})};
 }};
 const engine=new GroupEngine(f.store,runtime);await engine.tick(f.group.id);await engine.tick(f.group.id);await engine.tick(f.group.id);
 const m=qualityMetrics(f.store.request(f.r.id));assert.equal(stage,3);assert.equal(m.falseOppositions,1);assert.equal(m.denominator,1);
 const reopened=new GroupStore(path.join(f.dir,'test.sqlite'));try{assert.deepEqual(qualityMetrics(reopened.request(f.r.id)),m);}finally{reopened.close();}
});

test('engine rework receipt creates a second initial stage and preserves the first outcome',async t=>{
 const f=fixture(t),runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>({text:JSON.stringify({responseScope:d.id,status:'done',message:'Initial',summary:'Checked',verification:['artifact'],initialJudgment:{verdict:'done',evidence:['artifact checked']}})})};
 const engine=new GroupEngine(f.store,runtime);await engine.tick(f.group.id);
 let r=f.store.request(f.r.id);const first=r.actions[0].crossReviewKey;
 const work=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,content:'new implementation receipt'});r.results['work:codex'].messageId=work.id;r.actions[0].responseRepair={error:'previous response stale'};f.store.saveRequest(r);
 await engine.tick(f.group.id);r=f.store.request(f.r.id);assert.notEqual(r.actions[0].crossReviewKey,first);assert.equal(Object.keys(r.independentJudgments).length,2);assert.ok(r.independentJudgments[first]);assert.equal(r.actions[0].responseRepair,undefined);
});
