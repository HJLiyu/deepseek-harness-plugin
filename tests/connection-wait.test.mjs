import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {groupActivity,routeNative} from '../src/group-service.mjs';
import {GroupPermissions} from '../src/group-permissions.mjs';

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'connection-wait-')),store=new GroupStore(path.join(dir,'groups.sqlite'));
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const group=store.create({repo:dir,models:{codex:{},harness:{}}});group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:dir,harness:dir};group.status='idle';store.save(group);
 const {request}=store.input(group.id,{content:'current demand'});
 return {store,group,request};
}
test('same stale bridge stops admission attempts; a trusted new generation rearms only unadmitted work',async t=>{
 const f=fixture(t);let key='old',sends=0;
 const rt={responseScopeProtocol:1,appOpen:async()=>true,recoveryConnectionKey:()=>key,turn:async(_g,d)=>{
  sends++;if(key==='old')throw Object.assign(Error('unavailable'),{code:'GROUP_NOT_ADMITTED',admissionFailure:'codex_connection'});
  return {text:JSON.stringify({responseScope:d.id,message:'No execution',summary:'No work',owner:'none',integrator:'codex',tasks:{codex:'',harness:''},review:false})};
 }};const e=new GroupEngine(f.store,rt);
 for(let i=0;i<3;i++){
  const r=f.store.request(f.request.id);r.admissionRetryAt=0;f.store.saveRequest(r);await e.tick(f.group.id);
 }
 let r=f.store.request(f.request.id);assert.equal(sends,3);assert.equal(r.admissionWait.state,'needs_refresh');assert.equal(r.deliveryId,undefined);
 for(let i=0;i<4;i++)await e.tick(f.group.id);assert.equal(sends,3);
 let activity=groupActivity(f.store,e,f.group.id);assert.match(activity.detail,/请刷新协作连接/);assert.doesNotMatch(activity.detail,/自动重连/);assert.equal(activity.needsUser,true);
 key='new';await e.tick(f.group.id);assert.equal(sends,4);r=f.store.request(r.id);assert.ok(r.plans.codex);assert.equal(r.admissionWait,undefined);
});
test('unknown admitted outcome stops old-connection reads and never dispatches replacement execution',async t=>{
 const f=fixture(t);let key='old',sends=0,reads=0;
 const rt={appOpen:async()=>true,recoveryConnectionKey:()=>key,turn:async()=>{sends++;throw Error('unknown send');},recover:async()=>{
  reads++;throw Object.assign(Error('connection unavailable'),{code:'GROUP_RECOVERY_UNAVAILABLE'});
 }};const e=new GroupEngine(f.store,rt);
 await e.tick(f.group.id);const original=f.store.request(f.request.id).deliveryId;
 for(let i=0;i<3;i++){const r=f.store.request(f.request.id);r.nextRecoveryAt=0;f.store.saveRequest(r);await e.tick(f.group.id);}
 for(let i=0;i<3;i++)await e.tick(f.group.id);
 let r=f.store.request(f.request.id);assert.equal(reads,3);assert.equal(sends,1);assert.equal(r.deliveryId,original);
 const activity=groupActivity(f.store,e,f.group.id);assert.match(activity.detail,/结果仍未知/);assert.match(activity.detail,/请刷新协作连接/);assert.equal(activity.needsUser,true);
 key='new';await e.tick(f.group.id);assert.equal(reads,4);assert.equal(sends,1);assert.equal(f.store.request(r.id).deliveryId,original);
 r=f.store.request(r.id);r.recoveryWait.state='needs_refresh';f.store.saveRequest(r);
 const inspected=await e.inspectReply(f.group.id);
 assert.equal(inspected.inspected,true);assert.equal(reads,5);assert.equal(sends,1);
 assert.equal(f.store.request(r.id).deliveryId,original);assert.equal(f.store.group(f.group.id).status,'paused');
});

test('explicit retry rearms a bounded unadmitted connection attempt without granting execution',async t=>{
 const f=fixture(t);let attempts=0;
 const g=f.store.group(f.group.id);g.activeRequestId=f.request.id;g.status='active';f.store.save(g);
 const r=f.store.request(f.request.id);r.status='queued';r.admissionRetryCount=3;r.admissionWait={kind:'desktop_connection',revision:r.revision,connectionKey:'same',state:'needs_refresh'};f.store.saveRequest(r);
 const e=new GroupEngine(f.store,{appOpen:async()=>true,recoveryConnectionKey:()=> 'same',turn:async()=>{attempts++;throw Object.assign(Error('still unavailable'),{code:'GROUP_NOT_ADMITTED',admissionFailure:'codex_connection'});}});
 await e.tick(g.id);assert.equal(attempts,0);
 e.control(g.id,'retry');await e.tick(g.id);
 const after=f.store.request(r.id);assert.equal(attempts,1);assert.equal(after.admissionRetryCount,1);assert.equal(after.admissionWait.state,'retrying');assert.equal(after.deliveryId,undefined);
});

test('human steering while recovery is stopped still rearms reads on a fresh connection',async t=>{
 const f=fixture(t);let key='old',sends=0,reads=0;
 const e=new GroupEngine(f.store,{appOpen:async()=>true,recoveryConnectionKey:()=>key,turn:async()=>{sends++;throw Error('unknown send');},recover:async()=>{reads++;throw Object.assign(Error('offline'),{code:'GROUP_RECOVERY_UNAVAILABLE'});}});
 await e.tick(f.group.id);for(let i=0;i<3;i++){const r=f.store.request(f.request.id);r.nextRecoveryAt=0;f.store.saveRequest(r);await e.tick(f.group.id);}
 let r=f.store.request(f.request.id);const id=r.deliveryId;r.status='queued';r.revision++;f.store.saveRequest(r);
 const a=groupActivity(f.store,e,f.group.id);assert.equal(a.needsUser,true);assert.equal(a.members[0].label,'需要刷新连接');
 key='new';const d=f.store.delivery(id);d.recoveryConnectionKey=key;f.store.saveDelivery(d);
 await e.tick(f.group.id);r=f.store.request(r.id);assert.equal(reads,4);assert.equal(sends,1);assert.equal(r.deliveryId,id);assert.equal(r.recoveryWait.count,1);
 for(let i=0;i<2;i++){r=f.store.request(r.id);r.nextRecoveryAt=0;f.store.saveRequest(r);await e.tick(f.group.id);}
 await e.tick(f.group.id);assert.equal(reads,6);assert.equal(sends,1);
});

test('a vague approval cannot mutate a task or interrupt it while an exact approval is pending',t=>{
 const f=fixture(t);f.store.savePermission({id:'permission',groupId:f.group.id,requestId:f.request.id,status:'pending'});
 const permissions=new GroupPermissions(f.store,{});let interrupts=0;const before=f.store.request(f.request.id);
 const result=routeNative(f.store,{interrupt(){interrupts++;}},{adapter:'codex',sessionId:'ct',messageId:'human-yes',turnId:'human-turn',content:'同意'},permissions);
 assert.equal(result.block,true);assert.match(result.reason,/不会作为新需求打断/);assert.equal(interrupts,0);assert.equal(f.store.request(f.request.id).revision,before.revision);assert.equal(f.store.permission('permission').status,'pending');
});

test('shared-page vague agreement cannot steer a request while approval recovery is unresolved',t=>{
 const f=fixture(t),g=f.store.group(f.group.id);g.activeRequestId=f.request.id;f.store.save(g);
 f.store.savePermission({id:'old-permission',groupId:g.id,requestId:f.request.id,status:'interrupted',resumeIntent:{status:'awaiting_checkpoint'}});
 const before=f.store.request(f.request.id);assert.throws(()=>f.store.input(g.id,{content:'同意',mode:'auto',origin:{adapter:'shared-page',sessionId:g.id,messageId:'vague-yes'}}),/不会作为新需求打断/);
 assert.equal(f.store.request(f.request.id).revision,before.revision);assert.equal(f.store.requests(g.id).length,1);
});

test('connection maintenance words never become a business supplement or interrupt work',t=>{
 const f=fixture(t);let interrupts=0;const before=f.store.request(f.request.id);
 const r=routeNative(f.store,{interrupt(){interrupts++;}},{adapter:'codex',sessionId:'ct',messageId:'refresh',turnId:'human',content:'请刷新协议连接'},new GroupPermissions(f.store,{}));
 assert.equal(r.maintenance,true);assert.equal(interrupts,0);assert.equal(f.store.request(f.request.id).revision,before.revision);
 assert.throws(()=>f.store.input(f.group.id,{content:'请刷新协作连接',mode:'auto'}),/未创建或修改业务任务/);
});

test('peer prompts carry current approval state instead of reviving historical approval phrases',t=>{
 const f=fixture(t);f.store.savePermission({id:'expired',groupId:f.group.id,requestId:f.request.id,status:'interrupted',allowPhrase:'old approval',resumeIntent:{status:'awaiting_checkpoint'}});
 const p=JSON.parse(new GroupEngine(f.store,{}).prompt(f.group,f.request,'codex','planning').text);
 assert.equal(p.approvalStatus.records[0].status,'interrupted');assert.equal(p.approvalStatus.records[0].allowPhrase,undefined);assert.match(p.approvalStatus.instruction,/非pending/);
});
