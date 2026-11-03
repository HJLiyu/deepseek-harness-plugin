// Native progress renews the idle allowance, never the absolute cap. No message
// text, credential or approval decision is retained by this clock.
export function turnTiming(env = process.env) {
  const value = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isSafeInteger(n) && n > 0 && n <= 2147483647 ? Math.max(60000, n) : fallback;
  };
  const maxMs = value('CODEX_TURN_TIMEOUT_MS', 2 * 60 * 60 * 1000);
  return { maxMs, idleMs: Math.min(maxMs, value('CODEX_TURN_IDLE_TIMEOUT_MS', 30 * 60 * 1000)) };
}

export function nativeProgress(method, params, threadId, turnId) {
  if (!turnId || params?.threadId !== threadId || params?.turnId !== turnId) return false;
  if (['item/started', 'item/completed'].includes(method)) return Boolean(params.item?.id && params.item?.type);
  return method === 'item/agentMessage/delta' && typeof params.delta === 'string' && params.delta.length > 0;
}

export function createTurnDeadline({ idleMs, maxMs, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (![idleMs, maxMs].every(n => Number.isSafeInteger(n) && n > 0 && n <= 2147483647) || idleMs > maxMs) throw Error('Invalid turn deadline.');
  const started = now(); let last = started, holds = 0, closed = false, timer, reject;
  const promise = new Promise((_, fail) => { reject = fail; });
  function schedule() {
    if (closed) return;
    clearTimer(timer);
    const remaining = Math.min(started + maxMs, holds ? Infinity : last + idleMs) - now();
    timer = setTimer(check, Math.max(0, remaining)); timer?.unref?.();
  }
  function check() {
    if (closed) return;
    const elapsed = now() - started;
    const kind = elapsed >= maxMs ? 'absolute' : !holds && now() - last >= idleMs ? 'idle' : null;
    if (!kind) { schedule(); return; }
    closed = true;
    const error = new Error(kind === 'idle' ? `Codex turn timed out after ${idleMs}ms without matching native progress; recover its original outcome before retrying.` : `Codex turn reached its absolute limit of ${maxMs}ms; recover its original outcome before retrying.`);
    error.code = kind === 'idle' ? 'CODEX_TURN_IDLE_TIMEOUT' : 'CODEX_TURN_ABSOLUTE_TIMEOUT';
    error.cancelSource = 'transport_timeout'; reject(error);
  }
  schedule();
  return {
    promise,
    touch() { if (!closed) last = now(); },
    hold() {
      if (closed) return () => {};
      holds++; let released = false;
      return () => { if (released || closed) return; released = true; if (--holds === 0) { last = now(); schedule(); } };
    },
    close() { if (!closed) { closed = true; clearTimer(timer); } },
  };
}
