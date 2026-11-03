import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {savingsPolicy,serializeContext,reusableVerification,filterOutput} from '../src/context-savings.mjs';
import {finishTask} from '../src/task-list.mjs';
import {fileHash} from '../src/project-files.mjs';import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'savings-'));const store=new GroupStore(path.join(dir,'test.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{}});group.status='active';group.contexts={codex:'c',harness:'h'};
 const {request}=store.input(group.id,{content:'Keep all constraints',origin:{adapter:'test',sessionId:'s',messageId:'h'}});group.activeRequestId=request.id;store.save(group);return {store,group,request,dir};}
test('completed task projection has original access and preserves constraints, permissions and source',t=>{
 const f=fixture(t),msg=f.store.message(f.group.id,{sender:'harness',requestId:f.request.id,channel:'group',content:'original'});
 const task={taskId:'done',status:'done',task:'constraint',deps:['prior'],acceptance:'proof',resources:{reads:['x'],writes:[]},receipts:{work:{messageId:msg.id,summary:'long '.repeat(3000)}}};
 const payload={taskList:[task],approvalStatus:{records:[{status:'rejected'}]},requirement:'constraint'},before=structuredClone(payload);
 const compact=serializeContext(payload,f.store,f.group,f.request),c=JSON.parse(compact.text);assert.equal(c.taskList[0].receipts,undefined);assert.ok(c.taskList[0].originalEvidence[0].url.includes(msg.id));assert.deepEqual(c.approvalStatus,payload.approvalStatus);assert.deepEqual(c.taskList[0].resources,task.resources);assert.deepEqual(payload,before);
 f.group.savings={taskContext:'full'};assert.deepEqual(JSON.parse(serializeContext(payload,f.store,f.group,f.request).text).taskList,[task]);assert.equal(compact.observation.characters.after,compact.text.length);assert.equal(compact.observation.tokenSavings,null);
});
test('output filtering is optional and leaves verification and instructions intact',()=>{
 const m={id:'m',groupId:'g',requestId:'r',content:JSON.stringify({instruction:'constraint',verification:['complete proof'],toolOutput:'log '.repeat(4000)})};
 assert.equal(filterOutput(m,savingsPolicy()).content,m.content);
 const out=JSON.parse(filterOutput(m,savingsPolicy({outputFiltering:true,outputLimitChars:256})).content);assert.equal(out.toolOutput.preview.length,256);assert.deepEqual(out.verification,['complete proof']);assert.equal(out.instruction,'constraint');assert.ok(out.toolOutput.original.includes('messageId=m'));
});
test('incremental and threshold switches change actual prompt history without changing originals',t=>{
 const f=fixture(t);const old=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'OLD_HISTORY'});f.group.cursors.codex=old.seq;f.group.compactThresholdChars=500;
 const fresh=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'NEW_HISTORY'});const e=new GroupEngine(f.store,{});
 let p=JSON.parse(e.prompt(f.group,f.request,'codex','planning').text);assert.equal(p.delta.some(x=>x.id===old.id),false);assert.equal(p.delta.some(x=>x.id===fresh.id),true);
 f.group.savings={incremental:false,thresholdCompaction:false};p=JSON.parse(e.prompt(f.group,f.request,'codex','planning').text);assert.equal(p.delta.some(x=>x.id===old.id),true);
 const huge=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'BIG'.repeat(1000)});
 f.group.savings={incremental:false,thresholdCompaction:true};p=JSON.parse(e.prompt(f.group,f.request,'codex','planning').text);assert.ok(p.historyOmitted.some(x=>x.messageId===huge.id));
 f.group.savings.thresholdCompaction=false;p=JSON.parse(e.prompt(f.group,f.request,'codex','planning').text);assert.ok(p.delta.some(x=>x.id===huge.id));assert.equal(f.store.messageById(huge.id).content.length,3000);
});
test('verification reuse requires matching current hashes and has an effective off switch',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'a'),'original');const msg=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:f.request.id,content:'verified'});
 const task={taskId:'done',revision:0,status:'done',verificationSnapshot:{revision:0,messageId:msg.id,hashes:{a:fileHash(f.dir,'a')}}};f.request.taskList=[task];
 assert.equal(reusableVerification([task],f.store,f.group,f.request).length,1);
 f.group.savings={verificationReuse:false};assert.equal(JSON.parse(serializeContext({taskList:[task]},f.store,f.group,f.request).text).verificationReuse,undefined);
 fs.writeFileSync(path.join(f.dir,'a'),'changed');assert.equal(reusableVerification([task],f.store,f.group,f.request).length,0);
});
test('HTTP switches round trip, evidence lookup is scoped, and token effects remain unknown',async t=>{
 const f=fixture(t),msg=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'full original'});const service=await startGroupService({store:f.store,runtime:{},schedule:false});
 try{const base='/api/groups/'+f.group.id;
  const config=await localFetch(service.descriptor,base+'/savings',{incremental:false,outputFiltering:true});assert.equal(config.strategies.incremental.enabled,false);assert.equal(config.strategies.outputFiltering.enabled,true);assert.equal(config.tokenSavings,null);
  await assert.rejects(localFetch(service.descriptor,base+'/savings',{incremental:'yes'}));assert.equal(f.store.group(f.group.id).savings.incremental,false);
  assert.equal((await localFetch(service.descriptor,base+'/evidence?requestId='+f.request.id+'&messageId='+msg.id)).message.content,'full original');
  await assert.rejects(localFetch(service.descriptor,base+'/evidence?requestId=foreign&messageId='+msg.id));
 }finally{await service.close();}
});
test('final engine dispatch compacts receipts and redacts injected credentials after all metadata',async t=>{
 const f=fixture(t),secret='sk-fixture-not-real-012345',msg=f.store.message(f.group.id,{sender:'harness',channel:'group',requestId:f.request.id,content:'original '+secret});
 f.request.taskList=[{taskId:'old',status:'done',title:'Prior',task:'Keep constraint '+secret,acceptance:'Proof',receipts:{work:{messageId:msg.id,summary:'redundant '.repeat(1000)}}}];f.request.taskListRevision=f.request.revision;f.store.saveRequest(f.request);
 let observed;await new GroupEngine(f.store,{responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>{observed=d.prompt;return {text:JSON.stringify({responseScope:d.id,message:'Read',summary:'Read',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};}}).tick(f.group.id);
 const p=JSON.parse(observed);assert.equal(p.taskList[0].receipts,undefined);assert.doesNotMatch(observed,/redundant/);assert.equal(observed.includes(secret),false);assert.equal(f.store.messageById(msg.id).content,'original '+secret);assert.equal(p.contextSavings.characters.after,observed.length);
});

test('structured output filtering preserves error, evidence and authorization fields',()=>{
 const proof={verification:['complete evidence'],constraints:['read only'],approval:{status:'rejected'},error:{code:'UNKNOWN'}};
 const message={id:'m',groupId:'g',requestId:'r',content:JSON.stringify({toolOutput:{...proof,stdout:'x'.repeat(1000)}})};
 const output=JSON.parse(filterOutput(message,savingsPolicy({outputFiltering:true,outputLimitChars:256})).content).toolOutput;
 for(const [key,value] of Object.entries(proof))assert.deepEqual(output[key],value);assert.equal(output.stdout.preview.length,256);
});

test('accepted integration captures host verification hashes before clearing task execution state',()=>{
 const task={taskId:'t',revision:0,status:'running'},r={id:'r',revision:0,currentTaskId:'t',status:'active',taskList:[task],actions:[],deferred:[],agreement:{integrator:'codex'},results:{'review:harness':{status:'done',verification:['peer']},'integrate:codex':{status:'done',messageId:'m',verification:['checked']}},integrationCheck:{verified:{a:'hash'}}};
 assert.equal(finishTask(r),true);assert.deepEqual(task.verificationSnapshot,{revision:0,messageId:'m',hashes:{a:'hash'}});assert.equal(r.integrationCheck,undefined);
});
