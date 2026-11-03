import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupStore } from '../src/group-store.mjs';
import { GroupPermissions } from '../src/group-permissions.mjs';
import { routeNative } from '../src/group-service.mjs';
import { looksLikeCommand, parseCommand, sameCommand } from '../src/approval-text.mjs';

const phrase = '拒绝 2026-10-20-837dba4d a8080bbe-e83a-47e9-bd8d-1ae358d7426d';
const malformed = text => [
  '**' + text + '&#x20;**\n', '**' + text + '&amp;#x20;**\n',
  '  **' + text + '**  \n', '__' + text + '__', '`' + text + '`',
  text + '&nbsp;', '&#32;**' + text + '**', text + '&#x20;',
];

test('wrapped approval attempts are detection-only, never normalized into authority', () => {
  for (const decision of ['批准', '拒绝']) for (const text of malformed(phrase.replace('拒绝', decision))) {
    assert.equal(looksLikeCommand(text), true, text);
    assert.equal(parseCommand(text), null, text);
    assert.equal(sameCommand(text, text), false, text);
  }
  assert.equal(parseCommand(phrase).decision, 'reject');
  assert.equal(parseCommand('**' + phrase + '**  \n').decision, 'reject');
  assert.equal(parseCommand('**' + phrase.replace('拒绝', '批准') + '**'), null);
  for (const text of ['补充：讨论审批格式', '说明：' + phrase, '> ' + phrase]) {
    assert.equal(looksLikeCommand(text), false);
  }
});

for (const adapter of ['codex', 'harness']) test(`${adapter}: malformed approval input never steers pending work`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-routing-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const group = store.create({ repo: dir, models: { codex: {}, harness: {} } });
  group.contexts = { codex: 'ct', harness: 'ht' }; group.worktrees = { codex: dir, harness: dir };
  group.harnessAdapterId = 'harness-desktop';
  const { request } = store.input(group.id, { content: 'original operation' });
  const delivery = { id: randomUUID(), groupId: group.id, requestId: request.id,
    member: adapter === 'codex' ? 'harness' : 'codex', revision: request.revision,
    phase: 'work', status: 'pending', nativeTurnId: 'operation' };
  request.status = 'active'; request.deliveryId = delivery.id;
  group.status = 'active'; group.activeRequestId = request.id;
  store.save(group); store.saveRequest(request); store.saveDelivery(delivery);
  const permissions = new GroupPermissions(store, { permissionSnapshot: async () => ({ seq: 10 }) });
  const abort = new AbortController();
  const pending = permissions.request(group, delivery, adapter === 'codex'
    ? { method: 'harness/tool', params: { callId: 'fixture', toolName: 'pwsh', arguments: { command: 'fixture' } } }
    : { method: 'item/commandExecution/requestApproval', params: { threadId: 'ct', turnId: 'operation', command: 'fixture' } }, abort.signal);
  t.after(() => abort.abort());
  await new Promise(setImmediate);
  const record = store.permissions(group.id).at(-1), originalInput = store.input.bind(store);
  const before = JSON.stringify({ request: store.request(request.id), delivery: store.delivery(delivery.id), permission: store.permission(record.id) });
  let inputs = 0, interrupts = 0;
  store.input = (...args) => { inputs++; return originalInput(...args); };
  const engine = { interrupt() { interrupts++; } };
  let seq = 0;
  const route = content => routeNative(store, engine, { adapter, sessionId: group.contexts[adapter],
    harnessAdapterId: 'harness-desktop', messageId: `fixture-${++seq}`, turnId: 'decision', content }, permissions);
  for (const text of [...malformed(record.rejectPhrase), ...malformed(record.allowPhrase)]) {
    const result = route(text);
    assert.equal(result.bound, true); assert.equal(result.block, true);
    assert.equal(result.approvalCandidate, undefined);
    assert.match(result.reason, /格式不合法/);
    assert.equal(JSON.stringify({ request: store.request(request.id), delivery: store.delivery(delivery.id), permission: store.permission(record.id) }), before);
    assert.equal(store.permissions(group.id).length, 1);
    assert.throws(() => originalInput(group.id, { content: text }), /审批指令/);
  }
  assert.equal(inputs, 0); assert.equal(interrupts, 0);
  assert.equal(route(record.rejectPhrase).approvalCandidate, true);
  assert.equal(route('**' + record.rejectPhrase + '**  \n').approvalCandidate, true);
  assert.equal(store.permission(record.id).status, 'pending');
  assert.equal(store.permission(record.id).proof, undefined);
  assert.equal(inputs, 0); assert.equal(interrupts, 0);
  abort.abort(); assert.equal(await pending, false);
  const terminal = JSON.stringify(store.permission(record.id));
  assert.equal(route(record.allowPhrase).approvalCandidate, undefined);
  assert.equal(route('**' + record.allowPhrase + '&#x20;**').approvalCandidate, undefined);
  assert.equal(JSON.stringify(store.permission(record.id)), terminal);
  route('补充：纠正当前需求');
  assert.equal(inputs, 1); assert.equal(interrupts, 1);
});
