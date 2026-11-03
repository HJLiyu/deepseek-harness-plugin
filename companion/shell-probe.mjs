import path from 'node:path';

const MARKER = 'CODEX-HARNESS-SHELL-PROBE';
const output = value => typeof value === 'string' ? value.slice(0, 1500) : (value?.text ?? '').slice(0, 1500);

// Fixed diagnostic commands only; never accepts a caller-supplied command or
// an unconfined executor. Alternate binaries use the same native sandbox seam.
export async function probeShell(agent, variant = 'configured', services = agent.ctx) {
  if (agent.status !== 'idle') throw new Error('Pause the group and wait for the native agent to be idle.');
  if (!['configured', 'configured-standing', 'node-pipes', 'launch-spec', 'windows-powershell', 'cmd', 'cmd-standing'].includes(variant)) throw new Error('Unsupported diagnostic variant.');
  const shell = services.shell;
  if (typeof shell?.confine !== 'function' || typeof services.sandbox?.confine !== 'function') throw new Error('A confined native shell provider is required.');
  const standing = ['configured-standing', 'node-pipes', 'launch-spec', 'cmd-standing'].includes(variant);
  const policy = services.sandboxPolicy.resolve({ session: agent.session, ...standing ? {} : { mode: 'read-only' } });
  if (!['read-only', 'workspace-write'].includes(policy.mode) || !path.isAbsolute(policy.workspaceRoot)) throw new Error('Invalid diagnostic confinement.');
  if (variant === 'node-pipes' && policy.mode !== 'workspace-write') throw Error('Node pipe acceptance requires the existing workspace-write policy.');
  const command = variant === 'node-pipes'
    ? `node --test tests/diagnostics.test.mjs; $codexHarnessProbeExit = $LASTEXITCODE; if ($codexHarnessProbeExit -eq 0) { Write-Output '${MARKER}'; Write-Output '中文✓' }; exit $codexHarnessProbeExit`
    : `Write-Output '${MARKER}'; Write-Output '中文✓'`;
  const spec = shell.resolve({ command, workdir: policy.workspaceRoot,
    timeoutMs: variant === 'node-pipes' ? 15000 : 5000, stdoutMaxBytes: 4096, sandboxPolicy: policy });
  if (spec.sandboxPolicy?.mode !== policy.mode || spec.sandboxPolicy?.workspaceRoot !== policy.workspaceRoot) throw new Error('Native executor did not retain diagnostic confinement.');
  const declaredArgv = typeof shell.argv === 'function' ? shell.argv(spec) : null;
  if (variant === 'launch-spec') {
    if (!Array.isArray(declaredArgv)) throw Error('Native provider has no argv diagnostic seam.');
    const confined = await services.sandbox.confine(declaredArgv, policy, AbortSignal.timeout(5000));
    if (!Array.isArray(confined.argv) || !confined.argv.length) throw Error('Native sandbox returned no launch argv.');
    const flags = {};
    for (const key of ['--workspace', '--temp', '--mode']) {
      const i = confined.argv.indexOf(key); if (i >= 0) flags[key] = confined.argv[i + 1];
    }
    return { variant, executed: false, mode: policy.mode, cwd: policy.workspaceRoot,
      program: confined.argv[0], modules: confined.argv.filter(v => typeof v === 'string' && path.isAbsolute(v) && /\.[cm]?js$/i.test(v)),
      argumentCount: confined.argv.length, flags, enforcement: confined.enforcement ?? null,
      host: { pid: process.pid, ppid: process.ppid, cwd: process.cwd(), execPath: process.execPath,
        environment: Object.fromEntries(['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', '__COMPAT_LAYER', 'ELECTRON_RUN_AS_NODE', 'DSH_SUBPROCESS_CONTROL']
          .map(key => [key, Object.entries(process.env).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1] ?? null])) } };
  }
  let confinement;
  const argv = variant.startsWith('cmd')
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), '/d', '/c', `echo ${MARKER}`]
    : [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoProfile', '-NonInteractive', '-Command', `Write-Output '${MARKER}'; Write-Output '中文✓'`];
  const configured = variant.startsWith('configured') || variant === 'node-pipes';
  const running = configured ? await shell.execute(spec) : await shell.executeArgv(spec, async signal => {
    confinement = await services.sandbox.confine(argv, policy, signal);
    if (!Array.isArray(confinement.argv) || !confinement.argv.length) throw new Error('Native sandbox returned no launch argv.');
    return confinement.argv;
  });
  const result = await running.result();
  return { variant, executable: configured ? shell.pwshPath : argv[0], cwd: policy.workspaceRoot,
    launch: declaredArgv ? { program: declaredArgv[0], argumentCount: declaredArgv.length, sessionId: policy.sessionId ?? null,
      utf8Preamble: declaredArgv.at(-1)?.startsWith('[Console]::OutputEncoding') ?? false } : null,
    mode: policy.mode, enforcement: result.sandbox?.enforcement ?? confinement?.enforcement ?? null,
    exitCode: result.exitCode, stdout: output(result.stdout), stderr: output(result.stderr),
    markerSeen: output(result.stdout).includes(MARKER), unicodeSeen: output(result.stdout).includes('中文✓') };
}
