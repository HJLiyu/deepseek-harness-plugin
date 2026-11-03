import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupStore } from '../src/group-store.mjs';

test('historical pagination respects channel and shared messages', t => {
  const store = new GroupStore(':memory:');
  t.after(() => store.close());
  const group = store.create({ repo: process.cwd(), models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  const add = (channel, content) => store.message(group.id, { sender: 'human', channel, content });
  const a = add('group', 'group');
  add('collaboration', 'private collaboration');
  const shared = add('collaboration', 'shared');
  store.shareMessage(shared.id, 'group');
  const tail = add('group', 'tail');
  const forward = store.messages(group.id, { channel: 'group' }).messages;
  const last = store.messages(group.id, { channel: 'group', before: tail.seq, limit: 1 });
  const first = store.messages(group.id, { channel: 'group', before: last.previousCursor, limit: 10 });
  assert.deepEqual(forward.map(m => m.seq), [a.seq, shared.seq, tail.seq]);
  assert.deepEqual([...first.messages, ...last.messages].map(m => m.seq), [a.seq, shared.seq]);
  assert.equal(store.messages(group.id, { before: tail.seq }).messages.length, 3);
});
