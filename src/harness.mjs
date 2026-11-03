import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { RpcProcess } from './rpc.mjs';
import { goalDir } from './state.mjs';

const PROMPT_TIMEOUT_MS = Math.max(60000, Number(process.env.HARNESS_TURN_TIMEOUT_MS) || 30 * 60 * 1000);
const INITIALIZE_TIMEOUT_MS = Math.max(30000, Math.min(300000, Number(process.env.HARNESS_INITIALIZE_TIMEOUT_MS) || 90000));
const MAX_TOOL_DETAIL_CHARS = 12000;

export async function initializeHarness(rpc, onEvent, timeoutMs = INITIALIZE_TIMEOUT_MS) {
  const start = Date.now();
  onEvent?.({ side: 'Harness', type: 'connection_starting', stage: 'initialize', timeoutMs });
  try {
    const result = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'codex-harness-plugin', title: 'Codex Harness Plugin', version: '0.2.1' } }, timeoutMs);
    onEvent?.({ side: 'Harness', type: 'connection_ready', stage: 'initialize', elapsedMs: Date.now() - start });
    return result;
  } catch (error) {
    throw new Error(`Harness ACP initialize: ${error.message}`);
  }
}

function safeToolDetail(value, scrub) {
  if (value === undefined) return undefined;
  let text;
  try { text = scrub(JSON.stringify(value)); }
  catch { text = scrub(String(value)); }
  if (text.length > MAX_TOOL_DETAIL_CHARS) text = `${text.slice(0, MAX_TOOL_DETAIL_CHARS)}…[truncated]`;
  try { return JSON.parse(text); }
  catch { return text; }
}

export function createToolCallTracker(scrub = String) {
  const values = new Map();
  return {
    record(update = {}) {
      const id = update.toolCallId;
      if (!id) return null;
      const previous = values.get(id) ?? { toolCallId: id };
      const next = { ...previous };
      for (const key of ['title', 'kind', 'status', 'rawInput', 'content', 'locations']) {
        if (update[key] !== undefined) next[key] = safeToolDetail(update[key], scrub);
      }
      values.set(id, next);
      return next;
    },
    enrich(toolCall = {}) {
      const id = toolCall.toolCallId;
      return { ...(id ? values.get(id) : null), ...safeToolDetail(toolCall, scrub) };
    },
  };
}

function harnessInstall() { return process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'); }
function credential() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  const root = harnessInstall();
  const require = createRequire(path.join(root, 'package.json'));
  const yaml = require('js-yaml');
  const file = process.env.DSH_CREDENTIALS_PATH ?? path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const value = yaml.load(fs.readFileSync(file, 'utf8'))?.refs?.DEEPSEEK_API_KEY;
  if (!value) throw new Error('No existing DeepSeek API credential was found.');
  return value;
}

// The ACP model option is a serialized provider/model pair, not the short name
// users pass to start_collaboration. Resolve a friendly model name (or an exact
// option value) to the value the server advertises.
export function resolveModelValue(configOptions, requested) {
  if (!requested) return null;
  const model = (configOptions ?? []).find(option => option.id === 'model');
  if (!model) return null;
  const candidates = [];
  for (const option of model.options ?? []) {
    if (Array.isArray(option.options)) candidates.push(...option.options);
    else candidates.push(option);
  }
  for (const candidate of candidates) {
    let parsed = candidate.value;
    try { parsed = JSON.parse(candidate.value); } catch { /* keep string */ }
    if (candidate.value === requested || candidate.name === requested || (Array.isArray(parsed) && parsed.includes(requested))) {
      return candidate.value;
    }
  }
  const names = candidates.map(option => option.name ?? option.value).filter(Boolean);
  throw new Error(`Unknown DeepSeek model "${requested}". Available models: ${names.join(', ')}`);
}

export async function harnessTurn(goal, prompt, { onEvent, onPermission, onSession } = {}) {
  const key = credential();
  const root = harnessInstall();
  const runtimeHome = path.join(goalDir(goal.id), 'dsh');
  fs.mkdirSync(runtimeHome, { recursive: true });
  let sessionId = goal.harnessSessionId;
  let answer = '';
  let configOptions = [];
  const toolEvents = [];
  const titles = new Map();
  const scrub = value => String(value).split(key).join('[redacted]');
  const toolCalls = createToolCallTracker(scrub);
  const env = { ...process.env, DSH_HOME: runtimeHome, DEEPSEEK_API_KEY: key };
  // Do not leak the parent ACP session identity into the child harness.
  env.DSH_SESSION_ID = undefined;
  const rpc = new RpcProcess(process.execPath, [path.join(root, 'lib', 'bin.js'), '--profile', 'acp'], {
    cwd: goal.harnessWorktree,
    env,
    jsonrpc: true,
    onNotification(method, params) {
      if (method !== 'session/update' || params?.sessionId !== sessionId) return;
      const update = params.update ?? {};
      if (update.sessionUpdate === 'agent_message_chunk') answer += update.content?.text ?? '';
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        const id = update.toolCallId;
        toolCalls.record(update);
        if (update.title) titles.set(id, scrub(update.title));
        const event = { type: update.sessionUpdate, toolCallId: id, title: update.title ? scrub(update.title) : titles.get(id) ?? '', status: update.status, kind: update.kind };
        toolEvents.push(event);
        onEvent?.({ side: 'Harness', ...event });
      }
    },
    async onRequest(method, params, requestId) {
      if (method !== 'session/request_permission') throw new Error(`Unsupported Harness request: ${method}`);
      // ACP transport IDs can repeat after reconnect. Bind approval to this
      // exact request, rather than to a reused numeric RPC ID.
      const approvalId = `${sessionId}:${requestId}:${randomUUID()}`;
      const enriched = { ...params, toolCall: toolCalls.enrich(params?.toolCall ?? {}), requestId: approvalId, acpRequestId: requestId };
      onEvent?.({ side: 'Harness', type: 'approval_request', requestId: approvalId, acpRequestId: requestId, title: enriched.toolCall.title ?? '', toolCall: enriched.toolCall, options: params?.options?.map(o => ({ kind: o.kind, name: o.name })) });
      return onPermission?.(enriched) ?? { outcome: { outcome: 'cancelled' } };
    },
  });
  try {
    await initializeHarness(rpc, onEvent);
    if (sessionId) {
      const resumed = await rpc.request('session/resume', { sessionId, cwd: goal.harnessWorktree, mcpServers: [] }, 60000);
      configOptions = resumed?.configOptions ?? [];
    } else {
      const created = await rpc.request('session/new', { cwd: goal.harnessWorktree, mcpServers: [] }, 60000);
      sessionId = created.sessionId;
      configOptions = created.configOptions ?? [];
      onSession?.(sessionId);
    }
    const modelValue = resolveModelValue(configOptions, goal.deepseekModel);
    const modelOption = configOptions.find(option => option.id === 'model');
    if (modelValue && modelValue !== modelOption?.currentValue) {
      await rpc.request('session/set_config_option', { sessionId, configId: 'model', value: modelValue }, 30000);
    }
    const result = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, PROMPT_TIMEOUT_MS);
    if (result.stopReason !== 'end_turn') throw new Error(`Harness turn stopped: ${result.stopReason}`);
    return { sessionId, text: scrub(answer), toolEvents };
  } catch (error) {
    throw new Error(`${scrub(error.message)} ${scrub(rpc.stderr).slice(-1200)}`);
  } finally {
    if (sessionId) await rpc.request('session/close', { sessionId }, 15000).catch(() => {});
    await rpc.close();
  }
}
