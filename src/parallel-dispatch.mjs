import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {selectLane,prepareLaneSave} from './task-lanes.mjs';
import {resourceClaims} from './group-admission.mjs';

const views=new WeakMap();
const executionFields=['status','phase','agreement','actions','results','deferred','workBaselines','workCandidates','integrationScope','integrationCheck','integrationReadyReceipt','readinessBaseline','readinessBaselines','strength','error','errorDetails','nextRecoveryAt','recoveryWait','replyRecoveryAttempts','reviewRepairRounds','admissionWait','admissionRetryAt','admissionRetryCount','interrupted','nativeFailure'];
export function executionView(request,key) {
  const lane=request.lanes?.[key];if(!lane)throw Error('Unknown execution lane.');
  views.set(request,{key});
  selectLane(request,key);
  for(const field of executionFields){if(['actions','results'].includes(field))continue;if(Object.hasOwn(lane,field))request[field]=structuredClone(lane[field]);else delete request[field];}
  request.currentTaskId=lane.taskId;
  return request;
}
export function viewKey(request){return views.get(request)?.key;}
export function mergeUsage(current={},incoming={}) {
 const samples={...incoming.observation?.samples,...current.observation?.samples};
 const base=u=>{const ss=Object.values(u.observation?.samples||{});return {calls:(u.calls||0)-ss.length,knownTokens:(u.knownTokens||0)-ss.reduce((n,s)=>n+(s.tokens??0),0),unknownCalls:(u.unknownCalls||0)-ss.filter(s=>s.classification!=='complete').length};};
 const a=base(current),b=base(incoming),ss=Object.values(samples);
 return {...current,observation:{version:1,samples},calls:Math.max(a.calls,b.calls)+ss.length,knownTokens:Math.max(a.knownTokens,b.knownTokens)+ss.reduce((n,s)=>n+(s.tokens??0),0),unknownCalls:Math.max(a.unknownCalls,b.unknownCalls)+ss.filter(s=>s.classification!=='complete').length};
}
export function mergeExecution(root,view) {
  const key=viewKey(view),original=root.lanes[key];prepareLaneSave(view);
  const lane={...original,...view.lanes[key]};
  if(!Object.hasOwn(view.lanes[key],'deliveryId'))delete lane.deliveryId;
  for(const field of executionFields){if(Object.hasOwn(view,field))lane[field]=structuredClone(view[field]);else delete lane[field];}
  root.lanes[key]=lane;selectLane(root,root.activeLaneKey);root.usage=mergeUsage(root.usage,view.usage);
  if(['blocked','needs_recovery','needs_decision','awaiting_review'].includes(view.status)||lane.revision!==root.revision){root.parallelStop=true;root.status=view.status;root.error=view.error;}
  // Only the foreground lane may update the compatibility execution view.
  if(root.activeLaneKey===key&&lane.revision===root.revision)for(const field of executionFields){if(['actions','results'].includes(field))continue;if(Object.hasOwn(lane,field))root[field]=structuredClone(lane[field]);else delete root[field];}
  if(root.parallelStop&&root.status==='active')root.status='needs_recovery';
  return root;
}

function laneStore(store,requestId,key,member,recovering,owner){return new Proxy(store,{get(target,property){
  if(property==='beforeNativeAdmission')return (groupId,delivery)=>{
    const lease=target.db.prepare('SELECT owner,expires FROM worker_leases WHERE group_id=?').get(groupId);
    if(lease?.owner!==owner||lease.expires<=Date.now()||target.delivery(delivery.id)?.started)throw Error('Original admission lease or checkpoint changed; reconcile without sending.');
  };
  if(property==='group'&&recovering)return id=>({...target.group(id),activeRequestId:requestId});
  if(property==='request')return id=>id===requestId?target.requestInLane(id,key):target.request(id);
  if(property==='requests')return id=>target.requests(id).map(r=>r.id===requestId?target.requestInLane(r.id,key):r);
  if(property==='saveDelivery')return delivery=>{delivery.laneKey??=key;return target.saveDelivery(delivery);};
  if(['claimWorker','renewWorker'].includes(property))return ()=>true;
  if(property==='releaseWorker')return ()=>{};
  if(property==='save')return value=>{
    const latest=target.group(value.id);
    latest.cursors[member]=value.cursors[member];latest.initialized[member]=value.initialized[member];latest.summary=value.summary;
    if(!['paused','closed','apps_closed','blocked','needs_recovery','needs_decision'].includes(latest.status)||['blocked','needs_recovery','needs_decision'].includes(value.status))latest.status=value.status;
    return target.save(latest);
  };
  const value=target[property];return typeof value==='function'?value.bind(target):value;
}});}

// Work may overlap; review and integration continue through the original queue.
// No independent transport, approval implementation or third session is added.
export async function parallelTick(engine,groupId,Engine) {
  const store=engine.store,group=store.group(groupId),pending=store.admissions().rows().filter(r=>r.groupId===groupId&&r.state==='held'),request=store.request(pending[0]?.requestId??group.activeRequestId);
  if(!request?.taskList||(!pending.length&&request.phase!=='execution'))return null;
  const held=store.admissions().rows().filter(r=>r.groupId===groupId&&r.requestId===request.id&&r.state==='held');
  if(!held.length&&(request.parallelStop||request.parallelDisabled||request.actions?.[0]?.phase!=='work'||request.deliveryId||group.status!=='active'||store.pendingPermissions(groupId).length))return null;
  if(engine.running.has(groupId)||!store.claimWorker(groupId,engine.owner))return false;
  const controller=new AbortController();engine.running.set(groupId,controller);
  const timer=setInterval(()=>{if(!store.renewWorker(groupId,engine.owner))controller.abort();},5000);timer.unref();
  try{
    let reservations=held;
    if(!held.length){
      const candidates=[request.taskList.find(t=>t.taskId===request.currentTaskId),...request.taskList.filter(t=>t.status==='queued'&&t.taskId!==request.currentTaskId)];
      const distinct=new Set();reservations=[];let denied=false;
      for(const task of candidates){
        if(!reservations.length&&task?.taskId!==request.currentTaskId)break;
        const existing=task&&request.lanes[`${request.id}:${request.revision}:${task.taskId}`];
        if(task?.taskId!==request.currentTaskId&&existing?.prefetched&&existing.results?.['work:'+task.owner])continue;
        if(!task||distinct.has(task.owner)||resourceClaims(group.repo,task.resources).exclusive)continue;
        const result=store.admissions().reserve({groupId,requestId:request.id,taskId:task.taskId,member:task.owner,deliveryId:randomUUID()});
        if(result.admitted){distinct.add(task.owner);reservations.push(result.reservation);}else denied=true;
        if(reservations.length===2)break;
      }
      // A real capacity/session/unknown-result denial must not fall through
      // to ordinary dispatch, which has no reservation for this task.
      if(!reservations.length&&denied)return false;
    }
      // A single reservation is still dispatched through the same lane path;
      // its terminal result prevents an unused capacity reservation leaking.
      for(const reservation of reservations)store.transaction(()=>{
        const r=store.request(request.id),task=r.taskList.find(t=>t.taskId===reservation.taskId),key=`${r.id}:${reservation.revision}:${reservation.taskId}`;
        if(reservation.revision!==r.revision||r.lanes[key]?.reservationId===reservation.id)return;
        if(!r.lanes[key]?.actions?.length){
          r.lanes[key]={key,requestId:r.id,revision:r.revision,taskId:task.taskId,deliveryId:null,actions:[{phase:'work',member:task.owner,task:task.task,taskId:task.taskId,readOnly:task.readOnly,resources:task.resources},{phase:'review',member:task.owner==='codex'?'harness':'codex',taskId:task.taskId},{phase:'integrate',member:r.agreement.integrator,task:task.task,taskId:task.taskId,readOnly:task.readOnly}],results:{},terminalEvents:[]};
        }
        const lane=r.lanes[key];lane.status='active';lane.phase='execution';lane.agreement={...r.agreement,owner:task.owner,review:true,readOnlyWork:task.readOnly?[task.owner]:[],tasks:{codex:'',harness:'',[task.owner]:task.task}};lane.reservationId=reservation.id;
        lane.actions[0].resources=task.resources;
        lane.prefetched=task.taskId!==r.currentTaskId;store.saveRequest(r);
      });
    if(!reservations.length)return null;
    const settled=await Promise.allSettled(reservations.map(async reservation=>{
      const r=store.request(request.id),key=`${reservation.requestId}:${reservation.revision}:${reservation.taskId}`,lane=r.lanes[key];
      const journal=store.delivery(reservation.deliveryId);
      if(journal?.status==='received'){store.admissions().release(reservation.id);return;}
      if(journal?.status==='failed'&&store.admissions().releaseNativeFailure(reservation.id))return;
      if((r.parallelStop||r.revision!==reservation.revision||store.group(groupId).epoch!==reservation.epoch)&&!store.delivery(reservation.deliveryId)?.started){store.admissions().abandonUnstarted(reservation.id);return;}
      if(!journal?.started&&!isDeepStrictEqual(reservation.claims,resourceClaims(store.group(groupId).repo,r.taskList.find(t=>t.taskId===reservation.taskId)?.resources))){
        if(store.admissions().abandonUnstarted(reservation.id))store.transaction(()=>{const latest=store.request(request.id);latest.parallelDisabled=true;store.saveRequest(latest);});return;
      }
      if(!lane)throw Error('Reserved lane checkpoint missing.');
      if(!journal&&lane.actions?.[0]?.phase!=='work'){store.admissions().abandonUnstarted(reservation.id);return;}
      // A persisted reservation can precede transport admission. Its original
      // ID is supplied to the normal journal creation, never allocated anew.
      const recovering=Boolean(lane.deliveryId&&store.delivery(lane.deliveryId)?.started);
      const worker=new Engine(laneStore(store,request.id,key,reservation.member,recovering,engine.owner),engine.runtime,{maxRecoveryAttempts:engine.maxRecoveryAttempts,toolRegistry:engine.toolRegistry,toolCredentials:engine.toolCredentials});
      worker.reservedDeliveryId=reservation.deliveryId;
      const abort=()=>worker.interrupt(groupId,controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});
      try{await worker.runTick(groupId,{recoveryOnly:Boolean(lane.deliveryId)&&['paused','apps_closed'].includes(store.group(groupId).status)});}
      finally{controller.signal.removeEventListener('abort',abort);}
      store.admissions().release(reservation.id);
    }));
    if(store.request(request.id).parallelStop)for(const reservation of reservations)if(!store.delivery(reservation.deliveryId)?.started)store.admissions().abandonUnstarted(reservation.id);
    store.transaction(()=>{
      const r=store.request(request.id),g=store.group(groupId);
      if(settled.some(x=>x.status==='rejected')){r.parallelStop=true;r.status='needs_recovery';r.error='A parallel lane requires checkpoint reconciliation.';}
      const remaining=store.admissions().rows().some(x=>x.groupId===groupId&&x.requestId===r.id&&x.state==='held');
      if(!remaining&&reservations.some(x=>x.revision!==r.revision)){r.parallelStop=false;r.parallelDisabled=true;if(r.phase==='planning')r.status='queued';}
      if(r.parallelStop&&!remaining){
        r.parallelStop=false;r.parallelDisabled=true;
        const foreground=r.lanes[r.activeLaneKey];r.status=foreground?.status??'active';if(foreground?.error)r.error=foreground.error;
        if(g.activeRequestId===r.id&&!['paused','closed','apps_closed'].includes(g.status)){g.status=['blocked','needs_decision','needs_recovery'].includes(r.status)?r.status:'active';store.save(g);}
      }
      store.saveRequest(r);
    });
    return true;
  }finally{clearInterval(timer);store.releaseWorker(groupId,engine.owner);engine.running.delete(groupId);}
}
