// Deliberately narrow human commands. No model interpretation, quoted examples,
// bare "continue", approval, or group retry can release a requirement hold.
export function goalHoldCommands(content) {
  if (typeof content !== 'string') return [];
  const text = content.trim().replace(/^(?:补充|纠正)[：:]\s*/, '');
  if (/(?:```|~~~|^[ \t]*>|[“”「」『』"])/m.test(text)) return [];
  const commands = [];
  const pattern = /(?:^|[，,。；;！!\n])\s*(?:请)?(?:先)?(暂缓|跳过|放下|恢复|开始|继续处理|继续验收)\s*(R\d{2,3})(?=[ \t]*(?:$|[，,。；;！!\n]))/gi;
  for (const match of text.matchAll(pattern)) {
    commands.push({ id: match[2].toUpperCase(), state: ['暂缓', '跳过', '放下'].includes(match[1]) ? 'deferred' : 'resumed' });
  }
  return commands;
}

// Presentation only: a settled audit with host blockers/human holds left.
export function settledGoalWait(request) {
  const goal = request?.goal, list = goal?.checklist;
  if (request?.status !== 'blocked' || request.deliveryId || !Array.isArray(request.actions) || request.actions.length ||
      request.humanDecisions?.length || !goal?.auditMessageId || !Array.isArray(list) || !list.length ||
      list.length !== goal.requirements?.length || goal.requirements.some(r => !list.some(x => x.id === r.id && x.title === r.title))) return null;
  const remaining = list.filter(x => x.status !== 'done');
  if (!remaining.length || remaining.some(x => x.status !== 'blocked') ||
      request.error !== remaining.map(x => x.title + '：' + x.task).join('\n')) return null;
  const held = remaining.filter(x => goal.humanHolds?.[x.id]?.state === 'deferred');
  const external = remaining.filter(x => !held.includes(x));
  if (external.some(x => !/宿主维护方.*(?:定位|修复|提供)/s.test(x.task ?? ''))) return null;
  const done = list.length - remaining.length;
  return { requestId: request.id, revision: request.revision ?? 0, auditMessageId: goal.auditMessageId,
    done, external: external.length, held: held.length, needsUser: false, retryable: false,
    detail: `${done} 项已完成；${external.length ? external.length + ' 项等待 Harness 宿主修复' : ''}${external.length && held.length ? '，' : ''}${held.length ? held.length + ' 项按你的要求暂缓' : ''}。当前没有正在执行或待审批的操作。`,
    owner: external.length ? '宿主命令能力修复由维护方处理；暂缓项保持待命' : '协作成员保持你指定的暂缓',
    next: '不需要重复批准、重启或反复重试。宿主问题修复后再继续相应验收；暂缓项只有收到你新的明确恢复指令才启动。' };
}
