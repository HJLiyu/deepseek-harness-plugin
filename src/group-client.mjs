import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, readJson } from './state.mjs';
import { localFetch } from './group-http.mjs';
import { GROUP_PROTOCOL, GROUP_VERSION, groupBuildHash, groupRuntimeHash } from './group-build.mjs';
import { rememberDesktopBridge } from './desktop.mjs';

export function serviceBuildMatches(health) {
 // A live maintenance lease is not a version mismatch. Ordinary reads and
 // native routing must not take over its owner and restart the coordinator.
 return health.runtimeHash ? health.runtimeHash===groupRuntimeHash() : health.buildHash===groupBuildHash();
}
export async function ensureGroupService() {
  // A Harness-launched worker does not inherit Codex IPC credentials. Publish
  // the current trusted desktop pair even when another launcher owns the worker.
  rememberDesktopBridge();
  const file = path.join(dataDir, 'group-service.json');
  const current = readJson(file, null);
  let health;
  if (current) { try { health = await localFetch(current, '/api/health', undefined, { timeoutMs: 1500 }); } catch { /* recover a stopped daemon */ } }
  if (health) {
    const previous = health.protocol === 'codex-harness-group/v1' && health.version === '0.3.1';
    if ((health.protocol !== GROUP_PROTOCOL && !previous) || !health.buildHash) throw new Error('运行中的群协调服务协议不兼容。请先通过正常更新或退出流程重载；不会按 PID 强杀，也不会同时启动第二个执行者。历史和检查点会保留。');
    const parts = value => String(value).split('.').map(Number);
    const runningVersion = parts(health.version), expectedVersion = parts(GROUP_VERSION);
    for (let index = 0; index < 3; index++) {
      if (runningVersion[index] > expectedVersion[index]) throw new Error('运行中的协调器版本较新；拒绝降级，请重新加载当前插件。');
      if (runningVersion[index] < expectedVersion[index]) break;
    }
    // Disk replacement may already be underway. Only the maintenance owner
    // may finish that update; a reader with a different local hash must not
    // shut down the service in the middle of its still-valid drain lease.
    if(health.protocol===GROUP_PROTOCOL&&health.draining&&Number.isSafeInteger(health.drainExpiresAt)&&health.drainExpiresAt>Date.now())return current;
    if (serviceBuildMatches(health)) return current;
    await localFetch(current, '/api/admin/prepare-update', {});
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await localFetch(current, '/api/health');
      if (!state.running) { await localFetch(current, '/api/admin/shutdown', {}); break; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    // Listener shutdown precedes process/SQLite cleanup. Wait for the owner's lock release too.
    let released = false;
    const releaseDeadline = Date.now() + 15000;
    while (Date.now() < releaseDeadline) {
      try {
        const state = await localFetch(current, '/api/health', undefined, { timeoutMs: 500 });
        if (state.protocol === GROUP_PROTOCOL && serviceBuildMatches(state)) return current;
      } catch {
        if (!fs.existsSync(path.join(dataDir, 'group-service.lock'))) { released = true; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!released) throw new Error('Worker is still draining or releasing its lock; retry after its native checkpoint settles.');
  }
  const worker = fileURLToPath(new URL('../group-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker], { cwd: path.dirname(worker), detached: true, windowsHide: true,
    stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PLUGIN_DATA: dataDir } });
  let spawnError; child.on('error', error => { spawnError = error; }); child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const descriptor = readJson(file, null);
    if (descriptor) { try { const state = await localFetch(descriptor, '/api/health', undefined, { timeoutMs: 1000 }); if (state.protocol === GROUP_PROTOCOL && serviceBuildMatches(state)) return descriptor; } catch { /* waiting */ } }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Group service did not start. Inspect ${file} and the service lock; no model calls were made.`);
}
export async function groupCall(route, body) { return localFetch(await ensureGroupService(), route, body, { timeoutMs: 120000 }); }
export async function groupPage(groupId) {
  const descriptor = await ensureGroupService();
  if (groupId) await localFetch(descriptor, `/api/groups/${encodeURIComponent(groupId)}`);
  return { url: `${descriptor.url}/${groupId ? `g/${groupId}` : ''}#${descriptor.token}`, descriptorFile: path.join(dataDir, 'group-service.json') };
}

export async function openGroupPage(groupId, { getPage = groupPage, launch = spawn, platform = process.platform } = {}) {
  // Health/startup is completed before handing any URL to the browser.
  const page = await getPage(groupId), url = new URL(page.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Only the verified local group page can be opened.');
  const command = platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const child = launch(command, [url.href], { detached: true, windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
  child.unref();
  return { launchRequested: true, groupId: groupId ?? null };
}
