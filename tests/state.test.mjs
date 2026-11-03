import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-state-'));
process.env.HARNESS_PLUGIN_DATA = root;
const state = await import('../src/state.mjs');
const { readEvents } = await import('../src/events.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('goal IDs are validated before filesystem access', () => {
  assert.equal(state.assertGoalId('2026-10-18-abcdef12'), '2026-10-18-abcdef12');
  assert.match(state.newGoalId(), /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
  for (const bad of ['../../secrets', '2026-10-18-ABCDEF12', '2026-10-18-abc', '', null, 42]) {
    assert.throws(() => state.goalDir(bad), /Invalid goal ID/);
  }
});

test('control updates serialize and merge instead of clobbering each other', async () => {
  const id = '2026-10-18-abcdef12';
  await state.updateControl(id, { paused: false });
  await Promise.all([
    state.updateControl(id, { paused: true }),
    state.updateControl(id, { stop: true }),
    state.updateControl(id, current => ({ ...current, approval: { decision: 'allow', requestId: 7 } })),
  ]);
  const control = state.readControl(id);
  assert.equal(control.paused, true);
  assert.equal(control.stop, true);
  assert.deepEqual(control.approval, { decision: 'allow', requestId: 7 });
  assert.equal(fs.existsSync(`${state.controlPath(id)}.lock`), false);
});

test('a worker save preserves unrelated updates made from another goal snapshot', () => {
  const id = '2026-10-18-33333333';
  state.saveGoal({ id, status: 'active', codexThreadId: 'original', sidebar: null, workerPid: 1 });
  const worker = state.readGoal(id);
  const tool = state.readGoal(id);
  tool.sidebar = { verified: true, threadId: 'original' };
  delete tool.workerPid;
  state.saveGoal(tool);
  worker.status = 'awaiting_approval';
  state.saveGoal(worker);
  const saved = state.readGoal(id);
  assert.equal(saved.status, 'awaiting_approval');
  assert.deepEqual(saved.sidebar, tool.sidebar);
  assert.equal('workerPid' in saved, false);
});

test('a stale worker cannot save after the canonical thread changes', () => {
  const id = '2026-10-18-44444444';
  state.saveGoal({ id, status: 'awaiting_approval', codexThreadId: 'original' });
  const worker = state.readGoal(id);
  const tool = state.readGoal(id);
  tool.codexThreadId = 'replacement';
  state.saveGoal(tool);
  worker.status = 'active';
  assert.throws(() => state.saveGoal(worker), /thread changed/i);
  assert.equal(state.readGoal(id).codexThreadId, 'replacement');
  assert.equal(state.readGoal(id).status, 'awaiting_approval');
});

test('conflicting goal updates fail without replacing the newer value', () => {
  const id = '2026-10-18-55555555';
  state.saveGoal({ id, status: 'active' });
  const first = state.readGoal(id);
  const second = state.readGoal(id);
  first.status = 'paused';
  state.saveGoal(first);
  second.status = 'completed';
  assert.throws(() => state.saveGoal(second), /conflict/i);
  assert.equal(state.readGoal(id).status, 'paused');
  assert.equal(fs.existsSync(`${state.goalPath(id)}.lock`), false);
});

test('separate processes preserve both changes from simultaneous goal snapshots', { timeout: 10000 }, async () => {
  const id = '2026-10-18-66666666';
  state.saveGoal({ id, codexThreadId: 'thread', first: false, second: false });
  const code = `import { readGoal, saveGoal } from ${JSON.stringify(pathToFileURL(path.resolve('src/state.mjs')).href)};
    const goal = readGoal(process.argv[1]);
    console.log('ready');
    process.stdin.once('data', () => { goal[process.argv[2]] = true; saveGoal(goal); process.exit(0); });`;
  const writers = ['first', 'second'].map(field => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, id, field], { env: { ...process.env, HARNESS_PLUGIN_DATA: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', exitCode => exitCode === 0 ? resolve() : reject(new Error(stderr || `writer exited ${exitCode}`))); });
    const ready = new Promise((resolve, reject) => { child.stdout.once('data', resolve); done.catch(reject); });
    return { child, ready, done };
  });
  try {
    await Promise.all(writers.map(writer => writer.ready));
    for (const writer of writers) writer.child.stdin.end('save');
    await Promise.all(writers.map(writer => writer.done));
    const goal = state.readGoal(id);
    assert.equal(goal.first, true);
    assert.equal(goal.second, true);
    assert.equal(goal.revision, 3);
  } finally { for (const writer of writers) if (writer.child.exitCode === null) writer.child.kill(); }
});

test('event pages are chronological across rotation and tolerate a torn line', () => {
  const id = '2026-10-18-11111111';
  const dir = state.goalDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, 'events.jsonl');
  fs.writeFileSync(`${base}.3`, JSON.stringify({ n: 1 }) + '\n');
  fs.writeFileSync(`${base}.2`, JSON.stringify({ n: 2 }) + '\n');
  fs.writeFileSync(`${base}.1`, JSON.stringify({ n: 3 }) + '\n');
  fs.writeFileSync(base, JSON.stringify({ n: 4 }) + '\n{"n":5');
  const page = readEvents(id, 0, 100);
  assert.deepEqual(page.events.map(event => event.n), [1, 2, 3, 4]);
  assert.equal(page.total, 4);
  assert.equal(page.nextOffset, null);
  const second = readEvents(id, 1, 2);
  assert.deepEqual(second.events.map(event => event.n), [2, 3]);
  assert.equal(second.nextOffset, 3);
});

test('appendEvent rotates the live file into events.jsonl.1', () => {
  const id = '2026-10-18-22222222';
  const base = path.join(state.goalDir(id), 'events.jsonl');
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base, 'x'.repeat(5 * 1024 * 1024));
  state.appendEvent(id, { type: 'after-rotation' });
  assert.equal(fs.existsSync(`${base}.1`), true);
  assert.match(fs.readFileSync(base, 'utf8'), /after-rotation/);
});
