import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-flow-'));
process.env.HARNESS_PLUGIN_DATA = root;
const { saveGoal, readGoal, updateControl, readControl, goalDir } = await import('../src/state.mjs');
const { runGoal, setControl, decidePermission, adoptCodexThread, goalStatus } = await import('../src/orchestrator.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function seed(id, extra = {}) {
  saveGoal({ id, repo: process.cwd(), harnessWorktree: process.cwd(), codexThreadId: 'test-thread', status: 'active', rounds: 0, maxRounds: 1, objective: 'test collaboration', codexText: 'initial', seenUserTurnIds: [], ...extra });
}
const deps = { userTurns: async () => [], isDesktopOpen: () => true, delay: async () => {} };

test('real native human intervention is recorded separately before automatic turns pause', async () => {
  const id = '2026-10-19-a0000098'; seed(id);
  const result = await runGoal(id, { ...deps,
    userTurns: async () => [{ turnId: 'real-human-turn', text: 'Review the small patch first.' }],
    harness: async () => { assert.fail('must pause before Harness'); },
    delay: async () => { await updateControl(id, { stop: true }); },
  });
  assert.equal(result.status, 'stopped');
  const events = fs.readFileSync(path.join(goalDir(id), 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const message = events.find(e => e.type === 'human_message');
  assert.equal(message.turnId, 'real-human-turn');
  assert.equal(message.threadId, 'test-thread');
  assert.ok(message.messageId);
});

test('inline status recognizes another host holding the goal lock, but not its own idle host', async () => {
  const id = '2026-10-19-a0000099'; seed(id);
  const old = process.env.HARNESS_INLINE_WORKER;
  process.env.HARNESS_INLINE_WORKER = '1';
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    fs.writeFileSync(path.join(goalDir(id), 'worker.lock'), String(child.pid));
    assert.equal(goalStatus(id).workerAlive, true);
    fs.writeFileSync(path.join(goalDir(id), 'worker.lock'), String(process.pid));
    assert.equal(goalStatus(id).workerAlive, false);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    if (old === undefined) delete process.env.HARNESS_INLINE_WORKER; else process.env.HARNESS_INLINE_WORKER = old;
  }
});

test('pause after Harness preserves its reply and resumes with exactly one Codex delivery', async () => {
  const id = '2026-10-18-a0000001'; seed(id);
  let harnessCalls = 0, codexCalls = 0, paused = false;
  const result = await runGoal(id, { ...deps,
    harness: async () => { harnessCalls++; await updateControl(id, { paused: true }); return { text: 'durable reply', sessionId: 'session', toolEvents: [] }; },
    codex: async ({ prompt }) => { codexCalls++; assert.match(prompt, /durable reply/); return { text: 'reviewed', settings: { sandbox: 'workspace-write' } }; },
    delay: async () => { if (readControl(id).paused) { paused = true; assert.equal(readGoal(id).pendingHarness.text, 'durable reply'); await updateControl(id, { paused: false }); } },
  });
  assert.equal(paused, true); assert.equal(harnessCalls, 1); assert.equal(codexCalls, 1);
  assert.equal(result.status, 'round_limit'); assert.equal(readGoal(id).pendingHarness, null);
});

test('Codex reply becomes the next Harness input in the orchestrated round trip', async () => {
  const id = '2026-10-18-a0000002'; seed(id, { maxRounds: 2 });
  const prompts = [];
  await runGoal(id, { ...deps,
    harness: async (goal, prompt) => { prompts.push(prompt); return { text: 'Harness response', sessionId: 'session', toolEvents: [] }; },
    codex: async () => ({ text: 'CODEX-REVIEW-NONCE', settings: { sandbox: 'workspace-write' } }),
  });
  assert.equal(prompts.length, 2); assert.match(prompts[1], /CODEX-REVIEW-NONCE/); assert.equal(readGoal(id).rounds, 2);
});

test('failed Codex delivery preserves Harness checkpoint for retry', async () => {
  const id = '2026-10-18-a0000003'; seed(id);
  const result = await runGoal(id, { ...deps,
    harness: async () => ({ text: 'keep this', sessionId: 'session', toolEvents: [] }),
    codex: async () => { throw new Error('transport timeout'); },
  });
  assert.equal(result.status, 'paused'); assert.equal(readControl(id).paused, true);
  assert.equal(readGoal(id).pendingHarness.text, 'keep this');
  assert.equal(fs.existsSync(path.join(goalDir(id), 'worker.lock')), false);
});

test('terminal controls never restart a completed or stopped goal', async () => {
  for (const [id, status] of [['2026-10-18-a0000004', 'completed'], ['2026-10-18-a0000005', 'stopped']]) {
    seed(id, { status }); await setControl(id, { paused: false });
    assert.equal(readGoal(id).status, status);
  }
});

test('stale MCP or CLI decisions cannot queue an approval', async () => {
  const id = '2026-10-18-a0000006';
  seed(id, { pendingApproval: { requestId: 'current', codexThreadId: 'test-thread', userTurnIdsBeforeRequest: [] } });
  await assert.rejects(decidePermission(id, 'allow', 'old', { userTurns: async () => [] }), /Stale/);
  await assert.rejects(decidePermission(id, 'allow', 'current', { userTurns: async () => [] }), /human/);
  assert.equal(readControl(id).approval, null);
});

test('a verified approval turn is queued with its native turn identity', async () => {
  const id = '2026-10-18-a0000008';
  seed(id, { pendingApproval: { requestId: 'request', codexThreadId: 'test-thread', userTurnIdsBeforeRequest: ['old'] } });
  await decidePermission(id, 'allow', 'request', { userTurns: async () => [
    { turnId: 'old', text: 'anything' },
    { turnId: 'approved-turn', text: `批准 ${id} request` },
  ] });
  assert.deepEqual(readControl(id).approval, { decision: 'allow', requestId: 'request', source: 'human-message', turnId: 'approved-turn', threadId: 'test-thread' });
});

test('a thread change during human-message verification cannot queue an approval', async () => {
  const id = '2026-10-18-a0000009';
  seed(id, { pendingApproval: { requestId: 'request', codexThreadId: 'test-thread', userTurnIdsBeforeRequest: [] } });
  await assert.rejects(decidePermission(id, 'allow', 'request', { userTurns: async () => {
    const goal = readGoal(id); goal.codexThreadId = 'other-thread'; saveGoal(goal);
    return [{ turnId: 'approval', text: `批准 ${id} request` }];
  } }), /thread/i);
  assert.equal(readControl(id).approval, null);
});

test('thread adoption requires a paused checkpoint with no pending work or approval', async () => {
  for (const [suffix, extra] of [
    ['a', { status: 'active' }],
    ['b', { status: 'paused', pendingApproval: { requestId: 'request' } }],
    ['c', { status: 'paused', pendingHarness: { text: 'keep checkpoint' } }],
  ]) {
    const id = `2026-10-18-a000001${suffix}`; seed(id, extra);
    await updateControl(id, { paused: true });
    await assert.rejects(adoptCodexThread(id, 'replacement', { userTurns: async () => assert.fail('must reject before RPC') }), /paused|pending/i);
    assert.equal(readGoal(id).codexThreadId, 'test-thread');
  }
});

test('thread adoption binds seen messages and sidebar to the replacement in one save', async () => {
  const id = '2026-10-18-a000001d'; seed(id, { status: 'paused', sidebar: { verified: true }, codexComplete: true });
  await updateControl(id, { paused: true });
  const result = await adoptCodexThread(id, 'replacement', {
    userTurns: async ({ threadId }) => { assert.equal(threadId, 'replacement'); return [{ turnId: 'existing', text: 'old input' }]; },
    organize: async () => ({ section: { id: 'section', name: 'Codex × Harness' }, created: false, verified: true }),
  });
  const goal = readGoal(id);
  assert.equal(result.threadId, 'replacement');
  assert.equal(goal.codexThreadId, 'replacement');
  assert.deepEqual(goal.seenUserTurnIds, ['existing']);
  assert.equal(goal.sidebar.threadId, 'replacement');
  assert.equal(goal.sidebar.verified, true);
  assert.equal(goal.codexComplete, false);
  assert.equal(goal.status, 'paused');
  assert.equal(readControl(id).paused, true);
  assert.match(fs.readFileSync(path.join(goalDir(id), 'events.jsonl'), 'utf8'), /codex_thread_adopted/);
});

test('thread adoption rejects a goal changed while native state is being inspected', async () => {
  const id = '2026-10-18-a000001e'; seed(id, { status: 'paused' });
  await updateControl(id, { paused: true });
  await assert.rejects(adoptCodexThread(id, 'replacement', {
    userTurns: async () => [],
    organize: async () => { const goal = readGoal(id); goal.rounds++; saveGoal(goal); return { verified: true }; },
  }), /changed|conflict/i);
  assert.equal(readGoal(id).codexThreadId, 'test-thread');
  assert.equal(readGoal(id).rounds, 1);
});

test('normal approval polling records the bound native thread and consumes the phrase', async () => {
  const id = '2026-10-18-a000001f'; seed(id);
  let noticeSent = false;
  const phrase = { turnId: 'approval-turn', text: `批准 ${id} request` };
  const result = await runGoal(id, { ...deps,
    userTurns: async () => noticeSent ? [phrase] : [],
    harness: async (goal, prompt, { onPermission }) => {
      const response = await onPermission({ requestId: 'request', options: [{ optionId: 'once', kind: 'allow_once' }] });
      assert.equal(response.outcome.optionId, 'once');
      return { text: 'probe done', sessionId: 'session', toolEvents: [] };
    },
    codex: async ({ prompt }) => { if (prompt.startsWith('[Plugin status]')) noticeSent = true; return { text: 'reviewed' }; },
  });
  assert.equal(result.status, 'round_limit');
  assert.ok(readGoal(id).seenUserTurnIds.includes(phrase.turnId));
  const events = fs.readFileSync(path.join(goalDir(id), 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.find(x => x.type === 'permission_decision_queued').threadId, 'test-thread');
  assert.equal(events.find(x => x.type === 'approval_resolved').threadId, 'test-thread');
});

test('an in-flight permission is cancelled when its originating thread changes', async () => {
  const id = '2026-10-18-a0000020'; seed(id);
  await runGoal(id, { ...deps,
    harness: async (goal, prompt, { onPermission }) => {
      const response = await onPermission({ requestId: 'request', options: [{ optionId: 'once', kind: 'allow_once' }] });
      assert.equal(response.outcome.outcome, 'cancelled');
      throw new Error('cancelled probe');
    },
    codex: async () => { const goal = readGoal(id); goal.codexThreadId = 'replacement'; saveGoal(goal); return { text: 'notice' }; },
  });
  assert.equal(readGoal(id).codexThreadId, 'replacement');
  assert.equal(readGoal(id).pendingApproval, null);
  assert.equal(readControl(id).approval, null);
  assert.match(fs.readFileSync(path.join(goalDir(id), 'events.jsonl'), 'utf8'), /permission request or thread changed/);
});

test('a queued decision from another thread cannot resolve the permission', async () => {
  const id = '2026-10-18-a0000021'; seed(id);
  const result = await runGoal(id, { ...deps,
    harness: async (goal, prompt, { onPermission }) => {
      const response = await onPermission({ requestId: 'request', options: [{ optionId: 'once', kind: 'allow_once' }] });
      assert.equal(response.outcome.outcome, 'cancelled');
      return { text: 'cancelled', sessionId: 'session', toolEvents: [] };
    },
    codex: async () => { await updateControl(id, { approval: { decision: 'allow', source: 'human-message', requestId: 'request', threadId: 'other-thread', turnId: 'foreign' } }); return { text: 'notice' }; },
    delay: async () => { await updateControl(id, { stop: true }); },
  });
  assert.equal(result.status, 'stopped');
  const events = fs.readFileSync(path.join(goalDir(id), 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(x => x.type === 'approval_ignored'));
  assert.equal(events.some(x => x.type === 'approval_resolved' && x.decision === 'allow'), false);
});

test('completion requires an actual return of a Codex reply to Harness', async () => {
  const id = '2026-10-18-a0000007'; seed(id, { maxRounds: 2 });
  let calls = 0;
  const complete = 'STATUS: COMPLETE\nVERIFICATION: verified';
  const result = await runGoal(id, { ...deps,
    harness: async (goal, prompt) => { calls++; if (calls === 2) assert.match(prompt, /VERIFICATION: verified/); return { text: complete, sessionId: 'session', toolEvents: [] }; },
    codex: async () => ({ text: complete, settings: { sandbox: 'workspace-write' } }),
  });
  assert.equal(calls, 2); assert.equal(result.status, 'completed'); assert.equal(result.rounds, 2);
});
