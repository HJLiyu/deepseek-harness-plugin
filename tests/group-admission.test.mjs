import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {GroupStore} from '../src/group-store.mjs';
import {resourceClaims,resourceConflict} from '../src/group-admission.mjs';
import {makeTaskList} from '../src/task-list.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admission-')),file=path.join(dir,'test.sqlite'),store=new GroupStore(file);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{}});group.status='active';group.contexts={codex:'c',harness:'h'};store.save(group);
 const {request}=store.input(group.id,{content:'Implement',origin:{adapter:'test',sessionId:'s',messageId:'h'}});
 request.status='active';request.taskList=makeTaskList(request,[{key:'a',title:'A',task:'A',acceptance:'Tests',owner:'codex',resources:{reads:[],writes:['a']}},{key:'b',title:'B',task:'B',acceptance:'Tests',owner:'harness',resources:{reads:[],writes:['b']}}]);request.taskListRevision=request.revision;store.saveRequest(request);
 const input=i=>({groupId:group.id,requestId:request.id,taskId:request.taskList[i].taskId,member:i?'harness':'codex',deliveryId:'d'+i});
 return {dir,file,store,group,request,input,ledger:store.admissions()};
}
test('known native quota failure releases its exact reservation without implying success or erasing failure',t=>{
 for(const mutation of [null,d=>d.nativeFailure.turnId='other',d=>d.nativeAdmission.promptHash='wrong',d=>d.nativeFailure.kind='unknown',d=>d.epoch++]){
  const f=fixture(t),row=f.ledger.reserve(f.input(0)).reservation;
  const d={...f.input(0),id:row.id,status:'failed',started:true,revision:row.revision,epoch:row.epoch,prompt:'work',nativeTurnId:'turn',nativeAdmission:{threadId:'c',turnId:'turn',promptHash:f.store.hash(`[Group delivery ${row.id}]\nwork`)},nativeFailure:{kind:'usage_limit',turnId:'turn'}};
  const m=f.store.message(f.group.id,{sender:'codex',requestId:f.request.id,channel:'collaboration',content:'quota',origin:{adapter:'codex-reply',sessionId:'c',messageId:row.id}});d.responseMessageId=m.id;
  mutation?.(d);f.store.saveDelivery(d);assert.equal(f.ledger.releaseNativeFailure(row.id),!mutation);assert.equal(f.store.delivery(row.id).status,'failed');if(!mutation){assert.equal(f.ledger.releaseNativeFailure(row.id),false);assert.equal(f.ledger.observation(f.group.id).held,0);}
 }
});
test('large file identities remain exact and legacy rounded claims stay conservative',t=>{
 const f=fixture(t),a=path.join(f.dir,'precise-a'),b=path.join(f.dir,'precise-b');fs.writeFileSync(a,'a');fs.writeFileSync(b,'b');
 const original=fs.statSync;t.mock.method(fs,'statSync',(name,options)=>{
  const st=original(name,options);if(name!==a&&name!==b)return st;
  const exact=9007199254740992n+(name===b?1n:0n);return Object.assign(Object.create(Object.getPrototypeOf(st)),st,{ino:options?.bigint?exact:Number(exact)});
 });
 const first=resourceClaims(f.dir,{reads:[],writes:['precise-a']}),second=resourceClaims(f.dir,{reads:['precise-b'],writes:[]});
 assert.equal(first.writes[0].inode.endsWith(':9007199254740992'),true);assert.equal(second.reads[0].inode.endsWith(':9007199254740993'),true);assert.equal(resourceConflict(first,second),false);
 const legacy=structuredClone(second);delete legacy.identityVersion;assert.equal(resourceConflict(first,legacy),true);
 const held=f.ledger.reserve(f.input(0)).reservation;delete held.claims.identityVersion;f.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(held),held.id);
 assert.equal(f.ledger.reserve(f.input(1)).reason,'resource_conflict');assert.equal(f.ledger.rows()[0].state,'held');
});
test('capacity includes all rows and parents; session and task ownership cannot bypass admission',t=>{
 const f=fixture(t);let a=f.ledger.reserve(f.input(0));assert.equal(a.admitted,true);assert.equal(f.ledger.reserve(f.input(0)).reused,true);
 assert.throws(()=>f.ledger.reserve({...f.input(0),parentId:'different'}),/binding changed/);
 assert.equal(f.ledger.reserve({...f.input(1),member:'codex'}).reason,'executor_mismatch');
 f.group.executionSettings={maxExecutors:1};f.store.save(f.group);
 assert.equal(f.ledger.reserve({...f.input(1),parentId:a.reservation.id}).reason,'capacity_full');
 f.group.executionSettings.maxExecutors=2;f.store.save(f.group);assert.equal(f.ledger.reserve({...f.input(1),parentId:a.reservation.id}).admitted,true);
 assert.equal(f.ledger.observation(f.group.id).held,2);assert.equal(f.ledger.observation(f.group.id).schedulingImplemented,false);
});
test('missing claims run exclusively; dependencies require evidence; pause and approvals block',t=>{
 const f=fixture(t);delete f.request.taskList[0].resources;f.store.saveRequest(f.request);
 assert.equal(f.ledger.reserve(f.input(0)).reservation.claims.exclusive,true);assert.equal(f.ledger.reserve(f.input(1)).admitted,false);
 const g=fixture(t);g.request.taskList[1].deps=['a'];g.request.taskList[0].status='done';g.store.saveRequest(g.request);
 assert.equal(g.ledger.reserve(g.input(1)).reason,'dependency_not_accepted');g.request.taskList[0].evidenceRefs=['review+integration'];g.store.saveRequest(g.request);
 g.group.status='paused';g.store.save(g.group);assert.equal(g.ledger.reserve(g.input(1)).reason,'execution_paused_or_blocked');
 g.group.status='active';g.store.save(g.group);g.store.savePermission({id:'p',groupId:g.group.id,requestId:g.request.id,status:'pending'});assert.equal(g.ledger.reserve(g.input(1)).reason,'approval_pending');
});
test('normalization catches ancestors, case, links and uncertain aliases',t=>{
 const {dir}=fixture(t);fs.mkdirSync(path.join(dir,'folder'));fs.writeFileSync(path.join(dir,'folder','file'),'x');
 const c=(reads,writes)=>resourceClaims(dir,{reads,writes});
 assert.equal(resourceConflict(c([],['folder']),c(['folder/file'],[])),true);
 assert.equal(resourceConflict(c([],['NEW']),c(['new'],[])),true);
 assert.equal(resourceConflict(c(['folder/file'],[]),c(['folder/file'],[])),false);
 fs.linkSync(path.join(dir,'folder/file'),path.join(dir,'hardlink'));
 assert.equal(resourceConflict(c([],['folder/file']),c(['hardlink'],[])),true);
 fs.symlinkSync(path.join(dir,'folder'),path.join(dir,'alias'),'junction');
 assert.equal(resourceConflict(c([],['folder/file']),c(['alias/file'],[])),true);
 assert.equal(c([],['folder/../escape']).exclusive,true);assert.equal(c([],['unknown.']).exclusive,true);
});
test('ledger applies normalized read/write conflicts and conservatively serializes uncertain declarations',t=>{
 const f=fixture(t);f.request.taskList[1].resources={reads:['A'],writes:[]};f.store.saveRequest(f.request);
 assert.equal(f.ledger.reserve(f.input(0)).admitted,true);assert.equal(f.ledger.reserve(f.input(1)).reason,'resource_conflict');
 const g=fixture(t);g.request.taskList[1].resources={reads:[],writes:['unknown/../alias']};g.store.saveRequest(g.request);
 g.ledger.reserve(g.input(0));assert.equal(g.ledger.reserve(g.input(1)).reason,'sequential_required');
 const h=fixture(t);h.request.taskList[0].readOnly=true;h.store.saveRequest(h.request);assert.equal(h.ledger.reserve(h.input(0)).reason,'read_only_write_claim');
});
test('same native session is exclusive across groups, and unknown/restart do not free a row',t=>{
 const f=fixture(t);f.ledger.reserve(f.input(0));
 const other=f.store.create({repo:f.dir,models:{}});other.status='active';other.contexts={codex:'c',harness:'other'};f.store.save(other);
 const {request:r}=f.store.input(other.id,{content:'Other',origin:{adapter:'test',sessionId:'s',messageId:'other'}});r.status='active';r.taskList=makeTaskList(r,[{key:'a',title:'A',task:'A',owner:'codex',acceptance:'T',resources:{reads:[],writes:['z']}}]);r.taskListRevision=r.revision;f.store.saveRequest(r);
 assert.equal(f.ledger.reserve({groupId:other.id,requestId:r.id,taskId:r.taskList[0].taskId,member:'codex',deliveryId:'other'}).reason,'session_busy');
 f.store.saveDelivery({id:'d0',groupId:f.group.id,requestId:f.request.id,revision:f.request.revision,epoch:f.group.epoch,member:'codex',status:'pending',started:true});
 assert.equal(f.ledger.release('d0'),false);const reopened=new GroupStore(f.file);try{assert.equal(reopened.admissions().observation(f.group.id).held,1);}finally{reopened.close();}
 const msg=f.store.message(f.group.id,{sender:'codex',channel:'group',content:'Verified result',requestId:f.request.id});
 const d=f.store.delivery('d0');d.status='received';d.responseMessageId=msg.id;f.store.saveDelivery(d);
 assert.equal(f.ledger.release('d0'),true);assert.equal(f.ledger.release('d0'),false);assert.equal(f.ledger.observation(f.group.id).held,0);
 assert.equal(f.ledger.reserve(f.input(0)).admitted,false);assert.equal(f.ledger.reserve(f.input(0)).reservation.state,'released');
});
test('two SQLite writers racing for the final slot admit exactly one',async t=>{
 const f=fixture(t);f.group.executionSettings={maxExecutors:1};f.store.save(f.group);
 const url=new URL('../src/group-store.mjs',import.meta.url).href;
 const run=input=>new Promise((resolve,reject)=>{
  const w=new Worker(`const {parentPort,workerData}=require('node:worker_threads');import(workerData.url).then(({GroupStore})=>{const s=new GroupStore(workerData.file);try{parentPort.postMessage(s.admissions().reserve(workerData.input));}finally{s.close();}}).catch(e=>{throw e});`,{eval:true,workerData:{url,file:f.file,input}});
  w.once('message',resolve);w.once('error',reject);w.once('exit',code=>{if(code)reject(Error('worker exit '+code));});
 });
 const results=await Promise.all([run(f.input(0)),run(f.input(1))]);assert.equal(results.filter(r=>r.admitted).length,1);assert.equal(f.ledger.observation(f.group.id).held,1);
});
test('task declaration survives planning validation and new module is in release manifest',t=>{
 const f=fixture(t);assert.deepEqual(f.store.request(f.request.id).taskList[0].resources,{reads:[],writes:['a']});
 assert.match(fs.readFileSync(new URL('../scripts/package.mjs',import.meta.url),'utf8'),/'src\/group-admission.mjs'/);
});

function another(f,repo,member,resources){
 const group=f.store.create({repo,models:{}});group.status='active';group.contexts={codex:'other-c',harness:'other-h'};f.store.save(group);
 const {request}=f.store.input(group.id,{content:'Other',origin:{adapter:'test',sessionId:'s',messageId:group.id}});
 request.status='active';request.taskList=makeTaskList(request,[{key:'x',title:'X',task:'X',acceptance:'T',owner:member,resources}]);request.taskListRevision=request.revision;f.store.saveRequest(request);
 return {group,request,input:{groupId:group.id,requestId:request.id,taskId:request.taskList[0].taskId,member,deliveryId:group.id}};
}
test('physical paths and hardlinks conflict across project roots and held unknown survives restart',t=>{
 const f=fixture(t);const child=path.join(f.dir,'child');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'x'),'x');
 f.request.taskList[0].resources={reads:[],writes:['child/x']};f.store.saveRequest(f.request);
 assert.equal(f.ledger.reserve(f.input(0)).admitted,true);
 const g=another(f,child,'harness',{reads:['x'],writes:[]});
 assert.equal(f.ledger.reserve(g.input).reason,'resource_conflict');
 f.store.saveDelivery({id:'d0',groupId:f.group.id,requestId:f.request.id,member:'codex',revision:f.request.revision,epoch:f.group.epoch,started:true,status:'unknown'});
 const reopened=new GroupStore(f.file);try{assert.equal(reopened.admissions().reserve(g.input).reason,'resource_conflict');assert.equal(reopened.admissions().release('d0'),false);}finally{reopened.close();}
 fs.linkSync(path.join(child,'x'),path.join(child,'alias'));g.request.taskList[0].resources={reads:['alias'],writes:[]};f.store.saveRequest(g.request);
 assert.equal(f.ledger.reserve(g.input).reason,'resource_conflict');
});
test('historical failure without native work does not block; original unknown checkpoint still blocks',t=>{
 const f=fixture(t);const old=f.store.request(f.request.id);old.status='blocked';f.store.saveRequest(old);
 const {request:r}=f.store.input(f.group.id,{content:'New',origin:{adapter:'test',sessionId:'s',messageId:'new'}});
 r.status='active';r.taskList=makeTaskList(r,[{key:'new',title:'New',task:'New',acceptance:'T',owner:'harness',resources:{reads:[],writes:['new']}}]);r.taskListRevision=r.revision;f.store.saveRequest(r);
 const group=f.store.group(f.group.id);group.activeRequestId=r.id;f.store.save(group);
 const input={groupId:group.id,requestId:r.id,taskId:r.taskList[0].taskId,member:'harness',deliveryId:'new'};
 f.store.saveDelivery({id:'old-native',groupId:group.id,requestId:old.id,member:'codex',started:true,status:'unknown'});
 assert.equal(f.ledger.reserve(input).reason,'legacy_delivery_unsettled');
 const d=f.store.delivery('old-native');d.status='received';f.store.saveDelivery(d);
 assert.equal(f.ledger.reserve(input).admitted,true);
 assert.equal(f.ledger.observation(group.id).schedulingImplemented,false);
});
