import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENCODING = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
const quote = text => "'" + text.replaceAll("'", "''") + "'";

// Only augment the existing confined PowerShell invocation. The host still
// owns execution, permission decisions, output collection and cancellation.
export function createOwnedPipeCompat({ isBound, platform = process.platform, arch = process.arch,
  nativePath = path.join(path.dirname(process.execPath), 'resources/app.asar.unpacked/dsh/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node'),
  preloadPath = fileURLToPath(new URL('./owned-pipe.cjs', import.meta.url)), exists = fs.existsSync } = {}) {
  const dllPath = path.join(path.dirname(preloadPath), 'owned-pipe-win32-x64.dll');
  const selected = platform === 'win32' && arch === 'x64' &&
    [nativePath, preloadPath, dllPath].every(value => path.win32.isAbsolute(value) && !/[\r\n\0"]/u.test(value) && exists(value));
  const state = { available: selected, applied: 0, reason: selected ? 'process-local-own-libuv-pipes' : 'unsupported-platform-or-missing-dependency',
    node: '24.20.0', libuv: '1.52.1', native: '3.1.1' };
  return { state, transform(spec, argv) {
    const policy = spec?.sandboxPolicy;
    if (!selected || policy?.mode !== 'workspace-write' || !isBound?.(policy.sessionId) ||
        typeof policy.workspaceRoot !== 'string' || !path.win32.isAbsolute(policy.workspaceRoot) || /[\r\n\0]/u.test(policy.workspaceRoot) ||
        typeof spec.command !== 'string' || !Array.isArray(argv) || argv.length !== 6 ||
        !/^(?:pwsh|powershell)\.exe$/i.test(path.win32.basename(argv[0])) ||
        argv[1] !== '-NoLogo' || argv[2] !== '-NoProfile' || argv[3] !== '-NonInteractive' || argv[4] !== '-Command' ||
        argv[5] !== ENCODING + spec.command) return argv;
    // Node's NODE_OPTIONS parser consumes backslashes as escapes even inside
    // quotes; forward slashes preserve real Windows module paths verbatim.
    const option = '--require "' + preloadPath.replaceAll('\\', '/') + '"';
    const setup = '$env:DSH_GROUP_PIPE_ROOT = ' + quote(policy.workspaceRoot) + '; $env:DSH_GROUP_PIPE_NATIVE = ' + quote(nativePath) +
      '; $codexHarnessPipeOption = ' + quote(option) + '; if (-not $env:NODE_OPTIONS -or -not $env:NODE_OPTIONS.Contains($codexHarnessPipeOption)) { ' +
      '$env:NODE_OPTIONS = $codexHarnessPipeOption + \' \' + $env:NODE_OPTIONS }; ';
    state.applied++;
    return [...argv.slice(0, 5), ENCODING + setup + spec.command];
  } };
}
