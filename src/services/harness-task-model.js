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
export const ANALYSIS_REF_PATTERN = /^an-[0-9a-f]{24}$/;
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
const MAX_TOOL_CALLS = 100;
const MAX_SECTION_ITEMS = 50;
const MAX_FINGERPRINT_TEXT = 64;

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
  const requestFingerprint = typeof value.request_fingerprint === 'string' ? value.request_fingerprint.slice(0, MAX_FINGERPRINT_TEXT) : '';
  const planFingerprint = typeof value.plan_fingerprint === 'string' ? value.plan_fingerprint.slice(0, MAX_FINGERPRINT_TEXT) : '';
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
        tool_calls: normalizeToolCallList(raw.tool_calls),
      };
    }
  }
  const toolCalls = normalizeToolCallList(value.tool_calls);
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
    request_fingerprint: requestFingerprint,
    plan,
    plan_fingerprint: planFingerprint,
    confirmation,
    retry_target: typeof value.retry_target === 'string' ? value.retry_target.slice(0, 40) : null,
    step_states: stepStates,
    tool_calls: toolCalls,
    result,
    error,
    invalid: false,
  };
}

function normalizeToolCallList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_TOOL_CALLS).map((call) => (isPlainObject(call) ? {
    tool: boundedText(call.tool, 80),
    operation: boundedText(call.operation, 80),
    status: boundedText(call.status ?? call.state ?? '', MAX_STATE_TEXT) || 'unknown',
    started_at: typeof call.started_at === 'string' ? call.started_at.slice(0, 40) : null,
    finished_at: typeof call.finished_at === 'string' ? call.finished_at.slice(0, 40) : null,
    error: isPlainObject(call.error) ? {
      code: boundedText(call.error.code, 80),
      message: boundedText(call.error.message, MAX_ERROR_TEXT),
    } : null,
  } : null)).filter(Boolean);
}

/** 产物身份分类：返回 { kind, id, label }；无法识别时 kind='other'。 */
export function classifyArtifactRef(ref) {
  const text = String(ref ?? '');
  const match = text.split('/').filter(Boolean).at(-1) || text;
  if (EVIDENCE_REF_PATTERN.test(match)) return { kind: 'evidence', id: match, label: '证据' };
  if (ANALYSIS_REF_PATTERN.test(match)) return { kind: 'analysis', id: match, label: '分析' };
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
  if (!task) return { project_id: null, evidence: [], analysis: [], knowledge: [], brief: [], generation: [], other: [] };
  const chain = { project_id: task.request?.project_id || null, evidence: [], analysis: [], knowledge: [], brief: [], generation: [], other: [] };
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

/** “能力：…”只读能力查询任务：仅可存在于历史任务列表，绝不自动成为当前任务。 */
export function isCapabilityIntent(intent) {
  return /^能力：/u.test(String(intent ?? '').trim());
}

/**
 * 工具调用视图：只来自真实服务端快照的 tool_calls 字段（任务级或逐步级）。
 * 服务端没有记录时 present=false，页面展示明确空状态；绝不从计划步骤伪造
 * “已调用工具”。
 */
export function toolCallsView(task) {
  if (!task) return { present: false, calls: [] };
  const calls = [];
  for (const call of task.tool_calls || []) {
    if (!isPlainObject(call)) continue;
    calls.push({ step: '', ...call });
  }
  if (isPlainObject(task.step_states)) {
    for (const [stepId, state] of Object.entries(task.step_states)) {
      if (!Array.isArray(state.tool_calls)) continue;
      for (const call of state.tool_calls) {
        if (!isPlainObject(call)) continue;
        calls.push({ ...call, step: stepId });
      }
    }
  }
  return { present: calls.length > 0, calls: calls.slice(0, MAX_TOOL_CALLS) };
}

/**
 * 结果五分类视图：Evidence / Analysis / Knowledge / Brief / Artifact。
 * 全部由同一快照的 result/result_data/artifact_refs 派生；缺失即逐类空态。
 */
export function resultSections(task) {
  const empty = { present: false, items: [] };
  if (!task) {
    return { evidence: empty, analysis: empty, knowledge: empty, brief: empty, artifact: empty };
  }
  const chain = buildSourceChain(task);
  const evidence = chain.evidence.map((id) => ({ kind: 'evidence', id }));
  const analysis = chain.analysis.map((id) => ({ kind: 'analysis', id }));
  const knowledge = chain.knowledge.map((id) => ({ kind: 'knowledge', id }));
  const brief = chain.brief.map((id) => ({ kind: 'brief', id }));
  const artifact = chain.generation.map((id) => ({ kind: 'artifact', id }));
  const rows = isPlainObject(task.result?.result_data) ? task.result.result_data : null;
  if (rows) {
    if (Array.isArray(rows.analyses)) {
      for (const row of rows.analyses.slice(0, MAX_SECTION_ITEMS)) {
        if (!isPlainObject(row)) continue;
        const id = boundedText(row.id ?? row.analysis_id ?? '', 80);
        const summary = boundedText(row.summary ?? row.title ?? row.label ?? '', 200);
        if (id || summary) analysis.push({ kind: 'analysis', id, summary });
      }
    }
    if (Array.isArray(rows.artifacts)) {
      for (const row of rows.artifacts.slice(0, MAX_SECTION_ITEMS)) {
        if (!isPlainObject(row)) continue;
        const id = boundedText(row.id ?? row.artifact_id ?? '', 80);
        const name = boundedText(row.name ?? row.type ?? '', 120);
        if (id || name) artifact.push({ kind: 'artifact', id, name });
      }
    }
    if (isPlainObject(rows.artifact)) {
      artifact.push({
        kind: 'artifact',
        id: boundedText(rows.artifact.id ?? rows.artifact.artifact_id ?? '', 80),
        name: boundedText(rows.artifact.name ?? rows.artifact.type ?? '', 120),
      });
    }
  }
  const dedupe = (items) => [...new Map(items.map((item) => [item.id, item])).values()].slice(0, MAX_SECTION_ITEMS);
  const section = (items) => ({ present: items.length > 0, items: dedupe(items) });
  return {
    evidence: section(evidence),
    analysis: section(analysis),
    knowledge: section(knowledge),
    brief: section(brief),
    artifact: section(artifact),
  };
}

/**
 * 结果摘要标题：由同一快照派生（证据优先，其次成果数，最后按状态给出
 * 诚实结论）。绝不存在“静态 completed 覆盖 running”的文案。
 */
export function resultHeadline(task) {
  const chain = buildSourceChain(task);
  const evidenceCount = chain.evidence.length;
  const total = evidenceCount + chain.analysis.length + chain.knowledge.length + chain.brief.length + chain.generation.length;
  if (evidenceCount > 0) return `${evidenceCount} 条内容已保存为证据`;
  if (total > 0) return `${total} 项成果已生成`;
  if (isTaskTerminal(task?.state)) {
    return task?.state === 'failed' || task?.state === 'blocked' ? '任务未产生成果' : '任务已完成';
  }
  return '任务尚未产生结果';
}

/**
 * 技术详情（默认折叠展示）：task_id、project_id、request_id、计划/请求指纹、
 * 内部 state、时间戳、审批字段与重试目标。普通视图只展示用户目标、
 * 用户友好状态、进度/结果和错误。
 */
export function technicalDetails(task) {
  return {
    task_id: task?.id || '',
    project_id: task?.request?.project_id || '',
    request_id: task?.request?.request_id || '',
    request_fingerprint: task?.request_fingerprint || '',
    plan_fingerprint: task?.plan?.fingerprint || task?.plan_fingerprint || '',
    state: task?.state || '',
    created_at: task?.created_at || '',
    updated_at: task?.updated_at || '',
    retry_target: task?.retry_target || '',
    confirmation_approvals: task?.confirmation?.approval || {},
    required_approvals: task?.plan?.approvals || {},
  };
}

/**
 * 单一任务快照视图模型：页面所有可见信息（顶部汇总、任务卡片、步骤、
 * 工具调用、结果、技术详情）都从同一个 taskId 的同一个 snapshot 派生。
 * 轮询更新必须整体替换 snapshot（页面 setTask(whole)），不得局部拼接。
 */
export function taskSnapshotView(task) {
  if (!task) return null;
  return {
    task,
    state: task.state,
    stateLabel: stateLabel(task.state),
    phase: taskPhase(task),
    intent: task.request?.intent || '',
    projectId: task.request?.project_id || null,
    workflowTitle: task.plan?.workflow_title || null,
    steps: stepExecutionView(task),
    toolCalls: toolCallsView(task),
    approvals: requiredApprovals(task),
    errorText: taskErrorText(task),
    headline: resultHeadline(task),
    chain: buildSourceChain(task),
    sections: resultSections(task),
    technical: technicalDetails(task),
  };
}
