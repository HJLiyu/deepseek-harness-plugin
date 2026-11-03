import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupStore } from '../src/group-store.mjs';
import { startGroupService } from '../src/group-service.mjs';
import { localFetch } from '../src/group-http.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('background enumeration includes older groups beyond the UI limit', t => {
  const store = new GroupStore(':memory:');
  t.after(() => store.close());
  const groups = Array.from({ length: 205 }, (_, i) => store.create({ title: `group ${i}`, repo: process.cwd() }));
  assert.equal(store.list().length, 100);
  const all = [...store.allGroups()];
  assert.equal(all.length, groups.length);
  assert.equal(new Set(all.map(g => g.id)).size, groups.length);
  assert.equal(all[0].id, groups[0].id);
  assert.equal(all.at(-1).id, groups.at(-1).id);
});

test('scheduler and adapter update gate see an older active group', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-enumeration-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  const older = store.create({ repo: dir });
  older.status = 'active'; older.activeRequestId = 'queued'; older.harnessAdapterId = 'harness-desktop'; store.save(older);
  for (let i = 0; i < 100; i++) { const g = store.create({ repo: dir }); g.status = 'closed'; store.save(g); }
  const runtime = { adapterUpdates: new Map(), appOpen: async () => true };
  const service = await startGroupService({ store, runtime, descriptorFile: path.join(dir, 'service.json'), scheduleIntervalMs: 20 });
  let ticks = 0;
  service.engine.tick = async id => { if (id === older.id) ticks++; };
  t.after(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(ticks > 0, 'the old active group was scheduled');
  service.engine.running.set(older.id, new AbortController());
  const result = await localFetch(service.descriptor, '/api/admin/adapter-update', { adapterId: 'harness-desktop', action: 'begin' });
  assert.equal(result.ready, false, 'the old running group prevents adapter update');
  service.engine.running.delete(older.id);
});
