import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {recoveredHarnessResult} from '../companion/index.mjs';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';

test('completed native turn with no public text is terminal, never published as a formal answer',()=>{
 const id=randomUUID(),events=[{type:'turn/start',data:{turn:189}},
 {type:'user/message',data:{source:{kind:'user',rpcId:`group-${id}`},content:[{type:'text',text:`[Group delivery ${id}]\noriginal`}]}},
 {type:'assistant/message',data:{turn:189,message:{content:[{type:'reasoning',text:'PRIVATE INTERNAL CONTENT'}]}}},
 {type:'turn/end',seq:4233,data:{turn:189,reason:{kind:'completed'}}}];
 const recovered=recoveredHarnessResult(events,id);
 assert.equal(recovered.terminalNoReply,true);assert.equal(recovered.text,undefined);assert.equal(JSON.stringify(recovered).includes('PRIVATE'),false);
 assert.deepEqual(recovered.proof,{deliveryId:id,turn:189,endSeq:4233,reason:'completed'});
 assert.equal(recoveredHarnessResult(events.slice(0,-1),id),null);
 assert.equal(recoveredHarnessResult(events,randomUUID()),null);
});

for(const superseded of [false,true])test(`terminal work without formal reply resumes read-only planning, superseded=${superseded}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-reply-')),store=new GroupStore(path.join(dir,'groups.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
 const group=store.create({repo:dir,models:{codex:{},harness:{}}});Object.assign(group,{status:'active',contexts:{codex:'ct',harness:'ht'},worktrees:{codex:dir,harness:dir}});
 const {request}=store.input(group.id,{content:'authorized work'}),delivery={id:randomUUID(),groupId:group.id,requestId:request.id,member:'harness',phase:'work',revision:request.revision,status:'pending',started:true,prompt:'original',cursor:0};
 Object.assign(request,{phase:'execution',status:'active',deliveryId:delivery.id,actions:[{phase:'work',member:'harness',task:'do work'}],agreement:{owner:'harness',integrator:'harness',review:false}});
 if(superseded)request.revision++;
 group.activeRequestId=request.id;store.transaction(()=>{store.save(group);store.saveRequest(request);store.saveDelivery(delivery)});
 let calls=0;
 const rt={appOpen:async()=>true,recover:async()=>({terminalNoReply:true,proof:{deliveryId:delivery.id,sessionId:'ht',idle:true,turn:189,endSeq:4233,reason:'completed'}}),turn:async(_g,d)=>{
  calls++;assert.equal(d.phase,'planning');assert.match(JSON.parse(d.prompt).replyRecovery.instruction,/禁止直接重放/);
  return {text:JSON.stringify({owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false,message:'read-only recap',summary:'recap'})};
 }};
 const engine=new GroupEngine(store,rt);await engine.tick(group.id);
 const latest=store.request(request.id);assert.equal(latest.deliveryId,undefined);assert.equal(latest.status,'queued');
 assert.equal(store.delivery(delivery.id).status,'completed_without_reply');assert.equal(store.delivery(delivery.id).started,true);assert.equal(calls,0);
 if(superseded)assert.equal(latest.revision,1);else assert.equal(latest.phase,'planning');
 await engine.tick(group.id);assert.equal(calls,1);assert.equal(store.delivery(delivery.id).status,'completed_without_reply');
});

test('repeated missing replies exhaust only the bounded recap attempt, never replay the original work',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-budget-')),store=new GroupStore(path.join(dir,'groups.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
 const group=store.create({repo:dir,models:{codex:{},harness:{}}});Object.assign(group,{status:'active',contexts:{codex:'ct',harness:'ht'}});
 const {request}=store.input(group.id,{content:'work'}),id=randomUUID();Object.assign(request,{status:'active',deliveryId:id,replyRecoveryAttempts:{harness:2}});group.activeRequestId=request.id;
 store.transaction(()=>{store.save(group);store.saveRequest(request);store.saveDelivery({id,groupId:group.id,requestId:request.id,member:'harness',phase:'planning',status:'pending',started:true,revision:0,prompt:'old',cursor:0})});
 const engine=new GroupEngine(store,{appOpen:async()=>true,recover:async()=>({terminalNoReply:true,proof:{deliveryId:id,sessionId:'ht',idle:true,turn:1,endSeq:2,reason:'completed'}}),turn:async()=>assert.fail('must not replay')});
 await engine.tick(group.id);const r=store.request(request.id);assert.equal(r.status,'blocked');assert.equal(r.deliveryId,undefined);assert.equal(r.replyRecoveryAttempts.harness,3);
 assert.match(r.error,/不是等待真人批准/);engine.control(group.id,'retry');assert.equal(store.request(request.id).replyRecoveryAttempts,undefined);
});

test('unproven or busy terminal result cannot clear an admitted work checkpoint',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminal-proof-')),store=new GroupStore(path.join(dir,'groups.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
 const group=store.create({repo:dir,models:{codex:{},harness:{}}});Object.assign(group,{status:'active',contexts:{harness:'ht',codex:'ct'}});
 const {request}=store.input(group.id,{content:'work'}),id=randomUUID();request.deliveryId=id;request.status='active';group.activeRequestId=request.id;
 store.transaction(()=>{store.save(group);store.saveRequest(request);store.saveDelivery({id,groupId:group.id,requestId:request.id,member:'harness',phase:'work',status:'pending',started:true,revision:0,prompt:'old',cursor:0})});
 const engine=new GroupEngine(store,{appOpen:async()=>true,recover:async()=>({terminalNoReply:true,proof:{deliveryId:id,sessionId:'ht',idle:false,turn:1,endSeq:2,reason:'completed'}})});
 await engine.tick(group.id);assert.equal(store.request(request.id).deliveryId,id);assert.equal(store.delivery(id).status,'pending');
});
