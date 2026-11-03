import test from 'node:test';import assert from 'node:assert/strict';
import {GroupStore} from '../src/group-store.mjs';
import {makeTaskList} from '../src/task-list.mjs';
import {verifyNativeParallel,nativeParallelEvidence} from '../src/native-parallel.mjs';
import {activeHarnessTurn} from '../companion/index.mjs';
import {startGroupService} from '../src/group-service.mjs';
import {localFetch,sendJson,readBody} from '../src/group-http.mjs';
import http from 'node:http';

function fixture(t){
 const s=new GroupStore(':memory:');t.after(()=>{try{s.close();}catch{}});const g=s.create({repo:process.cwd(),models:{}});
 g.contexts={codex:'c',harness:'h'};g.harnessAdapterId='harness-desktop';g.status='active';s.save(g);
 const {request:r}=s.input(g.id,{content:'read-only native acceptance'});r.status='active';g.activeRequestId=r.id;s.save(g);
 r.taskList=makeTaskList(r,['codex','harness'].map((owner,i)=>({key:String(i),title:owner,task:'read existing file',acceptance:'exact result',owner,resources:{reads:[],writes:[]}})));r.taskListRevision=r.revision;s.saveRequest(r);
 for(const [i,member] of ['codex','harness'].entries()){
   assert.equal(s.admissions().reserve({groupId:g.id,requestId:r.id,taskId:r.taskList[i].taskId,member,deliveryId:member}).admitted,true);
   s.saveDelivery({id:member,member,phase:'work',groupId:g.id,requestId:r.id,revision:r.revision,epoch:g.epoch,started:true,status:'pending',
     ...(member==='codex'?{nativeTurnId:'ct',nativeAdmission:{threadId:'c',turnId:'ct',promptHash:'ph'}}:{})});
 }
 let calls=0;const runtime={adapter:()=>({}),recover:async()=>{calls++;return {pending:true,turnId:'ct'}}};
 const options={runtimeHash:'runtime',readHarness:async()=>({pending:true,sessionId:'h',deliveryId:'harness',adapterId:'harness-desktop',turn:3,startSeq:4,userSeq:5})};
 return {s,g,r,runtime,options,calls:()=>calls};
}
function finish(f,member){
 const d=f.s.delivery(member),raw=f.s.message(f.g.id,{sender:member,channel:'group',requestId:f.r.id,protocol:true,content:member+' genuine native response'});
 d.responseMessageId=raw.id;d.status='received';d.terminalReply={kind:member==='codex'?'codex-completed':'harness-completed',sessionId:f.g.contexts[member],textHash:f.s.hash(raw.content),
   ...(member==='codex'?{turnId:'ct'}:{deliveryId:member,turn:3,reason:'completed',endSeq:6})};
 f.s.saveDelivery(d);f.s.admissions().release(d.id);
}
test('native bracket plus both immutable terminal receipts is required; mock scheduling alone remains false',async t=>{
 const f=fixture(t);assert.equal(f.s.admissions().observation(f.g.id).schedulingImplemented,false);
 assert.equal((await verifyNativeParallel(f.s,f.runtime,f.g.id,f.options)).verified,true);assert.equal(f.calls(),2);
 assert.equal(nativeParallelEvidence(f.s,f.g.id),null);finish(f,'codex');assert.equal(nativeParallelEvidence(f.s,f.g.id),null);
 finish(f,'harness');assert.equal(f.s.admissions().observation(f.g.id).schedulingImplemented,true);
 const d=f.s.delivery('codex');d.terminalReply.textHash='mutated';f.s.saveDelivery(d);assert.equal(nativeParallelEvidence(f.s,f.g.id),null);
});
for(const fault of ['ended','harness','changed','approval'])test(`native overlap rejects ${fault} and saves no witness`,async t=>{
 const f=fixture(t);
 if(fault==='ended'){let reads=0;f.runtime.recover=async()=>++reads===1?{pending:true,turnId:'ct'}:{pending:false};}
 if(fault==='harness')f.options.readHarness=async()=>({pending:true,deliveryId:'unrelated'});
 if(fault==='changed')f.options.readHarness=async()=>{f.g.epoch++;f.s.save(f.g);return{pending:true,sessionId:'h',deliveryId:'harness',adapterId:'harness-desktop',turn:3,startSeq:4,userSeq:5}};
 if(fault==='approval')f.s.savePermission({id:'p',groupId:f.g.id,status:'pending',member:'codex'});
 assert.equal((await verifyNativeParallel(f.s,f.runtime,f.g.id,f.options)).verified,false);
 assert.equal(f.s.group(f.g.id).nativeParallelWitnesses,undefined);
});
test('Harness live proof matches native-owned delivery, open turn and metadata only',()=>{
 const rows=[{type:'turn/start',seq:1,data:{turn:2}},{type:'user/message',seq:2,data:{source:{kind:'user',rpcId:'group-d'},content:[{type:'text',text:'[Group delivery d]\nprivate text'}]}}];
 assert.deepEqual(activeHarnessTurn(rows,'d'),{turn:2,startSeq:1,userSeq:2});
 assert.equal(activeHarnessTurn(rows,'wrong'),null);
 assert.equal(activeHarnessTurn([...rows,{type:'turn/end',seq:3,data:{turn:2}}],'d'),null);
 assert.equal(activeHarnessTurn([rows[0],{...rows[1],data:{...rows[1].data,source:{kind:'user',rpcId:'unrelated'}}}],'d'),null);
});

test('authenticated service derives witness via actual adapter reads; caller-supplied proof is ignored',async t=>{
 const f=fixture(t);let adapterReads=0;
 const adapter=http.createServer(async(req,res)=>{
   assert.equal(req.headers.authorization,'Bearer test-only-token');assert.equal(req.url,'/parallel-proof');
   assert.deepEqual(await readBody(req),{sessionId:'h',deliveryId:'harness'});adapterReads++;
   sendJson(res,200,{pending:true,sessionId:'h',deliveryId:'harness',adapterId:'harness-desktop',turn:3,startSeq:4,userSeq:5});
 });
 await new Promise(resolve=>adapter.listen(0,'127.0.0.1',resolve));
 f.runtime.adapter=()=>({url:`http://127.0.0.1:${adapter.address().port}`,token:'test-only-token'});
 const service=await startGroupService({store:f.s,runtime:f.runtime,schedule:false});
 try{
   const result=await localFetch(service.descriptor,`/api/groups/${f.g.id}/verify-native-parallel`,{witnessId:'forged',proof:{verified:true}});
   assert.equal(result.verified,true);assert.notEqual(result.witnessId,'forged');assert.equal(adapterReads,1);assert.equal(f.calls(),2);
   assert.equal(f.s.admissions().observation(f.g.id).schedulingImplemented,false,'completion receipts are still missing');
 }finally{await service.close();await new Promise(resolve=>adapter.close(resolve));}
});
