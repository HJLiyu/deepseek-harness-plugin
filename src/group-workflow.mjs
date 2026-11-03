// One precedence table for execution ownership. This projection never grants
// permissions, changes an outcome, or starts a model. Stored status is a cache;
// a pending approval / admitted delivery is stronger evidence than that cache.
export function workflowState({group, request, delivery, approval, running=false, now=Date.now()}) {
  const state=(kind,owner,nextAction,needsUser=false,extra={})=>({version:1,kind,owner,nextAction,needsUser,...extra});
  if(group.status==='closed')return state('closed','human','new_group');
  if(group.status==='paused'){
    if(!group.schedulerFault||group.schedulerFault.epoch!==group.epoch)return state('paused','human','resume',true);
    if(!approval)return state('maintenance','maintenance','inspect_scheduler',false,{reason:'scheduler_fault'});
  }
  if(approval)return state('approval','human','decide_permission',true,{member:approval.member,permissionId:approval.id});
  if(delivery?.started&&request?.recoveryWait?.state==='needs_refresh')return state('connection','human','refresh_connection',true,{deliveryId:delivery.id});
  if(delivery?.started&&['pending','unknown','recovering'].includes(delivery.status))
    return running&&!['needs_recovery','awaiting_checkpoint'].includes(request?.status)&&!['needs_recovery','awaiting_checkpoint'].includes(group.status)
      ? state('running',delivery.member,'await_native_result',false,{member:delivery.member,phase:delivery.phase,deliveryId:delivery.id})
      : state('recovery','coordinator','recover_original',false,{member:delivery.member,phase:delivery.phase,deliveryId:delivery.id});
  if(request?.humanDecisions?.length)return state('decision','human','answer_decision',true);
  if(group.status==='apps_closed')return state('offline','host','await_app');
  if(!request||['completed','cancelled'].includes(request.status))return state('idle','human','new_requirement');
  if(request.admissionWait?.state==='needs_refresh'||request.recoveryWait?.state==='needs_refresh')return state('connection','human','refresh_connection',true);
  if(request.nextRecoveryAt>now)return state('recovery','coordinator','recover_original');
  if(request.admissionRetryAt>now)return state('connection','coordinator','await_retry');
  if(['blocked','needs_decision'].includes(request.status))return state('blocked',request.errorDetails?.human?.needsUser===true?'human':'maintenance',request.errorDetails?.human?.action??'inspect_cause',request.errorDetails?.human?.needsUser===true,{reason:request.errorDetails?.reason??'unclassified'});
  const held=request.deferred?.find(a=>a.why==='dependency'),action=request.actions?.[0];
  if(held)return state('dependency',held.waitingFor,'await_provider',false,{member:held.member,waitingFor:held.waitingFor});
  if(action||request.phase==='planning')return state('ready',action?.member??'coordinator','dispatch',false,{member:action?.member,phase:action?.phase??'planning'});
  return state('inconsistent','maintenance','inspect_schedule');
}

// Compatibility recoveries share one gate and deterministic ordering. Each
// handler still verifies its own exact native receipts / version / file facts.
// Stop after the first transition so later repairs cannot overwrite its work.
export const recoveryRules = Object.freeze([
  {method:'repairPlanningTransport',statuses:['blocked']},
  {method:'reconcileCompletedVerification',statuses:['blocked']},
  {method:'repairRetainedCandidates',statuses:['blocked']},
  {method:'repairMissingSources',statuses:['blocked']},
  {method:'repairMainSourceScope',statuses:['blocked']},
  {method:'repairAppliedIntegration',statuses:['blocked']},
  {method:'repairIntegrationClosure',statuses:['blocked']},
  {method:'repairStoredWorkFeedback',statuses:['blocked']},
  {method:'repairReadinessConflict',statuses:['blocked']},
  {method:'repairMultiSourceReadiness',statuses:['blocked','needs_decision']},
]);
export function reconcileRecoveries(engine,group,request) {
  if(!request||request.deliveryId||['paused','closed','apps_closed'].includes(group.status)||engine.store.pendingPermissions(group.id).length)return null;
  for(const rule of recoveryRules){
    if(rule.statuses.includes(request.status)&&typeof engine[rule.method]==='function'&&engine[rule.method](group,request)){
      request.workflowTransitions=[...(request.workflowTransitions??[]),{revision:request.revision,epoch:group.epoch,rule:rule.method,at:new Date().toISOString()}].slice(-24);
      return rule.method;
    }
  }
  return null;
}

// A malformed/narrowed review receipt is a protocol correction, not evidence
// that the implementation needs rewriting. Validate before consuming a repair
// round or changing the work queue.
export function readinessReceiptIssue(value,request,action) {
  if(!action?.integrationReadiness||value?.status!=='done')return null;
  const files=value.integrationFiles;
  if(!Array.isArray(files)||files.length>100||new Set(files).size!==files.length||files.some(n=>typeof n!=='string'))return '整合复核必须提供完整、唯一的integrationFiles清单。';
  const fixed=action.integrationSnapshot?.targets;
  if(fixed&&(files.length!==Object.keys(fixed).length||files.some(n=>!Object.hasOwn(fixed,n))))return '复核漏列或改动固定候选，请只读补齐清单；实现无需返工。';
  if(value.integrationFilesByMember){
    const map=value.integrationFilesByMember;
    if(typeof map!=='object'||Array.isArray(map)||Object.entries(map).some(([m,v])=>!['codex','harness'].includes(m)||!Array.isArray(v)))return '请按codex/harness返回有效的来源数组。';
    const all=Object.values(map).flat();
    if(new Set(all).size!==all.length||all.length!==files.length||all.some(n=>!files.includes(n)))return '按成员划分的来源必须恰好覆盖完整清单，不可重复或遗漏。';
    const selected=action.integrationSnapshot&&action.readinessConflict?{[action.integrationSnapshot.member]:action.integrationSnapshot.targets}:request.integrationScope?.members??(request.integrationScope?.targets?{[request.integrationScope.member]:request.integrationScope.targets}:{});
    if(Object.entries(selected).some(([m,v])=>Object.keys(v).some(n=>!map[m]?.includes(n))))return '复核漏列或移动已选定文件，请按原来源只读补齐，不要重派实现。';
  }
  if(action.missingSources){
    const kept=value.preservedFiles,expected=Object.keys(action.missingSources.preserved);
    if(!Array.isArray(kept)||new Set(kept).size!==kept.length||kept.length!==expected.length||kept.some(n=>!expected.includes(n)))return '请逐项确认全部preservedFiles；这是原件保留核对，不是实现返工。';
  }
  if(action.retainedArtifacts){
    const kept=value.preservedFiles,expected=Object.keys(action.retainedArtifacts.preserved);
    if(!Array.isArray(kept)||new Set(kept).size!==kept.length||kept.length!==expected.length||kept.some(n=>!expected.includes(n)))return '请完整确认既有保留契约中的preservedFiles，不要重复要求真人决定。';
  }
  return null;
}
