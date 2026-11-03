import { parseCommand, looksLikeCommand } from './approval-text.mjs';
import { cancellationSource } from './group-http.mjs';
import { randomUUID, createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;

// Identity of the operation, never authority to execute it. Keep every effect
// field; only native invocation identifiers may change on a fresh request.
export function intentOperationHash(details) {
  const copy = structuredClone(details);
  for (const key of ['threadId', 'turnId', 'itemId', 'callId', 'startedAtMs']) delete copy.params?.[key];
  if (copy.params?.nativeItem) {
    for (const key of ['id', 'processId', 'status', 'aggregatedOutput', 'exitCode', 'durationMs']) delete copy.params.nativeItem[key];
  }
  return hash(JSON.stringify(ordered(copy)));
}

export function pendingPermissionIntents(store, group, request, member) {
  const expire=()=>{
    if(store.request(request.id)?.revision!==request.revision)return;
    for(const p of store.permissions(group.id)){
      if(p.requestId!==request.id||!['cancelled','interrupted'].includes(p.status)||
         p.resumeIntent?.status!=='awaiting_native_request'||p.revision>=request.revision)continue;
      p.resumeIntent.status='expired';p.resumeIntent.reason='需求版本已变化，旧操作意图已过期；不会复用旧审批。若当前需求仍需该操作，请先核对当前要求与原执行检查点；只有确认可以安全重新发起后，才可创建新编号并等待新的真人决定。未知执行结果继续保留，不会自动重放。';store.savePermission(p);
      store.message(group.id,{sender:'system',channel:'group',requestId:request.id,content:`旧审批 ${p.id}：${p.resumeIntent.reason}`});
    }
  };
  if(store.db.isTransaction)expire();else store.transaction(expire);
  return store.permissions(group.id).filter(p => {
    const i = p.resumeIntent;
    return i?.status === 'awaiting_native_request' && ['cancelled', 'interrupted'].includes(p.status) &&
      p.requestId === request.id && p.revision === request.revision && i.epoch === group.epoch &&
      (!member || p.member === member) && i.contexts.codex === group.contexts.codex &&
      i.contexts.harness === group.contexts.harness && i.operationHash === intentOperationHash(p.details);
  });
}

// Called only after recovery confirms that this exact native turn ended. An
// unknown/pending transport outcome must never make an intent re-dispatchable.
export function settlePermissionIntents(store, group, request, delivery) {
  let found = false;
  for (const p of store.permissions(group.id)) {
    const i = p.resumeIntent;
    if (i?.status !== 'awaiting_checkpoint' || p.deliveryId !== delivery.id || p.requestId !== request.id ||
        delivery.requestId !== request.id || delivery.member !== p.member) continue;
    const valid = ['cancelled', 'interrupted'].includes(p.status) && p.revision === request.revision &&
      i.epoch === group.epoch && i.contexts.codex === group.contexts.codex && i.contexts.harness === group.contexts.harness &&
      i.operationHash === intentOperationHash(p.details);
    i.status = valid ? 'awaiting_native_request' : 'stale';
    store.savePermission(p); found ||= valid;
  }
  return found;
}

export function operationHash(record) {
  const { method, params } = record.details;
  let operation;
  if (method === 'harness/tool') {
    const args = typeof params.arguments === 'string' ? JSON.parse(params.arguments) : params.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid native operation arguments.');
    const { description, justification, ...effects } = args;
    operation = { toolName: params.toolName, arguments: effects };
  } else if (method === 'item/commandExecution/requestApproval') operation = { command: params.command, cwd: params.cwd };
  else throw Error('Owner receipts currently support exact native commands only.');
  return hash(JSON.stringify(ordered({ groupId: record.groupId, requestId: record.requestId, member: record.member, method, operation })));
}

export function ownerApprovalProof(turns, permission, threadId) {
  const phrase = `批准 ${permission.groupId} ${permission.id}`;
  for (const turn of [...turns].reverse()) {
    if (!turn.itemId || !turn.turnId) continue;
    const match = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(turn.text);
    if (!match) continue;
    let replies; try { replies = JSON.parse(match[1]); } catch { continue; }
    if (!Array.isArray(replies)) continue;
    const reply = replies.find(r => r.question === phrase && r.answer?.trim() === '批准' && typeof r.questionItemId === 'string');
    if (reply) return { adapter: 'codex-owner', threadId, turnId: turn.turnId, itemId: turn.itemId,
      questionItemId: reply.questionItemId, textHash: hash(turn.text), permissionId: permission.id };
  }
  return null;
}

export async function recordOwnerApproval(store, runtime, { groupId, permissionId }) {
  const group = store.group(groupId), permission = store.permission(permissionId);
  if (!group.approvalOwnerThreadId || Object.values(group.contexts).includes(group.approvalOwnerThreadId)) throw Error('A separate human owner chat must be explicitly configured.');
  if (!permission || permission.groupId !== groupId || !['cancelled', 'interrupted'].includes(permission.status)) throw Error('Only a never-approved interrupted command may receive a one-use retry receipt.');
  if (permission.resumeIntent) throw Error('A lifecycle intent requires a fresh native request and fresh approval, not an old request receipt.');
  const request = store.requestForDelivery(permission.requestId,permission.deliveryId);
  if (request.status !== 'blocked' || request.deliveryId || request.revision !== permission.revision) throw Error('Original demand must be settled and unchanged.');
  const proof = await runtime.ownerPermissionProof(group, permission);
  if (!proof || proof.threadId !== group.approvalOwnerThreadId || proof.permissionId !== permissionId) throw Error('No exact native human question reply approves this operation.');
  const digest = operationHash(permission);
  return store.transaction(() => {
    const latest = store.permission(permissionId), current = store.group(groupId), r = store.requestForDelivery(permission.requestId,permission.deliveryId);
    if (current.approvalOwnerThreadId !== group.approvalOwnerThreadId || latest.status !== permission.status || operationHash(latest) !== digest || r.deliveryId || r.status !== 'blocked' || r.revision !== permission.revision) throw Error('Operation changed during human proof verification.');
    if (latest.ownerReceipt) throw Error('This human decision already has a receipt; it cannot be reset or reused.');
    latest.ownerReceipt = { status: 'ready', proof, operationHash: digest, revision: r.revision, expiresAt: Date.now() + 10 * 60 * 1000 };
    store.savePermission(latest);
    store.message(groupId, { sender: 'system', channel: 'group', requestId: r.id,
      content: `已核验项目发起聊天的真人批准：${permissionId}。原请求未执行且已中断；仅允许原需求重试同一具体命令一次，10分钟失效，命令或需求改变即无效。` });
    return { permissionId, status: latest.ownerReceipt.status, proof, operationHash: digest };
  });
}

// Denial-only repair for the rich-text rejection incident. Never resumes a
// request, creates a receipt or permits execution. Keep the original cancel.
export function ownerRejectionQuestion(group, permission) {
  return `请在 Codex 侧边栏的“${group.title} · Codex”聊天中，只发送下面这一行，再选“已发送”：\n\n拒绝 ${group.id} ${permission.id}\n\n这是当前有效的新测试请求，拒绝后不会运行标记命令。本次不用关闭应用；我会核对原生拒绝记录和待审批清零。`;
}
export function ownerRejectionProof(turns, group, permission) {
  const question=ownerRejectionQuestion(group,permission);
  for(const turn of [...turns].reverse()){
    if(!turn.turnId||!turn.itemId)continue;
    const match=/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/.exec(turn.text);
    if(!match)continue;
    let replies;try{replies=JSON.parse(match[1])}catch{continue}
    if(!Array.isArray(replies))continue;
    const reply=replies.find(r=>r.question===question&&r.answer==='已发送'&&typeof r.questionItemId==='string');
    if(!reply)continue;
    let key;try{key=JSON.parse(reply.questionItemId)}catch{continue}
    if(!Array.isArray(key)||key.length!==3||key[0]!=='request_user_input_async'||!/^call_[A-Za-z0-9]+$/.test(key[1])||!Number.isSafeInteger(key[2])||key[2]<0)continue;
    return {adapter:'codex-owner-rejection',threadId:group.approvalOwnerThreadId,turnId:turn.turnId,itemId:turn.itemId,
      questionItemId:reply.questionItemId,textHash:hash(turn.text),permissionId:permission.id};
  }
  return null;
}
export async function recordOwnerRejection(store,runtime,{groupId,permissionId}){
  const group=store.group(groupId),permission=store.permission(permissionId);
  if(!group.approvalOwnerThreadId||Object.values(group.contexts).includes(group.approvalOwnerThreadId))throw Error('A separate human owner chat is required.');
  if(permission?.groupId!==groupId)throw Error('Unknown permission.');
  if(permission.status==='rejected'&&permission.rejectionReconciliation?.kind==='owner-confirmed-denial')return permission;
  const delivery=store.delivery(permission.deliveryId);
  if(permission.status!=='cancelled'||permission.proof||permission.ownerReceipt||permission.resumeIntent||
    permission.member!=='harness'||permission.confirmBy!=='codex'||permission.confirmSession!==group.contexts.codex||
    delivery?.status!=='received'||delivery.groupId!==groupId||delivery.requestId!==permission.requestId||!Number.isSafeInteger(delivery.cursor))throw Error('Only a terminal never-approved cancelled Harness request may be reconciled.');
  let after=delivery.cursor,misrouted;
  for(let page=0;page<10&&!misrouted;page++){
    const rows=store.messages(groupId,{after,limit:100}).messages;
    misrouted=rows.find(m=>m.sender==='human'&&m.requestId===permission.requestId&&m.inputMode==='supplement'&&
      m.origin?.adapter==='codex'&&m.origin.sessionId===permission.confirmSession&&m.content.startsWith('**')&&
      parseCommand(m.content)?.decision==='reject'&&parseCommand(m.content)?.permissionId===permission.id&&
      parseCommand(m.content)?.groupId===groupId&&m.timestamp>=permission.createdAt&&m.timestamp<=permission.decidedAt);
    if(rows.length<100)break;after=rows.at(-1).seq;
  }
  if(!misrouted)throw Error('No matching rich-text rejection was misrouted while this request was pending.');
  const proof=ownerRejectionProof(await runtime.readUserTurns({threadId:group.approvalOwnerThreadId,cwd:group.repo}),group,permission);
  if(!proof)throw Error('No exact native owner rejection confirmation exists.');
  const terminal=await runtime.recover(group,delivery);
  if(terminal?.interrupted!==true||terminal.pending)throw Error('Original native operation is not confirmed interrupted.');
  const digest=operationHash(permission);
  return store.transaction(()=>{
    const latest=store.permission(permissionId),g=store.group(groupId);
    if(latest.status!=='cancelled'||latest.proof||latest.ownerReceipt||latest.resumeIntent||operationHash(latest)!==digest||
      g.approvalOwnerThreadId!==proof.threadId||g.contexts.codex!==group.contexts.codex||g.contexts.harness!==group.contexts.harness||
      store.delivery(permission.deliveryId)?.status!=='received')throw Error('Permission changed during denial verification.');
    latest.rejectionReconciliation={kind:'owner-confirmed-denial',misroutedMessageId:misrouted.id,previousStatus:latest.status,previousReason:latest.reason,
      previousDecidedAt:latest.decidedAt,at:new Date().toISOString(),nativeTerminalConfirmed:true};
    latest.status='rejected';latest.proof=proof;latest.decidedAt=new Date().toISOString();
    latest.reason='原上下文的粗体拒绝误入需求后已取消；已核验项目发起聊天的原生真人拒绝确认。原取消记录保留，未恢复、批准或执行原操作。';
    store.savePermission(latest);
    store.message(groupId,{sender:'system',channel:'group',requestId:permission.requestId,
      content:`权限 ${permissionId}：rejected。已核验项目发起聊天中对此编号的真人拒绝确认，并确认原生操作已中断。原取消时间与原因保留；未补造原确认会话的记录、未重发或批准任何操作。`});
    return latest;
  });
}

export class GroupPermissions {
  constructor(store, runtime) { this.store = store; this.runtime = runtime; this.active = new Map(); }
  phrase(record, decision) { return `${decision === 'allow' ? '批准' : '拒绝'} ${record.groupId} ${record.id}`; }
  isCommand(content) { return Boolean(parseCommand(content)); }
  suspendForAppsClosed(group) {
    // Runs in the same transaction as epoch++ and before native cancellation.
    for (const p of this.store.permissions(group.id)) {
      const request = this.store.requestForDelivery(p.requestId,p.deliveryId);
      const i = p.resumeIntent;
      if (['awaiting_checkpoint', 'awaiting_native_request'].includes(i?.status) &&
          ['cancelled', 'interrupted'].includes(p.status) && p.revision === request?.revision &&
          group.activeRequestId === p.requestId && i.epoch === group.epoch &&
          i.contexts.codex === group.contexts.codex && i.contexts.harness === group.contexts.harness) {
        i.epoch = group.epoch + 1; this.store.savePermission(p); continue;
      }
      if (p.status !== 'pending' || p.epoch !== group.epoch || request?.revision !== p.revision ||
          group.activeRequestId !== p.requestId || request.deliveryId !== p.deliveryId) continue;
      p.resumeIntent = { status: 'awaiting_checkpoint', epoch: group.epoch + 1,
        contexts: { ...group.contexts }, operationHash: intentOperationHash(p.details),
        createdAt: new Date().toISOString() };
      this.store.savePermission(p);
      this.store.message(group.id, { sender: 'system', channel: 'group', requestId: p.requestId,
        content: `应用离线：已保留 ${p.member} 尚未批准的操作意图。旧审批 ${p.id} 失效；先核对原生检查点，确认中断后才可重新发起并等待新的真人决定。` });
    }
  }
  candidate(group, { adapter, sessionId, messageId, turnId, content }) {
    const parsed = parseCommand(content);
    if (!parsed) {
      if (/^(?:同意|批准|允许|拒绝|好的|yes|no|ok)[。.!！]?$/iu.test(content.trim()) && this.store.permissions(group.id).some(p=>p.status==='pending'||p.requestId===group.activeRequestId&&p.resumeIntent?.status==='awaiting_checkpoint')) {
        return {bound:true,block:true,reason:'当前有具体操作等待审批。普通“同意”或“拒绝”未绑定操作编号，不会作出决定，也不会作为新需求打断任务。请使用该审批提示中带群编号和操作编号的完整指令，到指定原生会话确认。'};
      }
      // Malformed approval-like text must not become a new demand or interrupt work.
      if (looksLikeCommand(content))
        return { bound: true, block: true, reason: '审批指令必须精确匹配，格式不合法，未作任何决定。请使用系统提示中的准确指令，不添加说明。' };
      return null;
    }
    const id = parsed.permissionId, record = this.store.permission(id);
    if(record?.groupId===group.id&&parsed.groupId===group.id&&record.status!=='pending')return {bound:true,block:true,
      reason:record.status==='rejected'?'这项操作已拒绝，无需重复发送。':'该编号已失效，本次决定未生效。请勿重用旧编号；如后续生成新审批，请仅对新的有效编号操作。'};
    if (!record || !this.active.has(id) || record.status !== 'pending' || record.groupId !== group.id || parsed.groupId !== group.id || record.confirmBy !== adapter || record.confirmSession !== sessionId) {
      return { bound: true, block: true, reason: '该审批已失效，或请到提示指定的空闲原生会话确认；群内身份标签不能批准权限。' };
    }
    const decision = parsed.decision;
    this.store.transaction(() => {
      const current = this.store.permission(id);
      current.candidate = { adapter, sessionId, messageId, turnId, content, parsed, decision };
      this.store.savePermission(current);
    });
    // This is only a hint to read native records. It never grants by sender label.
    return { bound: true, block: adapter === 'harness', approvalCandidate: true,
      reason: '审批指令已收到，须核验原生记录后才会生效。' };
  }
  async request(group, delivery, details, signal) {
    if (!signal || signal.aborted) return false;
    const current = this.store.group(group.id), request = this.store.requestForDelivery(delivery.requestId,delivery.id);
    if (current.activeRequestId !== request?.id || request.deliveryId !== delivery.id || ['paused', 'apps_closed', 'closed'].includes(current.status)) return false;
    const native = this.store.delivery(delivery.id);
    if (delivery.member === 'codex' && (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(details.method) ||
      details.params?.threadId !== group.contexts.codex || !native?.nativeTurnId || details.params?.turnId !== native.nativeTurnId)) return false;
    if (delivery.member === 'codex' && details.method === 'item/commandExecution/requestApproval' &&
      !(typeof details.params.command === 'string' && details.params.command.trim()) && !(typeof details.params.nativeItem?.command === 'string' && details.params.nativeItem.command.trim())) return false;
    if (delivery.member === 'codex' && details.method === 'item/fileChange/requestApproval' &&
      !(details.params.nativeItem?.type === 'fileChange' && Array.isArray(details.params.nativeItem.changes) && details.params.nativeItem.changes.length)) return false;
    if (delivery.member === 'harness' && (details.method !== 'harness/tool' || !details.params?.callId || details.params.arguments === undefined)) return false;
    if (JSON.stringify(details).length > 64000) throw new Error('Permission details too large for complete human review; operation declined.');
    const confirmBy = group.peerConnectionId ? 'owner' : delivery.member === 'codex' ? 'harness' : 'codex';
    const operation = { groupId: group.id, requestId: request.id, member: delivery.member, details };
    if (this.store.permissions(group.id).some(p => p.requestId === request.id && p.revision === request.revision &&
      p.member === delivery.member && p.resumeIntent?.status === 'awaiting_checkpoint' && p.resumeIntent.epoch === current.epoch)) return false;
    const intents = pendingPermissionIntents(this.store, current, request, delivery.member);
    const resumed = intents.find(p => p.resumeIntent.operationHash === intentOperationHash(details));
    if (intents.length && !resumed) return false;
    if (resumed && (resumed.deliveryId === delivery.id || delivery.member === 'codex' &&
      resumed.details.params.turnId === details.params.turnId || delivery.member === 'harness' &&
      resumed.details.params.callId === details.params.callId)) return false;
    let digest; try { digest = operationHash(operation); } catch { /* Other operations cannot use a command receipt. */ }
    const receipt = !resumed && digest && this.store.permissions(group.id).find(p => !p.resumeIntent && p.requestId === request.id && ['cancelled', 'interrupted'].includes(p.status) &&
      p.ownerReceipt?.status === 'ready' && p.ownerReceipt.revision === request.revision && p.ownerReceipt.expiresAt > Date.now() && p.ownerReceipt.operationHash === digest);
    const barrier = receipt ? { ownerReceiptId: receipt.id } : await this.runtime.permissionSnapshot(group, confirmBy);
    if (signal.aborted) return false;
    const record = { id: randomUUID(), groupId: group.id, requestId: request.id, deliveryId: delivery.id,
      member: delivery.member, details, confirmBy, confirmSession: confirmBy==='owner'?group.approvalOwnerThreadId:group.contexts[confirmBy], barrier,
      epoch: current.epoch, revision: request.revision, status: 'pending', createdAt: new Date().toISOString() };
    if (receipt) record.ownerReceiptId = receipt.id;
    record.allowPhrase = this.phrase(record, 'allow'); record.rejectPhrase = this.phrase(record, 'reject');
    this.store.transaction(() => {
      const latest = this.store.group(group.id), r = this.store.requestForDelivery(request.id,delivery.id);
      if (signal.aborted || latest.epoch !== record.epoch || r.revision !== record.revision || r.deliveryId !== delivery.id) throw new Error('Permission requester changed before presentation.');
      if (resumed) {
        const source = pendingPermissionIntents(this.store, latest, r, delivery.member).find(p => p.id === resumed.id);
        if (!source) throw Error('Permission intent changed before native reissue.');
        source.resumeIntent.status = 'reissued'; source.resumeIntent.reissuedAs = record.id;
        this.store.savePermission(source); record.resumesPermissionId = source.id;
      }
      this.store.savePermission(record); latest.pendingPermissionId = record.id; latest.status = 'awaiting_approval'; this.store.save(latest);
      this.store.message(group.id, { sender: 'system', channel: 'group', requestId: request.id,
        content: `${resumed ? `重开后重新请求：旧审批 ${resumed.id} 已失效，本次是新的原生请求，需新的真人决定。\n` : ''}需要真人单次审批（${delivery.member}）：${JSON.stringify(details)}\n请在${confirmBy==='owner'?'真人审批聊天 '+record.confirmSession:'空闲的 '+confirmBy+' 原生会话'}发送：${record.allowPhrase}\n或：${record.rejectPhrase}\n只有核验该会话新增原生用户记录后才会生效；代理回复、共享页身份标签及旧批准均无效。` });
    });
    return new Promise(resolve => {
      let settled = false, checking = false;
      const finish = (decision, proof, reason, receiptId, cancelSource) => {
        if (settled) return; settled = true; clearInterval(timer); signal.removeEventListener('abort', abort); this.active.delete(record.id);
        let allowed = decision === 'allow';
        try { this.store.transaction(() => {
          const saved = this.store.permission(record.id), latest = this.store.group(group.id);
          if (decision === 'allow' && receiptId) {
            const source = this.store.permission(receiptId);
            if (source.ownerReceipt?.status !== 'ready' || source.ownerReceipt.expiresAt <= Date.now() ||
              source.ownerReceipt.operationHash !== operationHash(saved) || source.ownerReceipt.revision !== this.store.requestForDelivery(request.id,delivery.id).revision ||
              JSON.stringify(source.ownerReceipt.proof) !== JSON.stringify(proof) || latest.approvalOwnerThreadId !== proof.threadId) throw Error('Human receipt changed or was consumed.');
            source.ownerReceipt.status = 'consumed'; source.ownerReceipt.consumedBy = saved.id; this.store.savePermission(source);
          }
          // The requesting app may disconnect before the other app closes or
          // the lifecycle poll runs. Keep the never-approved intent atomically
          // with cancellation. This is not approval or permission to replay:
          // original native completion must be verified before any new request.
          const currentRequest = this.store.requestForDelivery(saved.requestId,saved.deliveryId);
          if (decision == null && cancelSource === 'connection_disconnected' && saved.status === 'pending' && !saved.resumeIntent &&
              saved.epoch === latest.epoch && currentRequest?.revision === saved.revision &&
              currentRequest.deliveryId === saved.deliveryId && latest.activeRequestId === saved.requestId) {
            saved.resumeIntent = { status: 'awaiting_checkpoint', epoch: latest.epoch, contexts: { ...latest.contexts },
              operationHash: intentOperationHash(saved.details), createdAt: new Date().toISOString() };
            reason = `${reason ?? '审批连接已断开'}；已保留尚未批准的操作意图，须先核对原生检查点，再发起新的审批`;
          }
          saved.status = decision === 'allow' ? 'allowed_once' : decision === 'reject' ? 'rejected' : 'cancelled';
          saved.decidedAt = new Date().toISOString(); saved.proof = proof ?? null; saved.reason = reason ?? null; if (cancelSource) saved.cancelSource = cancelSource; this.store.savePermission(saved);
          if (latest.pendingPermissionId === saved.id) delete latest.pendingPermissionId;
          if (latest.status === 'awaiting_approval') latest.status = 'active'; this.store.save(latest);
          this.store.message(group.id, { sender: 'system', channel: 'group', requestId: request.id,
            content: `权限 ${saved.id}：${saved.status}${reason ? `（${reason}）` : ''}。仅针对本次原生请求。` });
        }); } catch { allowed = false; }
        resolve(allowed);
      };
      const abort = () => {
        const source = signal.aborted ? cancellationSource(signal.reason) : 'execution_interrupted';
        const label = { connection_disconnected: '\u5ba1\u6279\u8fde\u63a5\u5df2\u65ad\u5f00', transport_timeout: '\u5ba1\u6279\u7b49\u5f85\u5df2\u8d85\u65f6', execution_interrupted: '\u6267\u884c\u5df2\u4e2d\u65ad\u6216\u7ed1\u5b9a\u5df2\u53d8\u5316' }[source];
        finish(null, null, `${label}\uff1b\u65e7\u6279\u51c6\u4e0d\u53ef\u7528\u4e8e\u91cd\u8bd5`, undefined, source);
      };
      const check = async () => {
        if (checking || settled) return; checking = true;
        try {
          const saved = this.store.permission(record.id), latest = this.store.group(group.id), r = this.store.requestForDelivery(request.id,delivery.id);
          if (signal.aborted || latest.epoch !== record.epoch || r.revision !== record.revision || r.deliveryId !== delivery.id) return abort();
          let proof, decision, receiptId;
          if(saved.confirmBy==='owner'){proof=await this.runtime.permissionProof(group,saved);decision=proof?.decision;}
          else if (saved.candidate) { proof = await this.runtime.permissionProof(group, saved); decision = saved.candidate.decision; }
          else if (saved.ownerReceiptId) {
            const source = this.store.permission(saved.ownerReceiptId);
            if (!['cancelled', 'interrupted'].includes(source.status) || source.ownerReceipt?.status !== 'ready' || source.ownerReceipt.expiresAt <= Date.now() || source.ownerReceipt.operationHash !== operationHash(saved)) return abort();
            proof = await this.runtime.ownerPermissionProof(group, source);
            if (!proof || JSON.stringify(proof) !== JSON.stringify(source.ownerReceipt.proof)) return abort();
            decision = 'allow'; receiptId = source.id;
          } else return;
          if (!proof || settled) return;
          if (signal.aborted || this.store.group(group.id).epoch !== record.epoch || this.store.requestForDelivery(request.id,delivery.id).revision !== record.revision) return abort();
          if (JSON.stringify(this.store.permission(record.id).candidate) !== JSON.stringify(saved.candidate)) return;
          finish(decision, proof, undefined, receiptId);
        } catch (error) { if (!settled) finish(null, null, `无法核验原生记录：${error.message}`); }
        finally { checking = false; }
      };
      const timer = setInterval(check, 1500); timer.unref();
      this.active.set(record.id, { check, cancel: abort });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else if (record.ownerReceiptId || record.confirmBy==='owner') void check();
    });
  }
  recoverAbandoned() {
    this.store.transaction(() => {
      for (const group of this.store.list()) for (const record of this.store.permissions(group.id)) if (record.status === 'pending') {
        const request = this.store.requestForDelivery(record.requestId,record.deliveryId);
        if (!record.resumeIntent && request && request.revision === record.revision && request.deliveryId === record.deliveryId &&
            group.activeRequestId === record.requestId && record.epoch === group.epoch) {
          record.resumeIntent = { status: 'awaiting_checkpoint', epoch: group.epoch, contexts: { ...group.contexts },
            operationHash: intentOperationHash(record.details), createdAt: new Date().toISOString() };
        }
        record.status = 'interrupted'; record.reason = '协调器重启，须先核对原生检查点；不得复用旧批准。'; this.store.savePermission(record);
        if (group.pendingPermissionId === record.id) { delete group.pendingPermissionId; this.store.save(group); }
      }
    });
  }
}
