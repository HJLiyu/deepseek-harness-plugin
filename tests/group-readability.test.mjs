import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';

test('readability guidance reaches reused contexts in every phase without losing protocol or safety instructions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-readable-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const group = store.create({ repo: dir, models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  group.initialized = { codex: true, harness: true }; store.save(group);
  const { request } = store.input(group.id, { content: '回复要保证可读性', origin: { adapter: 'test', sessionId: 's', messageId: 'm' } });
  const engine = new GroupEngine(store, {});
  for (const phase of ['planning', 'work', 'review', 'integrate']) {
    request.actions = [{ phase, member: 'codex' }];
    const payload = JSON.parse(engine.prompt(group, request, 'codex', phase).text);
    assert.equal(payload.requirement, '回复要保证可读性');
    assert.match(payload.instruction, /先用一句话说结论/);
    assert.match(payload.instruction, /你现在不需要操作/);
    assert.match(payload.instruction, /需要真人回话、选择、批准或操作应用都算需要操作/);
    assert.match(payload.instruction, /首先列“补充／纠正当前需求”/);
    assert.match(payload.instruction, /具体步骤、对象与原因/);
    assert.match(payload.instruction, /放 verification/);
    assert.match(payload.instruction, /既定 JSON 协议/);
    if (phase !== 'planning') assert.match(payload.instruction, /无法.*blocked/);
    if (phase === 'planning') assert.match(payload.instruction, /startPhase/);
    if (phase === 'review') assert.match(payload.instruction, /只读复核/);
    if (phase === 'integrate') assert.match(payload.instruction, /不要覆盖未提交修改/);
  }
  for (const action of [{ phase: 'review', member: 'codex', goalAudit: true },
    { phase: 'review', member: 'codex', diagnostic: { reason: 'main_conflict' } }]) {
    request.actions = [action];
    const payload = JSON.parse(engine.prompt(group, request, 'codex', 'review').text);
    assert.match(payload.instruction, /你现在不需要操作/);
    assert.match(payload.instruction, /需要真人回话、选择、批准或操作应用都算需要操作/);
    assert.match(payload.instruction, /首先列“补充／纠正当前需求”/);
    assert.match(payload.instruction, action.goalAudit ? /completionChecklist/ : /不要改文件/);
  }
});
