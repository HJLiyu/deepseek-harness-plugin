import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const dataDir = path.resolve(process.env.HARNESS_PLUGIN_DATA ?? process.env.PLUGIN_DATA ?? path.join(os.homedir(), '.codex', 'deepseek-harness-plugin-data'));

// Goal IDs are generated below and are also accepted from MCP tool callers.
// Validate them before touching the filesystem so an agent cannot traverse out
// of the plugin data directory with an ID such as "../../secrets".
const GOAL_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
export function assertGoalId(id) {
  if (typeof id !== 'string' || !GOAL_ID_PATTERN.test(id)) throw new Error(`Invalid goal ID: ${String(id)}`);
  return id;
}
export function goalDir(id) { return path.join(dataDir, 'goals', assertGoalId(id)); }
export function goalPath(id) { return path.join(goalDir(id), 'goal.json'); }
export function controlPath(id) { return path.join(goalDir(id), 'control.json'); }
export function newGoalId() { return new Date().toISOString().slice(0, 10) + '-' + randomUUID().slice(0, 8); }

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
export function readJson(file, fallback = undefined) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const goalSnapshots = new WeakMap();
const lockWait = new Int32Array(new SharedArrayBuffer(4));
export function readGoal(id) {
  const goal = readJson(goalPath(id));
  if (goal) goalSnapshots.set(goal, structuredClone(goal));
  return goal;
}

// The worker and tools can hold different snapshots while awaiting RPC calls.
// Lock across processes and merge only fields changed since this object's read.
// Conflicting writes fail closed; a thread change invalidates every old worker
// snapshot so results and approvals cannot cross conversation boundaries.
export function saveGoal(goal, options = {}) {
  const file = goalPath(goal.id);
  const baseline = goalSnapshots.get(goal);
  if (baseline && baseline.id !== goal.id) throw new Error('A goal ID cannot change.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let handle;
  for (;;) {
    try { handle = fs.openSync(lock, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(lock, 'utf8'));
        let dead = false;
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); } catch (check) { dead = check.code === 'ESRCH'; }
        } else dead = Date.now() - fs.statSync(lock).mtimeMs > 10000;
        if (dead) { fs.unlinkSync(lock); continue; }
      } catch (check) { if (check.code === 'ENOENT') continue; throw check; }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the goal file lock.');
      Atomics.wait(lockWait, 0, 0, 25);
    }
  }
  try {
    fs.writeSync(handle, String(process.pid));
    const current = readJson(file);
    if (Object.hasOwn(options, 'expectedRevision') && current?.revision !== options.expectedRevision) throw new Error('Goal changed during the operation; retry from a fresh checkpoint.');
    if (current && !baseline) throw new Error('Goal already exists; readGoal before saving it.');
    if (baseline && !current) throw new Error('Goal was removed while it was being updated.');
    if (baseline && baseline.codexThreadId !== current.codexThreadId) throw new Error('Codex thread changed; reload the goal before saving.');
    const merged = { ...current };
    for (const key of new Set([...Object.keys(baseline ?? {}), ...Object.keys(goal)])) {
      if (['updatedAt', 'revision'].includes(key)) continue;
      if (baseline && isDeepStrictEqual(baseline[key], goal[key]) && Object.hasOwn(baseline, key) === Object.hasOwn(goal, key)) continue;
      if (baseline && !isDeepStrictEqual(current[key], baseline[key]) && !isDeepStrictEqual(current[key], goal[key])) {
        throw new Error(`Concurrent goal update conflict on ${key}; reload the goal.`);
      }
      if (Object.hasOwn(goal, key)) merged[key] = goal[key];
      else delete merged[key];
    }
    merged.revision = (current?.revision ?? 0) + 1;
    merged.updatedAt = new Date().toISOString();
    writeJson(file, merged);
    for (const key of Object.keys(goal)) delete goal[key];
    Object.assign(goal, merged);
    goalSnapshots.set(goal, structuredClone(merged));
  } finally {
    try { fs.closeSync(handle); } finally { fs.unlinkSync(lock); }
  }
}

export const DEFAULT_CONTROL = Object.freeze({ paused: false, stop: false, approval: null });
export function readControl(id) { return readJson(controlPath(id), { ...DEFAULT_CONTROL }); }
export function saveControl(id, control) { writeJson(controlPath(id), control); }

// The MCP server and the detached worker are separate processes. A plain
// read-modify-write of control.json can lose a pause issued while the worker is
// clearing an approval. Serialize control edits with a tiny advisory lock and
// merge inside it. Writes are short, so the retry window is deliberately small.
const controlLocks = new Map();
export function updateControl(id, patchOrUpdater) {
  assertGoalId(id);
  const previous = controlLocks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const file = controlPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const deadline = Date.now() + 5000;
    let handle;
    for (;;) {
      try { handle = fs.openSync(lock, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A crashed writer must not wedge every later control call.
        try {
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          if (age > 10000) { fs.unlinkSync(lock); continue; }
        } catch { /* another writer released it */ }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the control file lock.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    try {
      const current = readJson(file, { ...DEFAULT_CONTROL });
      const nextValue = typeof patchOrUpdater === 'function' ? patchOrUpdater(current) : { ...current, ...patchOrUpdater };
      writeJson(file, nextValue);
      return nextValue;
    } finally {
      try { fs.closeSync(handle); } catch { /* ignore */ }
      try { fs.unlinkSync(lock); } catch { /* ignore */ }
    }
  });
  controlLocks.set(id, next);
  next.finally(() => { if (controlLocks.get(id) === next) controlLocks.delete(id); }).catch(() => {});
  return next;
}

export function appendEvent(id, event) {
  const file = path.join(goalDir(id), 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const limit = 5 * 1024 * 1024;
  if (fs.existsSync(file) && fs.statSync(file).size >= limit) {
    for (let n = 3; n >= 1; n--) {
      const old = n === 1 ? file : `${file}.${n - 1}`;
      const dest = `${file}.${n}`;
      if (fs.existsSync(old)) fs.renameSync(old, dest);
    }
  }
  const message = ['harness_message', 'codex_message', 'human_message'].includes(event.type);
  fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), ...(message ? { messageId: randomUUID() } : {}), ...event }) + '\n');
}
