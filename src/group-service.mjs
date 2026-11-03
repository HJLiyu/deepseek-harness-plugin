import {effortPolicy} from './effort-policy.mjs';
import {savingsPolicy,savingsStatus,latestSavingsObservation} from './context-savings.mjs';
import {collaborationPolicy,roleSuggestions} from './collaboration-policy.mjs';
import {verifyNativeParallel} from './native-parallel.mjs';
import {qualityMetrics} from './review-quality.mjs';
import {budgetPolicy,calibrationSnapshot,budgetDecision} from './group-budget.mjs';
import {taskListView} from './task-list.mjs';
import {budgetObservation,parallelConfiguration} from './group-observability.mjs';
import {readiness,diskEvidence} from './status-explanation.mjs';
import { explainState } from './status-explanation.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { projectPath } from './git.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dataDir, writeJson, readJson } from './state.mjs';
import { GroupStore } from './group-store.mjs';
import { GroupEngine } from './group-engine.mjs';
import { GroupRuntime, groupSessionTitle } from './group-runtime.mjs';
import { equalSecret, readBody, sendJson, localFetch } from './group-http.mjs';
import { GROUP_PROTOCOL, groupBuildHash, captureGroupBuild } from './group-build.mjs';
import { GroupPermissions } from './group-permissions.mjs';
import { settledGoalWait } from './goal-holds.mjs';
import { readRecordedToolWait } from './codex.mjs';
import { workflowState } from './group-workflow.mjs';
import { connectionPresets } from './model-connections.mjs';

export function groupActivity(store,engine,id,options={}) {
  const result=baseGroupActivity(store,engine,id,options),group=store.group(id);
  // Resolve every checkpoint through its original request/lane. A held resource
  // reservation is only a reference; it is never proof of native execution.
  const references=new Map(),requests=typeof store.requests==='function'?store.requests(id):[];
  for(const request of requests){
    if(request.deliveryId)references.set(request.deliveryId,request);
    for(const lane of Object.values(request.lanes??{}))if(lane.deliveryId)references.set(lane.deliveryId,request);
  }
  if(typeof store.admissions==='function')for(const row of store.admissions().rows()){
    if(row.groupId!==id||row.state!=='held'||references.has(row.deliveryId))continue;
    const request=store.request(row.requestId);if(request?.groupId===id)references.set(row.deliveryId,request);
  }
  const approvals=store.pendingPermissions(id),facts=[];
  for(const [deliveryId,root]of references){
    const d=store.delivery(deliveryId);
    if(!d||d.groupId!==id||d.requestId!==root.id||!['codex','harness'].includes(d.member)||!['pending','unknown','superseded'].includes(d.status))continue;
    const r=store.requestForDelivery?.(root.id,d.id)??root;
    const uncertain=d.status!=='pending'||['needs_recovery','needs_decision','blocked','completed','cancelled','paused'].includes(r.status)||r.recoveryWait?.deliveryId===d.id||Boolean(r.nextRecoveryAt)||r.status==='needs_decision'||Boolean(d.pendingNative);
    const running=d.started===true&&!uncertain&&engine.running.has(id)&&!['paused','closed','apps_closed'].includes(group.status);
    facts.push({d,r,running,uncertain});
  }
  for(const member of result.members){
    const owned=facts.filter(f=>f.d.member===member.id);if(!owned.length)continue;
    const approval=approvals.find(p=>p.member===member.id);
    if(approval){Object.assign(member,{state:'attention',label:'等待你批准'});continue;}
    if(member.state==='attention'&&member.label==='检查原生权限提示')continue;
    const fact=owned.find(f=>f.running)??owned.find(f=>f.d.started)??owned[0];
    // Keep an actionable recovery/connection warning. A generic unsettled
    // checkpoint must not replace its specific cause and human action.
    if(member.state==='attention'&&!fact.running)continue;
    Object.assign(member,{deliveryId:fact.d.id,requestId:fact.d.requestId,phase:fact.d.phase,
      state:fact.running?'busy':'waiting',
      label:fact.running?({planning:'思考回复中',work:'处理任务中',review:fact.r.actions?.[0]?.blockerTriage?'排查阻塞':'复核中',integrate:'整理回复中'}[fact.d.phase]??'回复中'):fact.d.started?'回复待核对':'等待准入',
      executionEvidence:fact.running?'started_pending':fact.d.started?'unsettled_checkpoint':'reservation_only'});
  }
  if(approvals.length){result.needsUser=true;result.detail='需要真人审批，审批对应操作停止；其他成员按各自原投递状态显示，未确认的结果保留检查点。';}
  else if(result.members.filter(m=>m.state==='busy').length>1){result.needsUser=false;result.detail='两个成员的原投递均在执行；分别结算与复核。此状态显示不替代真实并行能力验收。';}
  else if(result.members.some(m=>m.state==='busy')&&result.members.some(m=>m.state==='waiting'&&m.executionEvidence==='unsettled_checkpoint')){result.detail='一位成员仍在执行，另一原投递等待核对；暂停新准入，保留成果和未知检查点。';}
  return result;
}
function baseGroupActivity(store, engine, id, { draining = false } = {}) {
  const group = store.group(id);
  const request = group.activeRequestId ? store.request(group.activeRequestId) : null;
  const delivery = request?.deliveryId ? store.delivery(request.deliveryId) : null;
  const members = ['codex', 'harness'].map(id => ({ id, state: 'idle', label: '待命' }));
  let harnessConnected = null;
  if (typeof engine.runtime?.adapter === 'function') {
    try { harnessConnected = Boolean(engine.runtime.adapter(group)); } catch { harnessConnected = false; }
    members[1].connected = group.peerConnectionId?true:harnessConnected;
  }
  const approval = store.pendingPermissions(id)[0];
  const workflow=workflowState({group,request,delivery,approval,running:engine.running.has(id)});
  const result = { members, detail: '等待你的新需求', workflow };
  const setAll = (state, label, detail) => { for (const m of members) Object.assign(m, { state, label }); result.detail = detail; return result; };
  if (approval) {
    const member = members.find(m => m.id === approval.member);
    if (member) Object.assign(member, { state: 'attention', label: '等待你批准' });
    result.detail = '需要真人审批，批准前不会执行该操作'; return result;
  }
  if (draining && !engine.running.has(id)) return setAll('waiting', '切换版本中', '正在保留原生检查点并切换新版；新消息已保存，切换完成后继续');
  if(workflow.kind==='maintenance'){
    result.needsUser=false;
    return setAll('attention','等待维护修复','调度器内部异常，已停止新派发并保留原任务、原生检查点与审批。由维护方检查和修复；当前无需你批准、重启或反复发送继续。');
  }
  if (delivery?.started && delivery.member==='codex' && readRecordedToolWait(delivery.nativeAdmission?.rolloutPath,delivery.nativeTurnId)) {
    result.needsUser=true;Object.assign(members[0],{state:'attention',label:'检查原生权限提示'});
    result.detail=`“${group.title} · Codex”有申请额外权限的原生工具尚未返回。请打开该聊天检查审批提示；插件待审批列表不包含所有桌面原生审批，不要反复重试或重复发送需求。批准后也可能仍在执行，以原生工具结果为准。`;
    return result;
  }
  if(workflow.kind==='running'&&!['paused','closed','apps_closed'].includes(group.status)){
    const member=members.find(m=>m.id===workflow.member);
    if(member)Object.assign(member,{state:workflow.kind==='running'?'busy':'waiting',label:workflow.kind==='running'?({planning:'思考回复中',work:'处理任务中',review:request.actions?.[0]?.blockerTriage?'排查阻塞':'复核中',integrate:'整理回复中'}[workflow.phase]??'回复中'):'核对原回复'});
    result.needsUser=false;
    result.detail=workflow.kind==='running'?'原生回合正在执行，收到完整回复后自动接续；当前无需你操作。':'原投递已启动，正在核对原结果；检查点保留，未确认前不会重复派发。';
    if(request.actions?.[0]?.blockerTriage)result.detail='独立成员正在只读核对阻塞原因，已有成果和验收要求保留；有可行步骤就接回原执行者，真实外部依赖会明确说明。本阶段不要求真人操作。';
    for(const held of request.deferred??[]){
      if(held.why!=='dependency')continue;
      const consumer=members.find(m=>m.id===held.member);
      if(consumer&&consumer.state!=='busy')Object.assign(consumer,{state:'waiting',label:'等待队友成果'});
      if(held.waitingFor===workflow.member)result.detail=`${workflow.member==='harness'?'Harness':'Codex'} 正在交付前置成果，完成后自动接回 ${held.member==='harness'?'Harness':'Codex'} 补齐剩余工作；已有实现保留，无需真人催进度。`;
    }
    if(draining)result.detail+=' 当前回合继续运行，结束后再安全加载维护更新。';
    return result;
  }
  if (request?.status === 'blocked' && request.nativeFailure?.kind === 'usage_limit') {
    result.needsUser = false;
    Object.assign(members[0], { state: 'waiting', label: 'Codex 额度不足' });
    Object.assign(members[1], { state: 'waiting', label: '等待 Codex 额度恢复' });
    const reset = /try again at ([^\r\n.]+)/i.exec(request.nativeFailure.message ?? '')?.[1];
    result.detail = `Codex 原生回合因额度不足而结束${reset ? `，宿主提示 ${reset} 后再试` : ''}。任务和已保存成果保留，恢复后可重试；当前没有自动续跑计时器，无需调整权限或重启，反复重试不能恢复额度。`;
    return result;
  }
  if (request?.status === 'blocked' && /原生会话最近一轮为 read-only.*当前阶段需要 workspace-write/u.test(request.error ?? '')) {
    result.needsUser = true;
    Object.assign(members[0], { state: 'attention', label: '需要工作区写权限' });
    Object.assign(members[1], { state: 'waiting', label: '等待 Codex 权限调整' });
    result.detail = `当前已进入写文件阶段。请打开“${group.title} · Codex”，将权限设为工作区可写、额外操作需审批，然后重试；未发送本次执行，无需重启或重复描述需求。`;
    return result;
  }
  if(request?.admissionWait?.kind==='desktop_connection'&&request.admissionWait.revision===request.revision&&!delivery?.started&&!['paused','closed'].includes(group.status)){
    result.needsUser=request.admissionWait.state==='needs_refresh';
    return request.admissionWait.state==='needs_refresh'
      ? setAll('attention','需要刷新连接','本次尚未发送。请回到发起协作的 Codex 聊天发送“请刷新协作连接”，由 Codex 检查并更新可信连接；无需重复发送原需求或批准。')
      : setAll('waiting','检查连接中','本次尚未发送，系统正自动进行有限次数的连接检查，使用保存的桌面连接；这不会自动取得新凭据。你现在不需要操作。');
  }
  if (request?.admissionRetryAt > Date.now() && !delivery?.started) return setAll('waiting', '等待会话空闲', 'Codex 原生会话暂被占用，本次尚未投递；正在等待并自动重试，不需要你批准或重复发送需求。');
  if (engine.runtime?.presenceError && !engine.running.has(id) && !['paused', 'closed'].includes(group.status)) {
    return setAll('waiting', '检查应用连接', '暂时无法确认应用是否在线，正在自动重试检测；已保留任务和审批，不会将检测失败视为应用关闭。');
  }
  if (delivery?.started && request?.recoveryWait && request.recoveryWait.deliveryId===delivery.id && request.recoveryWait.state==='needs_refresh') {
    result.needsUser=true;return setAll('attention','需要刷新连接','新要求已保存，但旧执行结果仍未知，连接检查已停止。请回到发起协作的 Codex 聊天发送“请刷新协作连接”；恢复后只核对原投递，不重发原操作。');
  }
  if (delivery?.started && delivery.revision !== request.revision) return setAll('waiting', '新要求已收到', '旧回复将保留但不采用；正在等待原生操作安全结束，再按新要求继续');
  if (delivery?.pendingNative) return setAll('waiting', '原生操作处理中', '原生会话仍在处理已投递消息；新要求已保存，结束后自动接续');
  if(delivery?.started&&request?.status==='needs_decision'&&/恢复次数已达上限/.test(request.error??'')){
    result.needsUser=false;return setAll('attention','等待维护核对','原回复暂时无法确认，需要维护方检查投递记录。没有待批准操作；连接更新后系统会自动重新核对，你无需反复重启、批准或重试。');
  }
  if (group.status === 'needs_recovery' || request?.status === 'needs_recovery') {
    const member = members.find(m => m.id === delivery?.member);
    if (member) Object.assign(member, { state: 'attention', label: '回复待核对' });
    result.needsUser=request?.recoveryWait?.deliveryId===delivery?.id && request?.recoveryWait?.state==='needs_refresh';
    result.detail = request?.recoveryWait && request.recoveryWait.deliveryId===delivery?.id
      ? request.recoveryWait.state==='needs_refresh'
        ? '原执行结果仍未知，检查点已保留。请回到发起协作的 Codex 聊天发送“请刷新协作连接”；连接恢复后只核对原结果，不重发执行。'
        : '原执行结果仍未知，系统正在有限次数核对保存的桌面连接；检查点保留，不重发执行，也不自动取得新凭据。你现在不需要操作。'
      : '系统正在核对原会话中的回复和工具结果，检查点已保留。你现在不需要操作；无法确认的执行不会自动重发。'; return result;
  }
  const goalWait = settledGoalWait(request);
  if (goalWait && !engine.running.has(id) && !['paused', 'closed', 'apps_closed', 'configuring'].includes(group.status)) {
    return setAll('waiting', goalWait.external ? '等待宿主修复' : '按要求暂缓', goalWait.detail);
  }
  const blockedDependency = request?.status === 'awaiting_review' && request.deferred?.find(item => item.why === 'blocked');
  if (blockedDependency && !engine.running.has(id) && !delivery?.started && !['paused', 'closed', 'apps_closed', 'configuring'].includes(group.status)) {
    const member = members.find(m => m.id === blockedDependency.member);
    if (member) Object.assign(member, { state: 'attention', label: '前置任务受阻' });
    for (const other of members.filter(m => m !== member)) Object.assign(other, { state: 'waiting', label: '等待前置修复' });
    const cause = request.results?.[`${blockedDependency.phase}:${blockedDependency.member}`];
    const reason = String(blockedDependency.reason || cause?.summary || request.error || '前置任务失败');
    result.detail = blockedDependency.member === 'harness' && /0xC0000142|3221225794/i.test(reason)
      ? 'Harness 报告终端无法启动（0xC0000142）。当前没有运行，也没有等待你批准。需要修复 Harness 宿主的命令启动环境，修复后再重试；重复批准或重试不能消除故障。原回复和待办已保留。'
      : `${blockedDependency.member === 'harness' ? 'Harness' : 'Codex'}：${reason.slice(0, 1200)}。当前没有运行；修复原因后使用“重试”，不要重复发送批准。`;
    return result;
  }
  const stopped = { paused: ['已暂停', '协作已暂停，继续后处理待办'], apps_closed: ['等待上线', '应用重新上线后继续'], closed: ['已结束', '本群已结束'], blocked: ['需处理', '任务受阻，请查看任务详情'], awaiting_review: ['等待依赖', '待办已保留，等待依赖完成或补充当前要求'], needs_decision: ['待决定', '双方存在未决项，需要你决定'], setup_failed: ['连接失败', '请查看连接与原始状态'], initializing: ['正在连接', '正在建立两个专用会话'], configuring: ['更新设置', '正在更新模型设置'] }[['paused','closed','apps_closed','configuring'].includes(group.status)?group.status:['blocked','needs_decision','awaiting_review'].includes(request?.status)?request.status:group.status];
  if(workflow.kind==='blocked'&&request?.errorDetails?.human?.needsUser===false){
    const detail=request.errorDetails.human;result.needsUser=false;
    return setAll('attention','等待维护核对',`${detail.detail} 负责处理：${detail.owner}。${detail.next} 当前没有运行，也没有待批准操作；无需重复发送批准或重启。`);
  }
  if (stopped) {
    const state = setAll(['blocked', 'needs_decision', 'setup_failed'].includes(group.status) ? 'attention' : 'waiting', ...stopped);
    if (request?.humanDecisions?.length && request.status === 'needs_decision') state.detail = '需要你决定：' + request.humanDecisions[0].question;
    return state;
  }
  if (engine.runtime?.adapterUpdates?.get(group.harnessAdapterId)?.expiresAt > Date.now() && !engine.running.has(id)) {
    return setAll('waiting', '更新中', '正在更新协作适配器，已保留需求；完成后自动接续');
  }
  if (request?.phase === 'planning' && !['completed', 'cancelled'].includes(request.status)) {
    for (const member of members) if (request.plans?.[member.id]) Object.assign(member, { state: 'waiting', label: '已回复，等对方' });
  }
  if (engine.running.has(id) && delivery?.status === 'pending') {
    const member = members.find(m => m.id === delivery.member);
    const label = delivery.started ? (request.actions?.[0]?.blockerTriage ? '排查阻塞' : request.actions?.[0]?.goalAudit ? '核对全部需求' : request.actions?.[0]?.diagnostic ? '排查整合差异' : { planning: '思考回复中', work: '处理任务中', review: '复核中', integrate: '整理回复中' }[delivery.phase] || '回复中') : '准备回复';
    if (member) Object.assign(member, { state: 'busy', label });
    result.detail = request.actions?.[0]?.goalAudit ? '本轮验收已结束，正在核对完整目标；未完成的原始需求会自动继续' : request.actions?.[0]?.diagnostic ? '整合者正在只读核对文件差异；当前无需你操作，结论将显示在协作区' : delivery.started ? '收到完整回复后会显示在对话中' : '正在准备本次协作';
    if(request.actions?.[0]?.blockerTriage)result.detail='独立成员正在只读核对阻塞原因，已有成果和验收要求保留；有可行步骤就接回原执行者，真实外部依赖会明确说明。本阶段不要求真人操作。';
  } else if (store.hasOpenRequests(id)) {
    const next = request && engine.nextMember?.(group, request);
    if (next) {
      const member = members.find(m => m.id === next); Object.assign(member, { state: 'waiting', label: '等待回复' });
      result.detail = `等待 ${next === 'harness' ? 'DeepSeek（Harness）' : 'Codex'} 接续，收到对方回复后再共同收敛`;
    } else result.detail = '有待处理需求，等待成员接续';
  }
  for (const dependency of request?.deferred ?? []) {
    if (dependency.why !== 'dependency') continue;
    const consumer = members.find(m => m.id === dependency.member), provider = members.find(m => m.id === dependency.waitingFor);
    if (consumer && consumer.state !== 'busy') Object.assign(consumer, { state: 'waiting', label: '等待队友成果' });
    if (provider?.state === 'busy') result.detail = `${provider.id === 'harness' ? 'Harness' : 'Codex'} 正在交付前置成果，完成后自动接回 ${dependency.member === 'harness' ? 'Harness' : 'Codex'} 补齐剩余工作；已有实现保留，无需真人催进度。`;
  }
  if (draining && members.some(m => m.state === 'busy')) result.detail += ' 当前回合继续运行，结束后再安全加载维护补丁。';
  if (harnessConnected === false && members[1].state !== 'busy') {
    Object.assign(members[1], { state: workflow.kind==='idle'?'idle':'waiting', label: '未连接' });
    if (members[0].state !== 'busy'&&workflow.kind!=='idle') result.detail = 'DeepSeek（Harness）未连接，当前未派发，原任务已保留；等待原适配器恢复连接后接续。长时间未恢复时需核对适配器状态。';
  }
  return result;
}

export function nativeMode(text) {
  text = text.trim();
  // Copying a highlighted instruction from chat can include Markdown markers.
  // Unwrap only a complete inline wrapper; quoted examples remain new input.
  const wrapped = /^(\*\*|__|`)([\s\S]+)\1$/u.exec(text);
  if (wrapped) text = wrapped[2].trim();
  if (/^(?:\/urgent\b|紧急[：:\s])/u.test(text)) return 'urgent';
  if (/^(?:\/supplement\b|补充[：:\s]|纠正[：:\s]|改为[：:\s])/u.test(text)) return 'supplement';
  if (/^(?:\/new\b|新需求[：:\s])/u.test(text)) return 'new';
  return 'auto';
}
export function routeNative(store, engine, { adapter, harnessAdapterId, sessionId, messageId, turnId, content }, permissions) {
  if (!['codex', 'harness'].includes(adapter)) throw new Error('Invalid native adapter.');
  const group = store.originFor(adapter, sessionId);
  if (!group || group.status === 'closed') return { bound: false };
  if (adapter === 'harness' && (!group.harnessAdapterId || group.harnessAdapterId !== harnessAdapterId)) throw new Error('Native Harness input belongs to another profile or an unbound legacy context.');
  const deliveryId = typeof content === 'string' && /^\[Group delivery ([a-f0-9-]{36})\]\n/.exec(content)?.[1];
  if (deliveryId) {
    const delivery = store.delivery(deliveryId);
    if (delivery) {
      const body = content.slice(`[Group delivery ${deliveryId}]\n`.length);
      const matches = delivery.prompt !== undefined ? body === delivery.prompt : delivery.promptHash === store.hash(body);
      if (delivery.groupId !== group.id || delivery.member !== adapter || !matches) throw new Error('Controller delivery identity or body does not match its persisted checkpoint.');
      if (!(delivery.started && delivery.status === 'pending') || delivery.nativeTurnId && delivery.nativeTurnId !== turnId) return { bound: true, block: true, duplicateDispatch: true, groupId: group.id, requestId: delivery.requestId };
      store.transaction(() => { delivery.nativeTurnId = turnId; store.saveDelivery(delivery); });
      return { bound: true, dispatch: true, block: false };
    }
  }
  if (typeof content !== 'string') throw new Error('Native attachment routing is not yet supported; original execution must remain blocked.');
  const candidate = permissions?.candidate(group, { adapter, sessionId, messageId, turnId, content });
  if (candidate) {
    if (!candidate.approvalCandidate && candidate.reason) store.transaction(() => store.message(group.id, {
      sender: 'system', channel: 'group', content: candidate.reason,
      origin: { adapter: `${adapter}-permission-notice`, sessionId, messageId },
    }));
    return candidate;
  }
  const mode = nativeMode(content);
  if (/^(?:请)?刷新(?:协作|协议)连接[。.!！]?$/u.test(content.trim())) {
    store.transaction(()=>store.message(group.id,{sender:'system',channel:'group',content:'这是连接维护指令，未作为业务需求或审批处理，当前任务版本不变。请在发起协作的 Codex 聊天请求刷新连接；群会话自身不能取得新的宿主连接凭据。',origin:{adapter:`${adapter}-connection-notice`,sessionId,messageId}}));
    return {bound:true,block:true,groupId:group.id,maintenance:true};
  }
  const result = store.input(group.id, { content, mode, channel: 'group', origin: { adapter, sessionId, messageId } });
  if (!result.duplicate && result.continuationOnly) engine.continueRequest?.(group.id);
  else if (!result.duplicate && !result.progressOnly && result.message.inputMode !== 'new') engine.interrupt(group.id);
  store.transaction(() => { const current = store.group(group.id); current.capabilities[`${adapter}Native`] = 'input_observed'; store.save(current); });
  return { bound: true, block: true, groupId: group.id, requestId: result.request?.id ?? null, duplicate: result.duplicate };
}
export async function startGroupService({ store = new GroupStore(), runtime, toolRegistry, toolCredentials, port = 0, token = randomBytes(32).toString('hex'), descriptorFile, schedule = true, scheduleIntervalMs = 1000, lifecycleIntervalMs = 4000, onShutdown, now = Date.now, htmlFile = fileURLToPath(new URL('../web/group.html', import.meta.url)), candidateRoot = process.env.HARNESS_CANDIDATE_ROOT, installedRoot = fileURLToPath(new URL('../',import.meta.url)) } = {}) {
  runtime ??= new GroupRuntime(store);
  const engine = new GroupEngine(store, runtime, {toolRegistry,toolCredentials});
  const permissions = new GroupPermissions(store, runtime);
  permissions.recoverAbandoned();
  runtime.requestPermission = (group, delivery, details, signal) => permissions.request(group, delivery, details, signal);
  let html = fs.readFileSync(htmlFile), frontendError = null;
  const loadPage = () => {try {
    const next=fs.readFileSync(htmlFile);if(!/<\/html>\s*$/i.test(next.toString('utf8')))throw Error('页面文件尚未写入完整，暂时保留上一有效页面。');
    html=next;frontendError=null;
  }catch(error){frontendError=String(error.message).slice(0,300)}return html};
  const loadedBuild=captureGroupBuild();
  let origin;
  const buildHash = groupBuildHash();
  let draining = false, operations = 0, drainExpiresAt = 0, closing = false, closeTask;
  const isDraining = () => { if (draining && drainExpiresAt <= now()) draining = false; return closing || draining; };
  const activeOperations = () => engine.running.size + operations;
  const operation = async fn => {
    if (isDraining()) throw new Error('Coordinator is draining; no new native setup/configuration is admitted.');
    operations++; try { return await fn(); } finally { operations--; }
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (closing) return sendJson(res, 503, { error: 'Coordinator is closing; retry after reconnection.' });
      // No CORS. A bearer capability is required even for reads. Do not trust Host or caller-supplied sender fields.
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return sendJson(res, 403, { error: 'Origin rejected.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && (url.pathname === '/' || /^\/g\/[0-9a-f-]+$/.test(url.pathname))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'none'" });
        res.end(loadPage()); return;
      }
      if(req.method==='GET'&&url.pathname==='/connections'){
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"});
        return res.end(fs.readFileSync(new URL('../web/connections.html',import.meta.url)));
      }
      if (!equalSecret(req.headers.authorization, `Bearer ${token}`)) return sendJson(res, 401, { error: 'Authentication required.' });
      if (req.method === 'GET' && url.pathname === '/api/health') {loadPage();return sendJson(res, 200, { ok: true, protocol: GROUP_PROTOCOL, buildHash:loadedBuild.legacyHash(html), runtimeHash:loadedBuild.runtimeHash, frontendHash:store.hash(html.toString('utf8')), frontendError, version: '0.3.2', pid: process.pid, draining: isDraining(), drainExpiresAt, running: activeOperations(),
        presenceError: runtime.presenceError ?? null,
        adapters: [...(runtime.harnessAdapters?.values() ?? [])].map(a => ({ adapterId: a.adapterId, connected: Date.now() - a.at < 15000, appOpen: a.appOpen, buildHash: a.buildHash ?? null, features: a.features ?? [] })) });}
      if(req.method==='GET'&&url.pathname==='/api/readiness'){
        const read=root=>{try{return root?diskEvidence(root):{};}catch{return {};}};
        const bound=url.searchParams.get('groupId')?store.group(url.searchParams.get('groupId')):null,adapter=bound?runtime.harnessAdapters?.get(bound.harnessAdapterId):null;
        const result=readiness(read(candidateRoot),read(installedRoot),{runtimeHash:loadedBuild.runtimeHash,buildHash:loadedBuild.legacyHash(html),adapterHash:adapter&&Date.now()-adapter.at<15000?adapter.buildHash:null});
        return sendJson(res,200,{...result,sources:{candidate:candidateRoot?'host_configured_root':'not_configured',installed:'running_module_directory',runtime:'loaded_module_snapshot',page:'served_page',adapter:'bound_adapter_heartbeat'}});
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/adapter-update') {
        const body = await readBody(req);
        if (!['harness-desktop', 'harness-web'].includes(body.adapterId) || !runtime.adapterUpdates) throw Error('Unsupported adapter update.');
        let lease = runtime.adapterUpdates.get(body.adapterId);
        if (body.action === 'begin') {
          if (lease?.expiresAt > Date.now()) throw Error('This adapter already has an update owner.');
          lease = { id: randomBytes(16).toString('hex'), expiresAt: Date.now() + 180000 }; runtime.adapterUpdates.set(body.adapterId, lease);
        } else if (!lease || lease.id !== body.leaseId || lease.expiresAt <= Date.now()) throw Error('Adapter update lease expired or belongs to another owner.');
        if (body.action === 'end') { runtime.adapterUpdates.delete(body.adapterId); return sendJson(res, 200, { released: true }); }
        if (!['begin', 'check'].includes(body.action)) throw Error('Invalid adapter update action.');
        const bound = [...store.allGroups()].filter(g => g.harnessAdapterId === body.adapterId && g.status !== 'closed');
        const ready = !bound.some(g => engine.running.has(g.id) || store.permissions(g.id).some(p => p.status === 'pending') ||
          store.requests(g.id).some(r => r.deliveryId && store.delivery(r.deliveryId)?.started));
        return sendJson(res, 200, { leaseId: lease.id, ready, expiresAt: lease.expiresAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/prepare-update') {
        // Drain admissions, not native work. Aborting the controller here also
        // cancels real approvals and direct app-server turns.
        draining = true; drainExpiresAt = now() + 45000;
        return sendJson(res, 200, { draining: true, running: activeOperations() });
      }
      if (req.method === 'POST' && url.pathname === '/api/admin/shutdown') {
        if (!onShutdown || !isDraining() || activeOperations()) throw new Error('Drain the worker and wait for its native checkpoint before shutdown.');
        sendJson(res, 200, { shuttingDown: true }); setImmediate(() => onShutdown()); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/groups') return sendJson(res, 200, { groups: store.list() });
      if(req.method==='GET'&&url.pathname==='/api/connections')return sendJson(res,200,{presets:connectionPresets,connections:runtime.connections.list(),approvalOwnerThreadId:process.env.CODEX_THREAD_ID||''});
      if(req.method==='POST'&&url.pathname==='/api/connections')return sendJson(res,201,await runtime.connections.save(await readBody(req)));
      if(req.method==='POST'&&url.pathname==='/api/connections/detect'){const b=await readBody(req);if(!['codex-cli','harness-acp'].includes(b.kind))throw Error('Unknown CLI protocol.');return sendJson(res,200,runtime.connections.detect(b.kind));}
      if(req.method==='POST'&&url.pathname==='/api/connections/test'){
        const b=await readBody(req);return sendJson(res,200,await operation(async()=>{
          if(!b.dialogue)return runtime.external.catalog(b.id);
          const p=runtime.connections.get(b.id);if(p.kind!=='api')throw Error('CLI 连通测试仅初始化协议与目录；实际推理请在专用群验收。');
          const r=await runtime.connections.api(p,'/chat/completions',{model:b.model||p.model,messages:[{role:'user',content:'Reply CONNECTION-OK only. Do not use tools.'}],max_tokens:32,stream:false});
          return {ok:Boolean(r.choices?.[0]?.message),usage:r.usage||null,billable:true};
        }));
      }
      if (req.method === 'GET' && url.pathname === '/api/projects/defaults') return sendJson(res, 200, { projectsRoot: process.env.HARNESS_PROJECTS_ROOT || (store.list()[0]?.repo ? path.dirname(store.list()[0].repo) : path.join(os.homedir(), 'Codex', 'projects')) });
      if (req.method === 'POST' && url.pathname === '/api/projects/preview') {
        const body = await readBody(req), workspacePath = projectPath(body.projectsRoot, body.projectName);
        return sendJson(res, 200, { workspacePath, exists: fs.existsSync(workspacePath) });
      }
      if (req.method === 'GET' && url.pathname === '/api/models/harness') {
        if (!runtime.harness) throw new Error('Harness companion not connected.');
        return sendJson(res, 200, await localFetch(runtime.harness, '/catalog', {}));
      }
      if (req.method === 'POST' && url.pathname === '/api/heartbeat') { runtime.uiHeartbeat = Date.now(); return sendJson(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/harness/register') { const accepted = runtime.registerHarness(await readBody(req)); return sendJson(res, 200, { ok: true, accepted: accepted !== false }); }
      if (req.method === 'POST' && url.pathname === '/api/native') return sendJson(res, 200, routeNative(store, engine, await readBody(req), permissions));
      if (req.method === 'POST' && url.pathname === '/api/permissions/request') {
        const body = await readBody(req), group = store.group(body.groupId), delivery = store.delivery(body.deliveryId);
        const active = engine.running.get(group.id);
        if (!active || !delivery || delivery.groupId !== group.id || delivery.member !== 'harness' || !delivery.started || delivery.status !== 'pending') throw new Error('No active matching Harness delivery.');
        const details = await runtime.harnessPermissionActive(group, delivery, body.handlerId);
        const disconnected = new AbortController();
        const closed = () => { if (!res.writableEnded) disconnected.abort({ cancelSource: 'connection_disconnected' }); };
        res.once('close', closed);
        try { return sendJson(res, 200, { allowed: await permissions.request(group, delivery, details, AbortSignal.any([active.signal, disconnected.signal, AbortSignal.timeout(30 * 60 * 1000)])) }); }
        finally { res.removeListener('close', closed); }
      }
      if (req.method === 'GET' && url.pathname === '/api/bindings') return sendJson(res, 200, { bindings: store.bindings().map(g => ({ groupId: g.id, contexts: g.contexts, harnessAdapterId: g.harnessAdapterId ?? null, title: groupSessionTitle(g, 'harness') })) });
      if (req.method === 'POST' && url.pathname === '/api/groups') { const body = await readBody(req); return sendJson(res, 201, await operation(() => runtime.create(body))); }
      const match = /^\/api\/groups\/([0-9a-f-]+)(?:\/(messages|input|control|budget|repair-empty-codex|bind-harness|settings|execution-settings|collaboration|savings|evidence|tools|tool-call|tool-calls|scopes|scope-request|scope-refresh|scope-revoke|scope-release-evidence|scope-release|verify-native-parallel|native-status|effort|tasks))?$/.exec(url.pathname);
      if (!match) return sendJson(res, 404, { error: 'Unknown route.' });
      const [, id, action] = match;
      if(req.method==='GET'&&action==='native-status'){
        const g=store.group(id),r=store.request(g.activeRequestId),ids=[r?.deliveryId,...Object.values(r?.lanes??{}).map(l=>l.deliveryId)].filter(Boolean);
        const deliveries=[...new Set(ids)].map(id=>store.delivery(id)).filter(d=>d?.groupId===g.id&&d.requestId===r.id&&d.started&&d.status==='pending').slice(0,2);
        return sendJson(res,200,{observations:await Promise.all(deliveries.map(async d=>{let observed;try{observed=await runtime.recover(g,d);}catch{}return {deliveryId:d.id,member:d.member,phase:d.phase,nativeTurnId:d.nativeTurnId??null,state:observed?.pending===true?'pending':observed?.nativeFailure||observed?.terminalNoReply||observed?.interrupted||observed?.recovered?'terminal':'unknown',source:observed?.source??'original_recovery'};}))});
      }
      if (req.method === 'POST' && ['settings', 'bind-harness'].includes(action)) {
        if (engine.running.has(id)) throw new Error('Wait for the native turn checkpoint to settle.');
        const body = await readBody(req);
        return sendJson(res, 200, await operation(() => action === 'settings' ? runtime.configure(id, body.models) : runtime.bindLegacyHarness(id, body.adapterId)));
      }
      if(req.method==='POST'&&action==='verify-native-parallel')return sendJson(res,200,await verifyNativeParallel(store,runtime,id,{runtimeHash:loadedBuild.runtimeHash}));
      if(req.method==='GET'&&action==='scopes')return sendJson(res,200,{grants:engine.scopeGrants.list(id),reservations:engine.scopeGrants.reservations(id)});
      if(req.method==='POST'&&action==='scope-request')return sendJson(res,200,await engine.scopeGrants.request(id,await readBody(req)));
      if(req.method==='POST'&&action==='scope-refresh'){const body=await readBody(req);if(Object.keys(body).length)throw Error('Native scope refresh accepts no claimed proof.');return sendJson(res,200,await engine.scopeGrants.refresh(id));}
      if(req.method==='POST'&&['scope-revoke','scope-release-evidence','scope-release'].includes(action)){
        const body=await readBody(req),allowed=action==='scope-revoke'?['grantId']:action==='scope-release-evidence'?['reservationId']:['reservationId','reviewMessageId'];
        if(Object.keys(body).some(k=>!allowed.includes(k)))throw Error('Invalid scope operation fields.');
        return sendJson(res,200,action==='scope-revoke'?engine.scopeGrants.requestRevocation(id,body.grantId):action==='scope-release-evidence'?await engine.scopeGrants.prepareRelease(id,body.reservationId):engine.scopeGrants.release(id,body.reservationId,body.reviewMessageId));
      }
      if(req.method==='GET'&&action==='tools')return sendJson(res,200,{tools:engine.toolRegistry.catalog(),writes:'native_scope_required'});
      if(req.method==='GET'&&action==='tool-calls')return sendJson(res,200,{calls:engine.toolExecutor.calls(id)});
      if(req.method==='POST'&&action==='tool-call'){
        const body=await readBody(req),disconnected=new AbortController();
        const closed=()=>{if(!res.writableEnded)disconnected.abort();};res.once('close',closed);
        const active=engine.running.get(id)?.signal;
        try{return sendJson(res,200,await engine.invokeTool(id,body,active?AbortSignal.any([active,disconnected.signal]):undefined));}
        finally{res.removeListener('close',closed);}
      }
      if(req.method==='GET'&&action==='effort')return sendJson(res,200,{policy:effortPolicy(store.group(id).effortPolicy),deliveries:store.db.prepare('SELECT value FROM deliveries WHERE group_id=?').all(id).map(x=>JSON.parse(x.value)).filter(d=>d.strength).map(d=>({deliveryId:d.id,member:d.member,model:d.strength.discovered?.model,strength:d.strength}))});
      if(req.method==='POST'&&action==='effort'){const policy=effortPolicy(await readBody(req));return sendJson(res,200,store.transaction(()=>{const g=store.group(id);g.effortPolicy=policy;store.save(g);return {policy,appliesAt:'next_native_admission'};}));}
      if(req.method==='GET'&&action==='tasks')return sendJson(res,200,{requests:store.requests(id).map(r=>({requestId:r.id,...taskListView(r)}))});
      if(req.method==='POST'&&action==='savings'){
        const policy=savingsPolicy(await readBody(req));return sendJson(res,200,store.transaction(()=>{const g=store.group(id);g.savings=policy;store.save(g);return savingsStatus(policy);}));
      }
      if(req.method==='GET'&&action==='evidence'){
        const request=store.request(url.searchParams.get('requestId')),message=store.messageById(url.searchParams.get('messageId'));
        if(!request||request.groupId!==id||message?.groupId!==id||message?.requestId!==request.id)throw Error('Evidence reference does not belong to this group and request.');
        return sendJson(res,200,{message});
      }
      if(req.method==='POST'&&action==='collaboration'){
        const body=await readBody(req),policy=collaborationPolicy(body);
        return sendJson(res,200,store.transaction(()=>{const g=store.group(id);g.collaboration=policy;store.save(g);store.message(id,{sender:'system',channel:'collaboration',content:'Human collaboration configuration saved for the next request planning boundary; existing deliveries and approval bindings are unchanged.'});return {configured:policy,appliesAt:'next_request_planning',active:store.request(g.activeRequestId)?.collaboration??null};}));
      }
      if (req.method === 'POST' && action === 'execution-settings') {
        const body=await readBody(req); const config=parallelConfiguration(body.maxExecutors);
        if(store.group(id).peerConnectionId&&config.maxExecutors>1)throw Error('外部伙伴目前使用串行执行，避免绕过文件作用域隔离；讨论与复核仍按需协作。');
        return sendJson(res,200,store.transaction(()=>{const g=store.group(id);g.executionSettings={maxExecutors:config.maxExecutors};store.save(g);return parallelConfiguration(config.maxExecutors,store.admissions().observation(id));}));
      }
      if (req.method === 'POST' && action === 'repair-empty-codex') return sendJson(res, 200, await operation(() => runtime.repairEmptyCodex(id)));
      if (req.method === 'GET' && !action) return sendJson(res, 200, { group: store.group(id), savings:{...savingsStatus(store.group(id).savings),latestObservation:latestSavingsObservation(store,id)}, collaboration:{configured:collaborationPolicy(store.group(id).collaboration),active:store.request(store.group(id).activeRequestId)?.collaboration??null,suggestions:roleSuggestions(store,store.group(id),collaborationPolicy(store.group(id).collaboration).taskClass),appliesAt:'next_request_planning'}, parallel: parallelConfiguration(store.group(id).executionSettings?.maxExecutors,store.admissions().observation(id)), requests: (() => {
        const recent = store.recentRequests(id), active = store.request(store.group(id).activeRequestId);
        return active && !recent.some(r => r.id === active.id) ? [active, ...recent] : recent;
      })().map((()=>{const calibration=calibrationSnapshot(store,store.group(id));return r => ({ ...r, quality:qualityMetrics(r),budgetObservation: {...budgetObservation(r.usage,calibration(r.actions?.[0]?.member??(r.plans?.codex?'harness':'codex'),r.actions?.[0]?.phase??r.phase)),calibrations:Object.fromEntries(['codex','harness'].map(member=>[member,calibration(member,r.actions?.[0]?.phase??r.phase)])),policy:r.budgetPolicy??budgetPolicy(),admission:budgetDecision(r.usage,r.budgetPolicy)}, strength: r.deliveryId ? store.delivery(r.deliveryId)?.strength ?? null : null, goalWait: settledGoalWait(r),
        waitingFor: r.deliveryId ? (() => {const d=store.delivery(r.deliveryId);return d ? {member:d.member,phase:d.phase,isPreviousRevision:d.revision!==r.revision} : null})() : null,
        contentPreview: (store.messageById(r.messageId)?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });})()), permissions: (() => { const recent = store.recentPermissions(id); return [...store.pendingPermissions(id).filter(p => !recent.some(r => r.id === p.id)), ...recent].map(p => ({...p, explanation: explainState(p)})); })(), activity: groupActivity(store, engine, id, { draining: isDraining() }), answerPreview: (()=>{const g=store.group(id),r=g.activeRequestId?store.request(g.activeRequestId):null;return engine.answerPreviews.read(g,r,r?.deliveryId?store.delivery(r.deliveryId):null)})() });
      if (req.method === 'GET' && action === 'messages') return sendJson(res, 200, store.messages(id, { after: Number(url.searchParams.get('after') || 0), before: url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined, limit: Number(url.searchParams.get('limit') || 100), channel: url.searchParams.get('channel') || undefined }));
      if (req.method === 'POST' && action === 'input') {
        const body = await readBody(req); const result = store.input(id, { ...body, mode: body.mode ?? 'auto' });
        if (!result.duplicate && result.continuationOnly) engine.continueRequest(id);
        else if (!result.duplicate && !result.progressOnly && result.message.inputMode !== 'new') engine.interrupt(id);
        return sendJson(res, 202, result);
      }
      if (req.method === 'POST' && action === 'control') {
        const body = await readBody(req), command = body.action;
        if (command === 'inspect-reply') return sendJson(res, 200, await engine.inspectReply(id));
        if (command === 'authorize-integration') return sendJson(res, 200, engine.authorizeIntegration(id, body));
        if (command === 'settle') { await engine.tick(id, { recoveryOnly: true }); return sendJson(res, 200, store.group(id)); }
        return sendJson(res, 200, engine.control(id, command));
      }
      if (req.method === 'POST' && action === 'budget') {
        const body = await readBody(req);
        return sendJson(res, 200, store.transaction(() => {
          const request = store.request(body.requestId);
          if (!request || request.groupId !== id) throw new Error('Unknown request.');
          if (body.hardTokenLimit !== undefined && body.hardTokenLimit !== null && (!Number.isSafeInteger(body.hardTokenLimit) || body.hardTokenLimit < 1)) throw new Error('Invalid hard limit.');
          if(body.hardTokenLimit!==undefined)request.hardTokenLimit = body.hardTokenLimit;
          if(body.policy!==undefined)request.budgetPolicy=budgetPolicy(body.policy);
          store.saveRequest(request); return request;
        }));
      }
      sendJson(res, 405, { error: 'Unsupported method.' });
    } catch (error) { sendJson(res, 400, { error: String(error.message).slice(0, 4000) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const descriptor = { url: origin, token, pid: process.pid, version: '0.3.2', protocol: GROUP_PROTOCOL, buildHash };
  if (descriptorFile) writeJson(descriptorFile, descriptor);
  let lastBindings = '';
  const flushBindings = () => {
    if (!descriptorFile) return;
    const bindings = { bindings: store.bindings().map(g => ({ groupId: g.id, contexts: g.contexts, harnessAdapterId: g.harnessAdapterId ?? null })) };
    const encoded = JSON.stringify(bindings);
    if (encoded !== lastBindings) { writeJson(path.join(path.dirname(descriptorFile), 'group-bindings.json'), bindings); lastBindings = encoded; }
  };
  flushBindings();
  const scheduled = new Map();
  const timer = schedule ? setInterval(() => {
    if (isDraining()) return;
      for (const group of store.allGroups()) {
        if (scheduled.has(group.id)) continue;
        if (['closed', 'paused', 'initializing', 'configuring', 'setup_failed'].includes(group.status)) continue;
        if (!group.activeRequestId && !store.hasOpenRequests(group.id, { queuedOnly: true })) continue;
        const task = engine.tick(group.id).catch(error => {
          store.transaction(() => {
            const current = store.group(group.id);
            // A rejected old tick cannot replace a newer human control or
            // present an internal failure as a human-owned pause.
            if(current.epoch!==group.epoch||['closed','paused','configuring'].includes(current.status))return;
            current.status='paused'; current.error=String(error.message).slice(0,4000);
            current.schedulerFault={epoch:current.epoch,requestId:current.activeRequestId??null,at:new Date().toISOString()};
            store.save(current);
          });
        }).finally(() => scheduled.delete(group.id));
        scheduled.set(group.id, task);
      }
  }, scheduleIntervalMs) : null;
  let checkingLifecycle = false, lifecycleTask;
  const lifecycle = schedule ? setInterval(async () => {
    if (checkingLifecycle || closing) return;
    checkingLifecycle = true;
    lifecycleTask = (async () => { try {
      flushBindings();
      if (engine.running.size && await runtime.appOpen() === false && !closing) for (const id of engine.running.keys()) {
        store.transaction(() => { const group = store.group(id); if (!['paused', 'closed', 'apps_closed'].includes(group.status)) { permissions.suspendForAppsClosed(group); group.status = 'apps_closed'; group.epoch++; store.save(group); } });
        engine.interrupt(id);
      }
    } catch { /* The next checkpoint observes lifecycle again. */ }
    finally { checkingLifecycle = false; } })();
    await lifecycleTask;
  }, lifecycleIntervalMs) : null;
  lifecycle?.unref();
  timer?.unref();
  return { descriptor, server, store, engine, runtime, permissions, close() {
    if (closeTask) return closeTask;
    closing = true;
    closeTask = (async () => {
    if (timer) clearInterval(timer);
    if (lifecycle) clearInterval(lifecycle);
    for (const group of store.allGroups()) engine.interrupt(group.id);
    const sweep = setInterval(() => server.closeIdleConnections(), 100); sweep.unref();
    try { await new Promise(resolve => server.close(resolve)); } finally { clearInterval(sweep); }
    await lifecycleTask;
    await engine.waitForIdle();
    await Promise.allSettled([...scheduled.values()]);
    store.close();
    })();
    return closeTask;
  } };
}

export function serviceDescriptor() { return readJson(path.join(dataDir, 'group-service.json'), null); }
