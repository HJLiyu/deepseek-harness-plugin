import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const LEGACY_PREFIX = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const PIPE_PREFIX = "$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.Encoding]::UTF8; ";
// Cordis returns a fresh callable Proxy on service method reads. Symbol
// properties pass through that wrapper; function reference equality does not.
const HOOK_MARKER = Symbol('codex-group-argv-hook');

// Change only the public argv seam. Execution, confinement, approval, output
// collection and cancellation remain owned by the existing native executor.
export function installGroupEncoding(shell, isBound, systemRoot = process.env.SystemRoot ?? 'C:\\Windows', { observe, transformWorkspaceArgv } = {}) {
  const state = { installed: false, applied: 0 };
  const hookId = randomUUID();
  const original = shell?.argv;
  if (typeof original !== 'function') return { state, dispose() {} };
  function argv(spec) {
    const result = original.call(this, spec);
    const report = (output, patched = false) => {
      // One owned wrapper also handles process-local pipe compatibility, so
      // normal HMR disposal cannot strand a second layer of old hooks.
      const transformed = transformWorkspaceArgv?.(spec, output) ?? output;
      // Diagnostics cannot change execution or turn a collection failure into
      // a command failure. Raw argv is consumed synchronously, never retained.
      try { observe?.(spec, result, transformed, { hookId, patched: patched || transformed !== output, bindingMatched: Boolean(isBound(spec.sandboxPolicy?.sessionId)) }); } catch {}
      return transformed;
    };
    // Keep the provider's direct launch under workspace-write. The extra cmd
    // process introduced below is present in the failing standing-policy path.
    // Returning its native argv leaves policy, confinement,
    // cancellation and the provider's original encoding preamble untouched.
    // This is a launch candidate; only a Harness-native run can validate it.
    const codepage = path.win32.join(systemRoot, 'System32', 'chcp.com');
    const safePath = value => /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(value);
    if (spec.sandboxPolicy?.mode === 'workspace-write') {
      // Older releases compared method references through Cordis proxies and
      // could leave our own wrapper attached after HMR disposal. Recognize the
      // ENTIRE legacy invocation, including this exact command's payload. Do
      // not unwrap any other provider, command, session or permission mode.
      const executable = shell.pwshPath;
      if (isBound(spec.sandboxPolicy?.sessionId) && typeof executable === 'string' && safePath(executable) && safePath(codepage) &&
          Array.isArray(result) && result.length === 5 && result[0] === path.win32.join(systemRoot, 'System32', 'cmd.exe') &&
          result[1] === '/d' && result[2] === '/s' && result[3] === '/c') {
        const encoded = Buffer.from(PIPE_PREFIX + spec.command, 'utf16le').toString('base64');
        const expected = `${codepage} 65001 >nul && ${executable} -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encoded}`;
        if (result[4] === expected) return report([executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', LEGACY_PREFIX + spec.command], true);
      }
      return report(result);
    }
    if (!isBound(spec.sandboxPolicy?.sessionId) || spec.sandboxPolicy?.mode !== 'read-only' ||
      !Array.isArray(result) || result.length !== 6 || result[1] !== '-NoLogo' || result[2] !== '-NoProfile' || result[3] !== '-NonInteractive' || result[4] !== '-Command' ||
      result[5] !== LEGACY_PREFIX + spec.command || !safePath(result[0]) || !safePath(codepage)) return report(result);
    const encoded = Buffer.from(PIPE_PREFIX + spec.command, 'utf16le').toString('base64');
    const launch = `${codepage} 65001 >nul && ${result[0]} -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand ${encoded}`;
    if (launch.length > 7900) return report(result); // Preserve native support for long commands beyond cmd's limit.
    state.applied++;
    // Base64 keeps all caller script text out of cmd syntax. chcp runs inside
    // the same confined process tree, before PowerShell caches its encoding.
    // No new console, language-mode change or persistent setting is involved.
    return report([path.win32.join(systemRoot, 'System32', 'cmd.exe'), '/d', '/s', '/c', launch], true);
  }
  Object.defineProperty(argv, HOOK_MARKER, { value: hookId });
  const inspect = () => {
    const current = shell.argv;
    return { installed: state.installed, reason: state.reason ?? null, methodType: typeof current,
      referenceEqual: current === argv, markerMatched: current?.[HOOK_MARKER] === hookId };
  };
  const isCurrent = () => inspect().markerMatched;
  try { shell.argv = argv; state.installed = true; }
  catch (error) { state.reason = String(error.message).slice(0, 200); }
  return { state, inspect, isCurrent, dispose() { if (isCurrent()) shell.argv = original; } };
}

// One explicitly selected session per adapter; ten minutes, sixteen records,
// <=16 KiB, RAM only. No command text, argument values, env, cwd or full paths.
export function createShellTrace({ buildHash, instanceId, now = Date.now } = {}) {
  let selected = null, receipt = null, records = [];
  let calls = 0, skipped = 0;
  const increment = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const shape = argv => ({ count: Array.isArray(argv) ? argv.length : null,
    program: Array.isArray(argv) && typeof argv[0] === 'string' ? path.win32.basename(argv[0]).slice(0, 80) : null,
    sha256: Array.isArray(argv) && argv.every(v => typeof v === 'string') ? createHash('sha256').update(JSON.stringify(argv)).digest('hex') : null });
  const active = sessionId => selected === sessionId && receipt?.expiresAt > now();
  const snapshot = sessionId => ({ enabled: active(sessionId), receipt: selected === sessionId ? { ...receipt } : null,
    calls: selected === sessionId ? calls : 0, skipped: selected === sessionId ? skipped : 0,
    records: selected === sessionId ? structuredClone(records) : [] });
  return {
    enable(sessionId) {
      selected = sessionId; records = []; calls = 0; skipped = 0;
      receipt = { traceId: randomUUID(), buildHash, instanceId, enabledAt: now(), expiresAt: now() + 600000,
        selfCheck: 'memory-ready', storage: 'memory', maxRecords: 16, maxBytes: 16384 };
      return snapshot(sessionId);
    },
    disable(sessionId) { if (selected === sessionId) { selected = null; records = []; receipt = null; calls = 0; skipped = 0; } return snapshot(sessionId); },
    snapshot,
    observe(spec, before, after, meta) {
      calls = increment(calls);
      if (!active(spec.sandboxPolicy?.sessionId)) { skipped = increment(skipped); return; }
      const mode = spec.sandboxPolicy?.mode;
      records.push({ callId: randomUUID(), at: now(), traceId: receipt.traceId, buildHash, instanceId,
        hookId: meta.hookId, mode: ['read-only', 'workspace-write', 'danger-full-access'].includes(mode) ? mode : 'unknown',
        hasSessionId: Boolean(spec.sandboxPolicy?.sessionId), bindingMatched: meta.bindingMatched === true,
        patched: meta.patched === true, before: shape(before), after: shape(after) });
      while (records.length > 16 || Buffer.byteLength(JSON.stringify({ receipt, records })) > 16384) records.shift();
    },
  };
}
