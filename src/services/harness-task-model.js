// 三页任务架构：Harness 任务快照的纯前端读取适配（无网络、无写入）。
//
// 只做确定性映射与有界化：任何输入（服务端快照、注入测试数据）都必须先
// 通过本模块的校验/归一化，再进入页面渲染。绝不在此处伪造任务、随机进度
// 或静态成功 —— 所有字段都来自真实服务端快照，缺失即诚实空态。
//
// 快照形状（与 harness-gateway externalTask 合同一致）：
//   task = {
//     id: 'ht-<uuid>',
//     state: 'planned|queued|running|succeeded|partial|failed|cancelled',
//     created_at, updated_at,
//     request: { user_id, request_id, project_id, intent },
//     request_fingerprint,
//     plan: { fingerprint, workflow_title, steps[], approvals{}, slots{} } | null,
//     plan_fingerprint,
//     confirmation: { approval{} } | null,
//     retry_target,
//     step_states: { [stepId]: { state, error, failed_count, started_at, finished_at } },
//     result: { artifact_refs[], final_response, result_data, presentation } | null,
//     error: { code, message, category, stage, exit_code, summary, tool_code, operation } | null,
//   }

export const HARNESS_TASK_ID_PATTERN = /^ht-[0-9a-f-]{36}$/;
export const EVIDENCE_REF_PATTERN = /^ev-[0-9a-f]{24}$/;
export const KNOWLEDGE_REF_PATTERN = /^(?:kc|card)-[0-9a-f]{24}$/;
export const BRIEF_REF_PATTERN = /^brf-[0-9a-f]{24}$/;
export const GENERATION_ARTIFACT_REF_PATTERN = /^g1x-[0-9a-f]{24}$/;
export const PROJECT_ID_PATTERN = /^prj-[0-9a-f]{24}$/;

export const TASK_STATE_LABELS = Object.freeze({
  planned: '等待确认',
  queued: '等待执行',
  running: '正在执行',
  reused: '已复用',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '执行失败',
  blocked: '已阻断',
  skipped: '已跳过',
  cancelled: '已取消',
});

export const STEP_STATE_LABELS = Object.freeze({
  planned: '等待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  blocked: '已阻断',
  skipped: '已跳过',
});

export const APPROVAL_LABELS = Object.freeze({
  paid_external_calls: '付费采集或模型分析',
  online_writes: '保存产物到 staging',
  handoff_creation: '创建交接包',
});

export const APPROVAL_REQUIREMENTS = Object.freeze(['paid_external_calls', 'online_writes', 'handoff_creation']);

const MAX_INTENT_TEXT = 12_000;
const MAX_RESPONSE_TEXT = 12_000;
const MAX_ERROR_TEXT = 240;
const MAX_REF_TEXT = 240;
const MAX_STEPS = 50;
const MAX_ARTIFACT_REFS = 50;
const MAX_STATE_TEXT = 24;

export function isValidHarnessTaskId(value) {
  return typeof value === 'string' && HARNESS_TASK_ID_PATTERN.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, limit) {
  return String(value ?? '').slice(0, limit);
}

export function stateLabel(state) {
  return TASK_STATE_LABELS[state] || String(state || 'unknown').slice(0, MAX_STATE_TEXT);
}

export function stepStateLabel(state) {
  return STEP_STATE_LABELS[state] || String(state || 'planned').slice(0, MAX_STATE_TEXT);
}

/**
 * 任务阶段分类（页面信息架构用）：
 * - planned：权威计划已生成，等待人工确认（审核中）；
 * - active：已确认，正在排队或执行；
 * - attention：终态但需要处理（部分完成/失败）；
 * - terminal：正常终态（成功/复用/取消）。
 */
export function taskPhase(task) {
  const state = task?.state;
  if (state === 'planned') return 'planned';
  if (state === 'queued' || state === 'running') return 'active';
  if (state === 'partial' || state === 'failed' || state === 'blocked') return 'attention';
  return 'terminal';
}

export function isTaskActive(state) {
  return state === 'queued' || state === 'running';
}

export function isTaskTerminal(state) {
  return ['succeeded', 'reused', 'partial', 'failed', 'blocked', 'cancelled'].includes(state);
}

/**
 * 归一化服务端任务快照为有界安全视图；非法输入返回 null（页面渲染诚实
 * 错误态，绝不猜测字段）。
 */
export function normalizeTaskSnapshot(value) {
  if (!isPlainObject(value)) return null;
  const id = boundedText(value.id, 80);
  if (!isValidHarnessTaskId(id)) return null;
  const state = boundedText(value.state, MAX_STATE_TEXT);
  if (!Object.hasOwn(TASK_STATE_LABELS, state) && !['unknown'].includes(state)) {
    return { id, state: 'unknown', created_at: '', updated_at: '', request: null, plan: null, confirmation: null, retry_target: null, step_states: {}, result: null, error: null, invalid: true };
  }
  const request = isPlainObject(value.request) ? {
    intent: boundedText(value.request.intent, MAX_INTENT_TEXT),
    project_id: typeof value.request.project_id === 'string' ? value.request.project_id.slice(0, 80) : null,
    request_id: typeof value.request.request_id === 'string' ? value.request.request_id.slice(0, 200) : null,
  } : null;
  const plan = isPlainObject(value.plan) ? {
    fingerprint: typeof value.plan.fingerprint === 'string' ? value.plan.fingerprint.slice(0, 64) : '',
    workflow_title: boundedText(value.plan.workflow_title, 160),
    steps: Array.isArray(value.plan.steps)
      ? value.plan.steps.slice(0, MAX_STEPS).map((step) => (isPlainObject(step) ? {
          step: boundedText(step.step, 40),
          label: boundedText(step.label, 160),
          operation: boundedText(step.operation, 80),
          depends_on: Array.isArray(step.depends_on) ? step.depends_on.slice(0, MAX_STEPS).map((dep) => boundedText(dep, 40)) : [],
          reuse: step.reuse === true,
          cost: step.cost === true,
          write: step.write === true,
        } : null)).filter(Boolean)
      : [],
    approvals: isPlainObject(value.plan.approvals) ? Object.fromEntries(
      APPROVAL_REQUIREMENTS.filter((key) => value.plan.approvals[key] === true).map((key) => [key, true]),
    ) : {},
    slots: isPlainObject(value.plan.slots) ? value.plan.slots : null,
  } : null;
  const confirmation = isPlainObject(value.confirmation) ? {
    approval: isPlainObject(value.confirmation.approval) ? Object.fromEntries(
      APPROVAL_REQUIREMENTS.filter((key) => value.confirmation.approval[key] === true).map((key) => [key, true]),
    ) : {},
  } : null;
  const stepStates = {};
  if (isPlainObject(value.step_states)) {
    for (const [stepId, raw] of Object.entries(value.step_states)) {
      if (!isPlainObject(raw)) continue;
      stepStates[boundedText(stepId, 40)] = {
        state: boundedText(raw.state, MAX_STATE_TEXT) || 'planned',
        failed_count: Number.isSafeInteger(raw.failed_count) && raw.failed_count > 0 ? raw.failed_count : 0,
        started_at: typeof raw.started_at === 'string' ? raw.started_at.slice(0, 40) : null,
        finished_at: typeof raw.finished_at === 'string' ? raw.finished_at.slice(0, 40) : null,
        error: isPlainObject(raw.error) ? {
          code: boundedText(raw.error.code, 80),
          message: boundedText(raw.error.message, MAX_ERROR_TEXT),
          retry_unsafe: raw.error.retry_unsafe === true,
        } : null,
      };
    }
  }
  const result = isPlainObject(value.result) ? {
    artifact_refs: Array.isArray(value.result.artifact_refs)
      ? value.result.artifact_refs.slice(0, MAX_ARTIFACT_REFS).map((ref) => boundedText(ref, MAX_REF_TEXT))
      : [],
    final_response: boundedText(value.result.final_response, MAX_RESPONSE_TEXT),
    result_data: value.result.result_data,
    presentation: value.result.presentation,
  } : null;
  const error = isPlainObject(value.error) ? {
    code: boundedText(value.error.code, 80),
    message: boundedText(value.error.message, MAX_ERROR_TEXT),
    summary: boundedText(value.error.summary, MAX_ERROR_TEXT),
    operation: boundedText(value.error.operation, 80),
    tool_code: boundedText(value.error.tool_code, 80),
    category: boundedText(value.error.category, 32),
    stage: boundedText(value.error.stage, 40),
  } : null;
  return {
    id,
    state,
    created_at: typeof value.created_at === 'string' ? value.created_at.slice(0, 40) : '',
    updated_at: typeof value.updated_at === 'string' ? value.updated_at.slice(0, 40) : '',
    request,
    plan,
    confirmation,
    retry_target: typeof value.retry_target === 'string' ? value.retry_target.slice(0, 40) : null,
    step_states: stepStates,
    result,
    error,
    invalid: false,
  };
}

/** 产物身份分类：返回 { kind, id, label }；无法识别时 kind='other'。 */
export function classifyArtifactRef(ref) {
  const text = String(ref ?? '');
  const match = text.split('/').filter(Boolean).at(-1) || text;
  if (EVIDENCE_REF_PATTERN.test(match)) return { kind: 'evidence', id: match, label: '证据' };
  if (KNOWLEDGE_REF_PATTERN.test(match)) return { kind: 'knowledge', id: match, label: '知识卡' };
  if (BRIEF_REF_PATTERN.test(match)) return { kind: 'brief', id: match, label: 'Brief' };
  if (GENERATION_ARTIFACT_REF_PATTERN.test(match)) return { kind: 'generation', id: match, label: '生成产物' };
  return { kind: 'other', id: boundedText(text, MAX_REF_TEXT), label: '身份引用' };
}

/**
 * 结果来源链：由任务结果中的 artifact_refs 与请求绑定派生（真实服务端
 * 字段，去重保序）。只展示存在的数据；无产物时返回空数组。
 */
export function buildSourceChain(task) {
  if (!task) return { project_id: null, evidence: [], knowledge: [], brief: [], generation: [], other: [] };
  const chain = { project_id: task.request?.project_id || null, evidence: [], knowledge: [], brief: [], generation: [], other: [] };
  const seen = new Set();
  for (const ref of task.result?.artifact_refs || []) {
    const classified = classifyArtifactRef(ref);
    const key = `${classified.kind}:${classified.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (chain[classified.kind] && Array.isArray(chain[classified.kind])) chain[classified.kind].push(classified.id);
  }
  return chain;
}

/** 审核状态摘要：当前状态 + 已批准范围 + 计划指纹（全部来自真实快照）。 */
export function reviewSummary(task) {
  if (!task) return null;
  const approvals = task.confirmation?.approval || {};
  return {
    state: task.state,
    label: stateLabel(task.state),
    phase: taskPhase(task),
    approvals,
    requiredApprovals: task.plan?.approvals || {},
    plan_fingerprint: task.plan?.fingerprint || task.plan_fingerprint || null,
    workflow_title: task.plan?.workflow_title || null,
  };
}

/** 步骤执行事件视图：step_states → 有序的进度/失败/尝试计数数组。 */
export function stepExecutionView(task) {
  if (!task?.plan?.steps) return [];
  return task.plan.steps.map((step) => {
    const snapshot = task.step_states?.[step.step] || { state: 'planned', failed_count: 0, started_at: null, finished_at: null, error: null };
    return {
      step: step.step,
      label: step.label,
      operation: step.operation,
      depends_on: step.depends_on,
      reuse: step.reuse,
      cost: step.cost,
      write: step.write,
      state: snapshot.state || 'planned',
      stateLabel: stepStateLabel(snapshot.state || 'planned'),
      attempts: Number(snapshot.failed_count) || 0,
      started_at: snapshot.started_at || null,
      finished_at: snapshot.finished_at || null,
      error: snapshot.error || null,
      retryable: snapshot.state === 'failed' && snapshot.error?.retry_unsafe !== true,
    };
  });
}

/** 有界错误文本（绝不回显原始载荷）。 */
export function taskErrorText(task) {
  if (!task?.error) return '';
  const { code, message, summary, operation, category, stage } = task.error;
  const parts = [];
  if (operation) parts.push(operation);
  if (code) parts.push(code);
  if (category && category !== 'unknown') parts.push(category);
  if (stage && stage !== 'unknown') parts.push(stage);
  const detail = message || summary || '';
  return `${parts.join(' · ')}${detail ? `：${detail}` : ''}`.slice(0, 400);
}

/** 计划确认/执行所需的人工授权范围（来自权威计划，绝不缺省放大）。 */
export function requiredApprovals(task) {
  return task?.plan?.approvals || {};
}
