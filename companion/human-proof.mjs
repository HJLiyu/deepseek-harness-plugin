import { sameCommand } from './approval-text.mjs';
const textOf = message => (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export function nativeHumanProof(events, { afterSeq, messageId, content }) {
  if (!Number.isSafeInteger(afterSeq) || typeof messageId !== 'string' || typeof content !== 'string') return null;
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= afterSeq) continue;
    const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : event.type === 'user/message' ? [event.data] : [];
    for (const message of messages) {
      const source = message.source;
      if (message.id === messageId && message.role === 'user' && source?.kind === 'user' &&
        typeof source.rpcId === 'string' && source.rpcId.length > 0 && !source.rpcId.startsWith('group-') && sameCommand(textOf(message), content)) {
        return { adapter: 'harness', messageId, seq: event.seq, rpcId: source.rpcId };
      }
    }
  }
  return null;
}
export function nativeToolCall(events, callId, toolName) {
  for (const event of [...events].reverse()) if (event.type === 'assistant/message' && event.data.message?.source?.kind === 'model') {
    const call = event.data.message.content?.find(p => p.type === 'tool-call' && p.id === callId && p.name === toolName);
    if (call) return call;
  }
  return null;
}
