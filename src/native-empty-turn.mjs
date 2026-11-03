// Only a complete, exact native turn with zero items proves this narrow case.
// Missing text, omitted items, truncated history or agent claims prove nothing.
import {recordUsage} from './group-observability.mjs';
import {attachDiagnostics} from './integration-diagnostics.mjs';
export function emptyNativeTurn(threadId, turn, nativeTurnId) {
  if(!nativeTurnId||turn?.id!==nativeTurnId||turn.status!=='completed'||
    !Array.isArray(turn.items)||turn.items.length||turn.truncated||turn.itemsTruncated)return null;
  return {terminalEmpty:true,text:'原生回合已完成，但没有输入、工具或回答记录。',usage:null,
    proof:{kind:'codex-empty-turn',threadId,turnId:turn.id,status:'completed',itemCount:0}};
}

export function validEmptyTurn(group, delivery, proof) {
  return delivery?.member==='codex'&&delivery.started===true&&proof?.kind==='codex-empty-turn'&&
    proof.threadId===group.contexts.codex&&proof.turnId===delivery.nativeTurnId&&
    delivery.nativeAdmission?.threadId===proof.threadId&&delivery.nativeAdmission.turnId===proof.turnId&&
    proof.status==='completed'&&proof.itemCount===0;
}

export function settleEmptyTurn(store, groupId, delivery, result) {
  return store.transaction(()=>{
    const group=store.group(groupId),request=store.request(delivery.requestId),current=store.delivery(delivery.id);
    if(request.deliveryId!==delivery.id||request.revision!==current?.revision||!validEmptyTurn(group,current,result.proof)||
      current.nativeAdmission.promptHash!==store.hash(`[Group delivery ${current.id}]\n${current.prompt}`)||
      request.actions[0]?.member!==current.member||request.actions[0]?.phase!==current.phase||store.pendingPermissions(groupId).length)
      throw Error('Empty native turn lacks an exact terminal admission proof.');
    current.status='completed_without_reply';current.nativeEmptyProof=result.proof;store.saveDelivery(current);
    store.admissions().releaseEmpty(current.id);
    recordUsage(request.usage,current.id,result);
    delete request.deliveryId;delete request.nextRecoveryAt;delete request.error;delete request.recoveryWait;
    const action=request.actions[0],previous=action?.emptyNativeRecovery;
    const attempt=(previous?.attempt??0)+1;
    if(action)action.emptyNativeRecovery={attempt,deliveryIds:[...(previous?.deliveryIds??[]),delivery.id],proof:result.proof};
    request.status=attempt<=2?'queued':'blocked';
    if(attempt>2){request.error='原生会话连续返回无内容回合，已停止新派发并保留成果，需要维护方检查宿主。';
      attachDiagnostics(request,{reason:'native_empty_turn_limit',human:{needsUser:false,owner:'维护方',action:'inspect_native_host',detail:request.error,next:'核对宿主空回合原因。'}});}
    if(!['paused','closed','apps_closed'].includes(group.status))group.status=attempt<=2?'active':'blocked';
    store.saveRequest(request);store.save(group);
    store.message(groupId,{sender:'system',channel:'collaboration',requestId:request.id,
      content:attempt<=2?'已核实原生回合完成且完整记录为空，没有工具执行记录。保留原投递，不认定任务成功；沿用当前任务与已完成清单继续，先核对已有成果，不重放旧命令。你现在不需要操作。':'原生宿主连续返回空回合，自动接续已达上限。由维护方排查，当前无需你批准、重启或重复发送继续。'});
    return current;
  });
}
