// Ephemeral public answer previews; never authoritative messages or approvals.
export const PREVIEW_LIMIT = 2000;
export function publicAnswer(text) {
  if (typeof text !== 'string') return '';
  const value = text.trimStart();
  if (!value.startsWith('{') && !value.startsWith('```')) return text.slice(-PREVIEW_LIMIT);
  const start = value.match(/^(?:```(?:json)?\s*)?\{\s*"message"\s*:\s*"/);
  if (!start) return '';
  const rest = value.slice(start[0].length); let end = 0, escaped = false;
  for (; end < rest.length; end++) {
    const c = rest[end];
    if (!escaped && c === '"') break;
    if (!escaped && c === '\\') escaped = true; else escaped = false;
  }
  try { return JSON.parse('"' + rest.slice(0, end) + '"').slice(-PREVIEW_LIMIT); } catch { return ''; }
}
export function createPreviewEmitter(send, { now = Date.now, interval = 500 } = {}) {
  let lastAt = -Infinity, lastText = '', pending = '', timer, closed = false;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (closed || !pending || pending === lastText) return;
    lastAt = now(); lastText = pending;
    try { send(lastText); } catch { /* previews must not affect delivery */ }
  };
  return {
    update(raw) { if (closed) return; pending = publicAnswer(raw); if (!pending || pending === lastText) return;
      if (now() - lastAt >= interval) flush();
      else if (!timer) { timer = setTimeout(flush, Math.max(1, interval - (now() - lastAt))); timer.unref?.(); }
    },
    close() { closed = true; clearTimeout(timer); pending = ''; },
  };
}
export function codexAnswerItem(item) {
  return item?.type === 'agentMessage' && ['commentary', 'final', 'final_answer'].includes(item.phase) && typeof item.text === 'string' ? item.text : '';
}
export function harnessAnswer(events, deliveryId) {
  const marker = `[Group delivery ${deliveryId}]\n`; let turn = null, claimed = null, answer = '';
  for (const e of events) {
    if (e.type === 'turn/start') turn = e.data?.turn;
    const source = e.data?.source;
    if (e.type === 'user/message' && ((source?.kind === 'plugin' && source.plugin === 'codex-group') || (source?.kind === 'user' && source.rpcId === `group-${deliveryId}`)) && (e.data.content ?? []).some(p => p.type === 'text' && p.text.startsWith(marker))) claimed = turn;
    if (claimed === null || e.data?.turn !== claimed) continue;
    if (e.type === 'turn/end') return '';
    if (e.type === 'assistant/message' && !e.data.interrupted) answer = (e.data.message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  }
  return publicAnswer(answer);
}
export class AnswerPreviews {
  constructor({ now = Date.now } = {}) { this.now = now; this.entries = new Map(); }
  clear(groupId) { this.entries.delete(groupId); }
  update(group, request, delivery, text) {
    if (!this.valid(group, request, delivery)) return false;
    const value = publicAnswer(text); if (!value) return false;
    const old = this.entries.get(group.id), at = this.now();
    if (old?.deliveryId === delivery.id && at - old.at < 500) return false;
    if (this.entries.size >= 64 && !this.entries.has(group.id)) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(group.id, { requestId: request.id, revision: request.revision, deliveryId: delivery.id, member: delivery.member, text: value, at }); return true;
  }
  valid(group, request, delivery) {
    return !!request && !!delivery && group.status === 'active' && group.activeRequestId === request?.id && request.status === 'active' && request.deliveryId === delivery?.id && delivery.started && delivery.status === 'pending' && delivery.revision === request.revision && ['codex', 'harness'].includes(delivery.member);
  }
  read(group, request, delivery) {
    const value = this.entries.get(group.id);
    if (!value || !this.valid(group, request, delivery) || value.deliveryId !== delivery.id || value.revision !== request.revision || this.now() - value.at > 15000) { this.clear(group.id); return null; }
    return value;
  }
}
