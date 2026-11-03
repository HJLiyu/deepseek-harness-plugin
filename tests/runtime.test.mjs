import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpcProcess } from '../src/rpc.mjs';
import { codexTurn, codexOrganizeThread, normalizeSandbox } from '../src/codex.mjs';
import { assertHumanDecision } from '../src/permissions.mjs';

test('removed parent ACP session identity stays absent in the RPC child', async () => {
  const old = process.env.DSH_SESSION_ID;
  process.env.DSH_SESSION_ID = 'parent-session';
  const rpc = new RpcProcess(process.execPath, ['-e', `require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);console.log(JSON.stringify({id:m.id,result:process.env.DSH_SESSION_ID??null}))})`], { env: { DSH_SESSION_ID: undefined } });
  try { assert.equal(await rpc.request('env', {}, 5000), null); }
  finally { await rpc.close(); if (old === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = old; }
});

test('spawn failure rejects RPC requests without crashing the host', async () => {
  const rpc = new RpcProcess(path.join(os.tmpdir(), 'nonexistent-plugin-test-executable'), []);
  try { await assert.rejects(rpc.request('ping', {}, 5000), /failed to start/); }
  finally { await rpc.close(); }
});

test('permission decisions require a fresh human phrase for the exact request', () => {
  const id = '2026-10-18-abcdef12';
  const pending = { requestId: 'session:7:nonce', userTurnIdsBeforeRequest: ['old'] };
  const text = `批准 ${id} ${pending.requestId}`;
  for (const turns of [[], [{ turnId: 'old', text }], [{ turnId: 'agent', text: `[DeepSeek Harness] ${text}` }], [{ turnId: 'new', text: `批准 ${id}` }]]) {
    assert.throws(() => assertHumanDecision(id, pending, 'allow', pending.requestId, turns), /human/);
  }
  assert.throws(() => assertHumanDecision(id, pending, 'allow', 'previous-request', [{ turnId: 'new', text }]), /Stale/);
  assertHumanDecision(id, pending, 'allow', pending.requestId, [{ turnId: 'new', text }]);
});

test('resume and turn both specify the workspace boundary and normalize settings', async () => {
  const calls = [];
  const result = await codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'probe', rpcFactory: (cwd, handlers) => ({
    notify() {}, async close() {}, async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') return { sandbox: { type: 'workspaceWrite' }, approvalPolicy: 'never' };
      if (method === 'turn/start') {
        handlers.onNotification('item/completed', { item: { type: 'agentMessage', text: 'READY' } });
        handlers.onNotification('turn/completed', { turn: { id: 'turn', status: 'completed' } });
        return { turn: { id: 'turn' } };
      }
      return {};
    },
  }) });
  assert.equal(result.settings.sandbox, 'workspace-write');
  assert.equal(result.text, 'READY');
  assert.ok(calls.some(x => x.method === 'thread/unarchive'));
  assert.ok(calls.findIndex(x => x.method === 'thread/unarchive') < calls.findIndex(x => x.method === 'thread/resume'), 'archived collaboration threads are restored before resume');
  assert.equal(calls.find(x => x.method === 'thread/resume').params.sandbox, 'workspace-write');
  assert.deepEqual(calls.find(x => x.method === 'turn/start').params.sandboxPolicy.writableRoots, [process.cwd()]);
  assert.equal(normalizeSandbox(result.settings.sandbox), 'workspace-write');
});

test('native sidebar organization reuses the section and verifies persistence', async () => {
  let moved = false, name;
  const calls = [];
  const section = { id: 'section', name: 'Codex × Harness' };
  const result = await codexOrganizeThread({ threadId: 'thread', cwd: process.cwd(), title: 'writer · Codex', rpcFactory: () => ({
    notify() {}, async close() {}, async request(method, params) {
      calls.push(method);
      if (method === 'thread/resume') return { thread: {}, sandbox: { type: 'workspaceWrite' } };
      if (method === 'threadSection/list') return { data: [section] };
      if (method === 'threadSection/create') assert.fail('duplicate section');
      if (method === 'thread/section/move') { moved = true; return {}; }
      if (method === 'thread/name/set') { assert.equal(params.threadId, 'thread'); name = params.name; return {}; }
      if (method === 'thread/read') return { thread: { name, section: moved ? section : null } };
      return {};
    },
  }) });
  assert.equal(result.verified, true);
  assert.equal(result.created, false);
  assert.equal(name, 'writer · Codex');
  assert.ok(calls.indexOf('thread/unarchive') >= 0);
  assert.ok(calls.indexOf('thread/unarchive') < calls.indexOf('thread/resume'));
});

test('Codex permission RPC grants only explicit one-shot approval and fails closed on cancellation or unsupported requests', async () => {
  for (const scenario of ['allow', 'reject', 'object', 'throw', 'aborted', 'unsupported', 'not-offered']) {
    const controller = new AbortController(); let decision, asked = 0;
    await codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'fixed operation', approvalPolicy: 'on-request', signal: controller.signal,
      onApproval: async () => { asked++; if (scenario === 'throw') throw Error('approval unavailable'); if (scenario === 'aborted') controller.abort(); return scenario === 'object' ? { allow: true } : scenario === 'allow' || scenario === 'aborted'; },
      rpcFactory: (cwd, handlers) => ({ notify() {}, close: async () => {}, async request(method) {
        if (method === 'turn/start') {
          decision = await handlers.onRequest(scenario === 'unsupported' ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval', { threadId: 'thread', turnId: 'turn', ...(scenario === 'not-offered' ? { availableDecisions: ['decline'] } : {}) });
          handlers.onNotification('item/completed', { item: { type: 'agentMessage', text: 'READY' } });
          handlers.onNotification('turn/completed', { turn: { id: 'turn', status: 'completed' } });
          return { turn: { id: 'turn' } };
        }
        return {};
      } }),
    });
    assert.deepEqual(decision, { decision: scenario === 'allow' ? 'accept' : 'decline' }, scenario);
    assert.equal(asked, ['unsupported', 'not-offered'].includes(scenario) ? 0 : 1);
  }
});

test('Codex live deltas expose only current public agent messages and never reasoning',async()=>{
 let handlers;const previews=[];
 const result=await codexTurn({threadId:'thread',cwd:process.cwd(),prompt:'probe',onAnswer:text=>previews.push(text),rpcFactory:(_cwd,h)=>{handlers=h;return {notify(){},async close(){},async request(method){
   if(method==='turn/start'){setImmediate(()=>{
     h.onNotification('item/started',{item:{id:'thinking',type:'reasoning',phase:'analysis'}});
     h.onNotification('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'thinking',delta:'SECRET'});
     h.onNotification('item/started',{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',phase:'final_answer'}});
     h.onNotification('item/agentMessage/delta',{threadId:'other',turnId:'turn',itemId:'answer',delta:'WRONG'});
     h.onNotification('item/agentMessage/delta',{threadId:'thread',turnId:'turn',itemId:'answer',delta:'{"message":"正在生成'});
     h.onNotification('item/completed',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'{"message":"完成"}'}});
     h.onNotification('turn/completed',{turn:{id:'turn',status:'completed'}});
   });return {turn:{id:'turn'}}}return {};
 }}}});
 assert.deepEqual(previews,['正在生成']);assert.equal(result.text,'{"message":"完成"}');
});
