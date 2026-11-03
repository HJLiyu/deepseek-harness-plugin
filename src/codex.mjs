import { createPreviewEmitter } from './group-progress.mjs';
import {emptyNativeTurn} from './native-empty-turn.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RpcProcess } from './rpc.mjs';
import {createTurnDeadline, nativeProgress, turnTiming} from './turn-deadline.mjs';
import { desktopBridgeAvailable, organizeDesktopThread, desktopTurn, matchesCodexDelivery, recoverDesktopDelivery, nativeTerminalFailure, isDesktopConnectionError } from './desktop.mjs';

const DEFAULT_MODEL = 'gpt-6.1-sol';
const DEFAULT_SANDBOX = 'workspace-write';
const DEFAULT_APPROVAL_POLICY = 'never';
const CLIENT_INFO = { name: 'codex_deepseek_harness_plugin', title: 'Codex DeepSeek Harness Plugin', version: '0.2.1' };

export function findCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const root = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  const candidates = fs.existsSync(root) ? fs.readdirSync(root).map(name => path.join(root, name, 'codex.exe')).filter(file => fs.existsSync(file)) : [];
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates.length) throw new Error('Codex app-server binary not found; set CODEX_BIN.');
  return candidates[0];
}

function openAppServer(cwd, handlers = {}) {
  return new RpcProcess(findCodexBinary(), ['app-server', '--listen', 'stdio://'], { cwd, ...handlers });
}

async function initialize(rpc) {
  await rpc.request('initialize', { clientInfo: CLIENT_INFO }, 30000);
  rpc.notify('initialized');
}

// A desktop Codex thread can be archived while the collaboration is paused
// (for example while a human approves an ACP escalation in another thread).
// Resuming still works, but the native sidebar hides archived threads, so make
// the collaboration thread visible again before every resume. The call is
// best-effort: older app-server builds and already-visible threads may reject
// it, and that must not block the turn.
async function restoreThread(rpc, threadId, onEvent) {
  try {
    await rpc.request('thread/unarchive', { threadId }, 30000);
    return true;
  } catch (error) {
    if (!/no archived rollout found/i.test(error.message)) {
      onEvent?.({ side: 'Codex', type: 'thread_unarchive_failed', threadId, message: error.message });
    }
    return false;
  }
}

export function normalizeSandbox(value) {
  const normalized = { workspaceWrite: 'workspace-write', readOnly: 'read-only', dangerFullAccess: 'danger-full-access' }[value] ?? value;
  if (!['workspace-write', 'read-only', 'danger-full-access'].includes(normalized)) throw new Error(`Unsupported Codex sandbox: ${value}`);
  return normalized;
}

function settingsFromResume(resumed) {
  return {
    sandbox: resumed?.sandbox?.type ? normalizeSandbox(resumed.sandbox.type) : null,
    approvalPolicy: resumed?.approvalPolicy ?? null,
    permissionProfile: resumed?.activePermissionProfile?.id ?? null,
    model: resumed?.model ?? null,
  };
}

// This is evidence from the most recent native turn, not a way to set or grant
// permissions. The desktop send-message tool cannot carry sandbox overrides.
export function readRecordedCodexPermissions(file) {
  if (!file || !path.isAbsolute(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift(); // Never parse a partial JSONL record.
    for (let i = lines.length - 1; i >= 0; i--) {
      let row; try { row = JSON.parse(lines[i]); } catch { continue; }
      if (row.type === 'turn_context') return row.payload ?? null;
    }
  } catch { /* Unknown evidence must not be treated as writable. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

export function desktopDispatchIssue(context, { cwd }) {
  // turn_context describes a historical turn, not the native UI's next-turn
  // permission selection. Never use it to veto or grant current capabilities.
  // The desktop host admits the new turn and enforces its current permissions.
  if (!context || typeof context.cwd !== 'string' || !path.isAbsolute(context.cwd)) return '无法确认原会话的工作目录';
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(context.cwd) === normalize(cwd) ? null : '原生会话工作目录与当前成员工作树不一致';
}

export function readRecordedToolWait(file, turnId) {
  if (!file || !path.isAbsolute(file) || !turnId) return null;
  let fd;
  try {
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,length=Math.min(size,256*1024),buffer=Buffer.alloc(length);fs.readSync(fd,buffer,0,length,size-length);
    const lines=buffer.toString('utf8').split('\n');if(size>length)lines.shift();
    let active=null;const pending=new Map();
    for(const line of lines){let row;try{row=JSON.parse(line)}catch{continue}const p=row.payload;
      if(row.type==='event_msg'&&p?.type==='task_started'){active=p.turn_id;pending.clear();}
      if(active!==turnId)continue;
      if(row.type==='event_msg'&&['task_complete','turn_aborted'].includes(p?.type)){pending.clear();active=null;continue;}
      if(row.type==='response_item'&&p?.type==='custom_tool_call'&&p.call_id&&typeof p.input==='string'&&/["']?sandbox_permissions["']?\s*:\s*["']require_escalated["']/u.test(p.input))pending.set(p.call_id,{kind:'native_permission_tool',at:row.timestamp});
      if(row.type==='response_item'&&p?.type==='custom_tool_call_output')pending.delete(p.call_id);
    }
    return [...pending.values()].at(-1)??null;
  }catch{return null}finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function desktopPermissionIssue(context, { cwd, sandbox, approvalPolicy, writableRoots }) {
  if (sandbox === 'read-only') return null;
  if (!context?.sandbox_policy) return '无法确认原生会话最近一轮的权限';
  const policy = context.sandbox_policy;
  let actual; try { actual = normalizeSandbox(policy.type); } catch { return '原生会话权限格式未知'; }
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const within = (root, child) => { const r = normalize(root), c = normalize(child); return c === r || c.startsWith(r + path.sep); };
  if (typeof context.cwd !== 'string' || !path.isAbsolute(context.cwd) || normalize(context.cwd) !== normalize(cwd)) return '原生会话工作目录与当前成员工作树不一致';
  // Respect a full-access mode selected in the native UI. This observation
  // never changes host settings or grants permissions on the user's behalf.
  if (actual === 'danger-full-access' && (!context.permission_profile || context.permission_profile.type === 'disabled')) return null;
  if (actual !== sandbox) return `原生会话最近一轮为 ${actual}，当前阶段需要 ${sandbox}`;
  if (context.approval_policy !== approvalPolicy) return `原生会话审批策略为 ${context.approval_policy ?? '未知'}，当前阶段需要 ${approvalPolicy}`;
  if (sandbox === 'workspace-write') {
    const roots = [context.cwd, ...(policy.writable_roots ?? policy.writableRoots ?? [])];
    if (writableRoots.some(root => !roots.some(allowed => within(allowed, root)))) return '原生会话可写范围未覆盖本阶段所需目录';
    // Modern managed profiles can narrow the legacy sandbox policy. Do not
    // mistake a read-only profile for a workspace-write grant.
    const profile = context.permission_profile;
    if (profile?.type === 'managed') {
      const entries = profile.file_system?.entries;
      if (!Array.isArray(entries)) return '无法确认原生会话托管权限的可写范围';
      for (const root of writableRoots) {
        const matching = entries.map(entry => ({ access: entry.access, root: entry.path?.type === 'path' ? entry.path.path : null }))
          .filter(entry => typeof entry.root === 'string' && path.isAbsolute(entry.root) && within(entry.root, root))
          .sort((a, b) => b.root.length - a.root.length);
        if (matching[0]?.access !== 'write') return '原生会话托管权限未允许写入本阶段目录';
      }
    }
  }
  return null;
}

export async function codexTurn({ threadId, cwd, prompt, onEvent, onAnswer, onApproval, onAdmitted, onActiveReader, onDispatchState, create = false, model, effort, writableRoots = [cwd], signal, sandbox = DEFAULT_SANDBOX, approvalPolicy = DEFAULT_APPROVAL_POLICY, rpcFactory = openAppServer, desktop = desktopTurn, desktopAvailable = desktopBridgeAvailable, deadlineFactory = createTurnDeadline }) {
  sandbox = normalizeSandbox(sandbox);
  const timing = turnTiming(); let deadline;
  let finalText = '';
  let completion;
  let finish;
  let threadSettings = null;
  let usage = null;
  let activeTurnId;
  let releaseActiveReader;
  let admissionAttempted = false;
  const pendingItems = new Map();
  const preview = createPreviewEmitter(text=>onAnswer?.(text));
  let answerItemId=null, answerText='';
  const publicItems=new Map();
  let aborted = false;
  const abort = () => { aborted = true; if (activeTurnId) rpc.request('turn/interrupt', { threadId, turnId: activeTurnId }, 10000).catch(() => {}); };
  const completed = new Promise(resolve => { finish = resolve; });
  const rpc = rpcFactory(cwd, {
    onNotification(method, params) {
      if (nativeProgress(method, params, threadId, activeTurnId)) deadline?.touch();
      if (method === 'item/started' && params?.item?.id) {
        pendingItems.set(params.item.id, params.item);
        if(activeTurnId&&params.threadId===threadId&&params.turnId===activeTurnId&&params.item.type==='agentMessage'&&['commentary','final','final_answer'].includes(params.item.phase)){publicItems.set(params.item.id,true);if(publicItems.size>8)publicItems.delete(publicItems.keys().next().value)}
        if (pendingItems.size > 32) pendingItems.delete(pendingItems.keys().next().value);
      }
      if (method === 'item/agentMessage/delta' && params?.threadId===threadId && activeTurnId && params.turnId===activeTurnId && typeof params.delta==='string') {
        if(publicItems.has(params.itemId)){
          if(answerItemId!==params.itemId){answerItemId=params.itemId;answerText=''}
          answerText=(answerText+params.delta).slice(0,64000);preview.update(answerText);
        }
      }
      if (method === 'thread/tokenUsage/updated') usage = params?.tokenUsage?.last ?? null;
      if (method === 'item/completed') {
        const item = params?.item;
        if (item?.id) { pendingItems.delete(item.id); publicItems.delete(item.id); }
        // Some providers never set `phase`; keep the last agent message as a
        // fallback instead of losing an otherwise valid final answer.
        if (item?.type === 'agentMessage') finalText = item.text ?? finalText;
        if (item?.type === 'commandExecution' || item?.type === 'fileChange' || item?.type === 'mcpToolCall') {
          onEvent?.({ side: 'Codex', type: item.type, status: item.status, command: item.command, exitCode: item.exitCode, changes: item.changes?.map(x => ({ path: x.path, kind: x.kind })) });
        }
      }
      if (method === 'turn/completed') { completion = params; finish(params); }
    },
    onRequest(method, params) {
      onEvent?.({ side: 'Codex', type: 'approval_request', method, reason: params?.reason });
      if (onApproval && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
        if (params?.availableDecisions != null && (!Array.isArray(params.availableDecisions) || !params.availableDecisions.includes('accept'))) return { decision: 'decline' };
        const release = params?.threadId === threadId && params?.turnId === activeTurnId ? deadline?.hold() : null;
        return Promise.resolve().then(() => onApproval(method, { ...params, nativeItem: pendingItems.get(params?.itemId) ?? null })).then(allow => ({ decision: allow === true && !signal?.aborted ? 'accept' : 'decline' }), () => ({ decision: 'decline' })).finally(() => release?.());
      }
      if (method.endsWith('/requestApproval')) return { decision: 'decline' };
      if (method === 'tool/requestUserInput') return { answers: {} };
      return { decision: 'decline' };
    },
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Codex turn cancelled before admission.');
    await initialize(rpc);
    if (create) {
      const started = await rpc.request('thread/start', { cwd, model: model ?? DEFAULT_MODEL, approvalPolicy, sandbox, serviceName: 'codex_deepseek_harness_plugin' }, 30000);
      threadId = started.thread.id;
      threadSettings = settingsFromResume(started);
    } else {
      // thread/resume supports these overrides. Without them a thread created
      // by the desktop app as read-only stays read-only, which silently blocks
      // the integration step of the collaboration.
      await restoreThread(rpc, threadId, onEvent);
      const resumed = await rpc.request('thread/resume', { threadId, cwd, model, excludeTurns: true, sandbox, approvalPolicy }, 30000);
      threadSettings = settingsFromResume(resumed);
    }
    // Preserve the main workspace's explicit per-turn boundary as well as the
    // resume override. This also repairs desktop-created read-only threads.
    const sandboxPolicy = sandbox === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots, networkAccess: false }
      : { type: sandbox === 'read-only' ? 'readOnly' : 'dangerFullAccess' };
    if (aborted) throw new Error('Codex turn cancelled before admission.');
    admissionAttempted = true;
    const startedTurn = await rpc.request('turn/start', { threadId, cwd, model, ...(effort ? { effort } : {}), approvalPolicy, sandboxPolicy, input: [{ type: 'text', text: prompt }] }, 30000);
    const turnId = startedTurn?.turn?.id;
    activeTurnId = turnId;
    if(turnId)onAdmitted?.({threadId,turnId,route:'app-server',...(typeof startedTurn?.turn?.effort==='string'?{confirmedEffort:startedTurn.turn.effort}:{})});
    if(turnId&&onActiveReader)releaseActiveReader=onActiveReader({threadId,turnId,read:async()=>{
      if(completion)return null;
      const snapshot=await rpc.request('thread/read',{threadId,includeTurns:true},30000);
      const turn=snapshot?.thread?.id===threadId?snapshot.thread.turns?.find(t=>t.id===turnId):null;
      return !completion&&['inProgress','running','active'].includes(turn?.status)?{pending:true,turnId}:null;
    }});
    if (aborted) abort();
    deadline = deadlineFactory(timing);
    const outcome = await Promise.race([completed, deadline.promise]);
    const status = outcome?.turn?.status ?? completion?.turn?.status;
    // An authoritative failure is a terminal result, not an uncertain transport
    // exception. Preserve completed stages and let quota recovery resume safely.
    if (status === 'failed' && outcome?.turn?.id === turnId) return {
      ...nativeTerminalFailure(outcome.turn), threadId, usage, usageScope: 'lastModelCall',
    };
    if (status !== 'completed') throw new Error(`Codex turn ${status ?? 'unknown'}: ${JSON.stringify(outcome?.turn?.error ?? {})}`);
    if (!finalText) {
      const read = await rpc.request('thread/read', { threadId, includeTurns: true }, 30000);
      const items = read?.thread?.turns?.at(-1)?.items ?? [];
      finalText = items.filter(x => x.type === 'agentMessage').at(-1)?.text ?? '';
    }
    return { threadId, turnId, text: finalText, status, settings: threadSettings, usage, usageScope: 'lastModelCall' };
  } catch (error) {
    if (!create && !admissionAttempted && /already has an active writer/i.test(error.message) && desktopAvailable()) {
      let rolloutPath = null;
      if (sandbox !== 'read-only') {
        try { const read = await rpc.request('thread/read', { threadId, includeTurns: false }, 30000); if (read.thread?.id === threadId) rolloutPath = read.thread.path; }
        catch { /* Preflight reports unavailable evidence without a model call. */ }
      }
      await rpc.close();
      return await desktop({ threadId, prompt, onEvent, onAnswer, onActiveReader, onAdmitted: receipt => onAdmitted?.({ ...receipt, ...(rolloutPath ? { rolloutPath } : {}) }), onDispatchState, signal, model, effort, timeoutMs: timing.maxMs, idleTimeoutMs: timing.idleMs, deadlineFactory,
        beforeDispatch: async ({ thread } = {}) => {
          let issue;
          try { issue = desktopDispatchIssue(thread?.id === threadId ? thread : null, { cwd }); }
          catch { issue = '无法解析原生会话权限记录'; }
          if (issue) throw Object.assign(Error(`${issue}。本次未调用模型，需要维护方核对会话绑定与当前工作树；这不是权限选择器问题，无需重复改权限或重启。`), { code: 'GROUP_NOT_ADMITTED', admissionFailure: 'codex_setup' });
        },
      });
    }
    // Setup failed before a model request was even sent. Transport failures
    // after turn/start remain uncertain, even if they mention writer contention.
    if (!create && !admissionAttempted) {
      error.code = 'GROUP_NOT_ADMITTED';
      if (!signal?.aborted) error.admissionFailure = /already has an active writer/i.test(error.message) ? 'codex_busy' : 'codex_setup';
    }
    throw error;
  } finally { releaseActiveReader?.(); deadline?.close(); preview.close(); signal?.removeEventListener('abort', abort); await rpc.close(); }
}

export async function codexCreateThread({ cwd, model = DEFAULT_MODEL, rpcFactory = openAppServer }) {
  const rpc = rpcFactory(cwd);
  try {
    await initialize(rpc);
    const result = await rpc.request('thread/start', { cwd, model, approvalPolicy: DEFAULT_APPROVAL_POLICY, sandbox: DEFAULT_SANDBOX, serviceName: 'codex_deepseek_harness_group' }, 30000);
    return result.thread.id;
  } finally { await rpc.close(); }
}

export async function codexRecoverDelivery({ threadId, cwd, prompt, nativeTurnId, allowSupersededReadOnly=false, refusal, signal, rpcFactory = openAppServer, desktopAvailable = desktopBridgeAvailable, desktopRecover = recoverDesktopDelivery }) {
  const rpc = rpcFactory(cwd);
  try {
    await initialize(rpc);
    const readThread = async () => {
      const read = await rpc.request('thread/read', { threadId, includeTurns: true }, 30000);
      if (read?.thread?.id !== threadId || !Array.isArray(read.thread.turns)) throw new Error('Native recovery did not return the complete original thread.');
      return read.thread;
    };
    let thread = await readThread();
    let turn = thread.turns.findLast(t => matchesCodexDelivery(t, threadId, prompt) || nativeTurnId&&t.id===nativeTurnId);
    if(!turn&&desktopAvailable()){
      const actual=await desktopRecover({threadId,prompt,nativeTurnId,allowIdleProof:allowSupersededReadOnly});
      if(actual&&!actual.unmatched)return actual;
      if(allowSupersededReadOnly&&actual?.unmatched&&actual.idle&&actual.threadId===threadId&&thread.turns.every(t=>['completed','interrupted','failed'].includes(t.status)))
        return {supersededReadOnly:true,proof:{kind:'superseded-readonly-unmatched',threadId,completeNativeTurnCount:thread.turns.length,desktopStatus:actual.status}};
    }
    if (!turn && refusal?.kind === 'desktop-pre-dispatch-busy' && refusal.threadId === threadId && refusal.auditMessageId && prompt.startsWith(`[Group delivery ${refusal.deliveryId}]\n`) && ['idle','notLoaded'].includes(thread.status?.type) && thread.turns.every(t => ['completed','interrupted','failed'].includes(t.status))) return { notAdmitted: true, proof: refusal };
    if (!turn) {
      // Legacy checkpoints lacked a typed pre-admission receipt. Absence alone
      // proves nothing: require the original server-owned writer-refusal audit,
      // acquire the exclusive native writer, then read the full idle history again.
      if (signal?.aborted || refusal?.kind !== 'codex-writer-refusal' || refusal.threadId !== threadId ||
          !refusal.auditMessageId || !prompt.startsWith(`[Group delivery ${refusal.deliveryId}]\n`)) return null;
      try { await rpc.request('thread/resume', { threadId, cwd, excludeTurns: false }, 30000); }
      catch (error) { if (/already has an active writer/i.test(error.message)) return null; throw error; }
      thread = await readThread();
      turn = thread.turns.findLast(t => matchesCodexDelivery(t, threadId, prompt));
      if (!turn) {
        if (signal?.aborted || thread.status?.type !== 'idle' || thread.turns.some(t => !['completed', 'interrupted', 'failed'].includes(t.status))) return null;
        return { notAdmitted: true, proof: { ...refusal, verifiedAt: new Date().toISOString(), turnCount: thread.turns.length } };
      }
    }
    const messages = turn.items.filter(i => i.type === 'agentMessage');
    const final = messages.findLast(i => ['final_answer', 'final'].includes(i.phase)) ?? messages.at(-1);
    const text = final?.text;
    if (['inProgress', 'running', 'active'].includes(turn.status)) return { pending: true, turnId: turn.id };
    if (['interrupted', 'failed'].includes(turn.status) && desktopAvailable()) {
      const authoritative = await desktopRecover({ threadId, prompt, nativeTurnId });
      if (authoritative) return authoritative;
      return null;
    }
    if (turn.status==='failed') return nativeTerminalFailure(turn);
    if (turn.status==='interrupted') return { text: text || `Codex 原生 turn 已${turn.status}；续跑前检查文件和命令现场。`, usage: null, interrupted: true, turnId: turn.id };
    if (turn.status !== 'completed' || final?.truncated || final?.textTruncated) return null;
    return text ? { text, usage: null, turnId: turn.id, recovered: true } : emptyNativeTurn(threadId,turn,nativeTurnId);
  } catch (error) {
    // Recovery performs reads only. An unavailable connection is not another
    // inconclusive native result and must not spend the outcome-read budget.
    if (isDesktopConnectionError(error)) error.code = 'GROUP_RECOVERY_UNAVAILABLE';
    throw error;
  } finally { await rpc.close(); }
}

// Native Codex sidebar sections are server-owned. Create (or reuse) the
// "Codex × Harness" section and move the collaboration thread into it. This
// replaces the previous instruction that asked the model to use non-existent
// "thread tools"; the operation is idempotent and verifiable via thread/read.
export async function codexOrganizeThread({ threadId, cwd, title, sectionName = 'Codex × Harness', sandbox = DEFAULT_SANDBOX, approvalPolicy = DEFAULT_APPROVAL_POLICY, rpcFactory = openAppServer }) {
  if (rpcFactory === openAppServer && desktopBridgeAvailable()) return organizeDesktopThread({ threadId, title, sectionName });
  sandbox = normalizeSandbox(sandbox);
  const rpc = rpcFactory(cwd);
  try {
    await initialize(rpc);
    await restoreThread(rpc, threadId);
    const resumed = await rpc.request('thread/resume', { threadId, cwd, excludeTurns: true, sandbox, approvalPolicy }, 30000);
    const settings = settingsFromResume(resumed);
    const sections = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const listed = await rpc.request('threadSection/list', { limit: 100, cursor }, 30000);
      sections.push(...(listed?.data ?? []));
      cursor = listed?.nextCursor ?? null;
      if (!cursor) break;
    }
    let section = sections.find(item => item.name === sectionName) ?? null;
    let created = false;
    if (!section) {
      const result = await rpc.request('threadSection/create', { name: sectionName }, 30000);
      section = result.section;
      created = true;
    }
    if (!section?.id) throw new Error('Codex did not return a sidebar section ID.');
    if (resumed?.thread?.section?.id !== section.id) {
      await rpc.request('thread/section/move', { threadId, sectionId: section.id }, 30000);
    }
    if (title) await rpc.request('thread/name/set', { threadId, name: title }, 30000);
    const read = await rpc.request('thread/read', { threadId, includeTurns: false }, 30000);
    const actual = read?.thread?.section ?? null;
    if (actual?.id !== section.id) throw new Error('Codex did not persist the sidebar section move.');
    if (title && read?.thread?.name !== title) throw new Error('Codex did not persist the group session title.');
    return { section: actual, created, settings, verified: true };
  } finally { await rpc.close(); }
}

export async function codexUserTurns({ threadId, cwd }) {
  const rpc = openAppServer(cwd);
  try {
    await initialize(rpc);
    const read = await rpc.request('thread/read', { threadId, includeTurns: true }, 30000);
    return (read?.thread?.turns ?? []).flatMap(turn => (turn.items ?? []).filter(item => item.type === 'userMessage').map(item => ({ turnId: turn.id, itemId: item.id, status: turn.status, text: (item.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n') })));
  } finally { await rpc.close(); }
}

export async function codexEffortCatalog({cwd,rpcFactory=openAppServer}) {
 const rpc=rpcFactory(cwd);try {await initialize(rpc);const data=[];let cursor=null;for(let i=0;i<20;i++){const page=await rpc.request('model/list',{limit:100,cursor},30000);data.push(...(page.data??[]));cursor=page.nextCursor;if(!cursor)return {data};}throw Error('Incomplete model catalog.');}finally{await rpc.close();}
}
