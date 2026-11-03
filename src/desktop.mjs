import { createPreviewEmitter, codexAnswerItem } from './group-progress.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { RpcProcess } from './rpc.mjs';
import {createTurnDeadline, turnTiming} from './turn-deadline.mjs';

// Resolve at call time: maintenance chooses the plugin data directory after
// binary discovery; importing this low-level module must not freeze that choice.
const bridgeFile = () => path.join(path.resolve(process.env.HARNESS_PLUGIN_DATA ?? process.env.PLUGIN_DATA ?? path.join(os.homedir(), '.codex', 'deepseek-harness-plugin-data')), 'desktop-bridge.json');
const readBridge = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
function writeBridge(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 }); fs.renameSync(temporary, file);
}
const validBridgeEnv = env => typeof env?.CODEX_APP_TOOLS_PIPE_PATH === 'string' && env.CODEX_APP_TOOLS_PIPE_PATH.length > 0 && env.CODEX_APP_TOOLS_PIPE_PATH.length <= 4096 &&
  typeof env.CODEX_THREAD_ID === 'string' && /^[a-f0-9-]{36}$/i.test(env.CODEX_THREAD_ID);
export function rememberDesktopBridge({ env = process.env, file = bridgeFile() } = {}) {
  if (!validBridgeEnv(env)) return false;
  const value = { CODEX_APP_TOOLS_PIPE_PATH: env.CODEX_APP_TOOLS_PIPE_PATH, CODEX_THREAD_ID: env.CODEX_THREAD_ID,
    ...(env.HARNESS_APP_TOOLS_SERVER ? { HARNESS_APP_TOOLS_SERVER: env.HARNESS_APP_TOOLS_SERVER } : {}) };
  let old; try { old = readBridge(file); } catch { /* Replace an incomplete local receipt. */ }
  if (JSON.stringify(old?.env) !== JSON.stringify(value)) writeBridge(file, { at: Date.now(), env: value });
  return true;
}
export function desktopBridgeEnvironment({ env = process.env, file = bridgeFile() } = {}) {
  let recorded; try { recorded = readBridge(file)?.env; } catch { /* Use current process context. */ }
  const source = validBridgeEnv(recorded) ? recorded : validBridgeEnv(env) ? env : null;
  return source ? { CODEX_APP_TOOLS_PIPE_PATH: source.CODEX_APP_TOOLS_PIPE_PATH, CODEX_THREAD_ID: source.CODEX_THREAD_ID,
    ...(source.HARNESS_APP_TOOLS_SERVER ? { HARNESS_APP_TOOLS_SERVER: source.HARNESS_APP_TOOLS_SERVER } : {}) } : null;
}
export function desktopBridgeAvailable(options) { return Boolean(desktopBridgeEnvironment(options)); }
export function desktopBridgeGeneration(options) {
  const env = desktopBridgeEnvironment(options);
  // Only connection identity matters. A different chat in the same app must
  // not keep resetting recovery budgets. Never expose the local capability.
  return env ? createHash('sha256').update(env.CODEX_APP_TOOLS_PIPE_PATH).digest('hex') : null;
}
export function isDesktopConnectionError(error) {
  return /connect (?:ENOENT|ECONNREFUSED|EPIPE)|RPC (?:process|stdin).*?(?:closed|exited|failed)|Desktop app tools bridge is unavailable|(?:read_thread|thread\/read|tools\/call|initialize) timed out/i.test(String(error?.message ?? error));
}

export async function organizeDesktopThread({ threadId, title, sectionName = 'Codex × Harness', bridge = openDesktopBridge() }) {
  try {
    const listed = await bridge.call('list_threads', { limit: 1 });
    let section = listed.sections?.find(s => s.name === sectionName);
    let created = false;
    if (!section) { const result = await bridge.call('create_sidebar_section', { name: sectionName }); section = result.section ?? result; created = true; }
    const sectionId = section.sectionId ?? section.id;
    if (!sectionId) throw Error('Desktop did not return a sidebar section ID.');
    await bridge.call('move_thread_to_sidebar_section', { threadId, sectionId });
    if (title) await bridge.call('set_thread_title', { threadId, title });
    const actual = await bridge.call('list_threads', { limit: 1 });
    const target = actual.sections?.find(s => (s.sectionId ?? s.id) === sectionId);
    if (!target?.itemKeys?.some(key => key.endsWith(':' + threadId))) throw Error('Desktop sidebar move was not visible in the app.');
    return { section: { id: sectionId, name: sectionName }, created, verified: true, source: 'desktop-app' };
  } finally { await bridge.close(); }
}

export function openDesktopBridge({ env = process.env, file = bridgeFile(), rpcFactory = (server, options) => new RpcProcess(process.execPath, [server], options) } = {}) {
  const bridgeEnv = desktopBridgeEnvironment({ env, file });
  const server = bridgeEnv?.HARNESS_APP_TOOLS_SERVER ?? path.join(os.homedir(), '.codex', '.tmp', 'bundled-marketplaces', 'openai-bundled', 'plugins', 'codex-app-tools', 'server.mjs');
  if (!bridgeEnv || !fs.existsSync(server)) throw new Error('Desktop app tools bridge is unavailable.');
  const rpc = rpcFactory(server, { jsonrpc: true, env: bridgeEnv });
  let initialized;
  return {
    async call(name, args) {
      initialized ??= rpc.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-harness-desktop-bridge', version: '0.2.1' } });
      await initialized;
      const result = await rpc.request('tools/call', { name, arguments: args, _meta: { threadId: bridgeEnv.CODEX_THREAD_ID } }, 90000);
      const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
      if (result.isError) throw new Error(text || `Desktop ${name} failed.`);
      return JSON.parse(text);
    },
    close: () => rpc.close(),
  };
}

const userText = turn => (turn.items ?? []).filter(item => item.type === 'userMessage').flatMap(item => item.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
function matchesInput(turn, prompt, prefix) {
  if ([prompt, prefix + prompt].includes(userText(turn))) return true;
  // Desktop message dispatch records a delegation item rather than fabricating
  // a human user message. Match the full input envelope, never an agent quote.
  return (turn.items ?? []).some(item => {
    if (item.type !== 'functionCallOutput' || item.namespace !== 'codex_app' || item.name !== 'send_message_to_thread') return false;
    const outputText = typeof item.output === 'string' ? item.output : item.output?.text;
    const input = outputText?.match(/<input>([\s\S]*)/)?.[1];
    if (typeof input !== 'string') return false;
    // The stable hash binds the entire original input and destination thread.
    // It survives the desktop's 20k output truncation without accepting an
    // agent quotation or treating an external input as human approval.
    return input.startsWith(prefix) || (!item.output?.truncated && outputText?.match(/<input>([\s\S]*)<\/input>/)?.[1] === prompt);
  });
}

export function matchesCodexDelivery(turn, threadId, prompt) {
  const hash = createHash('sha256').update(threadId + '\0' + prompt).digest('hex');
  return matchesInput(turn, prompt, `[Harness delivery ${hash}]\n`);
}

export function nativeTerminalFailure(turn) {
 const raw=String(turn.error?.message||turn.error||'').slice(0,4000);
 const quota=/usage limit|quota|rate.?limit|额度|余额|insufficient.*credit/i.test(raw);
 const kind=quota?'usage_limit':/^workspace routing discovery timed out$/i.test(raw)?'workspace_route_timeout':'native_error';
 const text=quota?'Codex 原生会话因额度不足而失败。已保留当前任务和成果；额度可用后再继续。':'Codex 原生会话已执行失败。已保留当前阶段和成果；请先核对原生错误后再继续。';
 return {text,usage:null,interrupted:true,turnId:turn.id,nativeFailure:{kind,message:raw,turnId:turn.id}};
}

// Read-only recovery uses the desktop writer's authoritative turn status.
export async function recoverDesktopDelivery({ threadId, prompt, nativeTurnId, allowIdleProof=false, bridgeFactory = openDesktopBridge }) {
  const bridge = bridgeFactory();
  try {
    const snapshot = await bridge.call('read_thread', { threadId, turnLimit: 10, includeOutputs: true, maxOutputCharsPerItem: 20000 });
    if (snapshot.thread?.id !== threadId) return null;
    const turn = snapshot.turns?.find(t => matchesCodexDelivery(t, threadId, prompt)||nativeTurnId&&t.id===nativeTurnId);
    if (!turn) return allowIdleProof&&['idle','notLoaded'].includes(snapshot.thread?.status?.type)&&snapshot.turns?.every(t=>['completed','interrupted','failed'].includes(t.status))
      ? {unmatched:true,idle:true,threadId,status:snapshot.thread.status.type}:null;
    if (['inProgress','running','active'].includes(turn.status)) return { pending: true, turnId: turn.id };
    const final = (turn.items ?? []).findLast(i => i.type === 'agentMessage' && ['final','final_answer'].includes(i.phase));
    if (turn.status==='failed') return nativeTerminalFailure(turn);
    if (turn.status==='interrupted') return {text:'Codex 原生操作已确认中断；继续前先检查已执行的操作。',usage:null,interrupted:true,turnId:turn.id};
    if (turn.status === 'completed' && final?.text && !final.truncated && !final.textTruncated) return { text: final.text, usage: null, turnId: turn.id, recovered: true };
    return null;
  } finally { await bridge.close(); }
}

// Use the desktop's existing writer instead of opening a competing app-server.
// Only the exact delivered input's completed turn can supply the reply.
export async function desktopTurn({ threadId, prompt, onEvent, onAnswer, onAdmitted, onActiveReader, onDispatchState, beforeDispatch, signal, model, effort, timeoutMs = turnTiming().maxMs, idleTimeoutMs = turnTiming().idleMs, deadlineFactory = createTurnDeadline, bridgeFactory = openDesktopBridge, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let bridge, initialRead = true, deadline, lastProgress;
  let releaseActiveReader;
  const preview=createPreviewEmitter(text=>onAnswer?.(text));
  const deliveryId = createHash('sha256').update(threadId + '\0' + prompt).digest('hex');
  const prefix = `[Harness delivery ${deliveryId}]\n`;
  try {
    onDispatchState?.({ route: 'desktop', stage: 'preflight', threadId });
    bridge = bridgeFactory();
    const read = () => bridge.call('read_thread', { threadId, turnLimit: 2, includeOutputs: true, maxOutputCharsPerItem: 20000 });
    const before = await read();
    initialRead = false;
    let turn = before.turns?.find(turn => matchesInput(turn, prompt, prefix));
    if (!turn) {
      const status=before.thread?.status?.type;
      const endedError=status==='systemError' && before.turns?.length>0 && before.turns.every(t=>['completed','failed','interrupted'].includes(t.status));
      if (status !== 'idle' && !endedError) throw Object.assign(new Error('Desktop collaboration thread is busy; pending Harness reply preserved.'), { code: 'GROUP_NOT_ADMITTED', admissionFailure: 'codex_busy' });
      // A completed/pending matching input above must always remain recoverable.
      // Only a genuinely new dispatch needs permission admission checks.
      await beforeDispatch?.({ thread: before.thread });
      if (signal?.aborted) throw Object.assign(Error('Codex turn cancelled before desktop admission.'), { code: 'GROUP_NOT_ADMITTED' });
      onDispatchState?.({ route: 'desktop', stage: 'send_attempted', threadId });
      await bridge.call('send_message_to_thread', { threadId, prompt: prefix + prompt, ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) });
      onEvent?.({ side: 'Codex', type: 'desktop_message_dispatched', threadId, deliveryId });
    }
    deadline = deadlineFactory({maxMs:timeoutMs,idleMs:Math.min(idleTimeoutMs,timeoutMs)});let receiptSaved=false;
    while (true) {
      const snapshot = await Promise.race([read(),deadline.promise]);
      turn = snapshot.turns?.find(turn => matchesInput(turn, prompt, prefix));
      if (turn) {
        const progress = createHash('sha256').update(JSON.stringify([turn.id,turn.status,(turn.items??[]).map(i=>[i.id,i.type,i.status,codexAnswerItem(i)?i.text:undefined])])).digest('hex');
        if (progress !== lastProgress) { lastProgress = progress; deadline.touch(); }
      }
      if(turn?.id&&!receiptSaved){onAdmitted?.({threadId,turnId:turn.id,route:'desktop',...(typeof turn.effort==='string'?{confirmedEffort:turn.effort}:{})});receiptSaved=true;
        const turnId=turn.id;releaseActiveReader=onActiveReader?.({threadId,turnId,read:async()=>{const snapshot=await read(),t=snapshot.turns?.find(t=>t.id===turnId&&matchesInput(t,prompt,prefix));return snapshot.thread?.id===threadId&&['inProgress','running','active'].includes(t?.status)?{pending:true,turnId}:null;}});
      }
      if (turn?.status === 'completed') {
        const messages = (turn.items ?? []).filter(item => item.type === 'agentMessage');
        const final = messages.findLast(item => ['final_answer', 'final'].includes(item.phase)) ?? messages.at(-1);
        if (!final?.text) throw new Error('Desktop completed turn has no reply.');
        if (final.truncated || final.textTruncated || final.text.length >= 20000) throw new Error('Desktop reply is truncated; pending Harness reply preserved.');
        return { threadId, turnId: turn.id, text: final.text, status: 'completed', settings: null };
      }
      if(turn&&!['completed','failed','interrupted'].includes(turn.status)){const item=(turn.items??[]).findLast(i=>codexAnswerItem(i));if(item)preview.update(item.text)}
      if (turn?.status==='failed') return nativeTerminalFailure(turn);
      if (turn?.status==='interrupted') return {text:'Codex 原生操作已确认中断；继续前先检查现场。',usage:null,interrupted:true,turnId:turn.id};
      // The desktop bridge has no native interrupt API. Release this poller
      // promptly, retain the admitted delivery and recover its actual outcome.
      // Never report a cancellation or launch a replacement while it still runs.
      if (signal?.aborted) throw new Error(signal.reason==='coordinator_update'?'协调器正在更新；原生操作继续，保留原投递并在更新后核对结果。':'已暂停后续派发；等待原生操作安全结束，保留原投递（真人插话或控制）。');
      await Promise.race([delay(2000),deadline.promise]);
    }
  } catch (error) {
    // No send can occur before this read completes. After a send attempt even
    // ENOENT is uncertain; the same error text cannot grant replay permission.
    if (initialRead && isDesktopConnectionError(error)) {
      error.code = 'GROUP_NOT_ADMITTED'; error.admissionFailure = 'codex_connection';
    }
    throw error;
  } finally { releaseActiveReader?.(); deadline?.close(); preview.close(); await bridge?.close(); }
}
