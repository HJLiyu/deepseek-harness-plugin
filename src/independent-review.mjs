import {createHash} from 'node:crypto';

const statuses = ['done', 'changes_requested', 'blocked'];
const evidence = x => Array.isArray(x) && x.length > 0 && x.length <= 20 && x.every(s => typeof s === 'string' && s.trim() && s.length <= 2000);
export const isolationNotice = '部分独立：本次初判载荷不含同伴结论，但固定原生会话的既有历史仍可见；这不是盲评。';

// Scope each initial judgment to the exact work receipts, task and revision.
// Specialty recovery/audit reviews retain their existing contracts.
export function judgmentBinding(request,action=request.actions?.[0]) {
 const work=Object.entries(request.results||{}).filter(([k])=>k.startsWith('work:')&&(!action?.reviewTargets||action.reviewTargets.includes(k.slice(5)))).map(([k,v])=>[k,v.messageId]).sort(([a],[b])=>a.localeCompare(b));
 if(!work.length||work.some(([,id])=>typeof id!=='string'||!id))return null;
 const scope=[request.id,request.revision,request.currentTaskId??null,action?.taskId??request.currentTaskId??null,action?.member,work];
 return {key:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),work};
}
export function enqueueInitialReview(request) {
 const a=request.actions?.[0];
 if(request.deliveryId||a?.phase!=='review'||Object.keys(a).some(k=>!['phase','member','task','taskId','readOnly','crossReviewKey','initialReviewKey','responseRepair','reviewTargets'].includes(k)))return false;
 const binding=judgmentBinding(request,a);if(!binding)return false;
 if(a.initialReviewKey){if(a.initialReviewKey===binding.key)return false;a.initialReviewKey=binding.key;const cross=request.actions[1];if(cross?.crossReviewKey)cross.crossReviewKey=binding.key;return true;}
 if(a.crossReviewKey===binding.key&&request.independentJudgments?.[binding.key])return false;
 delete a.responseRepair;a.crossReviewKey=binding.key;
 request.actions.unshift({phase:'review',member:a.member,readOnly:true,taskId:a.taskId,...(a.reviewTargets?{reviewTargets:a.reviewTargets}:{}),initialReviewKey:binding.key});return true;
}

export function initialReviewPayload(payload, request, group) {
  if (!request.actions?.[0]?.initialReviewKey) return payload;
  const task = request.taskList?.find(t => t.taskId === request.currentTaskId);
  const out = {};
  // Construct anew: do not rely on a blacklist of peer-bearing fields.
  for (const k of ['member','groupId','requestId','phase','approvalStatus','requirement','supplements','rules','currentTask']) if (payload[k] !== undefined) out[k] = structuredClone(payload[k]);
  out.project = group.repo; out.worktrees = group.worktrees;
  out.assignment = {phase:'review',member:payload.member,readOnly:true,task:task?.task ?? request.agreement?.tasks?.[request.agreement.owner] ?? payload.requirement,acceptance:task?.acceptance ?? 'Inspect the actual artifacts against the human requirements.'};
  out.isolation = {mode:'partial',notice:isolationNotice};
  out.artifacts = structuredClone(request.integrationScope?.members ?? {});
  if(request.actions[0].reviewTargets){out.assignment.reviewTargets=request.actions[0].reviewTargets;out.assignment.task+=' Review only the named peer targets; do not approve your own contribution.';out.artifacts=Object.fromEntries(Object.entries(out.artifacts).filter(([m])=>request.actions[0].reviewTargets.includes(m)));}
  out.instruction = '只读初判。先检查实际产物和原始要求，不查询同伴结论或群消息。返回常规 JSON：status=done 表示初判已记录，不代表验收通过；另含 initialJudgment:{verdict:"done|changes_requested|blocked",evidence:[实际证据]}。本轮不作最终验收、不修改文件、不发起审批。' + isolationNotice;
  if (out.currentTask) {
    out.currentTask.assignment = out.assignment;
    out.currentTask.outputContract = {...out.currentTask.outputContract,initialJudgment:'Required: verdict and nonempty evidence; this is an initial observation, not acceptance.'};
  }
  return out;
}

export function judgmentIssue(request, value) {
  const a = request.actions?.[0];
  if((a?.initialReviewKey||a?.crossReviewKey)&&judgmentBinding(request,a)?.key!==(a.initialReviewKey??a.crossReviewKey))return 'Initial judgment is stale for the current work receipt, task or revision.';
  if (a?.initialReviewKey) {
    if (value.status !== 'done' || !statuses.includes(value.initialJudgment?.verdict) || !evidence(value.initialJudgment?.evidence)) return '初判必须返回status=done和带非空证据的initialJudgment；本轮不作最终验收。';
  } else if (a?.crossReviewKey) {
    const initial = request.independentJudgments?.[a.crossReviewKey];
    if (!initial || initial.revision !== request.revision || initial.member !== a.member) return '初判记录缺失或已失效，不能采用交叉评审。';
    if (initial.verdict !== value.status && (!evidence(value.judgmentChange?.evidence) || value.judgmentChange.evidence.every(e => initial.evidence.includes(e)))) return '改判必须在judgmentChange.evidence中提供新增证据，不能仅复述初判。';
  }
  return null;
}

export function recordInitialJudgment(request, value, messageId, deliveryId) {
  const a = request.actions?.[0];
  if (!a?.initialReviewKey || judgmentIssue(request,value)) return false;
  request.independentJudgments ??= {};
  request.independentJudgments[a.initialReviewKey] ??= {key:a.initialReviewKey,revision:request.revision,member:a.member,taskId:a.taskId ?? request.currentTaskId ?? null,...structuredClone(value.initialJudgment),messageId,deliveryId,isolation:'partial',work:judgmentBinding(request,a).work};
  request.actions.shift();
  return true;
}
