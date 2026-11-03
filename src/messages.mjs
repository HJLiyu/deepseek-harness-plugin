import { createHash } from 'node:crypto';
import { readGoal } from './state.mjs';
import { readEventHistory } from './events.mjs';

export function eventMessageId(goalId, event) {
  return event.messageId ?? `legacy-${createHash('sha256').update(goalId + '\0' + JSON.stringify(event)).digest('hex').slice(0, 32)}`;
}

export function stopReason(goal) {
  if (['completed', 'stopped', 'round_limit', 'failed', 'app_closed'].includes(goal.status)) return goal.status;
  return goal.status === 'paused' ? goal.pausedReason ?? 'paused' : null;
}

// A view of the existing rotated event log, never a second transcript copy.
// Only explicit message events become speech; tool arguments cannot create a
// human message merely by carrying source='human'.
export function readTranscript(goalId, offset = 0, limit = 30) {
  const goal = readGoal(goalId);
  if (!goal) throw new Error(`Unknown goal: ${goalId}`);
  const { events, files } = readEventHistory(goalId);
  const messages = [];
  let previousAgent = null;
  for (const event of events) {
    const sender = { harness_message: 'dsh', codex_message: 'codex', human_message: 'human' }[event.type];
    const system = ['goal_started', 'goal_status', 'error', 'control', 'human_intervention'].includes(event.type);
    if (!sender && !system) continue;
    const content = sender ? event.text : event.message ?? event.objective ?? (event.type === 'control' ? JSON.stringify(event.patch) : event.status ?? `Human intervention (${event.count ?? 0})`);
    if (typeof content !== 'string') continue;
    const messageId = eventMessageId(goalId, event);
    const agent = sender === 'dsh' || sender === 'codex';
    const replyTo = event.replyTo ?? (agent && previousAgent?.sender !== sender ? previousAgent?.messageId ?? null : null);
    const timestamp = event.time ?? null;
    const message = {
      messageId, conversationId: goalId, threadId: event.threadId ?? event.codexThreadId ?? null,
      replyTo, sender: sender ?? 'system', recipient: agent ? (sender === 'dsh' ? 'codex' : 'dsh') : null,
      source: agent ? 'agent' : sender === 'human' ? 'human' : 'system',
      role: agent || sender === 'human' ? 'user' : 'system', content, timestamp,
      // Informational compatibility fields are never approval capabilities.
      authorization: null, contextSummary: null, pendingItems: [],
      turnLimit: event.maxRounds ?? goal.maxRounds, budget: event.maxRounds ?? goal.maxRounds,
      stopReason: event.type === 'goal_status' ? stopReason({ status: event.status }) : null,
      round: event.round ?? null, turnId: event.turnId ?? null,
      id: messageId, from: sender ?? 'system', text: content, at: timestamp,
    };
    messages.push(message);
    if (agent) previousAgent = message;
  }
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 30)));
  return { goalId, conversationId: goalId, threadId: goal.codexThreadId, status: goal.status, stopReason: stopReason(goal),
    messages: messages.slice(start, start + size), total: messages.length,
    nextOffset: start + size < messages.length ? start + size : null, retainedHistoryOnly: true, files };
}
