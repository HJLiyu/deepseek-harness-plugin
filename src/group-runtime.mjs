import {discoverEffort,selectEffort,confirmEffort} from './effort-policy.mjs';
import { sameCommand } from './approval-text.mjs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { dataDir, readJson } from './state.mjs';
import { codexTurn, codexEffortCatalog, codexOrganizeThread, codexRecoverDelivery, codexUserTurns } from './codex.mjs';
import { createHarnessWorktree, gitRoot, captureProjectSnapshot, createProject } from './git.mjs';
import { localFetch } from './group-http.mjs';
import { ownerApprovalProof } from './group-permissions.mjs';
import { groupRuntimeHash } from './group-build.mjs';
import { desktopBridgeGeneration } from './desktop.mjs';
import { ModelConnections } from './model-connections.mjs';
import { ExternalAgent } from './external-agent.mjs';

export function groupSessionTitle(group, member) {
  const project = String(group.repo ?? '').split(/[\\/]/).filter(Boolean).at(-1) || '项目协作';
  const topic = String(group.title && group.title !== '项目协作群' ? group.title : project).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || project;
  return `${topic} · ${member === 'harness' ? group.peerName || 'Harness' : 'Codex'}`;
}

export function codexWriterRefusal(store, group, delivery) {
  if (delivery.member !== 'codex' || delivery.status !== 'pending' || !delivery.started || delivery.nativeTurnId ||
      !Number.isSafeInteger(delivery.cursor) || store.request(delivery.requestId)?.revision !== delivery.revision) return null;
  let after = delivery.cursor;
  for (;;) {
    const page = store.messages(group.id, { after, limit: 100 });
    for (const message of page.messages) {
      if (message.requestId !== delivery.requestId) continue;
      if (message.sender !== 'system') return null;
      if (message.content === 'Desktop collaboration thread is busy; pending Harness reply preserved.') return { kind: 'desktop-pre-dispatch-busy', threadId: group.contexts.codex, deliveryId: delivery.id, auditMessageId: message.id };
      let error; try { error = JSON.parse(message.content); } catch { return null; }
      if (error.code !== -32600 || error.message !== `thread ${group.contexts.codex} already has an active writer`) return null;
      return { kind: 'codex-writer-refusal', threadId: group.contexts.codex, deliveryId: delivery.id, auditMessageId: message.id };
    }
    if (!page.messages.length) return null;
    after = page.nextCursor;
  }
}

export function nativeAppPresence() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-Command', "(Get-Process -Name ChatGPT,Codex,CodexHarness,'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count"],
    { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error, stdout) => {
      if (error) return reject(error);
      const count = stdout.trim();
      if (!/^\d+$/.test(count)) return reject(Error('Application presence probe returned an invalid count.'));
      resolve(Number(count) > 0);
    }));
}

// Downgrade explicitly read-only work and verified empty integrations. This
// never grants a new capability; attempted writes remain confined by the host.
export function codexSandboxForDelivery(delivery) {
  if (['planning', 'review'].includes(delivery.phase)) return 'read-only';
  let payload; try { payload = JSON.parse(delivery.prompt); } catch { return 'workspace-write'; }
  const task = typeof payload?.assignment?.task === 'string' ? payload.assignment.task.trimStart() : '';
  if (delivery.phase === 'work' && (payload?.assignment?.readOnly === true ||
      /^只读(?:联网)?(?:核对|审查|复核|检查|排查|验证|规划|调研|分析)/u.test(task) ||
      /(?:本轮|本次|当前任务)[：:，,\s]*(?:仅|只)?只读(?:规划)?[，,、\s]*(?:不改文件|不修改文件|不写入)/u.test(task))) return 'read-only';
  const selection = payload?.integrationSelection;
  if (delivery.phase === 'integrate' && selection) {
    const targets = selection.members ? Object.values(selection.members) : [selection.files];
    if (targets.length && targets.every(files => files && typeof files === 'object' && !Array.isArray(files) && !Object.keys(files).length)) return 'read-only';
  }
  return 'workspace-write';
}

export class GroupRuntime {
  get connections() { return this._connections??=new ModelConnections(this.store.file?path.dirname(this.store.file):dataDir); }
  get external() { return this._external??=new ExternalAgent(this.connections); }
  responseScopeProtocol = 1;
  progressVersion = groupRuntimeHash();
  constructor(store, { adapterDescriptor = id => store.file && path.resolve(path.dirname(store.file)) === path.resolve(dataDir)
    ? readJson(path.join(dataDir, `harness-adapter-${id}.json`), null) : null,
    codexCall = codexTurn, codexRecovery=codexRecoverDelivery, effortCatalog = codexEffortCatalog, readUserTurns = codexUserTurns, presenceProbe = nativeAppPresence, presenceNow = Date.now, presenceTtlMs = 2000 } = {}) {
    this.store = store; this.adapterDescriptor = adapterDescriptor; this.harness = null; this.harnessAdapters = new Map(); this.adapterUpdates = new Map(); this.uiHeartbeat = 0;
    this.readUserTurns = readUserTurns; this.effortCatalog=effortCatalog; this.codexCall=codexCall;this.codexRecovery=codexRecovery;this.nativeReaders=new Map();
    this.presenceProbe = presenceProbe; this.presenceNow = presenceNow; this.presenceTtlMs = presenceTtlMs;
  }
  registerHarness(input) {
    if (input.protocol !== 'codex-harness-group/v2' || !/^[a-z0-9-]{1,80}$/.test(input.adapterId ?? '')) throw new Error('Harness adapter must declare a stable profile identity and protocol v2. Restart the updated companion.');
    if (typeof input.token !== 'string' || input.token.length < 32) throw new Error('Invalid adapter secret.');
    const disk = this.adapterDescriptor(input.adapterId), current = this.harnessAdapters.get(input.adapterId);
    if (disk?.adapterId === input.adapterId && disk.url && disk.token &&
      (new URL(input.url).origin !== disk.url || input.token !== disk.token)) return false;
    const floor = Math.max(current?.instanceStartedAt ?? 0, disk?.instanceStartedAt ?? 0);
    if (floor && (!Number.isSafeInteger(input.instanceStartedAt) || input.instanceStartedAt < floor ||
      input.instanceStartedAt === disk?.instanceStartedAt && input.instanceId !== disk?.instanceId ||
      input.instanceStartedAt === current?.instanceStartedAt && input.instanceId !== current?.instanceId)) return false;
    if (input.instanceStartedAt !== undefined && (!Number.isSafeInteger(input.instanceStartedAt) || input.instanceStartedAt > Date.now() + 10000 || !/^[a-f0-9-]{36}$/.test(input.instanceId ?? ''))) throw Error('Invalid native adapter generation.');
    const url = new URL(input.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Adapter must use loopback.');
    const adapter = { adapterId: input.adapterId, instanceStartedAt: input.instanceStartedAt ?? null, instanceId: input.instanceId ?? null, url: url.origin, token: input.token, buildHash: /^[a-f0-9]{64}$/.test(input.buildHash ?? '') ? input.buildHash : null, at: Date.now(), appOpen: input.appOpen === true, features: Array.isArray(input.features) ? input.features.filter(f => typeof f === 'string').slice(0, 20) : [] };
    this.harnessAdapters.set(input.adapterId, adapter); this.harness = adapter;
    return true;
  }
  adapter(group) {
    if (group.peerConnectionId) return null;
    if (!group.harnessAdapterId) throw new Error('This legacy group needs an explicit Harness profile binding; do not route a v4 context into a v3 CLI.');
    const adapter = this.harnessAdapters.get(group.harnessAdapterId);
    if (!adapter || Date.now() - adapter.at > 15000) return null;
    return adapter;
  }
  async appOpen() {
    if ([...this.harnessAdapters.values()].some(a => a.appOpen && Date.now() - a.at < 15000) || process.env.HARNESS_ASSUME_APP_OPEN === '1') {
      this.presenceError = null; return true;
    }
    if (this.presenceCache && this.presenceNow() < this.presenceCache.expiresAt) return this.presenceCache.value;
    if (!this.presencePending) {
      this.presencePending = Promise.resolve().then(() => this.presenceProbe()).then(value => {
        if (typeof value !== 'boolean') throw Error('Invalid application presence result.');
        this.presenceError = null; return value;
      }).catch(error => { this.presenceError = String(error.message).slice(0, 300); return null; }).then(value => {
        this.presenceCache = { value, expiresAt: this.presenceNow() + this.presenceTtlMs };
        this.presencePending = null; return value;
      });
    }
    const value = await this.presencePending;
    // A fresh positive heartbeat outranks an older process snapshot.
    if ([...this.harnessAdapters.values()].some(a => a.appOpen && Date.now() - a.at < 15000)) {
      this.presenceError = null; return true;
    }
    return value;
  }
  async canTurn(group, member) {
    if(group.peerConnectionId&&member==='harness'){try{this.connections.get(group.peerConnectionId);return true;}catch{return false;}}
    if (this.adapterUpdates.get(group.harnessAdapterId)?.expiresAt > Date.now()) return false;
    return member !== 'harness' || Boolean(this.adapter(group));
  }
  async bindLegacyHarness(id, adapterId) {
    const before = this.store.group(id);
    if (before.status !== 'paused' || before.harnessAdapterId) throw new Error('Only a paused legacy group without a profile binding can be bound.');
    const descriptor = this.harnessAdapters.get(adapterId);
    if (!descriptor || Date.now() - descriptor.at > 15000) throw new Error('Selected profile is disconnected.');
    const proof = await localFetch(descriptor, '/diagnostics', { sessionId: before.contexts.harness });
    if (proof.adapterId !== adapterId || proof.sessionId !== before.contexts.harness || proof.inspectError) throw new Error('Selected profile cannot read this existing native context; no binding was changed.');
    return this.store.transaction(() => {
      const group = this.store.group(id);
      if (group.status !== 'paused' || group.epoch !== before.epoch || group.harnessAdapterId) throw new Error('Group changed while verifying its native profile.');
      group.harnessAdapterId = adapterId; group.epoch++;
      this.store.message(id, { sender: 'system', channel: 'collaboration', content: `已核验并固定 Harness profile：${adapterId}。保留原会话与待投递检查点。` });
      return this.store.save(group);
    });
  }
  async configure(id, models) {
    let group = this.store.group(id);
    if (group.status !== 'paused' || this.store.requests(id).some(r => r.deliveryId)) throw new Error('Pause the group and settle its pending native delivery before changing models.');
    for (const member of ['codex', 'harness']) if (!models?.[member]?.model || typeof models[member].model !== 'string') throw new Error('Choose both member models explicitly.');
    if(group.peerConnectionId)throw Error('外部伙伴的模型固定于专用上下文；请新建群使用新的接入配置，避免静默切换模型。');
    const descriptor = this.adapter(group); if (!descriptor) throw new Error('Bound Harness profile is disconnected.');
    group.status = 'configuring'; this.store.transaction(() => this.store.save(group));
    try {
      await localFetch(descriptor, '/configure', { sessionId: group.contexts.harness, model: models.harness });
      return this.store.transaction(() => {
        group = this.store.group(id); group.models = models; group.epoch++; group.status = 'paused';
        this.store.message(id, { sender: 'system', channel: 'group', content: '已按真人显式设置更新双方模型；群保持暂停，继续后使用新设置。' }); return this.store.save(group);
      });
    } catch (error) {
      this.store.transaction(() => { group = this.store.group(id); group.status = 'paused'; group.error = error.message; this.store.save(group); }); throw error;
    }
  }
  async initializeCodex(group) {
    const first = await codexTurn({ create: true, cwd: group.worktrees.codex, model: group.models.codex.model,
      effort: group.models.codex.effort, sandbox: 'read-only',
      prompt: `初始化项目群 ${group.id} 的专用 Codex 上下文。你与 Harness 平等协作，后续工作由群调度器分配。现在不要运行工具，不要改文件，只回复 GROUP-CONTEXT-READY。` });
    return first;
  }
  async repairEmptyCodex(id) {
    let group = this.store.group(id);
    if (group.initialized.codex || this.store.requests(id).length || !/no rollout found/i.test(group.sidebar?.error ?? '')) throw new Error('Only the verified empty, unused Codex setup can be repaired.');
    const oldId = group.contexts.codex;
    group.status = 'initializing'; this.store.transaction(() => this.store.save(group));
    const first = await this.initializeCodex(group);
    group = this.store.group(id); group.emptyCodexSetupId = oldId; group.contexts.codex = first.threadId;
    group.bootstrapUsage = first.usage ?? null;
    group.sidebar = await codexOrganizeThread({ threadId: first.threadId, cwd: group.worktrees.codex, title: groupSessionTitle(group, 'codex'), sandbox: 'read-only' });
    group.status = 'idle'; this.store.transaction(() => {
      this.store.message(id, { sender: 'codex', channel: 'collaboration', content: first.text }); this.store.save(group);
    }); return group;
  }
  async create(input) {
    if (!input.codexModel || !input.harnessModel) throw new Error('Choose both member models when creating a group.');
    const rounds = input.maxDiscussionRounds ?? 3;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 24) throw new Error('Discussion rounds must be 1–24.');
    const adapterId = input.harnessAdapterId ?? (this.harnessAdapters.has('harness-desktop') ? 'harness-desktop' : 'harness-web');
    const peer=input.peerConnectionId?this.connections.get(input.peerConnectionId):null;
    const adapter = this.harnessAdapters.get(adapterId);
    if (!peer&&(!adapter || Date.now() - adapter.at > 15000)) throw new Error('Selected Harness profile is not connected. Restart the updated companion before creating the dedicated sessions.');
    if(peer&&(!input.approvalOwnerThreadId||!/^[-a-z0-9]{20,80}$/i.test(input.approvalOwnerThreadId)))throw Error('外部伙伴需要指定单独的真人 Codex 审批聊天编号。');
    if(peer&&this.store.bindings().some(g=>Object.values(g.contexts||{}).includes(input.approvalOwnerThreadId)))throw Error('真人审批聊天不能是任何群的 AI 成员上下文。');
    if (input.createProject !== true && (typeof input.workspacePath !== 'string' || !input.workspacePath.trim())) throw new Error('请选择已有 Git 项目路径，或按项目名称创建新项目。');
    const repo = input.createProject === true ? createProject(input.projectsRoot, input.projectName) : gitRoot(input.workspacePath ?? '');
    const group = this.store.create({ title: input.title, repo, maxDiscussionRounds: rounds, models: {
      codex: { model: input.codexModel, effort: input.codexEffort ?? 'low' },
      harness: { model: input.harnessModel, effort: input.harnessEffort ?? null, provider: input.harnessProvider ?? 'deepseek-account' },
    } });
    if(peer){group.peerConnectionId=peer.id;group.peerName=peer.name;group.peerKind=peer.kind;group.approvalOwnerThreadId=input.approvalOwnerThreadId;}
    else group.harnessAdapterId = adapterId;
    this.store.transaction(() => this.store.save(group));
    try {
      group.baseline = captureProjectSnapshot(repo);
      for (const member of ['codex', 'harness']) {
        const tree = createHarnessWorktree(repo, `${group.id}-${member}`, group.baseline.commit);
        group.worktrees[member] = tree.worktree; group.branches[member] = tree.branch;
        this.store.transaction(() => this.store.save(group));
      }
      const first = await this.initializeCodex(group);
      group.contexts.codex = first.threadId; group.bootstrapUsage = first.usage ?? null;
      this.store.transaction(() => this.store.save(group));
      const created = peer?await this.external.create(peer.id,group.worktrees.harness,group.models.harness.model):await localFetch(adapter, '/create', { cwd: group.worktrees.harness, model: group.models.harness, groupId: group.id, title: groupSessionTitle(group, 'harness') });
      group.contexts.harness = created.sessionId;
      try { group.sidebar = await codexOrganizeThread({ threadId: group.contexts.codex, cwd: group.worktrees.codex, title: groupSessionTitle(group, 'codex'), sandbox: 'read-only' }); }
      catch (error) { group.sidebar = { verified: false, error: error.message }; }
      group.status = 'idle'; group.capabilities.harnessNative = peer?'external_transport':'adapter_connected';
      this.store.transaction(() => this.store.save(group));
      return group;
    } catch (error) {
      group.status = 'setup_failed'; group.error = error.message;
      this.store.transaction(() => this.store.save(group)); throw error;
    }
  }
  async prepareEffort(group,delivery,signal) {
    if(group.peerConnectionId&&delivery.member==='harness')return {selected:null,source:'external_model_default',confirmed:null};
    let catalog=null;const member=delivery.member,model=group.models?.[member]?.model;
    try {catalog=member==='codex'?await this.effortCatalog({cwd:group.worktrees.codex}):await localFetch(this.adapter(group),'/catalog',{}, {signal});}catch{}
    const r=this.store.request(delivery.requestId),task=r?.taskList?.find(t=>t.taskId===delivery.taskId)??{};
    const discovered=discoverEffort(catalog,model,member==='codex'?'app-server:model/list':'harness:modelCatalog',Date.now(),group.models?.[member]?.provider);
    return selectEffort({member,phase:delivery.phase,task,failures:r?.actions?.[0]?.repair?.round??r?.repair?.round??0,configured:group.models?.[member]?.effort,policy:group.effortPolicy,discovered});
  }
  saveStrength(delivery,change) {
    return this.store.transaction(()=>{const d=this.store.delivery(delivery.id);if(!d||d.requestId!==delivery.requestId||d.epoch!==delivery.epoch)throw Error('Effort receipt binding changed.');d.strength={...d.strength,...change};this.store.saveDelivery(d);return d.strength;});
  }
  async turn(group, delivery, signal, onAnswer) {
    const member = delivery.member;
    const strength=await this.prepareEffort(group,delivery,signal);
    this.saveStrength(delivery,strength);
    const current=this.store.group(group.id),request=this.store.request(delivery.requestId);
    if(signal?.aborted||current.epoch!==delivery.epoch||current.activeRequestId!==delivery.requestId||current.status!=='active'||request.revision!==delivery.revision||request.parallelStop||this.store.pendingPermissions(group.id).length||this.store.hasPendingScopes?.(group.id))throw Object.assign(Error('Control changed before effort application.'),{code:'GROUP_NOT_ADMITTED'});
    if(member==='harness'&&group.peerConnectionId){
      const guard=()=>{const g=this.store.group(group.id),r=this.store.requestForDelivery(delivery.requestId,delivery.id);if(signal?.aborted||g.epoch!==delivery.epoch||g.activeRequestId!==delivery.requestId||r?.revision!==delivery.revision||r.deliveryId!==delivery.id||!['active','awaiting_approval'].includes(g.status))throw Error('需求或权限状态已改变；停止外部工具执行。');};
      return this.external.turn(group.contexts.harness,delivery,{signal,onAnswer,guard,approve:details=>this.requestPermission(group,delivery,details,signal)});
    }
    if (member === 'codex') {
      const prompt = `[Group delivery ${delivery.id}]\n${delivery.prompt}`;
      const approvalRelay = this.requestPermission && (group.peerConnectionId&&group.approvalOwnerThreadId || group.harnessAdapterId && this.adapter(group)?.features?.includes('human-proof-v1'));
      this.saveStrength(delivery,{requested:strength.selected});
      let ownedReader;
      try{return await this.codexCall({ threadId: group.contexts.codex, cwd: group.worktrees.codex, prompt,
        onActiveReader: source=>{
          const d=this.store.delivery(delivery.id);
          if(source?.threadId!==group.contexts.codex||source.turnId!==d?.nativeAdmission?.turnId||typeof source.read!=='function')throw Error('Active native reader does not match its original admission.');
          const entry={...source,requestId:delivery.requestId,revision:delivery.revision,epoch:delivery.epoch,promptHash:this.store.hash(prompt)};ownedReader=entry;this.nativeReaders.set(delivery.id,entry);
          return ()=>{if(this.nativeReaders.get(delivery.id)===entry)this.nativeReaders.delete(delivery.id);};
        },
        onDispatchState: state=>this.store.transaction(()=>{
          const current=this.store.delivery(delivery.id);
          if(!current||current.requestId!==delivery.requestId||state.threadId!==group.contexts.codex||
             !['preflight','send_attempted'].includes(state.stage)||state.route!=='desktop'||current.nativeAdmission||
             state.stage==='preflight'&&current.nativeDispatch&&current.nativeDispatch.stage!=='preflight')throw Error('Invalid native dispatch journal.');
          current.nativeDispatch={...state,deliveryId:delivery.id,requestId:delivery.requestId,
            revision:delivery.revision,epoch:delivery.epoch,promptHash:this.store.hash(prompt)};
          this.store.saveDelivery(current);
        }),
        onAdmitted: receipt=>this.store.transaction(()=>{
          const current=this.store.delivery(delivery.id);
          if(!current||current.requestId!==delivery.requestId||receipt.threadId!==group.contexts.codex)throw Error('Native admission receipt does not match the persisted delivery.');
          current.strength=confirmEffort(current.strength,receipt.confirmedEffort,{native:true,deliveryId:delivery.id,threadId:receipt.threadId,turnId:receipt.turnId,route:receipt.route});current.nativeTurnId=receipt.turnId;current.nativeAdmission={...receipt,promptHash:this.store.hash(prompt)};this.store.saveDelivery(current);
        }),
        model: group.models.codex.model, effort: strength.selected??undefined, signal, onAnswer,
        approvalPolicy: approvalRelay ? 'on-request' : 'never',
        ...(approvalRelay ? { onApproval: (method, params) => this.requestPermission(group, delivery, { method, params }, signal) } : {}),
        sandbox: codexSandboxForDelivery(delivery),
        writableRoots: delivery.phase === 'integrate' ? [group.worktrees.codex, group.repo] : [group.worktrees.codex],
      });}finally{if(ownedReader&&this.nativeReaders.get(delivery.id)===ownedReader)this.nativeReaders.delete(delivery.id);}
    }
    const descriptor = this.adapter(group);
    if (!descriptor) throw new Error('This group’s Harness profile disconnected; dispatch retained without switching profiles.');
    const abort = () => localFetch(descriptor, '/cancel', { sessionId: group.contexts.harness, deliveryId: delivery.id }).catch(() => {});
    signal?.addEventListener('abort', abort, { once: true });
    let polling=false;
    const timer=onAnswer?setInterval(async()=>{if(polling||signal?.aborted)return;polling=true;try{const p=await localFetch(descriptor,'/progress',{sessionId:group.contexts.harness,deliveryId:delivery.id},{signal,timeoutMs:1500});if(p.sessionId===group.contexts.harness&&p.deliveryId===delivery.id&&typeof p.text==='string')onAnswer(p.text)}catch{}finally{polling=false}},500):null;timer?.unref();
    try { const result=await localFetch(descriptor, '/turn', { sessionId: group.contexts.harness, delivery, model: group.models.harness, effort:strength.selected }, { signal, timeoutMs: 30 * 60 * 1000 }); if(result.effortReceipt?.deliveryId===delivery.id&&result.effortReceipt.sessionId===group.contexts.harness){const receipt=result.effortReceipt;const saved=this.saveStrength(delivery,{requested:receipt.requested??null});this.saveStrength(delivery,confirmEffort(saved,receipt.confirmed,{native:true,deliveryId:delivery.id,sessionId:receipt.sessionId,route:'harness',turn:receipt.turn,source:receipt.source,headerSeqs:receipt.headerSeqs}));}return result; }
    finally { clearInterval(timer); signal?.removeEventListener('abort', abort); }
  }
  async scopeUserTurns(group,ownerThreadId) {
    if(!ownerThreadId||Object.values(group.contexts).includes(ownerThreadId))throw Error('A separate native human owner is required.');
    return this.readUserTurns({threadId:ownerThreadId,cwd:group.repo});
  }
  async ownerPermissionProof(group, permission) {
    const owner = this.store.group(group.id).approvalOwnerThreadId;
    if (!owner || Object.values(group.contexts).includes(owner)) return null;
    return ownerApprovalProof(await this.readUserTurns({ threadId: owner, cwd: group.repo }), permission, owner);
  }
  async permissionSnapshot(group, member) {
    if(member==='owner')return {turnIds:(await this.scopeUserTurns(group,group.approvalOwnerThreadId)).map(t=>t.turnId)};
    if (member === 'codex') return { turnIds: (await this.readUserTurns({ threadId: group.contexts.codex, cwd: group.worktrees.codex })).map(t => t.turnId) };
    const adapter = this.adapter(group);
    if (!adapter?.features?.includes('human-proof-v1')) throw new Error('Reload the native companion before requesting cross-host approval.');
    return localFetch(adapter, '/permission-snapshot', { sessionId: group.contexts.harness });
  }
  async permissionProof(group, record) {
    if(record.confirmBy==='owner'){
      if(group.approvalOwnerThreadId!==record.confirmSession||Object.values(group.contexts).includes(record.confirmSession))return null;
      const turn=(await this.scopeUserTurns(group,record.confirmSession)).find(t=>!record.barrier.turnIds.includes(t.turnId)&&t.status==='completed'&&(sameCommand(t.text,record.allowPhrase)||sameCommand(t.text,record.rejectPhrase)));
      return turn?{adapter:'codex-owner',sessionId:record.confirmSession,turnId:turn.turnId,itemId:turn.itemId,decision:sameCommand(turn.text,record.allowPhrase)?'allow':'reject'}:null;
    }
    const candidate = record.candidate;
    if (!candidate || candidate.sessionId !== group.contexts[record.confirmBy]) return null;
    if (record.confirmBy === 'codex') {
      const proof = (await this.readUserTurns({ threadId: candidate.sessionId, cwd: group.worktrees.codex })).find(t =>
        !record.barrier.turnIds.includes(t.turnId) && t.turnId === candidate.turnId && t.status === 'completed' && sameCommand(t.text, candidate.content));
      return proof ? { adapter: 'codex', sessionId: candidate.sessionId, turnId: proof.turnId, itemId: proof.itemId } : null;
    }
    const adapter = this.adapter(group); if (!adapter) return null;
    const result = await localFetch(adapter, '/permission-proof', { sessionId: candidate.sessionId,
      afterSeq: record.barrier.seq, messageId: candidate.messageId, content: candidate.content });
    return result.proof && result.adapterId === group.harnessAdapterId ? result.proof : null;
  }
  async harnessPermissionActive(group, delivery, handlerId) {
    const adapter = this.adapter(group);
    if (!adapter?.features?.includes('human-proof-v1')) throw new Error('Native permission relay is not connected.');
    const result = await localFetch(adapter, '/permission-active', { sessionId: group.contexts.harness, deliveryId: delivery.id, handlerId });
    if (!result.active || result.adapterId !== group.harnessAdapterId) throw new Error('No matching native permission request exists.');
    return result.details;
  }
  recoveryConnectionKey(group, delivery) {
    return delivery.member === 'codex' ? desktopBridgeGeneration() : null;
  }
  preflightNonAdmission(group, delivery) {
    const p=delivery.nativeDispatch;
    if(delivery.member!=='codex'||delivery.nativeAdmission||delivery.nativeTurnId||!p||p.route!=='desktop'||p.stage!=='preflight'||
       p.threadId!==group.contexts.codex||p.deliveryId!==delivery.id||p.requestId!==delivery.requestId||
       p.revision!==delivery.revision||p.epoch!==delivery.epoch||p.promptHash!==this.store.hash(`[Group delivery ${delivery.id}]\n${delivery.prompt}`))return null;
    return {notAdmitted:true,proof:{...p,kind:'desktop-preflight'}};
  }
  async recover(group, delivery, signal) {
    if(group.peerConnectionId&&delivery.member==='harness')return this.external.recover(group.contexts.harness,delivery);
    if (delivery.member === 'codex') {
      const unadmitted=this.preflightNonAdmission(group,delivery);if(unadmitted)return unadmitted;
      const prompt=`[Group delivery ${delivery.id}]\n${delivery.prompt}`;
      const receipt=delivery.nativeAdmission;
      const live=this.nativeReaders.get(delivery.id);
      if(live&&live.threadId===group.contexts.codex&&live.turnId===receipt?.turnId&&live.turnId===delivery.nativeTurnId&&live.requestId===delivery.requestId&&live.revision===delivery.revision&&live.epoch===delivery.epoch&&live.promptHash===receipt.promptHash){
        const observed=await live.read();
        if(this.nativeReaders.get(delivery.id)===live&&observed?.pending===true&&observed.turnId===live.turnId)return {pending:true,turnId:live.turnId,source:'original_native_connection'};
      }
      return this.codexRecovery({ threadId: group.contexts.codex, cwd: group.worktrees.codex, prompt,
        nativeTurnId:receipt?.threadId===group.contexts.codex&&receipt.promptHash===this.store.hash(prompt)?receipt.turnId:undefined,
        allowSupersededReadOnly:delivery.phase==='planning'&&delivery.revision<this.store.request(delivery.requestId)?.revision,
        refusal: codexWriterRefusal(this.store, group, delivery), signal });
    }
    const descriptor = this.adapter(group);
    if (!descriptor) return null;
    const response = await localFetch(descriptor, '/recover', { sessionId: group.contexts.harness, deliveryId: delivery.id }, { signal });
    if (response.result) return response.result;
    if(response.pending===true&&response.sessionId===group.contexts.harness&&response.deliveryId===delivery.id&&response.adapterId===group.harnessAdapterId&&Number.isSafeInteger(response.activeTurn?.turn)&&Number.isSafeInteger(response.activeTurn?.startSeq)&&Number.isSafeInteger(response.activeTurn?.userSeq)&&response.activeTurn.userSeq>=response.activeTurn.startSeq)return {pending:true,turnId:response.activeTurn.turn};
    if (response.notAdmitted && response.sessionId === group.contexts.harness && response.deliveryId === delivery.id && response.adapterId === group.harnessAdapterId) return { notAdmitted: true };
    return null;
  }
}
