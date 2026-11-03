export function approvalPhrase(goalId, pending, decision) {
  if (!['allow', 'reject'].includes(decision)) throw new Error('Permission decision must be allow or reject.');
  if (!pending?.requestId) throw new Error('There is no pending Harness permission request.');
  return `${decision === 'allow' ? '批准' : '拒绝'} ${goalId} ${pending.requestId}`;
}

export function assertHumanDecision(goalId, pending, decision, requestId, turns) {
  const phrase = approvalPhrase(goalId, pending, decision);
  if (!requestId || String(requestId) !== String(pending.requestId)) throw new Error('Stale or missing permission request ID.');
  const old = new Set(pending.userTurnIdsBeforeRequest ?? []);
  const match = turns.find(turn => !old.has(turn.turnId) && turn.text.trim() === phrase);
  if (!match) {
    throw new Error(`The human must first send exactly “${phrase}” in the collaboration chat.`);
  }
  return match;
}
