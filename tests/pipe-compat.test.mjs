import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createOwnedPipeCompat } from '../companion/pipe-compat.mjs';
import { installGroupEncoding } from '../companion/pwsh-encoding.mjs';
const require = createRequire(import.meta.url);
const { eligible, within } = require('../companion/owned-pipe.cjs');
const encoding = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const exe = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const spec = () => ({ command: 'node --test tests/diagnostics.test.mjs', sandboxPolicy: { mode: 'workspace-write', sessionId: 'bound', workspaceRoot: "C:/work/中文's project" } });
const options = { platform: 'win32', arch: 'x64', isBound: id => id === 'bound', nativePath: "C:/shared/it's native/koffi.node", preloadPath: "C:/plugin/it's pipe/owned-pipe.cjs", exists: () => true };
const argv = input => [exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', encoding + input.command];

test('pipe compatibility preserves the confined invocation, command, policy and existing NODE_OPTIONS', () => {
  const compat = createOwnedPipeCompat(options), shell = { argv }, original = shell.argv;
  const fix = installGroupEncoding(shell, options.isBound, 'C:\\Windows', { transformWorkspaceArgv: compat.transform });
  const input = spec(), before = structuredClone(input), result = shell.argv(input);
  assert.deepEqual(result.slice(0, 5), original(input).slice(0, 5));
  assert.ok(result[5].endsWith(input.command)); assert.ok(result[5].includes("中文''s project"));
  assert.ok(result[5].includes("it''s pipe")); assert.ok(result[5].includes("+ ' ' + $env:NODE_OPTIONS"));
  assert.ok(result[5].includes('Contains($codexHarnessPipeOption)')); assert.deepEqual(input, before);
  assert.equal(compat.state.applied, 1); fix.dispose(); assert.equal(shell.argv, original);
  const second = installGroupEncoding(shell, options.isBound, 'C:\\Windows', { transformWorkspaceArgv: compat.transform });
  assert.equal(shell.argv(input)[5].split('$env:DSH_GROUP_PIPE_ROOT =').length, 2); second.dispose();
});

test('unbound, read-only, unrestricted, unknown argv and missing dependencies stay unchanged', () => {
  const compat = createOwnedPipeCompat(options);
  for (const change of [{ sessionId: 'other' }, { mode: 'read-only' }, { mode: 'danger-full-access' }, { workspaceRoot: 'relative' }]) {
    const input = spec(); Object.assign(input.sandboxPolicy, change); const args = argv(input);
    assert.equal(compat.transform(input, args), args);
  }
  for (const args of [['unknown'], [exe, '-Command', 'other'], ['other.exe', ...argv(spec()).slice(1)]]) assert.equal(compat.transform(spec(), args), args);
  for (const change of [{ exists: () => false }, { platform: 'linux' }, { arch: 'arm64' }, { preloadPath: 'C:/bad"path/preload.cjs' }]) {
    const disabled = createOwnedPipeCompat({ ...options, ...change }), args = argv(spec());
    assert.equal(disabled.state.available, false); assert.equal(disabled.transform(spec(), args), args);
  }
});

test('owned-pipe eligibility rejects other objects, identities, explicit security and changed layouts', () => {
  const args = ['\\\\?\\pipe\\uv\\123-456', 0x400c0003, 0, 1, 65536, 65536, 0, null];
  assert.equal(eligible(args, 456), true); assert.equal(eligible(args, 789), false);
  for (const [index, value] of [[0, '\\\\?\\pipe\\other\\123-456'], [1, 0x40040003], [1, 0x500c0003], [2, 8], [3, 2], [7, 1n]]) {
    const altered = [...args]; altered[index] = value; assert.equal(eligible(altered, 456), false);
  }
  assert.equal(within('C:/project', 'C:/project/child'), true);
  assert.equal(within('C:/project', 'C:/project-other'), false);
  assert.equal(within('C:/project', 'D:/project'), false);
});

test('PowerShell injection quotes paths and preserves options without writing parent environment', { skip: process.platform !== 'win32' }, () => {
  const compat = createOwnedPipeCompat(options), input = spec();
  input.command = '[Console]::Write(($env:NODE_OPTIONS + "|" + $env:DSH_GROUP_PIPE_ROOT + "|" + $env:DSH_GROUP_PIPE_NATIVE))';
  const args = compat.transform(input, argv(input));
  const result = spawnSync(args[0], args.slice(1), { env: { ...process.env, NODE_OPTIONS: '--trace-warnings' }, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, [result.error?.message,result.signal,result.stderr].filter(Boolean).join(' | '));
  assert.equal(result.stdout, '--require "'+options.preloadPath+'" --trace-warnings|'+input.sandboxPolicy.workspaceRoot+'|'+options.nativePath);
});

test('unrestricted Node leaves the native shim inactive', { skip: process.platform !== 'win32' }, () => {
  const root = path.resolve('.');
  const result = spawnSync(process.execPath, ['--require', './companion/owned-pipe.cjs', '-e', 'console.log("UNRESTRICTED")'], {
    env: { ...process.env, DSH_GROUP_PIPE_ROOT: root, DSH_GROUP_PIPE_NATIVE: 'E:/dsh/resources/app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node' },
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  // This local integration is conditional on the already-installed host dependency.
  if (result.stderr.includes('native dependency unavailable')) return;
  assert.equal(result.status, 0, [result.error?.message,result.signal,result.stderr].filter(Boolean).join(' | ')); assert.equal(result.stdout.trim(), 'UNRESTRICTED');
});

test('a real Node child loads the Windows backslash preload path from NODE_OPTIONS', { skip: process.platform !== 'win32' }, () => {
  const compat = createOwnedPipeCompat({ ...options, preloadPath: path.resolve('companion/owned-pipe.cjs') });
  const input = spec(); input.command = "& '" + process.execPath.replaceAll("'", "''") + "' -e 'console.log(12345)'";
  const args = compat.transform(input, argv(input));
  const result = spawnSync(args[0], args.slice(1), { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 0, [result.error?.message,result.signal,result.stderr].filter(Boolean).join(' | ')); assert.equal(result.stdout.trim(), '12345');
});
