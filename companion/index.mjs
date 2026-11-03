import {configureIdleEffort,harnessEffortReceipt} from './effort.mjs';
import { harnessAnswer } from './bridge-progress.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readBody, sendJson, localFetch, equalSecret, cancellationSource } from './bridge-http.mjs';
import { probeShell } from './shell-probe.mjs';
import { nativeHumanProof, nativeToolCall } from './human-proof.mjs';
import { installGroupEncoding, createShellTrace } from './pwsh-encoding.mjs';
import { createOwnedPipeCompat } from './pipe-compat.mjs';
import { fileURLToPath } from 'node:url';
import { companionBuildHash } from './build.mjs';

// Capture at module evaluation: re-applying a cached module must never claim
// that code newly written to disk has actually been loaded by the host.
export const loadedBuildHash = companionBuildHash(fileURLToPath(new URL('./', import.meta.url)));

export const name = 'codex-group';
export const inject = ['webServer', 'sessionController', 'permissionPresets', 'agents', 'shell', 'sandboxPolicy', 'sandbox'];
const textOf = message => (message?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
export function deliveryPermissionPreset(delivery){
  if(['planning','review'].includes(delivery.phase))return 'read-only';
  if(delivery.phase==='work')try{
    const p=JSON.parse(delivery.prompt);
    if(p.assignment?.readOnly===true||p.currentTask?.assignment?.readOnly===true)return 'read-only';
  }catch{/* Legacy work keeps its existing workspace boundary. */}
  return 'workspace-write';
}
export function activeHarnessTurn(events,deliveryId){
  let start=null;
  for(const event of events){
    if(event.type==='turn/start')start=event;
    const source=event.data?.source;
    const ours=source?.kind==='plugin'&&source.plugin==='codex-group'||source?.kind==='user'&&source.rpcId===`group-${deliveryId}`;
    if(event.type==='user/message'&&ours&&textOf(event.data).startsWith(`[Group delivery ${deliveryId}]\n`)){
      const turn=start?.data?.turn;
      return Number.isSafeInteger(turn)&&Number.isSafeInteger(start.seq)&&Number.isSafeInteger(event.seq)&&
        !events.some(e=>e.type==='turn/end'&&e.data?.turn===turn)?{turn,startSeq:start.seq,userSeq:event.seq}:null;
    }
  }
  return null;
}
export async function waitHarnessReply(agent,inspect,deliveryId,{delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=Date.now,startupMs=10000,timeoutMs=30*60*1000}={}){
  const started=now();
  for(;;){
    await agent.whenIdle();
    await agent.ctx.parallel('session/flush',agent.session);
    const events=await inspect(),result=recoveredHarnessResult(events,deliveryId);
    if(result)return result;
    const marker=`[Group delivery ${deliveryId}]\n`;
    const queued=[...agent.inbox.nextStep,...agent.inbox.nextTurn].some(m=>textOf(m).startsWith(marker));
    const active=agent.status==='running'||queued||activeHarnessTurn(events,deliveryId);
    if(now()-started>=timeoutMs||!active&&now()-started>=startupMs)return null;
    // prompt(queue) can resolve before the host leaves idle. Waiting for a
    // bound terminal event, rather than one idle edge, closes that race.
    await delay(100);
  }
}
export function recoveredHarnessResult(events, deliveryId) {
  const marker = `[Group delivery ${deliveryId}]\n`;
  let turn = null, claimedTurn = null;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    const source = event.data?.source;
    const ours = source?.kind === 'plugin' && source.plugin === 'codex-group' || source?.kind === 'user' && source.rpcId === `group-${deliveryId}`;
    if (event.type === 'user/message' && ours && textOf(event.data).startsWith(marker)) { claimedTurn = turn; break; }
  }
  if (claimedTurn === null) return null;
  const end = events.find(e => e.type === 'turn/end' && e.data.turn === claimedTurn);
  if (!end) return null;
  const responses = events.filter(e => e.type === 'assistant/message' && e.data.turn === claimedTurn && !e.data.interrupted);
  const text = responses.map(e => textOf(e.data.message)).filter(Boolean).at(-1);
  if (end.data.reason?.kind !== 'completed') return { text: text || `Harness turn 已${end.data.reason?.kind}；续跑前检查文件和命令现场。`, usage: null, interrupted: true };
  if (!text) return { terminalNoReply: true, proof: { deliveryId, turn: claimedTurn, endSeq: end.seq, reason: 'completed' } };
  const usages = responses.map(e => e.data.usage);
  const usage = usages.every(u => Number.isSafeInteger(u?.totalTokens)) ? { totalTokens: usages.reduce((n, u) => n + u.totalTokens, 0) } : null;
  return { text, usage, recovered: true, proof: { deliveryId, turn: claimedTurn, endSeq: end.seq, reason: 'completed' } };
}
export async function apply(ctx, config = {}) {
  const buildHash = loadedBuildHash;
  const instanceStartedAt = Date.now(), instanceId = randomUUID();
  const descriptorFile = config.descriptorFile ?? path.join(os.homedir(), '.codex', 'deepseek-harness-plugin-data', 'group-service.json');
  const adapterId = config.adapterId ?? (process.versions.electron ? 'harness-desktop' : 'harness-web');
  if (!/^[a-z0-9-]{1,80}$/.test(adapterId)) throw new Error('Invalid stable Harness profile ID.');
  const bindingsFile = path.join(path.dirname(descriptorFile), 'group-bindings.json');
  let descriptor, bindings = fs.existsSync(bindingsFile) ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8')).bindings : [], adapterOrigin, uiSeenAt = 0, starting = false;
  const secret = randomBytes(32).toString('hex');
  const busy = new Set();
  const syncedTitles = new Map();
  const deliveries = new Map(), pendingPermissions = new Map();
  // Bounded, metadata-only receipt: an unavailable relay must not silently
  // look like a human rejection or leave the coordinator waiting forever.
  const permissionRelays = new Map();
  const binding = sessionId => bindings.find(b => b.contexts.harness === sessionId && b.harnessAdapterId === adapterId);
  const possibleBinding = sessionId => bindings.find(b => b.contexts.harness === sessionId);
  const shellTrace = createShellTrace({ buildHash, instanceId });
  const pipeCompat = createOwnedPipeCompat({ isBound: sessionId => Boolean(binding(sessionId)) });
  const encoding = installGroupEncoding(ctx.shell, sessionId => Boolean(binding(sessionId)), undefined,
    { observe: shellTrace.observe, transformWorkspaceArgv: pipeCompat.transform });
  ctx.effect(() => () => encoding.dispose());
  async function connect() {
    try {
      descriptor = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'));
      const health = await localFetch(descriptor, '/api/health');
      if (health.protocol !== 'codex-harness-group/v2') { const error = new Error('旧群后台缺少 profile 固定与安全更新协议；请先关闭旧后台，再重新加载适配器。'); error.code = 'GROUP_OLD_SERVICE'; throw error; }
      const registered = await localFetch(descriptor, '/api/harness/register', { url: adapterOrigin, token: secret, adapterId, buildHash, instanceStartedAt, instanceId, protocol: 'codex-harness-group/v2', features: ['human-proof-v1', 'confined-shell-probe-v1', 'module-build-receipt-v1'], appOpen: Date.now() - uiSeenAt < 20000 });
      if (registered.accepted === false) return;
    } catch (error) {
      if (error.code !== 'GROUP_OLD_SERVICE' && config.serviceWorker && !starting) {
        starting = true;
        const child = spawn(process.execPath, [config.serviceWorker], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HARNESS_PLUGIN_DATA: path.dirname(descriptorFile) } });
        child.on('error', () => {}); child.unref(); setTimeout(() => { starting = false; }, 15000).unref();
      }
      throw error;
    }
    bindings = (await localFetch(descriptor, '/api/bindings')).bindings;
    for (const b of bindings) {
      const sessionId = b.contexts.harness;
      if (b.harnessAdapterId !== adapterId || !sessionId || typeof b.title !== 'string' || !b.title.trim() || syncedTitles.get(sessionId) === b.title) continue;
      try {
        const accepted = await ctx.sessionController.rename({ sessionId, title: b.title });
        if (accepted?.title !== b.title) throw Error('Host did not confirm session title');
        syncedTitles.set(sessionId, b.title);
      } catch (error) { ctx.logger?.warn?.(`Group session title sync: ${String(error.message).slice(0, 300)}`); }
    }
  }
  async function agentFor(sessionId) {
    if (!binding(sessionId)) { await connect(); if (!binding(sessionId)) throw new Error('Session is not bound to a group.'); }
    const result = await ctx.sessionController.resolveAgent(sessionId);
    if (result.error) throw new Error(result.error.message ?? JSON.stringify(result.error)); return result.agent;
  }
  const inspect = async sessionId => (await ctx.sessionController.inspect(sessionId)).events;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(adapterOrigin).host || req.headers.origin || !equalSecret(req.headers.authorization, `Bearer ${secret}`)) return sendJson(res, 403, { error: 'Adapter authentication required.' });
      const input = await readBody(req);
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST required.' });
      if (req.url === '/catalog') return sendJson(res, 200, await ctx.sessionController.modelCatalog());
      if (req.url === '/shell-trace') {
        if (!binding(input.sessionId)) throw Error('Session is not bound to this adapter.');
        if (!['enable', 'read', 'disable'].includes(input.action)) throw Error('Invalid shell trace action.');
        const result = input.action === 'enable' ? shellTrace.enable(input.sessionId)
          : input.action === 'disable' ? shellTrace.disable(input.sessionId) : shellTrace.snapshot(input.sessionId);
        return sendJson(res, 200, { ...result, hookCurrent: encoding.isCurrent?.() === true,
          hookInspection: encoding.inspect?.() ?? { installed: encoding.state.installed, methodType: typeof ctx.shell?.argv }, adapterId });
      }
      if (req.url === '/create') {
        const result = await ctx.sessionController.create({ cwd: input.cwd });
        bindings.push({ groupId: input.groupId, contexts: { harness: result.sessionId }, harnessAdapterId: adapterId });
        const { agent } = await ctx.sessionController.resolveAgent(result.sessionId);
        if (!agent) throw new Error('Could not resolve the dedicated Harness session.');
        ctx.permissionPresets.set(agent.session, 'read-only');
        await ctx.sessionController.selectModel({ sessionId: result.sessionId, provider: input.model.provider, model: input.model.model,
          ...(input.model.effort ? { reasoningEffort: input.model.effort } : {}) });
        const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 100) : `Codex × Harness · ${input.groupId}`;
        const accepted = await ctx.sessionController.rename({ sessionId: result.sessionId, title });
        if (accepted?.title === title) syncedTitles.set(result.sessionId, title);
        return sendJson(res, 200, result);
      }
      if (req.url === '/diagnostics') {
        const bound = possibleBinding(input.sessionId);
        if (!bound || bound.harnessAdapterId && bound.harnessAdapterId !== adapterId) throw new Error('Native context belongs to another profile.');
        const events = await inspect(input.sessionId);
        const agent = ctx.agents.get(input.sessionId);
        const result = input.deliveryId ? recoveredHarnessResult(events, input.deliveryId) : null;
        return sendJson(res, 200, { adapterId, sessionId: input.sessionId, status: agent?.status ?? 'cold', inbox: agent ? { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length } : null,
          events: events.slice(-15).map(e => ({ type: e.type, seq: e.seq, turn: e.data?.turn, reason: e.data?.reason, textLength: e.type === 'assistant/message' ? textOf(e.data.message).length : undefined })),
          permissionRelay: permissionRelays.get(input.sessionId) ?? null, pipeCompat: pipeCompat.state,
          result: result ? { length: result.text?.length ?? 0, preview: result.text?.slice(0, 1500) ?? '', usage: result.usage, interrupted: result.interrupted,
            terminalNoReply: result.terminalNoReply === true, proof: result.proof } : null });
      }
      if(req.url==='/parallel-proof'){
        const bound=binding(input.sessionId),delivery=deliveries.get(input.sessionId),agent=ctx.agents.get(input.sessionId);
        const proof=bound&&delivery?.id===input.deliveryId&&delivery.groupId===bound.groupId&&busy.has(input.sessionId)&&agent?.status==='running'
          ?activeHarnessTurn(await inspect(input.sessionId),delivery.id):null;
        return sendJson(res,200,{adapterId,sessionId:input.sessionId,deliveryId:input.deliveryId,pending:Boolean(proof),...proof});
      }
      if (req.url === '/progress') {
        const bound=binding(input.sessionId),delivery=deliveries.get(input.sessionId);
        if(!bound||!delivery||delivery.id!==input.deliveryId||delivery.groupId!==bound.groupId||!busy.has(input.sessionId))return sendJson(res,200,{sessionId:input.sessionId,deliveryId:input.deliveryId,text:''});
        return sendJson(res,200,{sessionId:input.sessionId,deliveryId:input.deliveryId,text:harnessAnswer(await inspect(input.sessionId),delivery.id)});
      }
      if (req.url === '/permission-active') {
        const record = pendingPermissions.get(input.handlerId);
        return sendJson(res, 200, record && record.sessionId === input.sessionId && record.deliveryId === input.deliveryId
          ? { active: true, adapterId, details: record.details } : { active: false, adapterId });
      }
      const agent = await agentFor(input.sessionId);
      if (req.url === '/permission-snapshot') return sendJson(res, 200, { seq: (await inspect(input.sessionId)).reduce((maximum, e) => Math.max(maximum, e.seq ?? -1), -1) });
      if (req.url === '/permission-proof') return sendJson(res, 200, { adapterId, proof: nativeHumanProof(await inspect(input.sessionId), input) });
      if (req.url === '/diagnose-shell') {
        const bound = binding(input.sessionId);
        const state = await localFetch(descriptor, `/api/groups/${bound.groupId}`);
        if (state.group.status !== 'paused') throw new Error('Pause the group before native shell diagnosis.');
        if (busy.has(input.sessionId)) throw new Error('Native group session is busy.');
        busy.add(input.sessionId);
          try { return sendJson(res, 200, { ...await probeShell(agent, input.variant, ctx), encodingFix: encoding.state, pipeCompat: pipeCompat.state }); }
        finally { busy.delete(input.sessionId); }
      }
      if (req.url === '/configure') {
        if (agent.status !== 'idle') throw new Error('Native agent must be idle before a model change.');
        return sendJson(res, 200, await ctx.sessionController.selectModel({ sessionId: input.sessionId, provider: input.model.provider, model: input.model.model,
          ...(input.model.effort ? { reasoningEffort: input.model.effort } : {}) }));
      }
      if (req.url === '/cancel') { agent.cancel({ kind: 'hook', reason: 'Group human intervention' }, { keepInbox: true }); return sendJson(res, 200, { ok: true }); }
      if (req.url === '/recover') {
        const events = await inspect(input.sessionId);
        const marker = `[Group delivery ${input.deliveryId}]\n`;
        const admitted = events.some(e => e.type === 'user/message' && textOf(e.data).startsWith(marker));
        const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(m => textOf(m).startsWith(marker));
        const recovered = recoveredHarnessResult(events, input.deliveryId);
        const active=agent.status==='running'?activeHarnessTurn(events,input.deliveryId):null;
        const idle = agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length && !busy.has(input.sessionId);
        return sendJson(res, 200, { result: recovered?.terminalNoReply ? (idle ? { ...recovered, proof: { ...recovered.proof, sessionId: input.sessionId, idle: true } } : null) : recovered,
          notAdmitted: !admitted && !queued && !busy.has(input.sessionId) && agent.status === 'idle',
          pending:!recovered&&Boolean(active),activeTurn:active,
          adapterId, sessionId: input.sessionId, deliveryId: input.deliveryId });
      }
      if (req.url !== '/turn') return sendJson(res, 404, { error: 'Unknown operation.' });
      if (busy.has(input.sessionId)) throw new Error('Harness group session is busy; preserve the delivery.');
      busy.add(input.sessionId);
      try {
        const { delivery } = input;
        if (binding(input.sessionId).groupId !== delivery.groupId) throw new Error('Delivery is bound to another group.');
        deliveries.set(input.sessionId, delivery);
        const marker = `[Group delivery ${delivery.id}]\n`;
        const existing = await inspect(input.sessionId);
        const recovered = recoveredHarnessResult(existing, delivery.id);
        if (recovered) {
          if (recovered.terminalNoReply) recovered.proof = { ...recovered.proof, sessionId: input.sessionId,
            idle: agent.status === 'idle' && !agent.inbox.nextStep.length && !agent.inbox.nextTurn.length };
          return sendJson(res, 200, recovered);
        }
        const admitted = existing.some(e => e.type === 'user/message' && textOf(e.data).startsWith(marker));
        const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(m => textOf(m).startsWith(marker));
        if (admitted && agent.status !== 'running') throw new Error('Previous delivery did not complete; refusing to execute it twice.');
        const effortReceipt=!admitted&&!queued?{...await configureIdleEffort({agent,sessionController:ctx.sessionController,sessionId:input.sessionId,model:input.model,effort:input.effort}),deliveryId:delivery.id,sessionId:input.sessionId}:null;
        // Never inherit the desktop profile's danger-full-access/never preset.
        ctx.permissionPresets.set(agent.session, deliveryPermissionPreset(delivery));
        // Use the host's own message factory/API. Global npm SDK v3 objects must never be injected into an Electron v4 agent.
        if (!admitted && !queued) await ctx.sessionController.prompt({ sessionId: input.sessionId, requestId: `group-${delivery.id}`, mode: 'queue', content: [{ type: 'text', text: marker + delivery.prompt }] }, AbortSignal.timeout(120000));
        const result = await waitHarnessReply(agent,()=>inspect(input.sessionId),delivery.id);
        if(result&&effortReceipt)result.effortReceipt=harnessEffortReceipt(await inspect(input.sessionId),{deliveryId:delivery.id,sessionId:input.sessionId,turn:result.proof?.turn,model:input.model,requested:effortReceipt.requested});
        if (!result) throw new Error('Harness delivery has no completed reply; original session was retained.');
        if (result.terminalNoReply) result.proof = { ...result.proof, sessionId: input.sessionId,
          idle: agent.status === 'idle' && !agent.inbox.nextTurn.length && !agent.inbox.nextStep.length };
        return sendJson(res, 200, result);
      } finally { busy.delete(input.sessionId); deliveries.delete(input.sessionId); }
    } catch (error) { sendJson(res, 400, { error: String(error.message).slice(0, 4000) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  adapterOrigin = `http://127.0.0.1:${server.address().port}`;
  const adapterFile = path.join(path.dirname(descriptorFile), `harness-adapter-${adapterId}.json`);
  const adapterTemp = `${adapterFile}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(adapterFile), { recursive: true });
  fs.writeFileSync(adapterTemp, JSON.stringify({ url: adapterOrigin, token: secret, adapterId, instanceStartedAt, instanceId, buildHash })); fs.renameSync(adapterTemp, adapterFile);
  ctx.on('approval/request', async (request, next) => {
    const delivery = deliveries.get(request.agent?.id), bound = binding(request.agent?.id);
    if (!delivery || !bound) return next();
    const handlerId = randomUUID();
    const permissionRelay = { sessionId: request.agent.id, deliveryId: delivery.id, callId: request.callId, state: 'verifying', at: new Date().toISOString() };
    permissionRelays.delete(request.agent.id); permissionRelays.set(request.agent.id, permissionRelay);
    while (permissionRelays.size > 64) permissionRelays.delete(permissionRelays.keys().next().value);
    try {
      const call = nativeToolCall(await inspect(request.agent.id), request.callId, request.toolName);
      if (!call) throw Error('原生记录中尚未找到对应模型工具调用；未向真人展示审批，也未执行操作。');
      pendingPermissions.set(handlerId, { sessionId: request.agent.id, deliveryId: delivery.id,
        details: { method: 'harness/tool', params: { toolName: request.toolName, callId: request.callId, reason: request.reason, arguments: call.arguments } } });
      permissionRelay.state = 'waiting-for-human';
      const answer = await localFetch(descriptor, '/api/permissions/request', { groupId: bound.groupId, deliveryId: delivery.id, handlerId }, { signal: request.signal, timeoutMs: 30 * 60 * 1000 });
      permissionRelay.state = request.signal?.aborted ? 'cancelled' : answer.allowed === true ? 'allowed-once' : 'not-allowed';
      return answer.allowed === true && !request.signal?.aborted ? 'allowed-once' : 'rejected';
    } catch (error) {
      permissionRelay.state = request.signal?.aborted ? 'cancelled' : 'unavailable';
      permissionRelay.cancelSource = error.cancelSource ?? (request.signal?.aborted ? cancellationSource(request.signal.reason) : 'connection_disconnected');
      permissionRelay.error = String(error.message).slice(0, 600);
      ctx.logger?.warn?.(`Group approval relay: ${permissionRelay.error}`);
      return request.signal?.aborted ? 'cancelled' : 'unavailable';
    }
    finally { pendingPermissions.delete(handlerId); }
  }, { prepend: true });
  // Persist native input before rejecting admission. A bridge outage rejects rather than executing independently.
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    if (!possibleBinding(agent.id)) return next();
    if (!binding(agent.id)) return { kind: 'reject' };
    const natives = messages.filter(m => m.source?.kind === 'user');
    const routed = [];
    for (const message of natives) {
      try {
        if (message.content.some(p => p.type !== 'text')) throw new Error('群原生输入暂不支持附件，请在共享页提供文件路径；原生执行已阻止。');
        const result = await localFetch(descriptor, '/api/native', { adapter: 'harness', harnessAdapterId: adapterId, sessionId: agent.id, messageId: message.id, turnId: String(message.id), content: textOf(message) }, { signal });
        if (!result.dispatch) routed.push(message);
      } catch (error) {
        ctx.logger?.warn?.(`Group native input blocked: ${String(error.message).slice(0, 1000)}`);
        return { kind: 'reject' };
      }
    }
    if (!routed.length) return next();
    // A real user's input wins over an in-flight controller proposal at this boundary.
    return { kind: 'reject' };
  }, { prepend: true });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/codex-group/entry', handler: async (req, res) => {
    try {
      const hostname = new URL(`http://${req.headers.host}`).hostname;
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return sendJson(res, 403, { error: 'Loopback origin required.' });
      await connect();
      sendJson(res, 200, { url: `${descriptor.url}/#${descriptor.token}`, groups: bindings.filter(b => b.harnessAdapterId === adapterId).map(b => ({ groupId: b.groupId, sessionId: b.contexts.harness })) });
    } catch (error) { sendJson(res, 503, { error: String(error.message).slice(0, 1000) }); }
  } }), 'codex-group-entry');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/codex-group/presence', handler: async (req, res) => {
    const hostname = new URL(`http://${req.headers.host}`).hostname;
    if (req.method !== 'POST' || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || req.headers.origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'Local UI origin required.' });
    uiSeenAt = Date.now(); sendJson(res, 200, { ok: true });
  } }), 'codex-group-presence');
  await connect().catch(error => ctx.logger?.warn?.(`Group bridge not ready: ${error.message}`));
  const timer = setInterval(() => connect().catch(() => {}), 4000); timer.unref();
  ctx.effect(() => () => { clearInterval(timer); server.close(); });
}
