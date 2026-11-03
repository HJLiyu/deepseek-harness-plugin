import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {randomUUID} from 'node:crypto';import {GroupStore} from '../src/group-store.mjs';import {GroupRuntime} from '../src/group-runtime.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {ScopeGrants,scopeQuestion,scopeProof,scopeHash} from '../src/scope-grants.mjs';import {ToolExecutor,ToolRegistry} from '../src/tool-registry.mjs';
import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';import {makeTaskList,startNextTask} from '../src/task-list.mjs';
import {Worker} from 'node:worker_threads';import {resourceClaims} from '../src/group-admission.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'grants-')),store=new GroupStore(path.join(dir,'test.sqlite')),repo=path.join(dir,'project'),workspace=path.join(dir,'workspace');
 for(const root of [repo,workspace])fs.mkdirSync(path.join(root,'data'),{recursive:true});
 t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo,models:{codex:{},harness:{}}});g.status='active';g.contexts={codex:'c',harness:'h'};g.worktrees={codex:workspace,harness:workspace};g.approvalOwnerThreadId='owner';
 const {request:r}=store.input(g.id,{content:'Bounded local work'});g.activeRequestId=r.id;store.save(g);
 const turns=[],runtime=new GroupRuntime(store,{readUserTurns:async({threadId})=>threadId==='owner'?turns:[]});let n=Date.now();
 const manager=new ScopeGrants(store,runtime,{now:()=>n});return {dir,store,g,r,workspace,turns,runtime,manager,setNow:value=>n=value};
}
let seq=0;
function answer(f,g,action='allow',overrides={}){const i=++seq;const reply={question:scopeQuestion(g,action==='revoke'?'revoke':'approve'),answer:action==='allow'?'批准':action==='reject'?'拒绝':'撤销',questionItemId:JSON.stringify(['request_user_input_async','call_native'+i,0]),...overrides};const t={turnId:'t'+i,itemId:'i'+i,status:'completed',text:'<send_user_message_question_reply>'+JSON.stringify([reply])+'</send_user_message_question_reply>'};f.turns.push(t);return t;}
const spec=f=>({requestId:f.r.id,ownerThreadId:'owner',member:'codex',root:'workspace',resources:{reads:['data'],writes:['data']},categories:['write'],toolIds:['file.write'],notBefore:Date.now()-1000,expiresAt:Date.now()+60000,maxCalls:3,maxBudgetUnits:6});
async function approved(f,overrides={}){const g=await f.manager.request(f.g.id,{...spec(f),...overrides});answer(f,g);await f.manager.refresh(f.g.id);return f.manager.get(g.id);}
function delivery(f,id=randomUUID()){const d={id,groupId:f.g.id,requestId:f.r.id,member:'codex',phase:'work',revision:f.r.revision,epoch:f.g.epoch,status:'pending',started:true,toolScope:{reads:['data'],writes:['data']}};f.store.saveDelivery(d);return d;}
function registry(handler,costBoundUnits=2){const registry=new ToolRegistry();registry.register({id:'file.write',kind:'api',params:{file:{type:'string',required:true},text:{type:'string',required:true}},resources:p=>({reads:[],writes:[p.file]}),category:'write',needsGrant:true,timeoutMs:25,costBoundUnits},handler??((p,{repo})=>{fs.writeFileSync(path.join(repo,p.file),p.text);return {written:true};}));return registry;}
const input=(d,g,id='one',file='data/a')=>({deliveryId:d.id,grantId:g.id,callId:id,toolId:'file.write',params:{file,text:'local'}});
const signal=()=>new AbortController().signal;
function releaseReview(f,proposal){
 const d={id:randomUUID(),groupId:f.g.id,requestId:f.r.id,member:'harness',phase:'review',status:'received',scopeReleaseProposals:[proposal]};
 const m=f.store.message(f.g.id,{sender:'harness',requestId:f.r.id,channel:'group',protocol:true,content:JSON.stringify({responseScope:d.id,status:'done',scopeReleaseResolutions:[{reservationId:proposal.reservationId,evidenceHash:proposal.hash,nonExecutionVerified:true}]}),origin:{adapter:'harness-reply',sessionId:f.g.contexts.harness,messageId:d.id}});
 d.responseMessageId=m.id;f.store.saveDelivery(d);return m.id;
}
test('unknown charges keep both quotas held; confirmed zero charges restore both atomically',async t=>{
 const f=fixture(t),g=await approved(f,{maxBudgetUnits:10}),d=delivery(f),before=f.manager.get(g.id);
 const result=await new ToolExecutor(f.store,registry(async()=>new Promise(()=>{}),10),{grants:f.manager}).invoke(f.g.id,input(d,g),signal());
 const evidence={source:'provider_terminal_receipt',receiptId:'cost-check',operationHash:result.operationHash,terminal:true,notExecuted:true,chargedUnits:null};f.runtime.scopeExecutionEvidence=async()=>evidence;
 await assert.rejects(f.manager.prepareRelease(f.g.id,result.id),/charged units/i);
 // An already-persisted proposal from the older version cannot bypass the
 // final atomic gate, even with an independently delivered matching review.
 const row=f.manager.reservations(f.g.id).find(r=>r.id===result.id),legacy={reservationId:result.id,evidence,hash:scopeHash(evidence)};row.releaseProposal=legacy;f.manager.saveReservation(row);
 assert.throws(()=>f.manager.release(f.g.id,result.id,releaseReview(f,legacy)),/charged units/i);
 assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,10);assert.equal(f.manager.reservations(f.g.id)[0].state,'held');
 evidence.chargedUnits=0;const proposal=await f.manager.prepareRelease(f.g.id,result.id),messageId=releaseReview(f,proposal);f.manager.release(f.g.id,result.id,messageId);
 const after=f.manager.get(g.id);assert.equal(after.usedCalls,before.usedCalls);assert.equal(after.usedBudgetUnits,before.usedBudgetUnits);assert.equal(after.contract.maxCalls-after.usedCalls,before.contract.maxCalls-before.usedCalls);assert.equal(after.contract.maxBudgetUnits-after.usedBudgetUnits,10);
 assert.equal(f.manager.release(f.g.id,result.id,messageId).duplicate,true);assert.equal((await new ToolExecutor(f.store,registry(),{grants:f.manager}).invoke(f.g.id,input(d,g),signal())).duplicate,true);
});
test('charges exceeding the reserved bound cannot prepare or release quota',async t=>{
 const f=fixture(t),g=await approved(f,{maxBudgetUnits:10}),d=delivery(f),result=await new ToolExecutor(f.store,registry(async()=>new Promise(()=>{}),10),{grants:f.manager}).invoke(f.g.id,input(d,g),signal());
 const evidence={source:'provider_terminal_receipt',receiptId:'over-bound',operationHash:result.operationHash,terminal:true,notExecuted:true,chargedUnits:11};f.runtime.scopeExecutionEvidence=async()=>evidence;
 await assert.rejects(f.manager.prepareRelease(f.g.id,result.id),/reserved bound/i);
 const row=f.manager.reservations(f.g.id).find(r=>r.id===result.id),legacy={reservationId:result.id,evidence,hash:scopeHash(evidence)};row.releaseProposal=legacy;f.manager.saveReservation(row);
 assert.throws(()=>f.manager.release(f.g.id,result.id,releaseReview(f,legacy)),/reserved bound/i);assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,10);assert.equal(f.manager.reservations(f.g.id)[0].state,'held');
});
test('only a fresh exact native human question reply activates a bounded parent scope',async t=>{
 const f=fixture(t);f.turns.push({turnId:'old',itemId:'old',status:'completed',text:'批准 old-id'});
 const g=await f.manager.request(f.g.id,spec(f));assert.equal(g.status,'pending');
 const old=answer(f,g);assert.equal(scopeProof([old],{...g,barrier:[old.turnId+':'+old.itemId]}).length,0);f.turns.pop();
 answer(f,g,'allow',{questionItemId:'claimed-agent-proof'});await f.manager.refresh(f.g.id);assert.equal(f.manager.get(g.id).status,'pending');
 const incomplete=answer(f,g);incomplete.status='inProgress';await f.manager.refresh(f.g.id);assert.equal(f.manager.get(g.id).status,'pending');
 incomplete.status='completed';await f.manager.refresh(f.g.id);assert.equal(f.manager.get(g.id).status,'active');
 answer(f,g,'revoke');await f.manager.refresh(f.g.id);answer(f,g);await f.manager.refresh(f.g.id);assert.equal(f.manager.get(g.id).status,'revoked');
 await assert.rejects(f.manager.request(f.g.id,{...spec(f),ownerThreadId:'c'}));await assert.rejects(f.manager.request(f.g.id,{...spec(f),approved:true}));
 const fresh=await f.manager.request(f.g.id,spec(f));assert.notEqual(fresh.id,g.id);await f.manager.refresh(f.g.id);assert.equal(f.manager.get(fresh.id).status,'pending');
});
test('provider non-execution evidence needs an independent original review and retains incurred cost',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(async()=>new Promise(()=>{})),{grants:f.manager}),result=await ex.invoke(f.g.id,input(d,g),signal());
 await assert.rejects(f.manager.prepareRelease(f.g.id,result.id));
 f.runtime.scopeExecutionEvidence=async call=>({source:'provider_terminal_receipt',receiptId:'provider-receipt',operationHash:call.operationHash,notExecuted:true,terminal:false,chargedUnits:1});await assert.rejects(f.manager.prepareRelease(f.g.id,result.id));
 f.runtime.scopeExecutionEvidence=async call=>({source:'provider_terminal_receipt',receiptId:'provider-receipt',operationHash:call.operationHash,notExecuted:true,terminal:true,chargedUnits:1});
 const proposal=await f.manager.prepareRelease(f.g.id,result.id),review={id:randomUUID(),groupId:f.g.id,requestId:f.r.id,member:'codex',phase:'review',status:'received',scopeReleaseProposals:[proposal]};
 const receipt=member=>f.store.message(f.g.id,{sender:member,requestId:f.r.id,channel:'group',protocol:true,content:JSON.stringify({responseScope:review.id,status:'done',scopeReleaseResolutions:[{reservationId:result.id,evidenceHash:proposal.hash,nonExecutionVerified:true}]}),origin:{adapter:member+'-reply',sessionId:f.g.contexts[member],messageId:review.id}});
 let m=receipt('codex');review.responseMessageId=m.id;f.store.saveDelivery(review);assert.throws(()=>f.manager.release(f.g.id,result.id,m.id));
 review.member='harness';review.initialReview=true;m=receipt('harness');review.responseMessageId=m.id;f.store.saveDelivery(review);assert.throws(()=>f.manager.release(f.g.id,result.id,m.id));
 review.initialReview=false;f.store.saveDelivery(review);const released=f.manager.release(f.g.id,result.id,m.id);assert.equal(released.release.refundedUnits,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,1);assert.equal(f.manager.get(g.id).usedCalls,0);assert.equal((await ex.invoke(f.g.id,input(d,g),signal())).duplicate,true);
});
test('native proof read failure, not-before time, request revision and native context changes fail closed',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(),{grants:f.manager});
 f.runtime.scopeUserTurns=async()=>{throw Error('reader unavailable');};assert.equal((await ex.invoke(f.g.id,input(d,g,'unavailable'),signal())).reason,'native_scope_proof_unavailable');delete f.runtime.scopeUserTurns;
 const future=await approved(f,{notBefore:Date.now()+30000});assert.equal((await ex.invoke(f.g.id,input(d,future,'future'),signal())).reason,'scope_expired_or_not_yet_valid');
 const current=f.store.group(f.g.id);current.contexts.codex='different';f.store.save(current);assert.equal((await ex.invoke(f.g.id,input(d,g,'context'),signal())).reason,'scope_binding_mismatch');
 current.contexts.codex='c';f.store.save(current);const r=f.store.request(f.r.id);r.revision++;f.store.saveRequest(r);const changed=delivery(f);changed.revision=r.revision;f.store.saveDelivery(changed);assert.equal((await ex.invoke(f.g.id,input(changed,g,'revision'),signal())).reason,'scope_binding_mismatch');
});
test('effectful host calls bind resource/category/member/request/epoch and consume quota exactly once',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(),{grants:f.manager});
 const done=await ex.invoke(f.g.id,input(d,g),signal());assert.equal(done.resultStatus,'done');assert.equal(fs.readFileSync(path.join(f.workspace,'data/a'),'utf8'),'local');assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,2);
 assert.equal((await ex.invoke(f.g.id,input(d,g),signal())).duplicate,true);assert.equal(f.manager.get(g.id).usedCalls,1);
 await assert.rejects(ex.invoke(f.g.id,{...input(d,g),grantId:'old-id'},signal()),/rebound/);
 assert.equal((await ex.invoke(f.g.id,input(d,g,'out','elsewhere'),signal())).reason,'resource_out_of_scope');
 const wrong=await approved(f,{categories:['read']});assert.equal((await ex.invoke(f.g.id,input(d,wrong,'category'),signal())).reason,'scope_resource_or_category_mismatch');
 const restricted=await approved(f,{resources:{reads:[],writes:['data/b']}});assert.equal((await ex.invoke(f.g.id,input(d,restricted,'resource'),signal())).reason,'scope_resource_or_category_mismatch');
 const h=delivery(f);h.member='harness';f.store.saveDelivery(h);assert.equal((await ex.invoke(f.g.id,input(h,g,'member'),signal())).reason,'scope_binding_mismatch');
 const current=f.store.group(f.g.id);current.epoch++;f.store.save(current);const newer=delivery(f);newer.epoch=current.epoch;f.store.saveDelivery(newer);assert.equal((await ex.invoke(f.g.id,input(newer,g,'epoch'),signal())).reason,'scope_binding_mismatch');
});
test('atomic count/budget reservation prevents concurrent double spend across delivery identities',async t=>{
 const f=fixture(t),g=await approved(f,{maxCalls:1,maxBudgetUnits:2});let entered=0,finish;
 const ex=new ToolExecutor(f.store,registry(()=>{entered++;return new Promise(r=>finish=r);}),{grants:f.manager}),a=delivery(f),b=delivery(f);
 const first=ex.invoke(f.g.id,input(a,g,'a'),signal());await new Promise(r=>setTimeout(r,5));
 const second=await ex.invoke(f.g.id,input(b,g,'b'),signal());assert.equal(second.reason,'scope_call_limit');assert.equal(entered,1);finish({ok:true});await first;assert.equal(f.manager.get(g.id).usedBudgetUnits,2);
 const budget=await approved(f,{maxCalls:2,maxBudgetUnits:1});assert.equal((await ex.invoke(f.g.id,input(b,budget,'budget'),signal())).reason,'scope_budget_limit');
 const unknown=await approved(f);assert.equal((await new ToolExecutor(f.store,registry(()=>({}),null),{grants:f.manager}).invoke(f.g.id,input(b,unknown,'unknowncost'),signal())).reason,'scope_cost_bound_unknown');
});
test('new native revocation blocks subsequent admission and preserves completed effects and charges',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(),{grants:f.manager});await ex.invoke(f.g.id,input(d,g),signal());
 answer(f,g,'revoke').status='inProgress';assert.equal((await ex.invoke(f.g.id,input(d,g,'after'),signal())).reason,'scope_not_active');assert.equal(f.manager.get(g.id).status,'revoked');assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,2);assert.equal(fs.readFileSync(path.join(f.workspace,'data/a'),'utf8'),'local');
});
test('expiry and cancellation never refund or prove non-execution; unknown entries survive reopen',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f);let calls=0;const ex=new ToolExecutor(f.store,registry(async()=>{calls++;await new Promise(()=>{});}),{grants:f.manager});
 const result=await ex.invoke(f.g.id,input(d,g),signal());assert.equal(result.resultStatus,'unknown');assert.equal(f.manager.get(g.id).usedCalls,1);f.setNow(g.contract.expiresAt+1);
 assert.equal((await ex.invoke(f.g.id,input(delivery(f),g,'expired'),signal())).reason,'scope_expired_or_not_yet_valid');assert.equal(f.manager.get(g.id).usedBudgetUnits,2);
 await assert.rejects(f.manager.prepareRelease(f.g.id,result.id));f.store.close();const reopened=new GroupStore(path.join(f.dir,'test.sqlite'));try{
  const grants=new ScopeGrants(reopened,f.runtime),duplicate=await new ToolExecutor(reopened,registry(()=>{calls++;}),{grants}).invoke(f.g.id,input(d,g),signal());assert.equal(duplicate.resultStatus,'unknown');assert.equal(calls,1);assert.equal(grants.get(g.id).usedCalls,1);
 }finally{reopened.close();}
});
test('revocation during host credential lookup prevents execution and holds quota for independent release',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f);let entered=0;
 const ex=new ToolExecutor(f.store,registry(()=>{entered++;}),{grants:f.manager,credentials:()=>{answer(f,g,'revoke');return {};}});
 const result=await ex.invoke(f.g.id,input(d,g),signal());assert.equal(result.resultStatus,'unknown');assert.equal(result.reason,'scope_changed_before_execution');assert.equal(entered,0);assert.equal(f.manager.get(g.id).usedCalls,1);
 const proposal=await f.manager.prepareRelease(f.g.id,result.id);assert.equal(proposal.evidence.source,'host_journal_not_entered');assert.throws(()=>f.manager.release(f.g.id,result.id,'claimed-message'));
 // A real native review delivery, not a caller-supplied reviewer label, receives
 // and verifies the immutable host proposal before the engine applies release.
 const r=f.store.request(f.r.id);r.phase='work';r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'local',harness:''}};r.actions=[{phase:'review',member:'harness',scopeReleaseReview:true,task:'Independently verify non-entry'}];delete r.deliveryId;f.store.saveRequest(r);
 d.status='received';d.responseMessageId=f.store.message(f.g.id,{sender:'codex',requestId:r.id,channel:'group',content:'Unknown retained'}).id;f.store.saveDelivery(d);
 let reviewMessage;f.runtime.canTurn=async()=>true;f.runtime.responseScopeProtocol=1;f.runtime.appOpen=async()=>true;f.runtime.turn=async(_g,review)=>{
  const payload=JSON.parse(review.prompt);assert.equal(payload.scopeReleaseProposals[0].hash,proposal.hash);
  return {text:JSON.stringify({responseScope:review.id,status:'done',message:'Verified non-entry',summary:'Verified',verification:['host journal has a terminal outcome and no entry marker'],scopeReleaseResolutions:[{reservationId:result.id,evidenceHash:proposal.hash,nonExecutionVerified:true}]})};
 };
 await new GroupEngine(f.store,f.runtime).tick(f.g.id);const released=f.manager.reservations(f.g.id).find(x=>x.id===result.id);assert.equal(released.state,'released');reviewMessage=released.release.messageId;assert.equal(f.manager.get(g.id).usedCalls,0);assert.equal(f.manager.get(g.id).status,'revoked');assert.equal(f.manager.release(f.g.id,result.id,reviewMessage).duplicate,true);
 assert.equal((await ex.invoke(f.g.id,input(d,g),signal())).duplicate,true);assert.equal(entered,0);
});
test('actual engine performs one locally authorized write through the original delivery chain',async t=>{
 const f=fixture(t),g=await approved(f);f.r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'Local marker',harness:''}};
 f.r.taskList=makeTaskList(f.r,[{key:'local',title:'Local',task:'Write local marker',owner:'codex',acceptance:'marker',resources:{reads:[],writes:['data']}}]);f.r.taskListRevision=f.r.revision;startNextTask(f.r);f.store.saveRequest(f.r);
 f.runtime.responseScopeProtocol=1;f.runtime.appOpen=async()=>true;let result;
 f.runtime.turn=async(_g,d,_s,_a,tools)=>{result=await tools.invokeTool({callId:'authorized',toolId:'file.write',params:{file:'data/a',text:'local'},grantId:g.id});return {text:JSON.stringify({responseScope:d.id,status:'done',message:'Local marker',summary:'Local marker',verification:['local file'],integrationFiles:[]})};};
 await new GroupEngine(f.store,f.runtime,{toolRegistry:registry()}).tick(f.g.id);assert.equal(result?.resultStatus,'done');assert.equal(f.manager.reservations(f.g.id)[0].deliveryId,result.deliveryId);assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.store.admissions().observation(f.g.id).schedulingImplemented,false);
});
test('HTTP scope requests cannot accept claimed human proof and revocation intent fails closed',async t=>{
 const f=fixture(t),service=await startGroupService({store:f.store,runtime:f.runtime,schedule:false});try{const base='/api/groups/'+f.g.id;
  const grant=await localFetch(service.descriptor,base+'/scope-request',spec(f));assert.equal(grant.status,'pending');await assert.rejects(localFetch(service.descriptor,base+'/scope-refresh',{approved:true}));
  answer(f,grant);await localFetch(service.descriptor,base+'/scope-refresh',{});assert.equal((await localFetch(service.descriptor,base+'/scopes')).grants[0].status,'active');
  const revoke=await localFetch(service.descriptor,base+'/scope-revoke',{grantId:grant.id});assert.equal(revoke.admissionStopped,true);assert.equal(revoke.requiresNativeProof,true);assert.equal(f.manager.get(grant.id).status,'active');
 }finally{await service.close();}
});
test('scope grants cannot turn read-only reviews into executors or bypass the project integration lock',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(),{grants:f.manager});
 d.phase='review';f.store.saveDelivery(d);assert.equal((await ex.invoke(f.g.id,input(d,g,'review'),signal())).reason,'read_only_phase');
 const project=await approved(f,{root:'project'});d.phase='integrate';f.store.saveDelivery(d);assert.equal((await ex.invoke(f.g.id,input(d,project,'locked'),signal())).reason,'integration_lock_required');
 f.store.db.prepare('INSERT INTO integrations VALUES(?,?)').run(f.g.repo,f.r.id);assert.equal((await ex.invoke(f.g.id,input(d,project,'integrate'),signal())).resultStatus,'done');assert.equal(fs.readFileSync(path.join(f.g.repo,'data/a'),'utf8'),'local');
 const invalid=new ToolRegistry();invalid.register({id:'file.write',kind:'api',params:{file:{type:'string',required:true},text:{type:'string',required:true}},resources:p=>({reads:[],writes:[p.file]}),category:'read',needsGrant:false,timeoutMs:100,costBoundUnits:0},()=>{throw Error('must not execute');});
 d.phase='work';f.store.saveDelivery(d);assert.equal((await new ToolExecutor(f.store,invalid,{grants:f.manager}).invoke(f.g.id,input(d,g,'classification'),signal())).reason,'tool_category_mismatch');
});
test('two independent SQLite writers cannot reserve the final parent quota twice',async t=>{
 const f=fixture(t),g=await approved(f,{maxCalls:1,maxBudgetUnits:2}),claims=resourceClaims(f.workspace,{reads:[],writes:['data/a']});
 const run=id=>new Promise((resolve,reject)=>{
  const worker=new Worker(`const {parentPort,workerData:d}=require('node:worker_threads');Promise.all([import(d.storeURL),import(d.scopeURL)]).then(([{GroupStore},{ScopeGrants}])=>{const s=new GroupStore(d.file);try{const grants=new ScopeGrants(s,{});parentPort.postMessage(s.transaction(()=>grants.reserve(d.grantId,d.call,d.delivery,d.tool,d.root)));}finally{s.close();}}).catch(e=>{throw e});`,{eval:true,workerData:{storeURL:new URL('../src/group-store.mjs',import.meta.url).href,scopeURL:new URL('../src/scope-grants.mjs',import.meta.url).href,file:path.join(f.dir,'test.sqlite'),grantId:g.id,call:{id,groupId:f.g.id,requestId:f.r.id,deliveryId:id,revision:f.r.revision,epoch:f.g.epoch,operationHash:id,resources:claims},delivery:{member:'codex',phase:'work'},tool:{id:'file.write',category:'write',costBoundUnits:2},root:f.workspace}});
  worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('quota worker failed'));});
 });
 const results=await Promise.all([run('race-a'),run('race-b')]);assert.equal(results.filter(r=>r.allowed).length,1);assert.equal(f.manager.get(g.id).usedCalls,1);assert.equal(f.manager.get(g.id).usedBudgetUnits,2);
});
test('pending parent approval stops new native admission and fresh owner evidence resumes automatically',async t=>{
 const f=fixture(t),pending=await f.manager.request(f.g.id,spec(f));let turns=0;
 f.runtime.responseScopeProtocol=1;f.runtime.appOpen=async()=>true;f.runtime.turn=async(_g,d)=>{turns++;return {text:JSON.stringify({responseScope:d.id,message:'Read',summary:'Read',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};};
 const engine=new GroupEngine(f.store,f.runtime);await engine.tick(f.g.id);assert.equal(turns,0);assert.equal(f.store.hasPendingScopes(f.g.id),true);
 answer(f,pending);await engine.tick(f.g.id);assert.equal(turns,1);assert.equal(f.manager.get(pending.id).status,'active');assert.equal(f.store.hasPendingScopes(f.g.id),false);assert.equal(f.manager.list(f.g.id)[0].question,null);
});
test('identical effects in two child calls still have different operation identities',async t=>{
 const f=fixture(t),g=await approved(f),d=delivery(f),ex=new ToolExecutor(f.store,registry(),{grants:f.manager});
 const a=await ex.invoke(f.g.id,input(d,g,'a'),signal()),b=await ex.invoke(f.g.id,input(d,g,'b'),signal());assert.equal(a.resultStatus,'done');assert.equal(b.resultStatus,'done');assert.notEqual(a.operationHash,b.operationHash);assert.equal(a.paramsHash,b.paramsHash);
});
