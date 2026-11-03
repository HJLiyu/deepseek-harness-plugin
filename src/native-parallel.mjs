import {randomUUID} from 'node:crypto';
import {localFetch} from './group-http.mjs';

function activePair(store,groupId){
 const group=store.group(groupId),rows=store.admissions().rows().filter(r=>r.groupId===groupId&&r.state==='held');
 if(group.status!=='active'||store.pendingPermissions(groupId).length||rows.length!==2||new Set(rows.map(r=>r.member)).size!==2)return null;
 const pair=Object.fromEntries(rows.map(row=>[row.member,{row,delivery:store.delivery(row.deliveryId)}]));
 if(rows.some(row=>row.epoch!==group.epoch||row.requestId!==group.activeRequestId||row.revision!==store.request(row.requestId)?.revision))return null;
 if(Object.values(pair).some(({row,delivery:d})=>!d?.started||d.status!=='pending'||d.phase!=='work'||d.groupId!==groupId||d.member!==row.member||row.session!==`${row.member}:${group.contexts[row.member]}`||d.requestId!==row.requestId||d.epoch!==row.epoch||d.revision!==row.revision))return null;
 const c=pair.codex.delivery;
 if(c.nativeAdmission?.threadId!==group.contexts.codex||!c.nativeAdmission.turnId||c.nativeAdmission.turnId!==c.nativeTurnId)return null;
 return {group,pair,key:JSON.stringify(rows.map(r=>[r.id,r.digest]).sort())};
}

// C_before -> H_active -> C_after brackets a real overlap without assuming
// synchronized provider clocks. Every call only reads the original native turn.
export async function verifyNativeParallel(store,runtime,groupId,{runtimeHash=null,readHarness=(adapter,body)=>localFetch(adapter,'/parallel-proof',body)}={}){
 const initial=activePair(store,groupId);
 if(!initial)return {verified:false,reason:'two_native_deliveries_not_active'};
 const {group,pair}=initial,c=pair.codex.delivery,h=pair.harness.delivery;
 const adapter=runtime.adapter?.(group);
 if(!adapter)return {verified:false,reason:'bound_adapter_unavailable'};
 const before=await runtime.recover(group,c);
 if(before?.pending!==true||before.turnId!==c.nativeTurnId)return {verified:false,reason:'codex_not_active'};
 const peer=await readHarness(adapter,{sessionId:group.contexts.harness,deliveryId:h.id});
 if(peer.pending!==true||peer.adapterId!==group.harnessAdapterId||peer.sessionId!==group.contexts.harness||peer.deliveryId!==h.id||
   !Number.isSafeInteger(peer.turn)||!Number.isSafeInteger(peer.startSeq)||!Number.isSafeInteger(peer.userSeq)||peer.userSeq<peer.startSeq)
   return {verified:false,reason:'harness_not_active'};
 const after=await runtime.recover(group,c);
 if(after?.pending!==true||after.turnId!==c.nativeTurnId)return {verified:false,reason:'codex_ended_before_bracket'};
 return store.transaction(()=>{
   const current=activePair(store,groupId);if(!current||current.key!==initial.key)return {verified:false,reason:'bindings_changed'};
   const witness={id:randomUUID(),version:1,at:new Date().toISOString(),runtimeHash,
     requestId:c.requestId,revision:c.revision,epoch:c.epoch,kind:'native-codex-harness-bracket',
     codex:{deliveryId:c.id,turnId:c.nativeTurnId,sessionId:group.contexts.codex,promptHash:c.nativeAdmission.promptHash,digest:pair.codex.row.digest},
     harness:{deliveryId:h.id,turn:peer.turn,startSeq:peer.startSeq,userSeq:peer.userSeq,sessionId:group.contexts.harness,adapterId:peer.adapterId,digest:pair.harness.row.digest}};
   current.group.nativeParallelWitnesses=[...(current.group.nativeParallelWitnesses??[]),witness].slice(-8);store.save(current.group);
   return {verified:true,state:'overlap_observed_awaiting_terminal_receipts',witnessId:witness.id};
 });
}

// An observed overlap alone is insufficient: both original deliveries must
// subsequently have valid, unchanged native completion and protocol receipts.
export function nativeParallelEvidence(store,groupId){
 const g=store.group(groupId),readRow=store.db.prepare('SELECT value FROM admission_reservations WHERE id=? AND group_id=?');
 for(const w of [...(g.nativeParallelWitnesses??[])].reverse()){
   if(w.version!==1||w.kind!=='native-codex-harness-bracket'||w.codex?.sessionId!==g.contexts.codex||w.harness?.sessionId!==g.contexts.harness||w.harness.adapterId!==g.harnessAdapterId)continue;
   const valid=['codex','harness'].every(member=>{
     const p=w[member],d=store.delivery(p.deliveryId),saved=readRow.get(p.deliveryId,groupId),row=saved?JSON.parse(saved.value):null,message=d&&store.messageById(d.responseMessageId),terminal=d?.terminalReply;
     if(!row||row.digest!==p.digest||row.state!=='released'||d?.status!=='received'||d.phase!=='work'||d.groupId!==groupId||d.requestId!==w.requestId||d.revision!==w.revision||d.epoch!==w.epoch||
       message?.protocol!==true||message.groupId!==groupId||message.requestId!==w.requestId||message.sender!==member||
       terminal?.sessionId!==p.sessionId||terminal.textHash!==store.hash(message.content))return false;
     return member==='codex'?terminal.kind==='codex-completed'&&terminal.turnId===p.turnId&&d.nativeAdmission?.turnId===p.turnId&&d.nativeAdmission.promptHash===p.promptHash:
       terminal.kind==='harness-completed'&&terminal.deliveryId===p.deliveryId&&terminal.turn===p.turn&&terminal.reason==='completed'&&terminal.endSeq>p.userSeq;
   });
   if(valid)return {witnessId:w.id,at:w.at,runtimeHash:w.runtimeHash,deliveryIds:[w.codex.deliveryId,w.harness.deliveryId],kind:w.kind};
 }
 return null;
}
