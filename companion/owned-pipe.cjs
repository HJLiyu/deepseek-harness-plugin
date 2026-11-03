'use strict';
// Only the calling process's freshly-created libuv stdio pipes are affected.
// Tokens, existing pipes, filesystem ACLs and installed binaries stay untouched.
const path = require('node:path');
const fs = require('node:fs');
const KEY = Symbol.for('codex-harness.owned-pipe.v1');
function within(root, cwd) {
  if (!root || !path.win32.isAbsolute(root) || !path.win32.isAbsolute(cwd)) return false;
  const relative = path.win32.relative(root, cwd);
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative));
}
function eligible(args, pid) {
  const prefix = '\\\\?\\pipe\\uv\\';
  return typeof args[0] === 'string' && args[0].startsWith(prefix) &&
    new RegExp('^[0-9]+-' + pid + '$').test(args[0].slice(prefix.length)) && args[7] === null &&
    ((args[1] >>> 0) & (~0x400c0003 >>> 0)) === 0 &&
    (args[1] & 0xc0000) === 0xc0000 && [1, 2, 3].includes(args[1] & 3) &&
    args[2] === 0 && args[3] === 1 && args[4] === 65536 && args[5] === 65536 && args[6] === 0;
}
function install() {
  if (globalThis[KEY]) return globalThis[KEY].snapshot();
  const state = { enabled: false, granted: 0, failures: 0, reason: 'not-selected' };
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.electron ||
      !require('node:worker_threads').isMainThread || !within(process.env.DSH_GROUP_PIPE_ROOT, process.cwd())) return state;
  if (process.versions.node !== '24.20.0' || process.versions.uv !== '1.52.1') return { ...state, reason: 'unsupported-runtime' };
  const binding = process.env.DSH_GROUP_PIPE_NATIVE;
  if (!binding || !path.isAbsolute(binding) || !fs.existsSync(binding)) throw Error('Owned-pipe compatibility: native dependency unavailable.');
  const k = require(binding);
  if (k.version !== '3.1.1') throw Error('Owned-pipe compatibility: unsupported native dependency.');
  // Native code, rather than a JS callback, also serves libuv calls made on worker threads.
  const library = k.load(path.join(__dirname, 'owned-pipe-win32-x64.dll'));
  const enable = library.func('__stdcall', 'OwnedPipeInstall', 'uint32', ['str16']);
  const disable = library.func('__stdcall', 'OwnedPipeUninstall', 'uint32', []);
  const status = library.func('__stdcall', 'OwnedPipeStatus', 'void', ['void *']);
  const snapshot = () => {
    const b = Buffer.alloc(16); status(b);
    return { enabled: b.readInt32LE(0) === 1, granted: b.readInt32LE(4), failures: b.readInt32LE(8),
      lastError: b.readInt32LE(12), reason: b.readInt32LE(0) ? 'restricted-own-libuv-pipes' : 'not-active' };
  };
  const code = enable(process.env.DSH_GROUP_PIPE_ROOT);
  if (code === 50) return { ...state, reason: 'not-a-supported-restricted-process' };
  if (code) { disable(); throw Error('Owned-pipe compatibility initialization failed (Win32 ' + code + ').'); }
  globalThis[KEY] = { library, snapshot };
  process.once('exit', () => {
    const final = snapshot(); disable();
    if (process.env.DSH_GROUP_PIPE_TRACE === '1') console.error('CODEX_HARNESS_PIPE ' + JSON.stringify(final));
  });
  return snapshot();
}
module.exports = { eligible, within, install };
if (process.env.DSH_GROUP_PIPE_ROOT) install();
