import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { installGroupEncoding, createShellTrace } from '../companion/pwsh-encoding.mjs';

const prefix = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const fixture = () => ({ argv: spec => [exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prefix + spec.command] });
const spec = command => ({ command, sandboxPolicy: { sessionId: 'bound-session', mode: 'read-only' } });

test('encoding adapts only bound confined native commands and keeps script text outside cmd syntax', () => {
  const shell = fixture(), original = shell.argv, fix = installGroupEncoding(shell, id => id === 'bound-session', 'C:\\Windows');
  const input = spec("Write-Output '中文 & %PATH% ! ^'; exit 9");
  const snapshot = structuredClone(input), argv = shell.argv(input);
  assert.equal(argv[0], 'C:\\Windows\\System32\\cmd.exe');
  const payload = argv.at(-1).split(' -EncodedCommand ')[1];
  assert.equal(Buffer.from(payload, 'base64').toString('utf16le'), "$ProgressPreference = 'SilentlyContinue'; $OutputEncoding = [System.Text.Encoding]::UTF8; " + input.command);
  assert.deepEqual(input, snapshot); assert.equal(argv.at(-1).includes('%PATH%'), false);
  for (const altered of [{ ...input, sandboxPolicy: { ...input.sandboxPolicy, sessionId: 'other' } }, { ...input, sandboxPolicy: { ...input.sandboxPolicy, mode: 'danger-full-access' } }, spec('x'.repeat(4000))]) assert.deepEqual(shell.argv(altered), original(altered));
  fix.dispose(); assert.equal(shell.argv, original);
});

test('encoding keeps unknown argv, unsafe paths and later provider changes intact', () => {
  const shell = { argv: () => ['unrecognized', '-Command', 'body'] }, before = shell.argv(spec('body'));
  const fix = installGroupEncoding(shell, () => true); assert.deepEqual(shell.argv(spec('body')), before);
  const later = () => ['new-provider']; shell.argv = later; fix.dispose(); assert.equal(shell.argv, later);
  const bad = fixture(), original = bad.argv;
  installGroupEncoding(bad, () => true, 'C:\\Windows & echo unsafe'); assert.deepEqual(bad.argv(spec('body')), original(spec('body')));
});

test('hook identity and disposal work through fresh service method proxies without sentinel writes or reinstallation', () => {
  const target = fixture(); let writes = 0;
  // Cordis returns a new callable Proxy on method reads; symbols forward.
  const shell = new Proxy(target, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? new Proxy(value, {}) : value;
    },
    set(target, key, value) { writes++; return Reflect.set(target, key, value); },
  });
  const original = shell.argv;
  const fix = installGroupEncoding(shell, () => true, 'C:\\Windows');
  assert.equal(writes, 1);
  assert.equal(fix.inspect().referenceEqual, false);
  assert.equal(fix.inspect().markerMatched, true);
  assert.equal(fix.isCurrent(), true);
  const input = { ...spec('exit 7'), sandboxPolicy: { sessionId: 'bound-session', mode: 'workspace-write' } };
  assert.deepEqual(shell.argv(input), original(input));
  fix.inspect(); fix.isCurrent(); assert.equal(writes, 1);
  fix.dispose(); assert.equal(writes, 2); assert.equal(fix.isCurrent(), false);
  assert.deepEqual(shell.argv(input), original(input));
  fix.dispose(); assert.equal(writes, 2);
});

test('workspace-write retains the native direct launch and original policy without a cmd wrapper', () => {
  const shell = fixture(), original = shell.argv;
  const fix = installGroupEncoding(shell, id => id === 'bound-session', 'C:\\Windows');
  const input = { ...spec("Write-Output '中文✓'; node --version"), sandboxPolicy: {
    sessionId: 'bound-session', mode: 'workspace-write', workspaceRoot: 'C:\\project',
  } };
  const before = structuredClone(input);
  assert.deepEqual(shell.argv(input), original(input));
  assert.equal(shell.argv(input)[0], exe);
  assert.deepEqual(input, before);
  assert.equal(fix.state.applied, 0);
  // Planning/review retain the existing encoding path.
  assert.equal(shell.argv(spec('Write-Output 1'))[0], 'C:\\Windows\\System32\\cmd.exe');
  fix.dispose(); assert.equal(shell.argv, original);
});

test('workspace-write unwraps only this bound command exact orphaned legacy encoding wrapper', () => {
  const command = "Write-Output '中文 & %PATH%'; node --version";
  const legacy = fixture(); installGroupEncoding(legacy, () => true, 'C:\\Windows');
  const retained = legacy.argv(spec(command));
  const shell = { pwshPath: exe, argv: () => retained };
  const observations = [];
  installGroupEncoding(shell, id => id === 'bound-session', 'C:\\Windows', { observe: (...args) => observations.push(args) });
  const input = { ...spec(command), sandboxPolicy: { sessionId: 'bound-session', mode: 'workspace-write' } };
  const before = structuredClone(input);
  assert.deepEqual(shell.argv(input), fixture().argv(input));
  assert.deepEqual(input, before);
  assert.equal(observations[0][1][0], 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(observations[0][2][0], exe);
  for (const altered of [
    { ...input, command: command + '; extra' },
    { ...input, sandboxPolicy: { ...input.sandboxPolicy, sessionId: 'other' } },
    { ...input, sandboxPolicy: { ...input.sandboxPolicy, mode: 'danger-full-access' } },
    { ...input, sandboxPolicy: { ...input.sandboxPolicy, mode: 'read-only' } },
  ]) assert.deepEqual(shell.argv(altered), retained);
  const unknown = { pwshPath: exe, argv: () => [...retained.slice(0, 4), retained[4] + ' && echo other'] };
  const original = unknown.argv(input);
  installGroupEncoding(unknown, () => true, 'C:\\Windows');
  assert.deepEqual(unknown.argv(input), original);
});

test('opt-in shell trace links actual hook calls without retaining command, environment or full paths', () => {
  let clock = 1000;
  const trace = createShellTrace({ buildHash: 'a'.repeat(64), instanceId: 'adapter-instance', now: () => clock });
  const shell = fixture(), fix = installGroupEncoding(shell, id => id === 'bound-session', 'C:\\Windows', { observe: trace.observe });
  const input = { ...spec('secret-command-value'), env: { PRIVATE_KEY: 'secret-env-value' }, sandboxPolicy: {
    sessionId: 'bound-session', mode: 'workspace-write', workspaceRoot: 'C:\\private-workspace',
  } };
  shell.argv(input); assert.deepEqual(trace.snapshot('bound-session').records, []);
  const enabled = trace.enable('bound-session'); assert.equal(enabled.receipt.selfCheck, 'memory-ready');
  assert.equal(enabled.calls, 0); assert.equal(enabled.skipped, 0);
  shell.argv({ ...input, sandboxPolicy: { ...input.sandboxPolicy, sessionId: 'other' } });
  assert.equal(trace.snapshot('bound-session').calls, 1); assert.equal(trace.snapshot('bound-session').skipped, 1);
  assert.equal(trace.snapshot('bound-session').records.length, 0);
  const before = structuredClone(input); const result = shell.argv(input); const record = trace.snapshot('bound-session').records[0];
  assert.equal(record.traceId, enabled.receipt.traceId); assert.equal(record.buildHash, 'a'.repeat(64));
  assert.equal(record.instanceId, 'adapter-instance'); assert.equal(record.mode, 'workspace-write');
  assert.equal(record.before.program, 'powershell.exe'); assert.deepEqual(record.before, record.after);
  assert.equal(record.patched, false); assert.equal(record.bindingMatched, true);
  assert.equal(trace.snapshot('bound-session').calls, 2); assert.equal(trace.snapshot('bound-session').skipped, 1);
  assert.match(record.callId, /^[a-f0-9-]{36}$/); assert.match(record.hookId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(input, before); assert.equal(result[0], exe); assert.equal(fix.isCurrent(), true);
  assert.doesNotMatch(JSON.stringify(trace.snapshot('bound-session')), /secret-command|secret-env|private-workspace|PRIVATE_KEY|System32/);
  const copy = trace.snapshot('bound-session'); copy.records[0].mode = 'corrupted';
  assert.equal(trace.snapshot('bound-session').records[0].mode, 'workspace-write');
  assert.deepEqual(trace.snapshot('other').records, []);
  clock += 600001; shell.argv(input); assert.equal(trace.snapshot('bound-session').enabled, false);
  assert.equal(trace.snapshot('bound-session').calls, 3); assert.equal(trace.snapshot('bound-session').skipped, 2);
  assert.equal(trace.snapshot('bound-session').records.length, 1);
  trace.disable('bound-session'); assert.equal(trace.snapshot('bound-session').receipt, null); fix.dispose();
});

test('shell trace bounds storage, rotates sessions, distinguishes wrappers and never breaks execution', () => {
  const trace = createShellTrace({ buildHash: 'b'.repeat(64), instanceId: 'adapter' });
  const shell = fixture(), original = shell.argv;
  const fix = installGroupEncoding(shell, () => true, 'C:\\Windows', { observe: trace.observe });
  trace.enable('bound-session'); for (let i = 0; i < 80; i++) shell.argv(spec('command-' + i));
  const snapshot = trace.snapshot('bound-session'); assert.equal(snapshot.records.length, 16);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 16384);
  assert.equal(snapshot.records[0].patched, true); assert.equal(snapshot.records[0].after.program, 'cmd.exe');
  assert.notEqual(snapshot.records[0].before.sha256, snapshot.records[0].after.sha256);
  const reset = trace.enable('other'); assert.equal(reset.calls, 0); assert.equal(reset.skipped, 0);
  assert.deepEqual(trace.snapshot('bound-session').records, []);
  shell.argv = () => ['new-provider']; assert.equal(fix.isCurrent(), false); fix.dispose();
  assert.deepEqual(shell.argv(), ['new-provider']);
  const safe = fixture(); installGroupEncoding(safe, () => true, 'C:\\Windows', { observe() { throw Error('collector unavailable'); } });
  const input = { ...spec('exit 7'), sandboxPolicy: { sessionId: 'bound-session', mode: 'workspace-write' } };
  assert.deepEqual(safe.argv(input), original(input));
});

test('actual constrained PowerShell preserves Chinese, pipeline encoding, failure codes and errors', { skip: process.platform !== 'win32' }, () => {
  const shell = fixture(); installGroupEncoding(shell, () => true, process.env.SystemRoot);
  const pipeline = "'中文✓' | & '" + process.execPath.replaceAll("'", "''") + "' -e 'process.stdin.pipe(process.stdout)'";
  for (const [script, expected] of [["$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage'; Write-Output '中文✓'; Write-Output $ExecutionContext.SessionState.LanguageMode; " + pipeline, 0], ["Write-Error 'EXPECTED-ERROR'; exit 7", 7]]) {
    const argv = shell.argv(spec(script));
    const result = spawnSync(argv[0], argv.slice(1), { windowsHide: true, timeout: 10000 });
    assert.equal(result.status, expected, result.stderr?.toString());
    if (!expected) { assert.equal(result.stdout.toString('utf8').split('中文✓').length, 3); assert.match(result.stdout.toString('utf8'), /ConstrainedLanguage/); assert.equal(result.stderr.toString(), ''); }
    else assert.match(result.stderr.toString('utf8'), /EXPECTED-ERROR/);
  }
});
