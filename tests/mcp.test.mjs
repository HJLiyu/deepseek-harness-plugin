import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RpcProcess } from '../src/rpc.mjs';

test('MCP lists tools and executes status, events, pause, stop with boundary validation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-mcp-'));
  const id = '2026-10-18-b0000001';
  const dir = path.join(root, 'goals', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'goal.json'), JSON.stringify({ id, status: 'active', rounds: 0, repo: process.cwd(), harnessWorktree: process.cwd(), codexThreadId: 'active-thread', sidebar: { threadId: 'previous-thread', verified: true } }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"type":"probe"}\n{"torn":');
  const rpc = new RpcProcess(process.execPath, [path.resolve('server.mjs')], { env: { HARNESS_PLUGIN_DATA: root }, jsonrpc: true });
  const call = async (name, args) => rpc.request('tools/call', { name, arguments: { goalId: id, ...args } });
  const parse = result => JSON.parse(result.content[0].text);
  try {
    await rpc.request('initialize', { protocolVersion: '2025-03-26' });
    const { tools } = await rpc.request('tools/list');
    assert.equal(tools.length, 18);
    assert.equal(tools.find(x => x.name === 'collaboration_transcript').annotations.readOnlyHint, true);
    assert.equal(parse(await call('list_collaborations')).goals[0].id, id);
    assert.equal(parse(await call('collaboration_transcript')).total, 0);
    assert.ok(tools.find(x => x.name === 'organize_sidebar'));
    assert.ok(tools.find(x => x.name === 'adopt_codex_thread').inputSchema.required.includes('threadId'));
    assert.equal(tools.find(x => x.name === 'collaboration_status').annotations.readOnlyHint, true);
    assert.ok(tools.find(x => x.name === 'decide_harness_permission').inputSchema.required.includes('requestId'));
    const status = parse(await call('collaboration_status'));
    assert.equal(status.id, id);
    assert.equal(status.sidebar.verified, false);
    assert.equal(parse(await call('collaboration_events')).total, 1);
    assert.equal(parse(await call('pause_collaboration')).control.paused, true);
    assert.equal(parse(await call('stop_collaboration')).control.stop, true);
    assert.equal(parse(await call('resume_collaboration')).status, 'stopped');
    assert.equal((await call('adopt_codex_thread', { threadId: 'replacement' })).isError, true);
    assert.equal((await call('collaboration_status', { goalId: '../../outside' })).isError, true);
    assert.equal((await call('decide_harness_permission', { decision: 'allow', requestId: 'fake' })).isError, true);
  } finally { await rpc.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
