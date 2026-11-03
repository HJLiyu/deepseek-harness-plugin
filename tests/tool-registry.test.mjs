import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {GroupStore} from '../src/group-store.mjs';import {GroupEngine} from '../src/group-engine.mjs';
import {ToolRegistry,ToolExecutor,localToolRegistry} from '../src/tool-registry.mjs';
import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {makeTaskList,startNextTask} from '../src/task-list.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tools-')),file=path.join(dir,'test.sqlite'),store=new GroupStore(file);
 t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{}});g.status='active';g.contexts={codex:'c',harness:'h'};
 const {request:r}=store.input(g.id,{content:'Read only local tool check',origin:{adapter:'test',sessionId:'s',messageId:'m'}});g.activeRequestId=r.id;store.save(g);
 return {dir,file,store,g,r};}
const empty=()=>({reads:[],writes:[]});
const def=(id,overrides={})=>({id,kind:'api',params:{text:{type:'string',required:true,maxLength:100}},resources:empty,category:'read',needsGrant:false,timeoutMs:1000,...overrides});
function delivery(f){const d={id:'delivery',groupId:f.g.id,requestId:f.r.id,revision:f.r.revision,epoch:f.g.epoch,member:'codex',phase:'work',status:'pending',started:true,toolScope:{reads:['allowed'],writes:[]}};f.store.saveDelivery(d);return d;}
const call=(d,callId,toolId,params={text:'hello'})=>({callId,deliveryId:d.id,toolId,params});
test('host registry rejects unknown fields, credential parameters, invalid schemas and effectful unguarded tools',()=>{
 const r=new ToolRegistry();assert.throws(()=>r.register({...def('test'),endpoint:'bad'},()=>{}));
 assert.throws(()=>r.register(def('test',{params:{apiKey:{type:'string',required:true}}}),()=>{}));
 assert.throws(()=>r.register(def('test',{category:'write'}),()=>{}));
 r.register(def('test'),()=>{});assert.throws(()=>r.register(def('test'),()=>{}));
 assert.equal(r.catalog()[0].execute,undefined);assert.equal(r.catalog()[0].resources,'host_resolved_from_validated_parameters');
});
test('canonical path and alias scope, strict parameters, grant denial and audit survive SQLite reopen',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.dir,'allowed'));fs.writeFileSync(path.join(f.dir,'allowed','a'),'local');fs.writeFileSync(path.join(f.dir,'outside'),'outside');
 fs.linkSync(path.join(f.dir,'allowed','a'),path.join(f.dir,'alias'));
 const d=delivery(f),registry=new ToolRegistry();let executed=0;
 registry.register(def('file',{params:{file:{type:'string',required:true}},resources:p=>({reads:[p.file],writes:[]})}),p=>{executed++;return {content:fs.readFileSync(path.join(f.dir,p.file),'utf8')};});
 registry.register(def('write',{category:'write',needsGrant:true}),()=>{throw Error('must not run');});
 registry.register(def('irreversible',{category:'irreversible',needsGrant:true}),()=>{throw Error('must not run');});
 const executor=new ToolExecutor(f.store,registry),signal=new AbortController().signal;
 const a=await executor.invoke(f.g.id,call(d,'one','file',{file:'allowed/a'}),signal);assert.equal(a.result.content,'local');assert.equal(a.resultStatus,'done');
 assert.equal((await executor.invoke(f.g.id,call(d,'alias','file',{file:'alias'}),signal)).reason,'resource_out_of_scope'); // directory scope does not grant a second hardlink path
 for(const file of ['outside','../escape'])assert.equal((await executor.invoke(f.g.id,call(d,'bad'+file.length,'file',{file}),signal)).decision,'denied');
 assert.equal((await executor.invoke(f.g.id,call(d,'badparams','file',{file:'allowed/a',extra:true}),signal)).reason,'invalid_parameters_or_resources');
 for(const id of ['write','irreversible'])assert.equal((await executor.invoke(f.g.id,call(d,id,id),signal)).reason,'grant_required');
 const duplicate=await executor.invoke(f.g.id,call(d,'one','file',{file:'allowed/a'}),signal);assert.equal(duplicate.duplicate,true);assert.equal(executed,1);
 await assert.rejects(executor.invoke(f.g.id,call(d,'one','file',{file:'outside'}),signal),/rebound/);
 f.store.close();const reopened=new GroupStore(f.file);try{assert.equal(new ToolExecutor(reopened,registry).calls(f.g.id).length,7);}finally{reopened.close();}
});
test('real engine dispatch calls both local API and CLI tools and audits denials without credentials',async t=>{
 const f=fixture(t),secret='fixture-host-only-secret-12345',registry=localToolRegistry();let outputs;
 registry.register(def('echo'),(_p,{credentials})=>({value:credentials.apiKey,password:credentials.apiKey,[credentials.apiKey]:'key also scrubbed'}));
 registry.register(def('write',{category:'write',needsGrant:true}),()=>{throw Error('must not run');});
 registry.register(def('outside',{resources:()=>({reads:['private'],writes:[]})}),()=>{throw Error('must not run');});
 const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d,_s,_answer,tools)=>{
  outputs=[];for(const id of ['local.sha256','local.cli-sha256','echo','write','outside'])outputs.push(await tools.invokeTool({callId:"call"+outputs.length,toolId:id,params:{text:'hello'}}));
  assert.equal(d.prompt.includes(secret),false);return {text:JSON.stringify({responseScope:d.id,message:'Checked',summary:'Checked',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};
 }};
 await new GroupEngine(f.store,runtime,{toolRegistry:registry,toolCredentials:()=>({apiKey:secret})}).tick(f.g.id);
 assert.equal(outputs?.length,5);const digest=createHash('sha256').update('hello').digest('hex');for(const row of outputs.slice(0,2))assert.equal(row.result.sha256,digest);
 assert.equal(outputs[2].result.value,'[redacted]');assert.equal(outputs[3].reason,'grant_required');assert.equal(outputs[4].reason,'resource_out_of_scope');
 const serialized=JSON.stringify({calls:f.store.db.prepare('SELECT value FROM tool_calls').all(),messages:f.store.messages(f.g.id),deliveries:f.store.db.prepare('SELECT value FROM deliveries').all()});assert.equal(serialized.includes(secret),false);assert.equal(serialized.includes('"text":"hello"'),false);
 assert.equal(f.store.admissions().observation(f.g.id).schedulingImplemented,false);
});
test('real engine timeout remains unknown and cannot replay, including new IDs and restart',async t=>{
 const f=fixture(t),registry=new ToolRegistry();let entered=0,result,duplicate,newId;
 registry.register(def('slow',{timeoutMs:20}),async()=>{entered++;await new Promise(resolve=>setTimeout(resolve,70));return {late:true};});
 const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d,_s,_a,tools)=>{
  result=await tools.invokeTool({callId:'slow',toolId:'slow',params:{text:'x'}});
  duplicate=await tools.invokeTool({callId:'slow',toolId:'slow',params:{text:'x'}});
  newId=await tools.invokeTool({callId:'retry',toolId:'slow',params:{text:'x'}});
  return {text:JSON.stringify({responseScope:d.id,message:'Unknown retained',summary:'Unknown',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};
 }};
 await new GroupEngine(f.store,runtime,{toolRegistry:registry}).tick(f.g.id);assert.equal(result?.resultStatus,'unknown');assert.equal(result.reason,'timeout');assert.equal(duplicate.duplicate,true);assert.equal(newId.reason,'prior_tool_unsettled');assert.equal(entered,1);
 await new Promise(resolve=>setTimeout(resolve,80));assert.equal(new ToolExecutor(f.store,registry).calls(f.g.id).find(r=>r.id===result.id).resultStatus,'unknown');
 f.store.close();const reopened=new GroupStore(f.file);try{const prior=await new ToolExecutor(reopened,registry).invoke(f.g.id,{callId:'slow',deliveryId:result.deliveryId,toolId:'slow',params:{text:'x'}},new AbortController().signal);assert.equal(prior.resultStatus,'unknown');assert.equal(entered,1);}finally{reopened.close();}
});
test('real engine cancellation retains unknown and does not expose thrown credential text',async t=>{
 const f=fixture(t),registry=new ToolRegistry();let result,entered=0;
 registry.register(def('cancel'),async()=>{entered++;await new Promise(()=>{});});
 let engine;const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d,_s,_a,tools)=>{
  const pending=tools.invokeTool({callId:'cancel',toolId:'cancel',params:{text:'x'}});setTimeout(()=>engine.interrupt(f.g.id),15);result=await pending;
  return {text:JSON.stringify({responseScope:d.id,message:'Cancelled',summary:'Unknown',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};
 }};engine=new GroupEngine(f.store,runtime,{toolRegistry:registry});await engine.tick(f.g.id);assert.equal(result?.resultStatus,'unknown');assert.equal(result.reason,'cancelled');assert.equal(entered,1);
});
test('authenticated HTTP catalog/call/audit routes enforce active delivery and unknown-field rejection',async t=>{
 const f=fixture(t),d=delivery(f),service=await startGroupService({store:f.store,runtime:{},schedule:false});
 try{const base='/api/groups/'+f.g.id;assert.equal((await localFetch(service.descriptor,base+'/tools')).tools.length,2);
  const denied=await localFetch(service.descriptor,base+'/tool-call',call(d,'idle','local.sha256'));assert.equal(denied.reason,'delivery_not_active');
  await assert.rejects(localFetch(service.descriptor,base+'/tool-call',{...call(d,'bad','local.sha256'),credentials:'not accepted'}));
  assert.equal((await localFetch(service.descriptor,base+'/tool-calls')).calls.length,1);
 }finally{await service.close();}
});
test('live engine HTTP and CLI entry points use the existing service without lifecycle calls',async t=>{
 const f=fixture(t);let service,api,cli;
 const runtime={responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d)=>{
  api=await localFetch(service.descriptor,'/api/groups/'+f.g.id+'/tool-call',call(d,'http','local.sha256'));
  const input=path.join(f.dir,'call.json');fs.writeFileSync(input,JSON.stringify({groupId:f.g.id,call:call(d,'cli','local.cli-sha256')}));
  const output=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../cli.mjs',import.meta.url)),'group-tool-call',input],{env:{...process.env,HARNESS_PLUGIN_DATA:f.dir},windowsHide:true,timeout:10000});cli=JSON.parse(output.stdout);
  return {text:JSON.stringify({responseScope:d.id,message:'Checked',summary:'Checked',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};
 }};
 service=await startGroupService({store:f.store,runtime,schedule:false});fs.writeFileSync(path.join(f.dir,'group-service.json'),JSON.stringify(service.descriptor));
 try{await service.engine.tick(f.g.id);assert.equal(api?.resultStatus,'done');assert.equal(cli?.resultStatus,'done');assert.equal(api.result.sha256,cli.result.sha256);assert.equal(service.engine.toolExecutor.calls(f.g.id).length,2);}finally{await service.close();}
});
test('reported errors are terminal, thrown host errors are unknown and credential strings are discarded',async t=>{
 const f=fixture(t),d=delivery(f),secret='host-credential-unique-123',registry=new ToolRegistry(),signal=new AbortController().signal;
 registry.register(def('error'),()=>({status:'error',code:'invalid_input'}));registry.register(def('throws'),()=>{throw Error(secret);});
 const ex=new ToolExecutor(f.store,registry,{credentials:()=>({key:secret})});assert.equal((await ex.invoke(f.g.id,call(d,'e','error'),signal)).resultStatus,'error');
 assert.equal((await ex.invoke(f.g.id,call(d,'u','throws'),signal)).resultStatus,'unknown');assert.equal(JSON.stringify(ex.calls(f.g.id)).includes(secret),false);
});
test('in-flight reservation rejects a concurrent spend and survives a crash without replay',async t=>{
 const f=fixture(t),d=delivery(f),registry=new ToolRegistry();let resolve,entered=0;
 registry.register(def('read'),()=>{entered++;return new Promise(r=>resolve=r);});const ex=new ToolExecutor(f.store,registry),signal=new AbortController().signal;
 const first=ex.invoke(f.g.id,call(d,'first','read'),signal);await new Promise(r=>setImmediate(r));
 const concurrent=await ex.invoke(f.g.id,call(d,'second','read'),signal);assert.equal(concurrent.reason,'prior_tool_unsettled');
 const recovered=await new ToolExecutor(f.store,registry).invoke(f.g.id,call(d,'first','read'),signal);assert.equal(recovered.resultStatus,'unknown');assert.equal(entered,1);resolve({ok:true});await first;
});
test('actual work delivery snapshots its task read scope and cannot borrow a later task scope',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'allowed'),'local');fs.writeFileSync(path.join(f.dir,'other'),'other');
 f.r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'Read local',harness:''}};
 f.r.taskList=makeTaskList(f.r,[{key:'read',title:'Read',task:'Read',owner:'codex',acceptance:'evidence',readOnly:true,resources:{reads:['allowed'],writes:[]}}]);f.r.taskListRevision=f.r.revision;startNextTask(f.r);f.store.saveRequest(f.r);
 const registry=new ToolRegistry();registry.register(def('file',{params:{file:{type:'string',required:true}},resources:p=>({reads:[p.file],writes:[]})}),p=>({content:fs.readFileSync(path.join(f.dir,p.file),'utf8')}));let allowed,denied;
 await new GroupEngine(f.store,{responseScopeProtocol:1,appOpen:async()=>true,turn:async(_g,d,_s,_a,tools)=>{
  assert.deepEqual(d.toolScope,{reads:['allowed'],writes:[]});allowed=await tools.invokeTool({callId:'allowed',toolId:'file',params:{file:'allowed'}});
  const r=f.store.request(f.r.id);r.taskList[0].resources.reads=['other'];f.store.saveRequest(r);
  denied=await tools.invokeTool({callId:'other',toolId:'file',params:{file:'other'}});
  return {text:JSON.stringify({responseScope:d.id,status:'done',message:'Read',summary:'Read',verification:['local evidence'],integrationFiles:[]})};
 }},{toolRegistry:registry}).tick(f.g.id);
 assert.equal(allowed?.result.content,'local');assert.equal(denied?.reason,'resource_out_of_scope');
});
test('control or filesystem identity changes during host credential lookup prevent handler entry',async t=>{
 for(const mode of ['pause','identity']){
  const f=fixture(t);fs.writeFileSync(path.join(f.dir,'allowed'),'local');fs.writeFileSync(path.join(f.dir,'other'),'other');const d=delivery(f),registry=new ToolRegistry();let entered=0;
  registry.register(def('read',{resources:()=>({reads:['allowed'],writes:[]})}),()=>{entered++;return {ok:true};});
  const ex=new ToolExecutor(f.store,registry,{credentials:async()=>{
   await Promise.resolve();if(mode==='pause'){const g=f.store.group(f.g.id);g.status='paused';f.store.save(g);}else{fs.unlinkSync(path.join(f.dir,'allowed'));fs.linkSync(path.join(f.dir,'other'),path.join(f.dir,'allowed'));}return {};
  }});
  const result=await ex.invoke(f.g.id,call(d,'change','read'),new AbortController().signal);assert.equal(entered,0);assert.equal(result.resultStatus,'unknown');assert.equal(result.reason,mode==='pause'?'control_changed_before_execution':'resource_changed_before_execution');
 }
});
