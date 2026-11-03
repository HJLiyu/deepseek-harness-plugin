import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { captureIntegrationScope } from '../src/group-integration.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-rebase-'));
  const repo = path.join(dir, 'main'), peer = path.join(dir, 'peer'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@localhost');
  git(repo, 'config', 'core.autocrlf', 'false'); fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base'); const commit = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'peer', peer, commit);
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const group = store.create({ repo, models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  group.status = 'active'; group.contexts = { codex: 'ct', harness: 'ht' }; group.initialized = { codex: true, harness: true };
  group.worktrees = { codex: peer, harness: peer }; group.baseline = { commit };
  group.integrationState = { main: { 'a.txt': sha('base\n') }, peers: {} }; store.save(group);
  const { request } = store.input(group.id, { content: 'Preserve maintenance and add feature', origin: { adapter: 'test', sessionId: 's', messageId: 'm' } });
  request.phase = 'execution'; request.status = 'active';
  request.agreement = { owner: 'codex', integrator: 'codex', review: true, tasks: { codex: '', harness: '' } };
  request.actions = [{ phase: 'work', member: 'codex' }, { phase: 'review', member: 'harness' }, { phase: 'integrate', member: 'codex' }];
  store.saveRequest(request); group.activeRequestId = request.id; store.save(group);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'maintenance\n');
  const calls = []; const engine = new GroupEngine(store, { appOpen: async () => true });
  return { repo, peer, store, group, request, engine, calls };
}
const response = extra => ({ text: JSON.stringify({ message: 'Checked current main', status: 'done', summary: 'Scoped', verification: ['fixture bytes checked'], ...extra }) });

test('unaligned work reuses independent review to capture current bases without refreshing unrelated checkpoints', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.repo, 'unrelated.txt'), 'preserve staged\n'); git(f.repo, 'add', 'unrelated.txt');
  const staged = git(f.repo, 'diff', '--cached', '--binary');
  f.engine.runtime.turn = async (_group, delivery) => {
    f.calls.push(delivery);
    if (delivery.phase === 'work') fs.writeFileSync(path.join(f.peer, 'a.txt'), 'maintenance\nfeature\n');
    if (delivery.phase === 'review') {
      assert.equal(JSON.parse(delivery.prompt).assignment.integrationReadiness, true);
      return response({ integrationFiles: ['a.txt'] });
    }
    if (delivery.phase === 'integrate') fs.copyFileSync(path.join(f.peer, 'a.txt'), path.join(f.repo, 'a.txt'));
    return response();
  };
  await f.engine.tick(f.group.id); assert.equal(f.store.request(f.request.id).actions[0].integrationReadiness, true);
  await f.engine.tick(f.group.id);
  const reviewed = f.store.request(f.request.id);
  assert.equal(reviewed.integrationScope.bases.codex['a.txt'], sha('maintenance\n'));
  assert.equal(reviewed.integrationReadyReceipt.reviewer, 'harness');
  await f.engine.tick(f.group.id);
  assert.equal(f.store.request(f.request.id).status, 'completed');
  assert.deepEqual(f.calls.map(c => c.phase), ['work', 'review', 'integrate']);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'maintenance\nfeature\n');
  assert.equal(git(f.repo, 'diff', '--cached', '--binary'), staged);
  assert.equal(Object.hasOwn(f.store.group(f.group.id).integrationState.main, 'unrelated.txt'), false);
});

test('main changes during independent readiness are refused without an integration write', async t => {
  const f = fixture(t); let integrations = 0;
  f.engine.runtime.turn = async (_group, delivery) => {
    if (delivery.phase === 'work') fs.writeFileSync(path.join(f.peer, 'a.txt'), 'maintenance\nfeature\n');
    if (delivery.phase === 'review') {
      fs.writeFileSync(path.join(f.repo, 'a.txt'), 'concurrent human edit\n');
      return response({ integrationFiles: ['a.txt'] });
    }
    if (delivery.phase === 'integrate') integrations++;
    return response();
  };
  await f.engine.tick(f.group.id); await f.engine.tick(f.group.id);
  const request = f.store.request(f.request.id);
  assert.equal(integrations, 0); assert.equal(request.reviewRepairRounds??0, 0);
  assert.equal(request.status,'blocked');assert.equal(request.errorDetails.reason,'main_conflict');
  assert.equal(request.actions[0].phase, 'review'); assert.equal(request.integrationReadyReceipt, undefined);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'concurrent human edit\n');
});

test('independent reviewer can block a destructive candidate; no checkpoint is accepted', async t => {
  const f = fixture(t); let integrations = 0;
  f.engine.runtime.turn = async (_group, delivery) => {
    if (delivery.phase === 'work') fs.writeFileSync(path.join(f.peer, 'a.txt'), 'drops maintenance\n');
    if (delivery.phase === 'review') return response({ status: 'blocked', message: 'Human must decide conflicting content' });
    if (delivery.phase === 'integrate') integrations++;
    return response();
  };
  await f.engine.tick(f.group.id); await f.engine.tick(f.group.id);
  assert.equal(integrations, 0); assert.equal(f.store.request(f.request.id).status, 'blocked');
  assert.equal(f.store.request(f.request.id).integrationReadyReceipt, undefined);
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'maintenance\n');
});

async function legacyScopedWork(t) {
  const f = fixture(t);
  const request = f.store.request(f.request.id); request.agreement.owner = 'both'; f.store.saveRequest(request);
  f.engine.runtime.turn = async (_group, delivery) => {
    f.calls.push(delivery);
    if (delivery.phase === 'work') fs.writeFileSync(path.join(f.peer, 'a.txt'), 'maintenance\nfeature\n');
    if (delivery.phase === 'review') return response({ integrationFiles: ['a.txt'] });
    if (delivery.phase === 'integrate') fs.copyFileSync(path.join(f.peer, 'a.txt'), path.join(f.repo, 'a.txt'));
    return response();
  };
  await f.engine.tick(f.group.id); await f.engine.tick(f.group.id);
  const current = f.store.request(f.request.id);
  // Reproduce the saved state after the old executor-only diagnostic narrowed
  // candidates but could not authorize a newer base. No native work is pending.
  current.integrationScope = captureIntegrationScope(f.group, 'codex', ['a.txt'], current.revision);
  current.integrationDiagnosisRevision = current.revision; f.store.saveRequest(current);
  return f;
}

test('a saved multi-owner scope with unchanged admission main gets one independent readiness review', async t => {
  const f = await legacyScopedWork(t);
  await f.engine.tick(f.group.id);
  let request = f.store.request(f.request.id);
  assert.equal(request.actions[0].integrationReadiness, true);
  assert.equal(request.actions[0].member, 'harness');
  assert.equal(request.integrationScope.bases, undefined, 'scheduling a review grants no base');
  await f.engine.tick(f.group.id);
  request = f.store.request(f.request.id);
  assert.equal(request.integrationScope.bases.codex['a.txt'], sha('maintenance\n'));
  await f.engine.tick(f.group.id);
  assert.equal(f.store.request(f.request.id).status, 'completed');
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'maintenance\nfeature\n');
  assert.equal(f.calls.filter(x => x.phase === 'work').length, 1);
});

test('legacy readiness repair never treats concurrent main or changed candidates as stale bookkeeping', async t => {
  for (const changed of ['main', 'candidate']) await t.test(changed, async t => {
    const f = await legacyScopedWork(t);
    fs.writeFileSync(path.join(changed === 'main' ? f.repo : f.peer, 'a.txt'), 'new concurrent edit\n');
    await f.engine.tick(f.group.id);
    const request = f.store.request(f.request.id);
    assert.equal(request.status, 'blocked'); assert.equal(request.integrationReadyReceipt, undefined);
    assert.equal(request.actions[0].phase, 'integrate');
    assert.equal(f.calls.filter(x => x.phase === 'integrate').length, 0);
  });
});

test('legacy readiness review refuses changed main and cannot silently narrow its fixed target list', async t => {
  for (const change of ['during-review', 'drop-target']) await t.test(change, async t => {
    const f = await legacyScopedWork(t); await f.engine.tick(f.group.id);
    f.engine.runtime.turn = async () => {
      if (change === 'during-review') fs.writeFileSync(path.join(f.repo, 'a.txt'), 'new concurrent edit\n');
      return response({ integrationFiles: change === 'drop-target' ? [] : ['a.txt'] });
    };
    await f.engine.tick(f.group.id);
    const request = f.store.request(f.request.id);
    assert.equal(request.integrationReadyReceipt, undefined);
    assert.equal(request.actions[0].phase, 'review');
    if(change==='drop-target'){assert.equal(request.status,'active');assert.ok(request.actions[0].responseRepair);assert.equal(request.reviewRepairRounds??0,0);}
    else assert.equal(request.status,'blocked');
  });
});

test('a change after readiness scheduling is caught before a reviewer is admitted', async t => {
  const f = await legacyScopedWork(t); await f.engine.tick(f.group.id);
  const before = f.calls.length;
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'new edit before admission\n');
  await f.engine.tick(f.group.id);
  assert.equal(f.calls.length, before);
  assert.equal(f.store.request(f.request.id).status, 'blocked');
  assert.equal(f.store.request(f.request.id).integrationReadyReceipt, undefined);
});
