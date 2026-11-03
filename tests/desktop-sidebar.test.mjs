import test from 'node:test';
import assert from 'node:assert/strict';
import { organizeDesktopThread } from '../src/desktop.mjs';

test('desktop organization verifies visible membership instead of CLI section metadata', async () => {
  let moved = false, closed = false;
  const bridge = { async call(name, args) {
    if (name === 'list_threads') return { sections: [{ sectionId: 'visible', name: 'Codex × Harness', itemKeys: moved ? ['codex:thread:local:t'] : [] }] };
    if (name === 'move_thread_to_sidebar_section') { assert.equal(args.sectionId, 'visible'); moved = true; }
  }, close() { closed = true; } };
  const result = await organizeDesktopThread({ threadId: 't', title: 'title', bridge });
  assert.equal(result.verified, true); assert.equal(result.source, 'desktop-app'); assert.ok(closed);
});

test('desktop organization does not claim success when move is invisible', async () => {
  let closed = false;
  const bridge = { async call() { return { sections: [{ sectionId: 'visible', name: 'Codex × Harness', itemKeys: [] }] }; }, close() { closed = true; } };
  await assert.rejects(organizeDesktopThread({ threadId: 't', bridge }), /not visible/);
  assert.ok(closed);
});
