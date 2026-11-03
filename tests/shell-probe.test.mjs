import test from 'node:test';
import assert from 'node:assert/strict';
import { probeShell } from '../companion/shell-probe.mjs';

function fixture() {
  const calls = [], policy = { mode: 'read-only', workspaceRoot: process.cwd(), sessionId: 'native-test' };
  const result = { exitCode: 0, stdout: { text: 'CODEX-HARNESS-SHELL-PROBE\n' }, stderr: { text: '' }, sandbox: { enforcement: 'native' } };
  const shell = { pwshPath: 'configured-pwsh', ctx: { sandbox: { async confine(argv, received) {
    assert.equal(received.mode, 'read-only'); calls.push(argv); return { argv: ['native-runner', ...argv], enforcement: 'native' };
  } } }, confine() {}, resolve: spec => spec,
    async execute(spec) { calls.push(spec); return { result: async () => result }; },
    async executeArgv(spec, prepare) { const argv = await prepare(new AbortController().signal); assert.equal(argv[0], 'native-runner'); return { result: async () => result }; } };
  const agent = { status: 'idle', session: {}, ctx: { shell, sandbox: shell.ctx.sandbox, sandboxPolicy: { resolve: () => policy } } };
  return { agent, calls };
}
test('shell diagnosis uses fixed commands and retains native read-only confinement for every variant', async () => {
  const { agent, calls } = fixture();
  for (const variant of ['configured', 'windows-powershell', 'cmd']) {
    const result = await probeShell(agent, variant); assert.equal(result.markerSeen, true); assert.equal(result.mode, 'read-only');
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "Write-Output 'CODEX-HARNESS-SHELL-PROBE'; Write-Output '中文✓'");
});
test('shell diagnosis rejects busy agents, unknown commands and unconfined providers', async () => {
  const { agent } = fixture();
  await assert.rejects(probeShell(agent, 'arbitrary command'), /Unsupported/);
  agent.status = 'running'; await assert.rejects(probeShell(agent), /idle/);
  agent.status = 'idle'; delete agent.ctx.shell.confine; await assert.rejects(probeShell(agent), /confined/);
});

test('native diagnostics use declared plugin services rather than reading undeclared agent context', async () => {
  const { agent } = fixture(); const services = agent.ctx;
  services.shell.ctx = new Proxy({}, { get() { throw Error('cannot get nested service property without inject'); } });
  agent.ctx = new Proxy({}, { get() { throw Error('cannot get property without inject'); } });
  assert.equal((await probeShell(agent, 'configured', services)).markerSeen, true);
});

test('standing diagnostic retains the existing confined policy and refuses full access', async () => {
  const { agent, calls } = fixture();
  let mode = 'workspace-write';
  agent.ctx.sandboxPolicy.resolve = request => {
    assert.equal(request.mode, undefined);
    return { mode, workspaceRoot: process.cwd(), sessionId: 'native-test' };
  };
  assert.equal((await probeShell(agent, 'configured-standing')).mode, mode);
  assert.equal(calls[0].sandboxPolicy.mode, mode);
  mode = 'danger-full-access';
  await assert.rejects(probeShell(agent, 'configured-standing'), /Invalid diagnostic confinement/);
  assert.equal(calls.length, 1);
});

test('launch spec diagnosis never executes or exports arbitrary arguments', async () => {
  const { agent } = fixture(); let executed = false;
  agent.ctx.shell.argv = () => ['powershell', '-Command', 'fixed'];
  agent.ctx.shell.execute = () => { executed = true; throw Error('must not execute'); };
  agent.ctx.sandbox.confine = async () => ({ argv: ['runner', 'opaque-secret', '--mode', 'workspace-write', '--temp', 'private-temp'], enforcement: 'partial' });
  const result = await probeShell(agent, 'launch-spec');
  assert.equal(executed, false); assert.equal(result.executed, false);
  assert.equal(result.flags['--temp'], 'private-temp');
  assert.equal(JSON.stringify(result).includes('opaque-secret'), false);
  assert.deepEqual(Object.keys(result.host.environment), ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', '__COMPAT_LAYER', 'ELECTRON_RUN_AS_NODE', 'DSH_SUBPROCESS_CONTROL']);
  assert.equal(typeof result.host.pid, 'number');
});

test('Node acceptance uses the configured native executor and standing workspace policy', async () => {
  const { agent, calls } = fixture();
  agent.ctx.sandboxPolicy.resolve = request => {
    assert.equal(request.mode, undefined);
    return { mode: 'workspace-write', workspaceRoot: process.cwd(), sessionId: 'native-test' };
  };
  assert.equal((await probeShell(agent, 'node-pipes')).mode, 'workspace-write');
  assert.ok(calls[0].command.startsWith('node --test tests/diagnostics.test.mjs;'));
  assert.equal(calls[0].sandboxPolicy.mode, 'workspace-write');
  agent.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: process.cwd() });
  await assert.rejects(probeShell(agent, 'node-pipes'), /existing workspace-write/);
});
