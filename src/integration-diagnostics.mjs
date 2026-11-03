// Structured integration diagnostics.
// Pure functions only (no fs/git/child_process), so they can be unit tested in isolation.
// Goal: every integration failure carries a machine-readable reason code, a human
// explanation, and compact technical detail for the collapsed "技术详情" area.
// This module never decides to continue an integration: it only describes why one
// was refused. Callers must still throw/refuse (see integrationFailure()).

export const INTEGRATION_ERROR = 'INTEGRATION';

const HUMAN = Object.freeze({
  scope_source_missing: {detail:'候选成员工作树缺少主项目已有文件，不能把缺失自动解释为删除。',next:'由独立成员确认本轮是合入候选，还是只核验主项目现有成果；确认来源前不执行删除或重复提交。',owner:'成员核对文件来源',needsUser:false,action:'diagnose',label:'核对范围来源'},
  verification_mismatch: {
    detail: '整合后的文件与固定验收清单不一致，现有文件和原成果已保留。',
    next: '由整合者核对差异：已匹配文件保留，遗漏文件只按原候选补齐；若要缩减范围先独立复核，禁止直接忽略校验。',
    owner: '整合者核对固定范围与实际交付', needsUser: false, action: 'diagnose', label: '核对交付差异',
  },
  consent_expired: {
    detail: '整合覆盖授权已过期（有效期 30 分钟），本次没有覆盖任何文件。',
    next: '重新给一次覆盖授权后立即整合；授权与整合之间不要再插入其他操作。',
    owner: '你',
    needsUser: true,
    action: 'diagnose',
    label: '准备重新授权说明',
  },
  consent_files_changed: {
    detail: '授权之后目标文件发生了变化，原授权自动失效，本次没有覆盖文件。',
    next: '先核对 before/current/wanted 三个哈希；确认要覆盖的版本后重新授权。',
    owner: '你决定，整合者先列出差异',
    needsUser: true,
    action: 'diagnose',
    label: '准备差异说明',
  },
  consent_request_changed: {
    detail: '授权绑定的请求或版本已变化（例如补充了新需求），本次没有覆盖文件。',
    next: '在当前请求上重新授权；或先完成当前请求再整合。',
    owner: '你',
    needsUser: true,
    action: 'diagnose',
    label: '准备重新授权说明',
  },
  main_conflict: {
    detail: '主项目相关文件与预期版本不一致；为保护现有内容，本次没有覆盖。',
    next: '让整合者列出主项目当前内容与预期的差异，确认来源后再决定是否覆盖。',
    owner: '你决定，整合者先列出差异',
    needsUser: true,
    action: 'diagnose',
    label: '准备差异说明',
  },
  member_conflict: {
    detail: '两位共创成员对同一文件给出了不同内容，无法自动合并，本次没有覆盖。',
    next: '让成员对齐到同一版内容后再整合；不要用多数或整合者身份替你裁决。',
    owner: '你查看排查结果并决定下一步',
    needsUser: true,
    action: 'diagnose',
    label: '准备排查请求',
  },
  path_unsafe: {
    detail: '目标路径越出仓库范围或经过符号链接，出于安全拒绝整合。',
    next: '由真人确认路径；不要用符号链接或仓库外路径参与整合。',
    owner: '你',
    needsUser: true,
    action: 'diagnose',
    label: '准备路径说明',
  },
  checkpoint_missing_or_stale: {
    detail: '连续整合检查点缺失或落后，无法证明主项目当前内容来自本群上次整合。',
    next: '先做一次只读差异核对，确认来源后再决定是否授权覆盖。',
    owner: '你决定，整合者先核对来源',
    needsUser: true,
    action: 'diagnose',
    label: '准备来源核对',
  },
  unknown: {
    detail: '整合失败，但现有信息无法确认具体原因。',
    next: '把技术详情交给真人或让成员排查；不要重复尝试或换入口。',
    owner: '你查看失败原因并给出下一步要求',
    needsUser: true,
    action: 'diagnose',
    label: '准备排查请求',
  },
});

export const INTEGRATION_REASON_CODES = Object.freeze(Object.keys(HUMAN));

function compact(value, limit = 300) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > limit ? value.slice(0, limit) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => (typeof item === 'string' ? compact(item, 120) : compact(item, limit)));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = typeof item === 'string' ? compact(item, limit) : compact(item, limit);
    }
    return out;
  }
  return null;
}

export function integrationHuman(code) {
  return HUMAN[code] ?? HUMAN.unknown;
}

// Returns an Error whose message is already the human sentence, tagged with
// code/details so the engine can persist it as request.errorDetails.
export function integrationFailure(code, details = {}) {
  const known = Object.hasOwn(HUMAN, code);
  const human = integrationHuman(known ? code : 'unknown');
  const reason = known ? code : 'unknown';
  const error = new Error(human.detail);
  error.code = INTEGRATION_ERROR;
  error.reason = reason;
  error.details = {
    code: INTEGRATION_ERROR,
    reason,
    human: {
      detail: human.detail,
      next: human.next,
      owner: human.owner,
      needsUser: human.needsUser,
      action: human.action,
      label: human.label,
    },
    technical: compact(details) ?? {},
  };
  return error;
}

// Normalises anything thrown by the integration checks into the same shape.
// The returned object is JSON-serializable (no cycles) and also exposes
// `message` / `details` so callers can pass it straight into block(...).
// Unknown failures are reported as "unknown" instead of being classified by guesswork.
export function describeIntegrationFailure(error) {
  if (error && error.code === INTEGRATION_ERROR && error.details && error.details.human) {
    const details = error.details;
    return { ...details, message: details.human.detail, details };
  }
  const human = HUMAN.unknown;
  const details = {
    code: INTEGRATION_ERROR,
    reason: 'unknown',
    human: {
      detail: human.detail,
      next: human.next,
      owner: human.owner,
      needsUser: human.needsUser,
      action: human.action,
      label: human.label,
    },
    technical: { raw: compact(error && error.message ? String(error.message) : String(error)) ?? '' },
  };
  return { ...details, message: details.human.detail, details };
}

// Single place that decides whether a request keeps or loses its diagnostics.
// Used by the engine before persisting so stale diagnostics cannot survive a
// supplement, retry, recovery or a successful step.
export function attachDiagnostics(target, details) {
  if (!target || typeof target !== 'object') return target;
  if (details) target.errorDetails = { ...details, binding: { requestId: target.id, revision: target.revision ?? 0, error: target.error } }; else delete target.errorDetails;
  return target;
}

// Small helper so callers never build ad-hoc text: keep reason codes one of the known set.
export function isKnownIntegrationReason(code) {
  return Object.hasOwn(HUMAN, code) && code !== 'unknown';
}

export function currentDiagnostics(request) {
 const d=request?.errorDetails,b=d?.binding;
 return request?.error && b && b.requestId===request.id && b.revision===(request.revision??0) && b.error===request.error && !['completed','cancelled','queued','active'].includes(request.status) ? d : null;
}
