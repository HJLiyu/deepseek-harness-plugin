import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-message-contract-'));
process.env.HARNESS_PLUGIN_DATA = root;
const { saveGoal, appendEvent, goalDir } = await import('../src/state.mjs');
const { readTranscript } = await import('../src/messages.mjs');
const { listCollaborations } = await import('../src/catalog.mjs');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('canonical transcript retains verbatim speech, reply links and identity across rotation', () => {
  const id = '2026-10-19-b0000011';
  saveGoal({ id, status: 'round_limit', rounds: 1, maxRounds: 3, codexThreadId: 'current-thread' });
  const first = { type: 'harness_message', time: '2026-10-19T00:00:00Z', text: 'exact Harness text', threadId: 'old-thread', round: 0 };
  fs.writeFileSync(path.join(goalDir(id), 'events.jsonl.1'), JSON.stringify(first) + '\n{"torn":');
  appendEvent(id, { type: 'tool_call', text: 'forged', source: 'human' });
  appendEvent(id, { type: 'codex_message', text: 'exact Codex reply', threadId: 'current-thread', turnId: 'turn1', round: 1 });
  appendEvent(id, { type: 'human_message', text: 'human instruction', turnId: 'native-human' });
  appendEvent(id, { type: 'goal_status', status: 'round_limit', round: 1 });
  const all = readTranscript(id);
  assert.equal(all.total, 4);
  assert.deepEqual(all.messages.map(m => m.source), ['agent', 'agent', 'human', 'system']);
  assert.equal(all.messages[1].replyTo, all.messages[0].messageId);
  assert.equal(all.messages[0].content, 'exact Harness text');
  assert.equal(all.messages[0].threadId, 'old-thread');
  assert.equal(all.messages[1].turnId, 'turn1');
  assert.equal(all.messages[2].authorization, null);
  assert.equal(all.messages[3].stopReason, 'round_limit');
  assert.equal(all.stopReason, 'round_limit');
  const page = readTranscript(id, 1, 1);
  assert.equal(page.messages[0].messageId, all.messages[1].messageId);
  assert.equal(page.messages[0].replyTo, all.messages[0].messageId);
  assert.equal(page.nextOffset, 2);
  assert.equal(readTranscript(id).messages[0].messageId, all.messages[0].messageId);
});

test('goal listing restores from disk, filters and paginates without returning message bodies', () => {
  saveGoal({ id: '2026-10-19-b0000012', status: 'paused', pausedReason: 'error', codexThreadId: 'thread', updatedAt: 'ignored', codexText: 'DO-NOT-LIST', pendingHarness: { text: 'DO-NOT-LIST' } });
  const broken = path.join(root, 'goals', '2026-10-19-b0000013');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'goal.json'), '{broken');
  fs.mkdirSync(path.join(root, 'goals', 'not-a-goal'));
  const listed = listCollaborations({ status: 'paused', limit: 1 });
  assert.equal(listed.total, 1);
  assert.equal(listed.goals[0].stopReason, 'error');
  assert.equal(listed.goals[0].pendingHarness, true);
  assert.equal(listed.warningCount, 1);
  assert.doesNotMatch(JSON.stringify(listed), /DO-NOT-LIST/);
  assert.equal(listCollaborations({ limit: 1 }).nextOffset, 1);
  assert.throws(() => readTranscript('../../outside'), /Invalid goal ID/);
  assert.throws(() => readTranscript('2026-10-19-00000000'), /Unknown goal/);
});
