import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validEmptyTurn} from './native-empty-turn.mjs';
import {nativeParallelEvidence} from './native-parallel.mjs';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const lower=p=>p.replaceAll('\\','/').replace(/\/$/,'').toLowerCase();
const within=(p,root)=>p===root||p.startsWith(root+'/');
// Session occupancy is distinct from task success and unknown historical use.
// Only the coordinator's exact native terminal/quarantine proofs release the
// session gate; a caller-supplied status name alone never does.
export function deliveryUnsettled(store,d){
  if(!d.started||['received','failed'].includes(d.status))return false;
  const g=store.group(d.groupId);
  if(d.status==='completed_without_reply'){
    if(validEmptyTurn(g,d,d.nativeEmptyProof)&&d.nativeAdmission.promptHash===store.hash(`[Group delivery ${d.id}]\n${d.prompt}`))return false;
    const p=d.nativeTerminalProof;
    if(d.member==='harness'&&p?.deliveryId===d.id&&p.sessionId===g.contexts.harness&&p.idle===true&&p.reason==='completed'&&Number.isSafeInteger(p.turn)&&p.turn>=0&&Number.isSafeInteger(p.endSeq)&&p.endSeq>=0)return false;
  }
  if(d.status==='unmatched_superseded_readonly'){
    const p=d.recoveryProof,r=store.request(d.requestId);
    if(d.member==='codex'&&d.phase==='planning'&&r?.revision>d.revision&&!d.nativeAdmission&&!d.nativeTurnId&&p?.kind==='superseded-readonly-unmatched'&&p.threadId===g.contexts.codex&&Number.isSafeInteger(p.completeNativeTurnCount)&&p.completeNativeTurnCount>=0&&['idle','notLoaded'].includes(p.desktopStatus))return false;
  }
  return true;
}
const overlap=(a,b)=>within(a.path,b.path)||within(b.path,a.path)||Boolean(a.inode&&a.inode===b.inode);
const blocked=reason=>({admitted:false,reason});
export function resourceClaims(root, declaration) {
  const fallback=reason=>({exclusive:true,reason,reads:[],writes:[]});
  if(!declaration||!Array.isArray(declaration.reads)||!Array.isArray(declaration.writes)||declaration.reads.length+declaration.writes.length>100)return fallback('resources_missing_or_invalid');
  try {
    const realRoot=fs.realpathSync(root),rootKey=lower(realRoot);
    const resolve=value=>{
      if(typeof value!=='string'||!value||value.length>2000||path.isAbsolute(value)||/[:\x00-\x1f*?]/.test(value)||value.split(/[\\/]/).some(s=>s==='.'||s==='..'||/[. ]$/.test(s)))throw Error('uncertain path');
      let current=path.resolve(realRoot,value.replaceAll('\\',path.sep)),tail=[];
      if(!within(lower(current),rootKey))throw Error('outside root');
      while(!fs.existsSync(current)){
        // A dangling link is not proof that a path is absent.
        try{fs.lstatSync(current);throw Error('unresolved link');}catch(e){if(e.code!=='ENOENT')throw e;}
        tail.unshift(path.basename(current));const parent=path.dirname(current);if(parent===current)throw Error('no existing ancestor');current=parent;
      }
      const real=fs.realpathSync(current),canonical=path.join(real,...tail);
      if(!within(lower(canonical),rootKey))throw Error('alias outside root');
      // NTFS file IDs can exceed 2^53. Number conversion can make distinct
      // files compare equal; retain the host's exact integer identity.
      const st=tail.length?null:fs.statSync(real,{bigint:true});
      return {path:lower(canonical),inode:st?.isFile()?`${st.dev}:${st.ino}`:null};
    };
    return {identityVersion:2,exclusive:false,reason:null,reads:declaration.reads.map(resolve),writes:declaration.writes.map(resolve)};
  }catch{return fallback('resource_identity_uncertain');}
}
export function resourceConflict(a,b) {
  // Old held claims may contain rounded identities. Do not reinterpret or
  // release them during migration; serialize admission until they settle.
  if(a.exclusive||b.exclusive||a.identityVersion!==2||b.identityVersion!==2)return true;
  return a.writes.some(x=>[...b.reads,...b.writes].some(y=>overlap(x,y)))||b.writes.some(x=>a.reads.some(y=>overlap(x,y)));
}
export function declaredWritesCover(root,declaration,files){
  const declared=resourceClaims(root,declaration);if(declared.exclusive)return false;
  return files.every(file=>{const claim=resourceClaims(root,{reads:[],writes:[file]});return !claim.exclusive&&claim.writes.every(target=>declared.writes.some(scope=>within(target.path,scope.path)||Boolean(target.inode&&target.inode===scope.inode)));});
}

// Internal scheduler API, not an authorization endpoint. Every level consumes
// a row; rows are never expired merely because a lease or timeout elapsed.
export class AdmissionLedger {
  constructor(store){this.store=store;}
  rows(){return this.store.db.prepare('SELECT value FROM admission_reservations').all().map(r=>JSON.parse(r.value));}
  reserve(input){return this.store.transaction(()=>{
    const {groupId,requestId,taskId,member,deliveryId,parentId=null}=input;
    if(!['codex','harness'].includes(member)||typeof deliveryId!=='string'||!deliveryId||deliveryId.length>200)throw Error('Invalid admission identity.');
    const group=this.store.group(groupId),request=this.store.request(requestId);
    if(!request||request.groupId!==groupId)return blocked('request_mismatch');
    const task=request.taskList?.find(t=>t.taskId===taskId);
    if(!task||task.revision!==request.revision)return blocked('task_revision_mismatch');
    if(task.owner!==member)return blocked('executor_mismatch');
    const claims=resourceClaims(group.repo,task.resources);
    if(task.readOnly&&claims.writes.length)return blocked('read_only_write_claim');
    const context=group.contexts?.[member];if(typeof context!=='string'||!context)return blocked('session_unconfirmed');
    const rows=this.rows(),binding={groupId,requestId,taskId,member,deliveryId,parentId,revision:request.revision,epoch:group.epoch,session:`${member}:${context}`,root:lower(fs.realpathSync(group.repo)),claims};
    const digest=hash(binding),existing=rows.find(r=>r.deliveryId===deliveryId);
    if(existing){if(existing.digest!==digest)throw Error('Delivery reservation binding changed.');return {admitted:false,reason:'reservation_exists',reused:true,reservation:existing};}
    if(group.status!=='active'||!['active','queued'].includes(request.status))return blocked('execution_paused_or_blocked');
    if(this.store.pendingPermissions(groupId).length||this.store.hasPendingScopes?.(groupId))return blocked('approval_pending');
    if(request.parallelStop||['blocked','needs_recovery','needs_decision'].includes(this.store.request(group.activeRequestId)?.status))return blocked('active_request_has_unsettled_failure');
    if(task.status!=='queued'&&task.status!=='running')return blocked('task_not_runnable');
    if(task.deps.some(key=>!request.taskList.some(t=>t.key===key&&t.status==='done'&&t.evidenceRefs?.length)))return blocked('dependency_not_accepted');
    const held=rows.filter(r=>r.state==='held');
    if(held.some(r=>r.groupId===groupId&&r.requestId!==requestId))return blocked('prior_request_unsettled');
    const legacy=this.store.db.prepare('SELECT value FROM deliveries').all().map(r=>JSON.parse(r.value)).filter(d=>deliveryUnsettled(this.store,d)&&d.id!==deliveryId&&!held.some(r=>r.deliveryId===d.id));
    if(legacy.some(d=>d.groupId===groupId||`${d.member}:${this.store.group(d.groupId).contexts?.[d.member]}`===binding.session))return blocked('legacy_delivery_unsettled');
    if(parentId&&!held.some(r=>r.id===parentId&&r.groupId===groupId&&r.requestId===requestId&&r.revision===request.revision))return blocked('parent_not_held');
    const limit=group.executionSettings?.maxExecutors??2;
    if(!Number.isSafeInteger(limit)||limit<1||limit>16)throw Error('Invalid executor limit.');
    if(held.filter(r=>r.groupId===groupId).length>=limit)return blocked('capacity_full');
    if(held.some(r=>r.session===binding.session))return blocked('session_busy');
    if(held.some(r=>r.groupId===groupId&&r.taskId===taskId))return blocked('task_already_reserved');
    if(held.some(r=>resourceConflict(claims,r.claims)))return blocked(claims.exclusive?'sequential_required':'resource_conflict');
    const reservation={...binding,id:deliveryId,digest,state:'held',createdAt:Date.now(),release:null};
    this.store.db.prepare('INSERT INTO admission_reservations VALUES(?,?,?)').run(deliveryId,groupId,JSON.stringify(reservation));
    return {admitted:true,reused:false,reservation};
  });}
  // Terminal status is read from the coordinator journal, never a caller's
  // assertion of success/non-execution. Failed/unknown calls retain their row.
  releaseNativeFailure(id){return this.store.transaction(()=>{
    const row=this.rows().find(r=>r.id===id);if(!row||row.state!=='held')return false;
    const d=this.store.delivery(id),g=this.store.group(row.groupId),p=d?.nativeFailure,m=this.store.messageById(d?.responseMessageId);
    if(d?.status!=='failed'||d.member!=='codex'||p?.kind!=='usage_limit'||!p.turnId||p.turnId!==d.nativeTurnId||d.nativeAdmission?.turnId!==p.turnId||d.nativeAdmission.threadId!==g.contexts.codex||!/^[a-f0-9]{64}$/.test(d.nativeAdmission.promptHash??'')||m?.groupId!==row.groupId||m.requestId!==row.requestId||m.sender!=='codex'||m.origin?.messageId!==id||d.requestId!==row.requestId||d.revision!==row.revision||d.epoch!==row.epoch||d.groupId!==row.groupId||d.member!==row.member)return false;
    row.state='released';row.release={deliveryId:id,reason:'verified_native_usage_failure',turnId:p.turnId,at:Date.now()};
    this.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(row),id);return true;
  });}
  release(id){return this.store.transaction(()=>{
    const row=this.rows().find(r=>r.id===id);if(!row)return false;if(row.state==='released')return false;
    const d=this.store.delivery(row.deliveryId);
    if(!d||d.requestId!==row.requestId||d.revision!==row.revision||d.epoch!==row.epoch||d.member!==row.member||d.groupId!==row.groupId)return false;
    const message=this.store.messageById(d.responseMessageId);
    if(d.status!=='received'||typeof d.responseMessageId!=='string'||message?.requestId!==row.requestId||message?.groupId!==row.groupId||message?.sender!==row.member)return false;
    row.state='released';row.release={deliveryId:d.id,messageId:d.responseMessageId,at:Date.now()};
    this.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(row),id);return true;
  });}
  abandonUnstarted(id){return this.store.transaction(()=>{
    const row=this.rows().find(r=>r.id===id);if(!row||row.state!=='held')return false;
    const d=this.store.delivery(row.deliveryId);
    if(d&&(d.started||d.nativeAdmission||d.nativeTurnId||d.status!=='not_admitted'||d.nativeDispatch?.stage==='send_attempted'))return false;
    row.state='released';row.release={deliveryId:row.deliveryId,reason:d?'verified_not_admitted':'no_dispatch_journal',at:Date.now()};
    this.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(row),id);return true;
  });}
  releaseEmpty(id){const apply=()=>{
    const row=this.rows().find(r=>r.id===id);if(!row||row.state!=='held')return false;
    const d=this.store.delivery(id),g=this.store.group(row.groupId);
    if(d?.status!=='completed_without_reply'||d.requestId!==row.requestId||d.revision!==row.revision||
      d.epoch!==row.epoch||d.groupId!==row.groupId||d.member!==row.member||!validEmptyTurn(g,d,d.nativeEmptyProof))return false;
    row.state='released';row.release={deliveryId:id,reason:'verified_empty_native_turn',proof:d.nativeEmptyProof,at:Date.now()};
    this.store.db.prepare('UPDATE admission_reservations SET value=? WHERE id=?').run(JSON.stringify(row),id);return true;
  };return this.store.db.isTransaction?apply():this.store.transaction(apply);}
  observation(groupId){
    const held=this.rows().filter(r=>r.groupId===groupId&&r.state==='held'),ids=new Set();
    let settledWithoutReply=0,quarantinedReadOnly=0;
    for(const row of this.store.db.prepare('SELECT value FROM deliveries WHERE group_id=?').all(groupId)){const d=JSON.parse(row.value);if(deliveryUnsettled(this.store,d))ids.add(d.id);else if(d.status==='completed_without_reply')settledWithoutReply++;else if(d.status==='unmatched_superseded_readonly')quarantinedReadOnly++;}
    const validation=nativeParallelEvidence(this.store,groupId);
    return {unit:'heldReservations',held:held.length,occupancy:held.length,unsettledDeliveries:ids.size,settledWithoutReply,quarantinedReadOnly,sessions:held.map(r=>r.session),schedulingImplemented:Boolean(validation),validatedWith:validation?'nativeRuntime':'mockRuntime',validation};
  }
}
