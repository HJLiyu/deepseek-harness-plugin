import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {discoverEffort,selectEffort,confirmEffort,effortPolicy} from '../src/effort-policy.mjs';
import {configureIdleEffort,harnessEffortReceipt} from '../companion/effort.mjs';
import {GroupStore} from '../src/group-store.mjs';import {GroupRuntime} from '../src/group-runtime.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {startGroupService} from '../src/group-service.mjs';import {localFetch} from '../src/group-http.mjs';
import {codexEffortCatalog} from '../src/codex.mjs';
const discovered=()=>discoverEffort({data:[{model:'same-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}]}]},'same-model','mock:model/list',123);
test('auto ignores legacy low configuration and raises complex integration effort',()=>{
 const r=selectEffort({member:'codex',phase:'integrate',configured:'low',policy:{mode:'auto'},discovered:discovered(),task:{resources:{writes:['a','b','c','d']}}});
 assert.equal(r.expected,'high');assert.equal(r.selected,'high');assert.equal(r.source,'rule');
});
test('configured mode uses its fixed setting without misreporting human origin',()=>{
 const r=selectEffort({member:'codex',phase:'integrate',configured:'low',policy:{mode:'configured'},discovered:discovered(),failures:3});
 assert.equal(r.expected,'low');assert.equal(r.selected,'low');assert.equal(r.source,'configured');
});
test('explicit human override wins in both modes and unknown capability fallback stays unconfirmed',()=>{
 for(const mode of ['auto','configured']){const r=selectEffort({member:'codex',phase:'integrate',configured:'high',policy:{mode,overrides:{codex:'low'}},discovered:discovered()});assert.equal(r.expected,'low');assert.equal(r.source,'human');}
 const r=selectEffort({member:'codex',phase:'integrate',configured:'low',policy:{mode:'auto'},discovered:discoverEffort(null,'same-model','mock')});
 assert.equal(r.expected,'high');assert.equal(r.selected,'low');assert.equal(r.source,'rule');assert.equal(r.fallback.reason,'capability_unknown');assert.equal(r.confirmed,null);assert.deepEqual(r.discovered.supported,[]);
});
test('unsupported effort falls back deterministically; discovery never invents model capabilities',()=>{
 const r=selectEffort({member:'codex',phase:'planning',discovered:discovered()});assert.equal(r.expected,'medium');assert.equal(r.selected,'low');assert.equal(r.fallback.reason,'unsupported_effort');assert.equal(r.discovered.at,123);
 assert.deepEqual(discoverEffort({data:[{model:'other',supportedReasoningEfforts:['high']}]},'same-model','mock').supported,[]);
 assert.equal(selectEffort({member:'codex',phase:'work',discovered:discoverEffort(null,'same-model','mock')}).selected,null);
});
test('missing native receipt remains unknown; shared configuration and input echoes cannot confirm',()=>{
 let r=selectEffort({member:'codex',phase:'work',discovered:discovered()});r.requested='low';
 assert.equal(confirmEffort(r,'low',{deliveryId:'d'}).confirmed,null);
 assert.equal(confirmEffort(r,null,{native:true,deliveryId:'d'}).status,'unknown');
 r=confirmEffort(r,'high',{native:true,deliveryId:'d',turnId:'turn'});assert.equal(r.status,'mismatch');assert.equal(r.confirmed,'high');
});
test('Harness rejects busy or queued sessions before changing configuration and preserves model',async()=>{
 const calls=[],sessionController={selectModel:async x=>calls.push(x)},agent={status:'running',inbox:{nextTurn:[],nextStep:[]}},args={agent,sessionController,sessionId:'h',model:{provider:'p',model:'same-model'},effort:'high'};
 await assert.rejects(configureIdleEffort(args),/idle/);assert.equal(calls.length,0);
 agent.status='idle';agent.inbox.nextTurn.push({});await assert.rejects(configureIdleEffort(args),/idle/);assert.equal(calls.length,0);
 agent.inbox.nextTurn=[];const receipt=await configureIdleEffort(args);assert.equal(receipt.confirmed,null);assert.deepEqual(calls,[{sessionId:'h',provider:'p',model:'same-model',reasoningEffort:'high'}]);
});
test('human override beats phase and difficulty; invalid policy fails closed',()=>{
 const r=selectEffort({member:'codex',phase:'integrate',failures:2,policy:{overrides:{codex:'low'}},discovered:discovered()});assert.equal(r.expected,'low');assert.equal(r.source,'human');assert.equal(r.selected,'low');
 assert.throws(()=>effortPolicy({overrides:{codex:'invalid effort'}}));assert.throws(()=>effortPolicy({model:'replacement'}));
});
test('runtime discovery and persisted three values survive SQLite reopen without reapplying a delivery',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effort-'));let store=new GroupStore(path.join(dir,'db.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{codex:{model:'same-model'}}});g.worktrees={codex:dir};store.save(g);const {request:r}=store.input(g.id,{content:'local'});
 const d={id:'d',groupId:g.id,requestId:r.id,revision:r.revision,epoch:g.epoch,member:'codex',phase:'planning',status:'pending'};store.saveDelivery(d);
 let calls=0;const runtime=new GroupRuntime(store,{effortCatalog:async()=>{calls++;return {data:[{model:'same-model',supportedReasoningEfforts:['low','high']}]};}});
 const strength=await runtime.prepareEffort(g,d);runtime.saveStrength(d,{...strength,requested:'low'});assert.equal(calls,1);
 store.close();store=new GroupStore(path.join(dir,'db.sqlite'));const saved=store.delivery('d').strength;assert.equal(saved.expected,'medium');assert.equal(saved.requested,'low');assert.equal(saved.confirmed,null);assert.equal(saved.discovered.source,'app-server:model/list');assert.equal(calls,1);
});
test('actual engine dispatch applies Codex effort and records only the native admission confirmation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effort-engine-')),store=new GroupStore(path.join(dir,'db.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const g=store.create({repo:dir,models:{codex:{model:'same-model'},harness:{model:'h'}}});g.status='active';g.contexts={codex:'c',harness:'h'};g.worktrees={codex:dir,harness:dir};store.save(g);const {request:r}=store.input(g.id,{content:'Read-only local planning'});g.activeRequestId=r.id;store.save(g);
 let count=0;const runtime=new GroupRuntime(store,{effortCatalog:async()=>({data:[{model:'same-model',supportedReasoningEfforts:['low','medium','high']}]}),codexCall:async args=>{
  count++;assert.equal(args.model,'same-model');assert.equal(args.effort,'medium');args.onAdmitted({threadId:'c',turnId:'t',route:'app-server',confirmedEffort:'medium'});return {text:JSON.stringify({message:'local',status:'done',responseScope:args.prompt.match(/Group delivery ([^\]]+)/)[1],summary:'local',verification:['local']}),usage:null};
 }});runtime.canTurn=async()=>true;runtime.appOpen=async()=>true;
 const engine=new GroupEngine(store,runtime);await engine.tick(g.id);const ds=store.db.prepare('SELECT value FROM deliveries WHERE group_id=?').all(g.id).map(x=>JSON.parse(x.value));assert.equal(count,1);assert.equal(ds[0].strength.expected,'medium');assert.equal(ds[0].strength.requested,'medium');assert.equal(ds[0].strength.confirmed,'medium');assert.equal(ds[0].strength.confirmation.turnId,'t');
});

test('Harness provider catalog and actual request headers are independent evidence',()=>{
 const cat={groups:[{id:'p',models:[{id:'m',reasoning:{efforts:[{id:'low'},{id:'high'}]}}]},{id:'q',models:[{id:'m',reasoning:{efforts:[{id:'max'}]}}]}]};
 assert.deepEqual(discoverEffort(cat,'m','native',1,'p').supported,['low','high']);
 const args={deliveryId:'d',sessionId:'h',turn:3,model:{provider:'p',model:'m'},requested:'high'};
 const events=[{type:'request/header',seq:10,data:{turn:2,header:{config:{provider:'p',model:'m',reasoningEffort:'low'}}}},{type:'request/header',seq:20,data:{turn:3,header:{config:{provider:'p',model:'m',reasoningEffort:'high'}}}}];
 assert.equal(harnessEffortReceipt(events,args).confirmed,'high');assert.equal(harnessEffortReceipt(events,{...args,turn:4}).confirmed,null);assert.equal(harnessEffortReceipt(events,{...args,model:{provider:'q',model:'m'}}).confirmed,null);
});
test('Codex catalog discovery reads all pages without creating or starting a turn',async()=>{
 const calls=[];let closed=false;
 const result=await codexEffortCatalog({cwd:'.',rpcFactory:()=>({notify(){},async close(){closed=true;},async request(method,args){calls.push(method);if(method==='initialize')return {};assert.equal(method,'model/list');return args.cursor?{data:[{model:'b'}],nextCursor:null}:{data:[{model:'a'}],nextCursor:'next'};}})});
 assert.deepEqual(result.data.map(x=>x.model),['a','b']);assert.equal(closed,true);assert.deepEqual(calls,['initialize','model/list','model/list']);
});
test('HTTP effort policy and original delivery history expose all three values without changing models',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'effort-http-')),store=new GroupStore(path.join(dir,'db.sqlite'));t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});
 const models={codex:{model:'same-model',effort:'high'},harness:{model:'h'}};const g=store.create({repo:dir,models}),{request:r}=store.input(g.id,{content:'local'});
 const strength=selectEffort({member:'codex',phase:'work',discovered:discovered()});store.saveDelivery({id:'d',groupId:g.id,requestId:r.id,revision:r.revision,member:'codex',strength});
 const service=await startGroupService({store,runtime:{},schedule:false});try{const base='/api/groups/'+g.id+'/effort';
  const body=await localFetch(service.descriptor,base);assert.equal(body.deliveries[0].strength.confirmed,null);assert.deepEqual(Object.keys(body.deliveries[0].strength).filter(x=>['expected','requested','confirmed','source','discovered','fallback'].includes(x)).sort(),['confirmed','discovered','expected','fallback','requested','source']);
  await localFetch(service.descriptor,base,{mode:'auto',overrides:{codex:null}});assert.deepEqual(store.group(g.id).models,models);await assert.rejects(localFetch(service.descriptor,base,{model:'replacement'}));
 }finally{await service.close();}
});
