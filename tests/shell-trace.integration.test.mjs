import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupStore } from '../src/group-store.mjs';
import { GroupRuntime } from '../src/group-runtime.mjs';
import { startGroupService } from '../src/group-service.mjs';
import { localFetch } from '../src/group-http.mjs';
import { apply as applyCompanion, loadedBuildHash } from '../companion/index.mjs';

test('native shell trace requires authentication and a bound session, then reports fixture hook metadata only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-trace-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  const group = store.create({ repo: dir, models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  group.contexts = { codex: 'ct', harness: 'ht' }; group.worktrees = { codex: dir, harness: dir };
  group.harnessAdapterId = 'harness-desktop'; store.save(group);
  const rt = new GroupRuntime(store), descriptorFile = path.join(dir, 'service.json');
  const hub = await startGroupService({ store, runtime: rt, schedule: false, descriptorFile });
  const effects = [];
  const shellTarget = { argv: spec => ['C:\\Windows\\powershell.exe', '-Command', spec.command] };
  const shell = new Proxy(shellTarget, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? new Proxy(value, {}) : value;
  } });
  const original = shell.argv;
  const ctx = { shell, on() {}, effect(fn) { effects.push(fn()); }, webServer: { register: () => () => {} },
    sessionController: { rename: async r => ({ title: r.title }) } };
  t.after(async () => {
    for (const dispose of effects.reverse()) if (typeof dispose === 'function') dispose();
    await hub.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await applyCompanion(ctx, { descriptorFile, adapterId: 'harness-desktop' });
  const adapter = rt.adapter(group), route = '/shell-trace';
  assert.equal((await fetch(adapter.url + route, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(adapter.url + route, { method: 'POST', headers: {
    authorization: `Bearer ${adapter.token}`, origin: 'https://foreign.invalid',
  }, body: '{}' })).status, 403);
  await assert.rejects(localFetch(adapter, route, { sessionId: 'foreign', action: 'enable' }), /bound/);
  await assert.rejects(localFetch(adapter, route, { sessionId: 'ht', action: 'arbitrary' }), /action/);
  const start = await localFetch(adapter, route, { sessionId: 'ht', action: 'enable' });
  assert.equal(start.hookCurrent, true); assert.equal(start.receipt.buildHash, loadedBuildHash);
  assert.equal(start.hookInspection.referenceEqual, false); assert.equal(start.hookInspection.markerMatched, true);
  assert.equal(start.receipt.selfCheck, 'memory-ready');
  assert.equal(start.calls, 0); assert.equal(start.skipped, 0);
  shell.argv({ command: 'FOREIGN_COMMAND', sandboxPolicy: { sessionId: 'another', mode: 'workspace-write' } });
  const skipped = await localFetch(adapter, route, { sessionId: 'ht', action: 'read' });
  assert.equal(skipped.calls, 1); assert.equal(skipped.skipped, 1); assert.deepEqual(skipped.records, []);
  shell.argv({ command: 'PRIVATE_COMMAND', sandboxPolicy: { sessionId: 'ht', mode: 'workspace-write' } });
  const result = await localFetch(adapter, route, { sessionId: 'ht', action: 'read' });
  assert.equal(result.records.length, 1); assert.equal(result.records[0].bindingMatched, true);
  assert.equal(result.calls, 2); assert.equal(result.skipped, 1);
  assert.equal(result.records[0].patched, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_COMMAND/);
  await localFetch(adapter, route, { sessionId: 'ht', action: 'disable' });
  assert.deepEqual((await localFetch(adapter, route, { sessionId: 'ht', action: 'read' })).records, []);
  for (const dispose of effects.reverse().splice(0)) if (typeof dispose === 'function') dispose();
  effects.length = 0; assert.deepEqual(shell.argv({ command: 'restored' }), original({ command: 'restored' }));
});
