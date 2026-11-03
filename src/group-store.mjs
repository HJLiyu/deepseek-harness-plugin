import {executionView,viewKey,mergeExecution} from './parallel-dispatch.mjs';
import {AdmissionLedger} from './group-admission.mjs';
import {invalidateTasks} from './task-list.mjs';
import {laneRequest,prepareLaneSave} from './task-lanes.mjs';
import { currentDiagnostics } from './integration-diagnostics.mjs';
import { goalHoldCommands } from './goal-holds.mjs';
import { looksLikeCommand } from './approval-text.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { dataDir, newGoalId, assertGoalId } from './state.mjs';

const json = value => JSON.stringify(value);
const decode = row => row ? JSON.parse(row.value) : null;
function hasRecordId(id) {
  if (id === undefined || id === null) return false;
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('记录编号必须是非空字符串。');
  return true;
}
export const members = ['codex', 'harness'];
export function isStatusOnlyInput(content) {
 const text=String(content??'').trim().replace(/^补充[：:]\s*/, '');
 return /^(?:目前的?情况|当前情况|查看进度|检查当前状态|查看任务详情)[？?。]?$/.test(text) || text === '请先排查当前受阻原因，用通俗中文说明卡在哪一步、由谁处理、有哪些选项及推荐方案；能在现有授权内解决的继续处理，需要额外权限则列出具体操作。不要重复执行结果未知的操作。';
}
export class GroupStore {
  constructor(file = path.join(dataDir, 'groups.sqlite')) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_group ON requests(group_id);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,group_id TEXT NOT NULL,
        origin TEXT UNIQUE,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id,seq);
      CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scope_grants(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scope_reservations(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scope_native_events(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_calls(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tool_calls_group ON tool_calls(group_id);
      CREATE TABLE IF NOT EXISTS integrations(repo TEXT PRIMARY KEY,request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admission_reservations(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_leases(group_id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS permissions(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,value TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  admissions() { return new AdmissionLedger(this); }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  group(id) {
    assertGoalId(id);
    const group = decode(this.db.prepare('SELECT value FROM groups WHERE id=?').get(id));
    if (!group) throw new Error(`Unknown group: ${id}`);
    return group;
  }
  list() { return this.db.prepare('SELECT value FROM groups ORDER BY rowid DESC LIMIT 100').all().map(decode); }
  *allGroups() {
    let after = 0;
    const page = this.db.prepare('SELECT rowid AS cursor,value FROM groups WHERE rowid>? ORDER BY rowid LIMIT 100');
    while (true) {
      const rows = page.all(after);
      for (const row of rows) yield decode(row);
      if (rows.length < 100) return;
      after = rows.at(-1).cursor;
    }
  }
  save(group) {
    assertGoalId(group.id);
    group.updatedAt = new Date().toISOString();
    this.db.prepare('INSERT INTO groups VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(group.id, json(group));
    return group;
  }
  create(input) {
    const group = { id: newGoalId(), title: input.title || 'Codex × Harness', repo: input.repo,
      models: input.models, contexts: { codex: null, harness: null }, worktrees: {}, branches: {},
      cursors: { codex: 0, harness: 0 }, initialized: { codex: false, harness: false },
      maxDiscussionRounds: input.maxDiscussionRounds ?? 3, compactThresholdChars: input.compactThresholdChars ?? 48000,
      status: 'initializing', activeRequestId: null, epoch: 0, createdAt: new Date().toISOString(),
      capabilities: { codexNative: 'unverified', harnessNative: 'unverified', hardTokenLimit: 'unavailable' } };
    return this.transaction(() => this.save(group));
  }
  request(id) { if (!hasRecordId(id)) return null; return laneRequest(decode(this.db.prepare('SELECT value FROM requests WHERE id=?').get(id))); }
  requestInLane(id,key) { const r=this.request(id);return r?executionView(r,key):null; }
  requestForDelivery(id,deliveryId) { const r=this.request(id);if(!r)return null;const d=this.delivery(deliveryId);const key=Object.values(r.lanes||{}).find(l=>l.deliveryId===deliveryId)?.key??(d?.requestId===id?d.laneKey:null);return key&&r.lanes[key]&&key!==r.activeLaneKey?executionView(r,key):r; }
  saveRequest(request) {
    if(viewKey(request)){const root=this.request(request.id);request=mergeExecution(root,request);}
    prepareLaneSave(request);
    invalidateTasks(request);
    if (!currentDiagnostics(request)) delete request.errorDetails;
    if (['completed','cancelled'].includes(request.status)) { delete request.workBaselines; delete request.workCandidates; delete request.readinessBaseline; }
    // Cleanup deletes compatibility properties too; persist those deletions in
    // their lane before serializing, so a later read cannot revive old facts.
    prepareLaneSave(request);
    this.db.prepare('INSERT INTO requests VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(request.id, request.groupId, json(request));
    return request;
  }
  requests(groupId) { return this.db.prepare('SELECT value FROM requests WHERE group_id=? ORDER BY rowid').all(groupId).map(row=>laneRequest(decode(row))); }
  reconcileGoalHolds(request) {
    if (!request.goal) return {};
    const allowed = new Set(request.goal.requirements.map(r => r.id));
    const records = [request.messageId, ...request.supplements].map(id => this.messageById(id))
      .filter(m => m?.sender === 'human' && m.groupId === request.groupId && m.requestId === request.id)
      .sort((a, b) => a.seq - b.seq);
    const holds = {};
    for (const message of records) for (const command of goalHoldCommands(message.content)) {
      if (allowed.size && !allowed.has(command.id)) continue;
      holds[command.id] = { state: command.state, messageId: message.id, seq: message.seq,
        textHash: this.hash(message.content), timestamp: message.timestamp };
    }
    // Reconstruct from real input records, never from an agent's checklist or
    // task prose. This also migrates pre-update demands without a DB rewrite.
    request.goal.humanHolds = holds;
    return holds;
  }
  recentRequests(groupId, limit = 100) { return this.recentRecords('requests', groupId, limit).map(laneRequest); }
  recentPermissions(groupId, limit = 50) { return this.recentRecords('permissions', groupId, limit); }
  recentRecords(table, groupId, limit) {
    if (!['requests', 'permissions'].includes(table) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error('Invalid recent-record query.');
    return this.db.prepare(`SELECT value FROM ${table} WHERE group_id=? ORDER BY rowid DESC LIMIT ?`).all(groupId, limit).reverse().map(decode);
  }
  hasOpenRequests(groupId, { queuedOnly = false } = {}) {
    return Boolean(this.db.prepare(`SELECT 1 FROM requests WHERE group_id=? AND ${queuedOnly ? "json_extract(value,'$.status')='queued'" : "json_extract(value,'$.status') NOT IN ('completed','cancelled')"} LIMIT 1`).get(groupId));
  }
  hasPendingScopes(groupId) {
    const group=this.group(groupId),request=this.request(group.activeRequestId);if(!request||['completed','cancelled'].includes(request.status))return false;
    return this.db.prepare("SELECT value FROM scope_grants WHERE group_id=? AND json_extract(value,'$.status')='pending'").all(groupId).some(row=>{const g=JSON.parse(row.value);return g.contract.requestId===request.id&&g.contract.revision===request.revision&&g.contract.epoch===group.epoch&&g.contract.expiresAt>Date.now();});
  }
  pendingPermissions(groupId) {
    return this.db.prepare("SELECT value FROM permissions WHERE group_id=? AND json_extract(value,'$.status')='pending' ORDER BY rowid").all(groupId).map(decode);
  }
  message(groupId, input) {
    const origin = input.origin ? json([groupId, input.origin.adapter, input.origin.sessionId, input.origin.messageId]) : null;
    if (input.origin && (!input.origin.adapter || !input.origin.sessionId || !input.origin.messageId)) throw new Error('Stable origin adapter, session and message IDs are required.');
    if (origin) {
      const previous = decode(this.db.prepare('SELECT value FROM messages WHERE origin=?').get(origin));
      if (previous) {
        if (previous.content !== input.content || previous.sender !== input.sender || previous.channel !== input.channel || (previous.inputMode ?? 'new') !== (input.inputMode ?? 'new')) throw new Error('Origin ID reused with different content or routing.');
        return { ...previous, duplicate: true };
      }
    }
    if (!['human', 'codex', 'harness', 'system'].includes(input.sender)) throw new Error('Invalid sender.');
    if (!['group', 'collaboration'].includes(input.channel)) throw new Error('Invalid channel.');
    if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 256000) throw new Error('Message must contain 1–256000 characters.');
    const message = { ...input, id: input.id ?? randomUUID(), groupId, timestamp: new Date().toISOString() };
    const result = this.db.prepare('INSERT INTO messages(id,group_id,origin,value) VALUES(?,?,?,?)').run(message.id, groupId, origin, json(message));
    message.seq = Number(result.lastInsertRowid);
    this.db.prepare('UPDATE messages SET value=? WHERE id=?').run(json(message), message.id);
    return message;
  }
  messages(groupId, { after = 0, before, limit = 100, channel } = {}) {
    this.group(groupId);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid message cursor.');
    limit = Math.max(1, Math.min(200, Number(limit) || 100));
    if (before !== undefined) {
      if (!Number.isSafeInteger(before) || before < 1) throw new Error('Invalid historical cursor.');
      const rows = channel
        ? this.db.prepare("SELECT value FROM messages WHERE group_id=? AND seq<? AND (json_extract(value,'$.channel')=? OR EXISTS(SELECT 1 FROM json_each(messages.value,'$.channels') WHERE value=?)) ORDER BY seq DESC LIMIT ?").all(groupId, before, channel, channel, limit)
        : this.db.prepare('SELECT value FROM messages WHERE group_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(groupId, before, limit);
      const messages = rows.map(decode).reverse();
      return { messages, updates: [], nextCursor: messages.at(-1)?.seq ?? after, previousCursor: messages[0]?.seq ?? before };
    }
    const rows = channel
      ? this.db.prepare("SELECT value FROM messages WHERE group_id=? AND seq>? AND (json_extract(value,'$.channel')=? OR EXISTS(SELECT 1 FROM json_each(messages.value,'$.channels') WHERE value=?)) ORDER BY seq LIMIT ?").all(groupId, after, channel, channel, limit)
      : this.db.prepare('SELECT value FROM messages WHERE group_id=? AND seq>? ORDER BY seq LIMIT ?').all(groupId, after, limit);
    const messages = rows.map(decode);
    const updates = this.db.prepare("SELECT value FROM messages WHERE group_id=? AND seq<=? AND json_type(value,'$.channels')='array' ORDER BY seq DESC LIMIT 50").all(groupId, after).map(decode);
    return { messages, updates, nextCursor: messages.at(-1)?.seq ?? after };
  }
  input(groupId, { content, channel = 'group', mode = 'new', requestId, origin, maxDiscussionRounds, alertTokens, hardTokenLimit, goalRequirements }) {
    if(typeof content==='string'&&/^(?:请)?刷新(?:协作|协议)连接[。.!！]?$/u.test(content.trim()))throw Error('这是连接维护指令，未创建或修改业务任务。请在发起协作的 Codex 聊天请求刷新连接；共享输入不能取得新的宿主凭据。');
    if (typeof content==='string' && /^(?:同意|批准|允许|拒绝|好的|yes|no|ok)[。.!！]?$/iu.test(content.trim())) {
      const activeId=this.group(groupId).activeRequestId;
      if(this.permissions(groupId).some(p=>p.status==='pending'||p.requestId===activeId&&p.resumeIntent?.status==='awaiting_checkpoint'))throw Error('这条简短回复未绑定具体审批，不会作为新需求打断任务。请等待原审批核对完成，并在提示指定的原生会话使用完整审批指令；共享输入不能代替原生批准。');
    }
    if (looksLikeCommand(content)) throw new Error('审批指令须在提示指定的空闲原生会话发送；共享输入和代理标签不能作为批准。');
    if (!['auto', 'new', 'supplement', 'urgent'].includes(mode)) throw new Error('Invalid input mode.');
    if (maxDiscussionRounds !== undefined && (!Number.isInteger(maxDiscussionRounds) || maxDiscussionRounds < 1 || maxDiscussionRounds > 24)) throw new Error('Discussion rounds must be 1–24.');
    for (const value of [alertTokens, hardTokenLimit]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Token thresholds must be positive integers.');
    if (goalRequirements !== undefined && (!Array.isArray(goalRequirements) || !goalRequirements.length || goalRequirements.length > 50 || goalRequirements.some(x=>typeof x !== 'string'||!x.trim()||x.length>2000))) throw Error('完整目标清单须包含1–50项非空原始需求。');
    const goalMode = Boolean(goalRequirements || /全部完成前不要停|完成全部原始需求|全部原始需求.*(?:完成|落实)|直到全部完成/.test(content));
    return this.transaction(() => {
      const group = this.group(groupId);
      if (group.status === 'closed') throw new Error('Group is closed.');
      // Retry identity is checked before resolving automatic routing: the
      // current request may already have completed since the first receipt.
      if (origin) {
        const row = this.db.prepare('SELECT value FROM messages WHERE origin=?').get(json([groupId, origin.adapter, origin.sessionId, origin.messageId]));
        if (row) {
          const previous = decode(row);
          if (previous.content !== content || previous.channel !== channel || previous.sender !== 'human' || (mode !== 'auto' && previous.inputMode !== mode)) throw new Error('Origin ID reused with different content or routing.');
          return { message: { ...previous, duplicate: true }, request: this.request(previous.requestId), progressOnly: Boolean(previous.progressOnly), continuationOnly:Boolean(previous.continuationOnly), duplicate: true };
        }
      }
      if (['auto','supplement'].includes(mode) && isStatusOnlyInput(content) && maxDiscussionRounds===undefined && alertTokens===undefined && hardTokenLimit===undefined) {
        const request=this.request(requestId??group.activeRequestId)??(!requestId?this.requests(groupId).at(-1):null);
        if (requestId && (!request || request.groupId!==groupId)) throw Error('未找到本群的目标任务。');
        const message=this.message(groupId,{sender:'human',channel,content,origin,inputMode:mode,progressOnly:true,...(request?{requestId:request.id}:{})});
        const phase=request?.waitingFor?.phase??request?.actions?.[0]?.phase??request?.phase;
        const stages={planning:'协商分工',work:'执行任务',review:'复核',integrate:'整合',execution:'执行'};
        const states={completed:'已完成',blocked:'需处理',needs_decision:'需处理',awaiting_review:'等待前置任务',needs_recovery:'等待核对原回复',active:'执行中',queued:'排队中',awaiting_approval:'等待批准'};
        let reason=request?.error||'';
        if (/Main project integration conflict|Member integration conflict/.test(reason)) reason='整合检查发现文件差异，现场已保留；应先核对差异和授权范围。';
        if (/整合起点缺少/.test(reason)) reason='调度器未识别已有的整合指令，尚未派发整合；这是调度衔接问题。';
        this.message(groupId,{sender:'system',channel,requestId:request?.id,content:request?'当前进度：'+(stages[phase]||'等待调度')+'；'+(states[request.status]||request.status)+'。'+(reason?'\n原因：'+reason:'')+'\n本次仅查询进度，保留原计划、检查点和授权；没有重新派发或批准操作。详情可在“任务”中展开。':'当前没有项目任务。你可以直接发送新的需求。'});
        return {message,request,progressOnly:true,duplicate:false};
      }
      if (mode === 'auto') {
        const current = this.request(group.activeRequestId);
        requestId ??= current && !['completed', 'cancelled'].includes(current.status) ? current.id : this.requests(groupId).filter(r => r.status === 'queued').at(-1)?.id;
        mode = requestId ? 'supplement' : 'new';
      }
      const fallback = mode === 'supplement' && !requestId && !group.activeRequestId ? this.requests(groupId).filter(r => r.status === 'queued').at(-1)?.id : null;
      const target = mode === 'supplement' ? this.request(requestId ?? group.activeRequestId ?? fallback) : null;
      if (mode === 'supplement' && (!target || target.groupId !== groupId || ['completed', 'cancelled'].includes(target.status))) throw new Error('当前没有可补充的任务，或目标任务已结束。请切换为“自动”或“独立新需求”后发送。');
      if(target&&!target.humanDecisions?.length&&goalRequirements===undefined&&maxDiscussionRounds===undefined&&alertTokens===undefined&&hardTokenLimit===undefined&&/^(?:补充[：:]\s*)?(?:继续|接着|继续推进|批准|同意)[。！!\s]*$/.test(content.trim())){
        const message=this.message(groupId,{sender:'human',channel,content,requestId:target.id,inputMode:mode,origin,continuationOnly:true});
        return {message,request:target,continuationOnly:true,duplicate:false};
      }
      const id = target?.id ?? randomUUID();
      const message = this.message(groupId, { sender: 'human', channel, ...(channel === 'group' ? { channels: ['group', 'collaboration'] } : {}), content, requestId: id, inputMode: mode, origin });
      if (message.duplicate) return { message, request: this.request(message.requestId), duplicate: true };
      if (target) {
        delete target.nextRecoveryAt; delete target.error;
        if (target.deliveryId) { const d = this.delivery(target.deliveryId); if (d) { d.recoveryAttempts = 0; this.saveDelivery(d); } }
        target.results = {};
        delete target.humanDecisions; delete target.schedulingResolution;
        // A supplement continues the same task. Keep its original byte
        // baseline so saved partial work is still included after login or
        // clarification; invalidate decisions/candidates, not task provenance.
        delete target.workCandidates; delete target.integrationScope;
        delete target.readinessBaseline;delete target.integrationReadyReceipt;
        if (goalMode) target.goal = { requirements: goalRequirements?.map((title,i)=>({id:'R'+String(i+1).padStart(2,'0'),title})) ?? target.goal?.requirements ?? [], cycles:0, history:[] };
        target.deferred = [];
        target.supplements.push(message.id); target.status = 'queued'; target.phase = 'planning'; target.plans = {};
        delete target.integrationConsent; target.actions = []; target.reviewRepairRounds = 0; target.discussionRounds = 0; target.revision++; delete target.previousPlans;
        group.epoch++; this.saveRequest(target);
      } else {
        this.saveRequest({ id, groupId, messageId: message.id, supplements: [], priority: mode === 'urgent' ? 1 : 0,
          status: 'queued', phase: 'planning', plans: {}, actions: [], results: {}, discussionRounds: 0,
          ...(goalMode ? { goal: { requirements:goalRequirements?.map((title,i)=>({id:'R'+String(i+1).padStart(2,'0'),title})) ?? [],cycles:0,history:[] } } : {}),
          maxDiscussionRounds: maxDiscussionRounds ?? group.maxDiscussionRounds, revision: 0,
          usage: { knownTokens: 0, unknownCalls: 0, calls: 0 }, alertTokens: alertTokens ?? null,
          hardTokenLimit: hardTokenLimit ?? null, createdAt: message.timestamp });
        if (mode === 'urgent' && group.activeRequestId) {
          const current = this.request(group.activeRequestId);
          if (current && !['completed', 'cancelled'].includes(current.status)) { current.status = 'queued'; delete current.nextRecoveryAt; this.saveRequest(current); }
          group.activeRequestId = null; group.epoch++;
        }
      }
      const saved = this.request(id);
      if (saved.goal) {
        this.reconcileGoalHolds(saved);
        // A requirement-control message needs a fresh audit of the retained
        // ledger, not a new execution of the original plan. Keep any native
        // delivery checkpoint so existing recovery rules still run first.
        if (saved.goal.checklist?.length && saved.agreement && goalHoldCommands(content)
          .some(c => saved.goal.requirements.some(r => r.id === c.id))) {
          saved.phase = 'execution';
          saved.actions = [{ phase: 'review', member: members.find(m => m !== saved.agreement.integrator), goalAudit: true }];
        }
        this.saveRequest(saved);
      }
      this.save(group);
      return { message, request: this.request(id), duplicate: false };
    });
  }
  delivery(id) { if (!hasRecordId(id)) return null; return decode(this.db.prepare('SELECT value FROM deliveries WHERE id=?').get(id)); }
  permission(id) { if (!hasRecordId(id)) return null; return decode(this.db.prepare('SELECT value FROM permissions WHERE id=?').get(id)); }
  permissions(groupId) { return this.db.prepare('SELECT value FROM permissions WHERE group_id=? ORDER BY rowid').all(groupId).map(decode); }
  savePermission(record) { this.db.prepare('INSERT INTO permissions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(record.id, record.groupId, json(record)); }
  saveDelivery(delivery) {
    const request=this.request(delivery.requestId);
    if(request && !delivery.laneKey)delivery.laneKey=request.activeLaneKey;
    this.db.prepare('INSERT INTO deliveries VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(delivery.id, delivery.groupId, json(delivery));
  }
  messageById(id) { if (!hasRecordId(id)) return null; return decode(this.db.prepare('SELECT value FROM messages WHERE id=?').get(id)); }
  shareMessage(id, channel) {
    const message = this.messageById(id);
    if (!message || !['group', 'collaboration'].includes(channel)) throw new Error('Unknown message or channel.');
    message.channels = [...new Set([message.channel, ...(message.channels ?? []), channel])];
    this.db.prepare('UPDATE messages SET value=? WHERE id=?').run(json(message), id);
  }
  bindings() { return this.db.prepare("SELECT value FROM groups WHERE json_extract(value,'$.status')!='closed'").all().map(decode); }
  originFor(adapter, sessionId) {
    if (!members.includes(adapter)) throw new Error('Invalid adapter.');
    return decode(this.db.prepare("SELECT value FROM groups WHERE json_extract(value,?)=? AND json_extract(value,'$.status')!='closed' LIMIT 1").get(`$.contexts.${adapter}`, sessionId));
  }
  hash(value) { return createHash('sha256').update(value).digest('hex'); }
  claimWorker(groupId, owner, now = Date.now()) {
    return this.transaction(() => {
      const lease = this.db.prepare('SELECT owner,expires FROM worker_leases WHERE group_id=?').get(groupId);
      if (lease && lease.owner !== owner && lease.expires > now) return false;
      this.db.prepare('INSERT INTO worker_leases VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(groupId, owner, now + 45000);
      return true;
    });
  }
  renewWorker(groupId, owner) { return Number(this.db.prepare('UPDATE worker_leases SET expires=? WHERE group_id=? AND owner=?').run(Date.now() + 45000, groupId, owner).changes); }
  releaseWorker(groupId, owner) { this.db.prepare('DELETE FROM worker_leases WHERE group_id=? AND owner=?').run(groupId, owner); }
}
