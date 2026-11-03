import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GroupStore } from '../src/group-store.mjs';
import { GroupRuntime, codexSandboxForDelivery } from '../src/group-runtime.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { startGroupService } from '../src/group-service.mjs';
import { localFetch } from '../src/group-http.mjs';
import { RpcProcess } from '../src/rpc.mjs';
import { GroupPermissions } from '../src/group-permissions.mjs';

test('explicit read-only work and empty integration never demand write permissions', () => {
  const delivery=(phase,payload)=>({phase,prompt:JSON.stringify(payload)});
  for(const phase of ['planning','review'])assert.equal(codexSandboxForDelivery({phase}), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:'只读核对当前源码与证据，不修改文件'}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{readOnly:true,task:'Inspect current evidence'}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:'制定DeepSeek账号管理方案。本轮只读，不改文件、不建仓、不操作账号。'}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:'只读联网调研，不修改文件。'}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:'只读规划与方案分析'}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('integrate',{integrationSelection:{members:{codex:{},harness:{}}}})), 'read-only');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:'修复并验证源码'}})), 'workspace-write');
  assert.equal(codexSandboxForDelivery(delivery('integrate',{integrationSelection:{files:{'a.mjs':'hash'}}})), 'workspace-write');
  assert.equal(codexSandboxForDelivery(delivery('integrate',{})), 'workspace-write');
  assert.equal(codexSandboxForDelivery({phase:'work',prompt:'invalid'}), 'workspace-write');
  assert.equal(codexSandboxForDelivery(delivery('work',null)), 'workspace-write');
  assert.equal(codexSandboxForDelivery(delivery('work',{assignment:{task:123}})), 'workspace-write');
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 150; i++) { if (check()) return; await sleep(20); } assert.fail('Backend condition did not settle.'); }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-lifecycle-'));
  const store = new GroupStore(path.join(dir, 'groups.sqlite'));
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const create = () => {
    const g = store.create({ repo: dir, models: { codex: {}, harness: {} } });
    g.status = 'idle'; g.contexts = { codex: randomUUID(), harness: randomUUID() }; g.worktrees = { codex: dir, harness: dir };
    store.transaction(() => store.save(g)); return g;
  };
  return { store, create };
}
const proposal = { owner: 'none', integrator: 'codex', tasks: { codex: '', harness: '' }, review: false, summary: 'No work necessary.', message: 'Checked.' };

test('scheduler faults retain checkpoints and report maintenance ownership instead of asking the human to resume', async t => {
  const { store, create } = fixture(t), g = create();
  const {request} = store.input(g.id, {content:'preserve this work'});
  g.activeRequestId = request.id; g.status = 'active'; store.save(g);
  request.actions = [{phase:'work',member:'codex'}]; request.deliveryId = 'original-checkpoint'; store.saveRequest(request);
  store.saveDelivery({id:request.deliveryId,groupId:g.id,requestId:request.id,started:true,status:'unknown',member:'codex',phase:'work'});
  const service = await startGroupService({store,runtime:{},scheduleIntervalMs:20});
  let calls=0;
  service.engine.tick = async () => { calls++; throw Error('fixture internal failure'); };
  try {
    await until(()=>store.group(g.id).status==='paused');
    const page=await localFetch(service.descriptor,`/api/groups/${g.id}`);
    assert.equal(page.activity.workflow.owner,'maintenance');
    assert.equal(page.activity.workflow.kind,'maintenance');
    assert.equal(page.activity.needsUser,false);
    assert.match(page.activity.detail,/维护/);
    assert.doesNotMatch(page.activity.detail,/请.*(?:批准|重启|恢复)/);
    assert.equal(store.request(request.id).deliveryId,'original-checkpoint');
    assert.equal(store.delivery('original-checkpoint').status,'unknown');
    await sleep(70); assert.equal(calls,1,'internal fault must stop new admissions rather than loop');
    await localFetch(service.descriptor,`/api/groups/${g.id}/control`,{action:'pause'});
    const human=await localFetch(service.descriptor,`/api/groups/${g.id}`);
    assert.equal(human.activity.workflow.owner,'human');
    assert.equal(human.activity.workflow.kind,'paused');
    assert.equal(human.activity.workflow.needsUser,true);
  } finally {await service.close();}
});

test('an old scheduler failure cannot overwrite a newer explicit close', async t => {
  const {store,create}=fixture(t),g=create();store.input(g.id,{content:'queued'});
  const service=await startGroupService({store,runtime:{},scheduleIntervalMs:20});let reject;
  service.engine.tick=()=>new Promise((_resolve,no)=>{reject=no;});
  try {
    await until(()=>Boolean(reject));
    await localFetch(service.descriptor,`/api/groups/${g.id}/control`,{action:'close'});
    reject(Error('late old failure')); await sleep(50);
    assert.equal(store.group(g.id).status,'closed');
  } finally {reject?.(Error('cleanup'));await service.close();}
});

test('a group waiting for a native reply cannot block another group across scheduler cycles', async t => {
  const { store, create } = fixture(t), held = create(), other = create();
  store.input(held.id, { content: 'hold' }); store.input(other.id, { content: 'finish' });
  let release, heldCalls = 0, otherCalls = 0;
  const rt = { appOpen: async () => true, turn: async (g) => {
    if (g.id === held.id) { heldCalls++; await new Promise(resolve => { release = resolve; }); }
    else otherCalls++;
    return { text: JSON.stringify(proposal) };
  } };
  const service = await startGroupService({ store, runtime: rt, scheduleIntervalMs: 20 });
  try {
    await until(() => heldCalls === 1 && otherCalls >= 2);
    assert.equal(heldCalls, 1, 'same native context must not be scheduled twice');
    assert.equal(service.engine.running.has(held.id), true);
  } finally { release?.(); await service.close(); }
});

test('presence probes share one asynchronous operation, expire and distinguish failure from closure', async () => {
  let clock = 100, calls = 0, release;
  const rt = new GroupRuntime({}, { presenceNow: () => clock, presenceTtlMs: 20,
    presenceProbe: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = rt.appOpen(), second = rt.appOpen(); await Promise.resolve();
  assert.equal(calls, 1); release(false); assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await rt.appOpen(), false); assert.equal(calls, 1);
  clock += 21; rt.presenceProbe = async () => { calls++; throw Error('process query unavailable'); };
  assert.equal(await rt.appOpen(), null); assert.match(rt.presenceError, /unavailable/);
  clock += 21; rt.presenceProbe = async () => true;
  assert.equal(await rt.appOpen(), true); assert.equal(rt.presenceError, null);
});

test('a native heartbeat arriving during a negative process probe prevents a false closure', async () => {
  let release; const rt = new GroupRuntime({}, { presenceProbe: () => new Promise(resolve => { release = resolve; }) });
  const pending = rt.appOpen(); await Promise.resolve();
  rt.harnessAdapters.set('test', { appOpen: true, at: Date.now() }); release(false);
  assert.equal(await pending, true);
});

test('unknown presence does not admit work or label the group apps_closed', async t => {
  const { store, create } = fixture(t), g = create(); store.input(g.id, { content: 'work' });
  const engine = new GroupEngine(store, { appOpen: async () => null, turn: async () => assert.fail('must not admit') });
  await engine.tick(g.id); assert.notEqual(store.group(g.id).status, 'apps_closed'); assert.equal(engine.running.size, 0);
});

test('unknown lifecycle presence preserves a running operation; close waits for its cleanup and is idempotent', async t => {
  const { store, create } = fixture(t), g = create(); store.input(g.id, { content: 'hold' });
  let started, done, presence = true;
  const admitted = new Promise(resolve => { started = resolve; });
  const rt = { appOpen: async () => presence, turn: async (_g, _d, signal) => {
    started(); await new Promise(resolve => { done = resolve; signal.addEventListener('abort', resolve, { once: true }); });
    // Final native cleanup can still need the database after interruption.
    await sleep(40); assert.ok(store.group(g.id)); return { text: JSON.stringify(proposal) };
  } };
  const service = await startGroupService({ store, runtime: rt, scheduleIntervalMs: 20, lifecycleIntervalMs: 20 });
  try {
    await admitted; presence = null; await sleep(80);
    assert.equal(service.engine.running.has(g.id), true); assert.notEqual(store.group(g.id).status, 'apps_closed');
    const closing = service.close(); assert.equal(service.close(), closing); await closing;
    assert.equal(service.engine.inflight.size, 0); assert.equal(service.engine.running.size, 0);
  } finally { done?.(); await service.close(); }
});

test('recent polling preserves old active requests and pending approvals without discarding history', async t => {
  const { store, create } = fixture(t), g = create();
  const original = store.input(g.id, { content: 'active' }).request;
  store.transaction(() => { g.activeRequestId = original.id; g.status = 'active'; store.save(g); });
  store.savePermission({ id: 'old-pending', groupId: g.id, status: 'denied', member: 'codex' });
  for (let i = 0; i < 105; i++) {
    const r = store.input(g.id, { content: `queue ${i}`, mode: 'new' }).request;
    r.status = 'completed'; store.saveRequest(r);
    store.savePermission({ id: `finished-${i}`, groupId: g.id, status: 'denied' });
  }
  assert.equal(store.recentRequests(g.id).length, 100); assert.equal(store.requests(g.id).length, 106);
  assert.throws(() => store.recentRequests(g.id, -1), /Invalid/);
  const service = await startGroupService({ store, runtime: {}, schedule: false });
  try {
    store.savePermission({ id: 'old-pending', groupId: g.id, status: 'pending', member: 'codex' });
    const page = await localFetch(service.descriptor, `/api/groups/${g.id}`);
    assert.equal(page.requests[0].id, original.id); assert.equal(page.requests.length, 101);
    assert.equal(page.permissions[0].id, 'old-pending'); assert.equal(page.permissions.length, 51);
  } finally { await service.close(); }
});

test('RPC close rejects pending calls immediately and never admits subsequent requests', async () => {
  const rpc = new RpcProcess(process.execPath, ['-e', 'process.stdin.resume()']);
  const pending = assert.rejects(rpc.request('held', {}, 60000), /closed/);
  await rpc.close(); await pending; assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.request('after-close'), /closed/); await rpc.close();
});

test('definitive app closure interrupts a running operation and records apps_closed', async t => {
  const { store, create } = fixture(t), g = create(); store.input(g.id, { content: 'hold' });
  let presence = true, admitted, interrupted;
  const started = new Promise(resolve => { admitted = resolve; });
  const rt = { appOpen: async () => presence, turn: async (_g, _d, signal) => {
    admitted(); await new Promise(resolve => signal.addEventListener('abort', () => { interrupted = true; resolve(); }, { once: true }));
    return { text: JSON.stringify(proposal) };
  } };
  const service = await startGroupService({ store, runtime: rt, scheduleIntervalMs: 20, lifecycleIntervalMs: 20 });
  try { await started; presence = false; await until(() => interrupted); assert.equal(store.group(g.id).status, 'apps_closed'); }
  finally { await service.close(); }
});

test('an orphan pending permission cannot crash coordinator startup or acquire a resume grant', t => {
  const { store, create } = fixture(t), g = create();
  store.savePermission({ id: 'orphan', groupId: g.id, status: 'pending' });
  new GroupPermissions(store, {}).recoverAbandoned();
  assert.equal(store.permission('orphan').status, 'interrupted'); assert.equal(store.permission('orphan').resumeIntent, undefined);
});
