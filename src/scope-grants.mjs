import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {resourceClaims} from './group-admission.mjs';

const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
export const scopeHash=x=>createHash('sha256').update(JSON.stringify(ordered(x))).digest('hex');
const atomic=(store,fn)=>store.db.isTransaction?fn():store.transaction(fn);
const decode=row=>row?JSON.parse(row.value):null;
const key=t=>`${t.turnId}:${t.itemId}`;
const within=(p,s)=>p.path===s.path||p.path.startsWith(s.path+'/')||Boolean(p.inode&&p.inode===s.inode);
function fields(value,names){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!names.includes(k)))throw Error('Invalid scope contract fields.');}
function int(n,min=0){return Number.isSafeInteger(n)&&n>=min;}
function refundableUnits(reserved,charged){
  // Non-execution does not prove zero fees. Wait for an explicit cost receipt
  // before releasing either quota; confirmed fees remain consumed.
  if(!int(charged))throw Error('Known charged units are required for atomic quota release.');
  if(reserved!==null&&charged>reserved)throw Error('Charged units exceed the reserved bound.');
  return reserved===null?0:reserved-charged;
}
export function toolRoot(group,delivery){return fs.realpathSync(delivery.phase==='integrate'?group.repo:group.worktrees?.[delivery.member]??group.repo);}
export function scopeQuestion(grant,action='approve'){
  if(action==='revoke')return `撤销范围授权 ${grant.groupId} ${grant.id} ${grant.contractHash}`;
  return `范围授权 ${grant.groupId} ${grant.id} ${grant.contractHash}\n${JSON.stringify({...grant.contract,notBeforeISO:new Date(grant.contract.notBefore).toISOString(),expiresAtISO:new Date(grant.contract.expiresAt).toISOString()})}\n仅授权所列工具和资源；预算单位为宿主声明的上界，不是实际费用。未知调用保留预留，取消和到期不证明未执行。`;
}
// The input here is supplied exclusively by the host's native user-message
// reader. API candidates, assistant messages and old approval IDs are not proof.
export function scopeProof(turns,grant){
  const seen=new Set(grant.barrier),found=[];
  for(const t of turns){
    if(!t.turnId||!t.itemId||seen.has(key(t)))continue;
    const match=/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(t.text??'');if(!match)continue;
    let replies;try{replies=JSON.parse(match[1]);}catch{continue;}if(!Array.isArray(replies))continue;
    for(const reply of replies){
      let q;try{q=JSON.parse(reply.questionItemId);}catch{continue;}
      if(!Array.isArray(q)||q.length!==3||q[0]!=='request_user_input_async'||!/^call_[a-zA-Z0-9]+$/.test(q[1])||!int(q[2]))continue;
      const action=reply.question===scopeQuestion(grant,'revoke')&&reply.answer==='撤销'?'revoke':reply.question===scopeQuestion(grant)&&reply.answer==='批准'?'allow':reply.question===scopeQuestion(grant)&&reply.answer==='拒绝'?'reject':null;
      // A fresh human denial/revocation blocks immediately, even while its
      // enclosing assistant turn is still running. Positive authority waits
      // for a completed native turn.
      if(action==='allow'&&t.status!=='completed')continue;
      if(action)found.push({action,ownerThreadId:grant.contract.ownerThreadId,turnId:t.turnId,itemId:t.itemId,questionItemId:reply.questionItemId,textHash:scopeHash(t.text),eventId:scopeHash([grant.contract.ownerThreadId,t.itemId,reply.questionItemId])});
    }
  }return found;
}
export class ScopeGrants {
  constructor(store,runtime,{now=Date.now}={}){this.store=store;this.runtime=runtime;this.now=now;}
  get(id){return decode(this.store.db.prepare('SELECT value FROM scope_grants WHERE id=?').get(id));}
  save(g){this.store.db.prepare('INSERT INTO scope_grants VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(g.id,g.groupId,JSON.stringify(g));}
  reservations(groupId){return this.store.db.prepare('SELECT value FROM scope_reservations WHERE group_id=?').all(groupId).map(r=>JSON.parse(r.value));}
  saveReservation(r){this.store.db.prepare('INSERT INTO scope_reservations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(r.id,r.groupId,JSON.stringify(r));}
  list(groupId){return this.store.db.prepare('SELECT value FROM scope_grants WHERE group_id=?').all(groupId).map(r=>{
    const g=JSON.parse(r.value),group=this.store.group(groupId),request=this.store.request(g.contract.requestId),stale=group.epoch!==g.contract.epoch||request?.revision!==g.contract.revision||group.contexts[g.contract.member]!==g.contract.nativeContext;
    const effectiveState=['active','pending'].includes(g.status)&&stale?'stale':['active','pending'].includes(g.status)&&this.now()>=g.contract.expiresAt?'expired':g.status;
    return {...g,effectiveState,admissionEligible:effectiveState==='active'&&!g.revocationRequested&&this.now()>=g.contract.notBefore&&this.now()<g.contract.expiresAt,proofRefreshRequiredBeforeCall:true,remainingCalls:Math.max(0,g.contract.maxCalls-g.usedCalls),question:effectiveState==='pending'&&!g.revocationRequested?scopeQuestion(g):null,revocationQuestion:['active','pending'].includes(effectiveState)?scopeQuestion(g,'revoke'):null,budgetUnit:'host_declared_upper_bound_units',actualCost:null};
  });}

  async native(group,owner){
    if(typeof owner!=='string'||!owner||Object.values(group.contexts).includes(owner)||group.approvalOwnerThreadId&&group.approvalOwnerThreadId!==owner)throw Error('A designated separate native human owner is required.');
    if(typeof this.runtime.scopeUserTurns!=='function')throw Error('Native scope proof reader unavailable.');
    let turns;try{turns=await this.runtime.scopeUserTurns(group,owner);}catch{throw Error('Native scope proof reader unavailable.');}if(!Array.isArray(turns))throw Error('Invalid native scope proof response.');return turns;
  }
  async request(groupId,input){
    fields(input,['requestId','ownerThreadId','member','root','resources','categories','toolIds','notBefore','expiresAt','maxCalls','maxBudgetUnits']);
    const g=this.store.group(groupId),r=this.store.request(input.requestId),n=this.now();
    if(r?.groupId!==groupId||!['codex','harness'].includes(input.member)||!['workspace','project'].includes(input.root)||!Array.isArray(input.categories)||!input.categories.length||input.categories.some(x=>!['read','write','irreversible'].includes(x))||!Array.isArray(input.toolIds)||!input.toolIds.length||input.toolIds.length>30||input.toolIds.some(x=>!/^[-a-z0-9._]{1,80}$/.test(x))||!int(input.notBefore)||!int(input.expiresAt)||input.expiresAt<=n||input.expiresAt<=input.notBefore||!int(input.maxCalls,1)||input.maxCalls>10000||input.maxBudgetUnits!==undefined&&!int(input.maxBudgetUnits)||JSON.stringify(input).length>24000)throw Error('Invalid scope request.');
    fields(input.resources,['reads','writes']);const rootPath=fs.realpathSync(input.root==='project'?g.repo:g.worktrees?.[input.member]??g.repo),claims=resourceClaims(rootPath,input.resources);if(claims.exclusive)throw Error('Scope resources cannot be confirmed.');
    const contract={...structuredClone(input),rootPath,claims,revision:r.revision,epoch:g.epoch,nativeContext:g.contexts[input.member],maxBudgetUnits:input.maxBudgetUnits??null,categories:[...new Set(input.categories)].sort(),toolIds:[...new Set(input.toolIds)].sort()};
    const turns=await this.native(g,input.ownerThreadId),grant={id:randomUUID(),groupId,contract,contractHash:scopeHash(contract),status:'pending',createdAt:n,barrier:turns.map(key),usedCalls:0,usedBudgetUnits:0};
    return atomic(this.store,()=>{const current=this.store.group(groupId),latest=this.store.request(r.id);if(current.epoch!==g.epoch||latest.revision!==r.revision||current.approvalOwnerThreadId!==g.approvalOwnerThreadId)throw Error('Scope binding changed while reading native records.');this.save(grant);return {...grant,question:scopeQuestion(grant),revocationQuestion:scopeQuestion(grant,'revoke')};});
  }
  async refresh(groupId){
    const group=this.store.group(groupId),grants=this.list(groupId).filter(g=>['pending','active'].includes(g.status)),owners=new Map();
    for(const grant of grants)if(!owners.has(grant.contract.ownerThreadId)){try{owners.set(grant.contract.ownerThreadId,await this.native(group,grant.contract.ownerThreadId));}catch{atomic(this.store,()=>{for(const prior of grants.filter(g=>g.contract.ownerThreadId===grant.contract.ownerThreadId)){const current=this.get(prior.id);current.nativeCheck={state:'unavailable',at:this.now()};this.save(current);}});throw Error('Native scope proof reader unavailable.');}}
    return atomic(this.store,()=>{
      const current=this.store.group(groupId);if(current.epoch!==group.epoch||current.approvalOwnerThreadId!==group.approvalOwnerThreadId)throw Error('Scope identity changed during verification.');
      for(const initial of grants){
        const g=this.get(initial.id);g.nativeCheck={state:'verified',at:this.now()};this.save(g);const proofs=scopeProof(owners.get(g.contract.ownerThreadId),g),revoke=proofs.find(p=>p.action==='revoke'),reject=proofs.find(p=>p.action==='reject'),allow=proofs.find(p=>p.action==='allow');
        const proof=revoke??(g.status==='pending'?(reject??allow):null);if(!proof)continue;
        const used=decode(this.store.db.prepare('SELECT value FROM scope_native_events WHERE id=?').get(proof.eventId));if(used){if(used.grantId!==g.id)throw Error('Native scope proof was already used.');continue;}
        if(proof.action==='allow'&&(g.status!=='pending'||this.now()>=g.contract.expiresAt||current.epoch!==g.contract.epoch||this.store.request(g.contract.requestId)?.revision!==g.contract.revision))continue;
        this.store.db.prepare('INSERT INTO scope_native_events VALUES(?,?)').run(proof.eventId,JSON.stringify({grantId:g.id,proof}));
        g.status=proof.action==='allow'?'active':proof.action==='revoke'?'revoked':'rejected';g.decisions??=[];g.decisions.push(proof);g.proof=proof;g.decidedAt=this.now();this.save(g);
      }return this.list(groupId);
    });
  }
  requestRevocation(groupId,id){return atomic(this.store,()=>{const g=this.get(id);if(g?.groupId!==groupId)throw Error('Unknown scope.');if(this.now()>=g.contract.expiresAt||!['active','pending'].includes(g.status))return {grantId:id,status:g.status,admissionStopped:true,question:null,requiresNativeProof:false};if(['active','pending'].includes(g.status)){g.revocationRequested=true;this.save(g);}return {grantId:id,status:g.status,admissionStopped:Boolean(g.revocationRequested)||g.status!=='active',question:scopeQuestion(g,'revoke'),requiresNativeProof:true};});}
  // Called inside the same transaction that inserts the tool-call journal.
  reserve(grantId,call,delivery,tool,root){
    if(!this.store.db.isTransaction)throw Error('Scope quota requires a transaction.');
    const g=this.get(grantId),c=g?.contract,n=this.now(),current=this.store.group(call.groupId);
    if(!g||g.groupId!==call.groupId||g.status!=='active'||g.revocationRequested)return {allowed:false,reason:'scope_not_active'};
    if(c.requestId!==call.requestId||c.revision!==call.revision||c.epoch!==call.epoch||c.member!==delivery.member||current.contexts[c.member]!==c.nativeContext||c.rootPath!==root||c.root==='project'&&delivery.phase!=='integrate')return {allowed:false,reason:'scope_binding_mismatch'};
    if(n<c.notBefore||n>=c.expiresAt)return {allowed:false,reason:'scope_expired_or_not_yet_valid'};
    if(!c.categories.includes(tool.category)||!c.toolIds.includes(tool.id)||call.resources.exclusive||call.resources.reads.some(p=>![...c.claims.reads,...c.claims.writes].some(s=>within(p,s)))||call.resources.writes.some(p=>!c.claims.writes.some(s=>within(p,s))))return {allowed:false,reason:'scope_resource_or_category_mismatch'};
    if(scopeHash(resourceClaims(root,c.resources))!==scopeHash(c.claims))return {allowed:false,reason:'scope_resource_identity_changed'};
    const units=tool.costBoundUnits??null;
    if(g.usedCalls>=c.maxCalls)return {allowed:false,reason:'scope_call_limit'};
    if(c.maxBudgetUnits!==null&&(units===null||g.usedBudgetUnits>c.maxBudgetUnits-units))return {allowed:false,reason:units===null?'scope_cost_bound_unknown':'scope_budget_limit'};
    const reservation={id:call.id,groupId:call.groupId,grantId,deliveryId:call.deliveryId,requestId:call.requestId,revision:call.revision,epoch:call.epoch,operationHash:call.operationHash,member:delivery.member,state:'held',reservedUnits:units,createdAt:n};
    if(!Number.isSafeInteger(g.usedBudgetUnits+(units??0)))return {allowed:false,reason:'scope_budget_overflow'};
    g.usedCalls++;g.usedBudgetUnits+=units??0;this.save(g);this.saveReservation(reservation);return {allowed:true,reservationId:call.id};
  }
  check(id){
    const r=decode(this.store.db.prepare('SELECT value FROM scope_reservations WHERE id=?').get(id)),g=r&&this.get(r.grantId);if(!r||r.state!=='held'||g?.status!=='active'||g.revocationRequested)return false;
    const c=g.contract,group=this.store.group(r.groupId),request=this.store.request(r.requestId);return group.status==='active'&&group.activeRequestId===r.requestId&&!request?.parallelStop&&['active','queued'].includes(request?.status)&&group.contexts[c.member]===c.nativeContext&&group.epoch===r.epoch&&request?.revision===r.revision&&this.now()>=c.notBefore&&this.now()<c.expiresAt;
  }
  settle(id,status){const r=decode(this.store.db.prepare('SELECT value FROM scope_reservations WHERE id=?').get(id));if(r?.state==='held'&&status!=='unknown'){r.state='consumed';r.settledAt=this.now();this.saveReservation(r);}}
  async prepareRelease(groupId,id){
    const reservation=decode(this.store.db.prepare('SELECT value FROM scope_reservations WHERE id=?').get(id)),call=decode(this.store.db.prepare('SELECT value FROM tool_calls WHERE id=?').get(id));
    if(reservation?.groupId!==groupId||call?.resultStatus!=='unknown'||reservation.state!=='held'||!call.finishedAt)throw Error('Only an unsettled unknown reservation can be reconciled.');
    let evidence;
    if(!call.executedAt)evidence={source:'host_journal_not_entered',receiptId:call.id,operationHash:call.operationHash,terminal:true,notExecuted:true,chargedUnits:0};
    else if(typeof this.runtime.scopeExecutionEvidence==='function')evidence=await this.runtime.scopeExecutionEvidence(call);
    fields(evidence,['source','receiptId','operationHash','terminal','notExecuted','chargedUnits']);
    if(call.executedAt&&evidence.source!=='provider_terminal_receipt'||!['host_journal_not_entered','provider_terminal_receipt'].includes(evidence.source)||typeof evidence.receiptId!=='string'||!evidence.receiptId||evidence.receiptId.length>200||evidence.operationHash!==call.operationHash||evidence.terminal!==true||evidence.notExecuted!==true||evidence.chargedUnits!==null&&!int(evidence.chargedUnits))throw Error('Reliable non-execution evidence unavailable.');
    refundableUnits(reservation.reservedUnits,evidence.chargedUnits);
    const proposal={reservationId:id,grantId:reservation.grantId,requestId:call.requestId,deliveryId:call.deliveryId,epoch:call.epoch,revision:call.revision,executor:reservation.member,evidence,hash:scopeHash(evidence)};
    return atomic(this.store,()=>{const current=decode(this.store.db.prepare('SELECT value FROM scope_reservations WHERE id=?').get(id));if(evidence.source==='provider_terminal_receipt'&&this.reservations(groupId).some(r=>r.id!==id&&r.releaseProposal?.evidence.receiptId===evidence.receiptId&&r.releaseProposal.evidence.source===evidence.source&&r.operationHash!==call.operationHash))throw Error('Provider evidence already belongs to a different child call.');if(current.state!=='held')throw Error('Reservation changed.');current.releaseProposal=proposal;this.saveReservation(current);return proposal;});
  }
  reviewProposals(groupId,member,requestId){return this.reservations(groupId).filter(r=>r.state==='held'&&r.releaseProposal&&r.member!==member&&(!requestId||r.requestId===requestId)).slice(0,30).map(r=>r.releaseProposal);}
  release(groupId,id,messageId){return atomic(this.store,()=>{
    const r=decode(this.store.db.prepare('SELECT value FROM scope_reservations WHERE id=?').get(id));if(r?.groupId!==groupId)throw Error('Unknown scope reservation.');if(r.state==='released')return {released:false,duplicate:true};
    const proposal=r.releaseProposal,m=this.store.messageById(messageId),d=m&&decode(this.store.db.prepare('SELECT value FROM deliveries WHERE id=?').get(m.origin?.messageId));
    let reply;try{reply=JSON.parse(m?.content);}catch{}
    if(!proposal||m?.groupId!==groupId||m.requestId!==r.requestId||!d||d.groupId!==groupId||d.requestId!==r.requestId||d.phase!=='review'||d.initialReview||d.replyOnly||d.member===r.member||m.sender!==d.member||d.status!=='received'||d.responseMessageId!==messageId||!m.protocol||reply?.status!=='done'||reply.responseScope!==d.id||!d.scopeReleaseProposals?.some(p=>p.reservationId===id&&p.hash===proposal.hash)||!reply.scopeReleaseResolutions?.some(p=>p.reservationId===id&&p.evidenceHash===proposal.hash&&p.nonExecutionVerified===true))throw Error('An independent delivered review of this exact host evidence is required.');
    const grant=this.get(r.grantId),units=r.reservedUnits,charged=proposal.evidence.chargedUnits,refund=refundableUnits(units,charged);
    grant.usedCalls--;grant.usedBudgetUnits-=refund;if(grant.usedCalls<0||grant.usedBudgetUnits<0)throw Error('Invalid quota reconciliation.');
    r.state='released';r.release={messageId,evidenceHash:proposal.hash,refundedUnits:refund,retainedUnits:units===null?null:units-refund,at:this.now()};this.save(grant);this.saveReservation(r);return {released:true,release:r.release};
  });}
  acceptReview(groupId,messageId){const m=this.store.messageById(messageId);let reply;try{reply=JSON.parse(m.content);}catch{return [];}
    const results=[];for(const p of (Array.isArray(reply.scopeReleaseResolutions)?reply.scopeReleaseResolutions:[]).slice(0,30))try{results.push(this.release(groupId,p.reservationId,messageId));}catch{results.push({released:false,reason:'independent_evidence_mismatch'});}return results;
  }
}
