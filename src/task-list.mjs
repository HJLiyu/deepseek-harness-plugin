import {reviewerFor} from './collaboration-policy.mjs';
import {createHash} from 'node:crypto';
import {activateTaskLane} from './task-lanes.mjs';
export function makeTaskList(request,items){
 if(!Array.isArray(items)||!items.length||items.length>50)throw Error('taskList requires 1–50 tasks.');
 const ids=new Set();
 return items.map((x,index)=>{
  if(!x||typeof x.title!=='string'||!x.title.trim()||x.title.length>300||typeof x.task!=='string'||!x.task.trim()||x.task.length>6000||typeof x.acceptance!=='string'||!x.acceptance.trim()||x.acceptance.length>2000||!['codex','harness'].includes(x.owner))throw Error('Invalid task definition.');
  const key=x.key||String(index+1);if(typeof key!=='string'||key.length>100||ids.has(key))throw Error('Duplicate task key.');
  if(x.resources!==undefined&&(!x.resources||!Array.isArray(x.resources.reads)||!Array.isArray(x.resources.writes)||x.resources.reads.length+x.resources.writes.length>100||[...x.resources.reads,...x.resources.writes].some(p=>typeof p!=='string'||!p||p.length>2000)))throw Error('Invalid task resources.');
  const deps=x.deps||[];if(!Array.isArray(deps)||deps.some(d=>!ids.has(d)))throw Error('Dependencies must refer to earlier tasks.');ids.add(key);
  return {taskId:createHash('sha256').update(request.id+'\0'+request.revision+'\0'+key).digest('hex').slice(0,24),key,index,title:x.title,task:x.task,owner:x.owner,deps,acceptance:x.acceptance,readOnly:x.readOnly===true,...(x.resources?{resources:structuredClone(x.resources)}:{}),evidenceRefs:[],revision:request.revision,status:'queued'};
 });
}
export function startNextTask(request){
 const list=request.taskList;if(!list)return false;
 if(request.taskListRevision!==request.revision)throw Error('Task list revision changed.');
 const next=list.find(t=>t.status!=='done');if(!next)return false;
 if(next.status!=='queued'||next.deps.some(k=>!list.some(t=>t.key===k&&t.status==='done')))throw Error('Task is not ready.');
 const lane=activateTaskLane(request,next.taskId);
 const prefetched=lane.prefetched&&(lane.results?.['work:'+next.owner]||lane.status!=='active')?{actions:structuredClone(lane.actions),deferred:structuredClone(lane.deferred??[]),status:lane.status,error:lane.error}:null;
 next.status='running';request.currentTaskId=next.taskId;
 const reviewer=reviewerFor(next.owner,request.collaboration);
 request.agreement={...request.agreement,owner:next.owner,review:true,readOnlyWork:next.readOnly?[next.owner]:[],independentWork:[],tasks:{codex:'',harness:'',[next.owner]:next.task}};
 request.actions=[{phase:'work',member:next.owner,task:next.task,readOnly:next.readOnly,taskId:next.taskId},{phase:'review',member:reviewer,taskId:next.taskId},{phase:'integrate',member:request.agreement.integrator,task:next.task,readOnly:next.readOnly,taskId:next.taskId}];
 if(prefetched){
  request.actions=prefetched.actions;request.deferred=prefetched.deferred;for(const k of ['workBaselines','workCandidates','integrationScope']){if(lane[k]!==undefined)request[k]=structuredClone(lane[k]);else delete request[k];}delete lane.prefetched;
 }
 request.phase='execution';request.status=prefetched?.status??'active';if(prefetched?.error)request.error=prefetched.error;return true;
}
export function finishTask(request){
 const t=request.taskList?.find(t=>t.taskId===request.currentTaskId);if(!t)return false;
 if(t.status==='done')return false;
 if(['blocked','needs_recovery','needs_decision','paused'].includes(request.status)||t.revision!==request.revision||request.deliveryId||request.actions?.length||request.deferred?.length)return false;
 const review=Object.entries(request.results||{}).find(([k,v])=>k.startsWith('review:')&&v.status==='done');
 const integration=request.results?.['integrate:'+request.agreement.integrator];
 const noFiles=t.readOnly===true&&Array.isArray(integration?.integrationFiles)&&integration.integrationFiles.length===0&&Array.isArray(review?.[1]?.verification)&&review[1].verification.length>0;
 if(!review||integration?.status!=='done'||(!integration.verification?.length&&!noFiles))return false;
 t.status='done';t.evidenceRefs=[...(integration.verification?.length?integration.verification:review[1].verification)];t.receipts=structuredClone(request.results);if(request.integrationCheck?.verified&&integration.messageId)t.verificationSnapshot={revision:t.revision,messageId:integration.messageId,hashes:structuredClone(request.integrationCheck.verified)};t.completedEvent=request.id+':'+t.taskId+':'+request.revision;
 // The next task receives its own lane; retain this task's original results.
 request.deferred=[];
 for(const k of ['integrationScope','integrationCheck','integrationReadyReceipt','workBaselines','workCandidates','reviewRepairRounds'])delete request[k];
 delete request.currentTaskId;return true;
}
export function invalidateTasks(request){
 if(request.taskList&&request.taskListRevision!==request.revision&&request.taskListInvalidatedRevision!==request.revision){
  request.taskListInvalidatedRevision=request.revision;
  request.taskListHistory||=[];request.taskListHistory.push({revision:request.taskListRevision,tasks:structuredClone(request.taskList)});
  for(const t of request.taskList)t.status='invalidated';delete request.currentTaskId;
 }
}
export function taskListView(request){
 return {revision:request.revision,tasks:(request.taskList||[]).map(t=>({...t,receipts:undefined,executionStage:Object.values(request.lanes??{}).find(l=>l.taskId===t.taskId&&l.revision===t.revision)?.deliveryId?'inflight':Object.values(request.lanes??{}).find(l=>l.taskId===t.taskId&&l.revision===t.revision)?.prefetched?'awaiting_serial_review':null,status:t.revision!==request.revision?'invalidated':t.status!=='done'&&Object.values(request.lanes??{}).some(l=>l.taskId===t.taskId&&l.revision===t.revision&&l.deliveryId)?'running':t.taskId===request.currentTaskId&&['blocked','needs_recovery','needs_decision','paused'].includes(request.status)?'blocked':t.taskId===request.currentTaskId&&request.actions?.[0]?.phase==='review'?'review':t.status})),invalidationPolicy:'A new revision invalidates the entire queue conservatively; history is retained and a new plan must revalidate the queue.',currentTaskId:request.currentTaskId??null};
}
