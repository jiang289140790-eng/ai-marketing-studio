/* global structuredClone */
// Deterministic workflow executor (v1). After the user confirms the exact
// plan, this engine — never the language model — constructs and invokes every
// tool call. Batch intent expands into one exact validated ams_harness_tool_v1
// call per item; step ids and idempotency keys derive deterministically from
// task/plan/step/item identity; existing durable artifacts are reused by
// exact identity contracts; only a failed step can be explicitly retried; and
// paid steps with ambiguous outcomes fail closed with RETRY_UNSAFE.
//
// Every expanded call passes validateToolCall (and therefore the existing
// project/approval/revision/idempotency rules) before bridge contact. A
// planner or template bug surfaces as a bounded INTERNAL_PLAN_VALIDATION_ERROR
// with zero bridge calls.
//
// The tool client contract is one canonical shape: every call crossing it —
// project reads, normal tool steps, lineage audit and retries alike — is the
// external ams_harness_tool_v1 call ({schema_version, operation, payload,
// idempotency_key, expected_revision?}). The client performs the single
// bridge-boundary validation on that shape; the executor's internal
// validateToolCall check above only guards plan construction and its enriched
// value is never forwarded to the client.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { p22ItemFromEvidence, toP19AttachmentEvidenceInput, toP19EvidenceInput } from '../../src/services/p22-research-assist.js';
import { ANALYSIS_ENGINE_VERSION, deriveHandoffPackage, runDeterministicRules } from '../../src/services/p19-workspace-service.js';
import {
  ANALYSIS_KIND,
  ANALYSIS_SCHEMA_VERSION,
  BRIEF_REVIEW_SCHEMA_VERSION,
  BRIEF_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION,
  KNOWLEDGE_CARD_SCHEMA_VERSION,
  MODEL_ANALYSIS_SCHEMA_VERSION,
  MULTIMODAL_METHOD,
  MULTIMODAL_PROVIDER,
} from '../../src/services/p19-contracts.js';
import { validateToolCall } from './tool-contract.mjs';
import { validatePlanShape } from './planner.mjs';
import { APPROVAL_SCOPES, BRIEF_ID_PATTERN, CARD_ID_PATTERN, COMPARE_METRIC_LABELS, G1_JOB_ID_PATTERN, MAX_FAN_OUT } from './workflow-catalog.mjs';

export const STEP_STATE_PLANNED = 'planned';
export const STEP_STATE_RUNNING = 'running';
export const STEP_STATE_REUSED = 'reused';
export const STEP_STATE_SUCCEEDED = 'succeeded';
export const STEP_STATE_FAILED = 'failed';
export const STEP_STATE_BLOCKED = 'blocked';
export const STEP_STATE_SKIPPED = 'skipped';
export const TERMINAL_STEP_STATES = new Set([STEP_STATE_REUSED, STEP_STATE_SUCCEEDED, STEP_STATE_FAILED, STEP_STATE_BLOCKED, STEP_STATE_SKIPPED]);
export const SUCCESS_STEP_STATES = new Set([STEP_STATE_REUSED, STEP_STATE_SUCCEEDED]);
const MAX_RESUME_OUTPUT_BYTES = 256 * 1024;
const MAX_TERMINAL_RESULT_BYTES = 64 * 1024;

// Transport-level failures on a paid step mean the boundary may have executed
// the paid reservation without a verifiable outcome. Retrying would risk
// duplicate cost, so these fail closed with RETRY_UNSAFE.
export const PAID_AMBIGUOUS_CODES = Object.freeze([
  'TOOL_TIMEOUT',
  'TOOL_BRIDGE_UNAVAILABLE',
  'TOOL_BRIDGE_HTTP_ERROR',
  'TOOL_RESPONSE_INVALID',
  'TOOL_RESPONSE_TOO_LARGE',
]);

export const STEP_LABELS = Object.freeze({
  planned: '尚未执行',
  running: '执行中',
  reused: '已复用',
  succeeded: '成功',
  failed: '失败',
  blocked: '被阻断',
  skipped: '已跳过',
});

// Fail-closed identity diagnostics for canonical Brief identity derivation:
// a stable code plus the accurate field/index of the offending input — never
// the raw value. No Brief ID is ever derived from an invalid or partial set.
export const BRIEF_PROJECT_IDENTITY_INVALID = 'BRIEF_PROJECT_IDENTITY_INVALID';
export const BRIEF_CARD_IDENTITY_INVALID = 'BRIEF_CARD_IDENTITY_INVALID';

function bounded(value, limit) {
  return String(value ?? '').slice(0, limit);
}

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const PROJECT_ID_PATTERN = /^prj-[0-9a-f]{24}$/;

/**
 * Deterministic replacement Brief identity: brief-<24 位小写十六进制> derived
 * from the exact project plus the COMPLETE Knowledge Card identity set. Every
 * input is validated against the exact identity contracts BEFORE any
 * derivation — an invalid project binding, a non-array identity set, or any
 * empty/malformed/non-canonical card identity fails closed with a bounded
 * identity error (BRIEF_PROJECT_IDENTITY_INVALID / BRIEF_CARD_IDENTITY_INVALID,
 * accurate field plus the first offending index, never the raw value) and NO
 * Brief ID is generated from a filtered or partial set. Only the complete
 * validated set — deduplicated and deterministically sorted — participates in
 * the stable derivation: the same project/card set always yields the same
 * identity; a changed card set or project never collides. This only ever
 * derives a FRESH identity — already-canonical Brief versioning and reuse are
 * unaffected.
 */
export function deriveCanonicalBriefId(projectId, cardIds) {
  if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
    throw boundedError(BRIEF_PROJECT_IDENTITY_INVALID, '项目身份必须是精确的 prj-<24 位小写十六进制>：已拒绝派生 Brief 身份。', { field: 'project_id' });
  }
  if (!Array.isArray(cardIds)) {
    throw boundedError(BRIEF_CARD_IDENTITY_INVALID, '知识卡身份集合必须是数组：已拒绝派生 Brief 身份。', { field: 'knowledge_cards' });
  }
  const canonicalCards = [];
  for (let index = 0; index < cardIds.length; index += 1) {
    const id = String(cardIds[index] ?? '');
    if (!CARD_ID_PATTERN.test(id)) {
      throw boundedError(BRIEF_CARD_IDENTITY_INVALID, '知识卡身份必须是精确的 kc-<24 位小写十六进制>：已拒绝派生 Brief 身份。', { field: 'knowledge_card_id', index });
    }
    canonicalCards.push(id);
  }
  return `brief-${sha256Hex(`${projectId}\0${[...new Set(canonicalCards)].sort().join('\0')}`).slice(0, 24)}`;
}

/**
 * Complete, project-bound Knowledge Card identity set for Brief reuse and
 * derivation. Every card must carry an exact canonical kc-<24 位小写十六进制>
 * identity bound to the exact project; an empty/malformed/non-canonical or
 * mis-bound card identity fails closed with BRIEF_CARD_IDENTITY_INVALID before
 * any reuse or derivation — an illegal card is never silently filtered and
 * never participates in a Brief identity.
 */
function validatedCardIds(cards, projectId) {
  if (!Array.isArray(cards)) {
    throw boundedError(BRIEF_CARD_IDENTITY_INVALID, '知识卡集合必须是数组：已拒绝生成 Brief。', { field: 'knowledge_cards' });
  }
  const output = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    const id = String(card?.id ?? '');
    if (!CARD_ID_PATTERN.test(id)) {
      throw boundedError(BRIEF_CARD_IDENTITY_INVALID, '知识卡身份必须是精确的 kc-<24 位小写十六进制>：已拒绝生成 Brief。', { field: 'knowledge_card_id', index });
    }
    if (card?.project_id !== projectId) {
      throw boundedError(BRIEF_CARD_IDENTITY_INVALID, '知识卡身份与当前项目错绑：已拒绝生成 Brief。', { field: 'knowledge_card_id', index });
    }
    output.push(id);
  }
  return output;
}

function boundedError(code, message, diagnostics = {}) {
  return Object.assign(new Error(String(message).slice(0, 240)), { code: String(code).slice(0, 80), diagnostics });
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const SAFE_DIAGNOSTIC_TYPES = new Set(['array', 'null', 'object', 'string', 'number', 'boolean', 'undefined', 'function', 'bigint', 'symbol']);
const SAFE_JSON_ROOT_KEYS = new Set(['analyses']);
const SAFE_ANALYSIS_KEYS = new Set([
  'source_id', 'text_expression', 'hook', 'copy_pattern', 'target_audience', 'audience_need_emotion',
  'media_analysis', 'virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks',
]);
const SAFE_MEDIA_KEYS = new Set([
  'media_id', 'visual_content', 'composition', 'people', 'scene', 'emotion', 'visual_selling_points', 'style_pattern',
]);

function boundedDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : null;
}

function boundedDiagnosticType(value) {
  const text = bounded(value, 24);
  return SAFE_DIAGNOSTIC_TYPES.has(text) ? text : 'unknown';
}

function boundedDiagnosticKey(value, allowlist = null) {
  const text = bounded(value, 64);
  if (allowlist && !allowlist.has(text)) return '<unrecognized-key>';
  return /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(text) || text === '<nonstandard-key>'
    ? text
    : '<nonstandard-key>';
}

function boundedDiagnosticKeys(value, limit, allowlist = null) {
  return Array.isArray(value) ? value.slice(0, limit).map((key) => boundedDiagnosticKey(key, allowlist)) : [];
}

function boundedDiagnosticFieldTypes(value, limit, allowlist = null) {
  if (!plainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, limit).map(([key, type]) => [
    boundedDiagnosticKey(key, allowlist),
    boundedDiagnosticType(type),
  ]));
}

function boundedDiagnosticMediaRow(value) {
  if (!plainObject(value)) return null;
  return {
    row_type: boundedDiagnosticType(value.row_type),
    keys: boundedDiagnosticKeys(value.keys, 16, SAFE_MEDIA_KEYS),
    field_types: boundedDiagnosticFieldTypes(value.field_types, 16, SAFE_MEDIA_KEYS),
  };
}

function boundedDiagnosticAnalysisRow(value) {
  if (!plainObject(value)) return null;
  return {
    row_type: boundedDiagnosticType(value.row_type),
    keys: boundedDiagnosticKeys(value.keys, 24, SAFE_ANALYSIS_KEYS),
    field_types: boundedDiagnosticFieldTypes(value.field_types, 24, SAFE_ANALYSIS_KEYS),
    media_count: boundedDiagnosticCount(value.media_count),
    media_rows: Array.isArray(value.media_rows)
      ? value.media_rows.slice(0, 8).map(boundedDiagnosticMediaRow).filter(Boolean)
      : [],
  };
}

function boundedResponseShape(value) {
  if (!plainObject(value)) return null;
  return {
    root_type: boundedDiagnosticType(value.root_type),
    known_root_keys: Array.isArray(value.known_root_keys)
      ? value.known_root_keys.filter((key) => ['choices', 'output', 'usage'].includes(key)).slice(0, 3)
      : [],
    compatible_choice_count: boundedDiagnosticCount(value.compatible_choice_count),
    native_choice_count: boundedDiagnosticCount(value.native_choice_count),
    content_type: boundedDiagnosticType(value.content_type),
    content_length: boundedDiagnosticCount(value.content_length),
    content_part_count: boundedDiagnosticCount(value.content_part_count),
    content_parts: Array.isArray(value.content_parts) ? value.content_parts.slice(0, 8).map((part) => ({
      part_type: ['text', 'output_text', 'other'].includes(part?.part_type) ? part.part_type : null,
      value_type: boundedDiagnosticType(part?.value_type),
      text_type: boundedDiagnosticType(part?.text_type),
      text_length: boundedDiagnosticCount(part?.text_length),
    })) : [],
    json_root_type: value.json_root_type == null ? null : boundedDiagnosticType(value.json_root_type),
    ...(Array.isArray(value.json_root_keys) ? { json_root_keys: boundedDiagnosticKeys(value.json_root_keys, 24, SAFE_JSON_ROOT_KEYS) } : {}),
    ...(value.analyses_type != null ? { analyses_type: boundedDiagnosticType(value.analyses_type) } : {}),
    ...(value.analysis_count != null ? { analysis_count: boundedDiagnosticCount(value.analysis_count) } : {}),
    ...(Array.isArray(value.analysis_rows) ? {
      analysis_rows: value.analysis_rows.slice(0, 4).map(boundedDiagnosticAnalysisRow).filter(Boolean),
    } : {}),
  };
}

function boundedModelFailureDiagnostics(value) {
  if (!plainObject(value)) return {};
  const responseShape = boundedResponseShape(value.response_shape);
  const field = typeof value.field === 'string' && /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,95}$/.test(value.field)
    ? value.field
    : null;
  const reason = typeof value.reason === 'string' && /^[A-Z][A-Z0-9_]{1,95}$/.test(value.reason)
    ? value.reason
    : null;
  return {
    ...(field ? { field } : {}),
    ...(reason ? { reason } : {}),
    ...(responseShape ? { response_shape: responseShape } : {}),
  };
}

// ---------------------------------------------------------------------------
// G1 asynchronous job state. An accepted generation.submit is non-terminal:
// the outer deterministic result must follow the real asynchronous G1 job
// state through exact read-only generation.status reads (never a
// resubmission), so a queued/running job is pending and a terminal
// failed/needs_attention job fails the outer task instead of completing it.
// ---------------------------------------------------------------------------

const G1_JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'needs_attention']);

/** 规范化 G1 作业状态；未知/畸形状态返回 null（fail-closed 为非终态处理）。 */
function g1JobStatus(job) {
  if (!plainObject(job)) return null;
  const status = typeof job.status === 'string' ? job.status : '';
  return G1_JOB_STATUSES.has(status) ? status : null;
}

/** 有界作业诊断视图：仅保留有界 code/issues/provider_code/provider_message。 */
function boundedG1JobDiagnostics(job) {
  const source = plainObject(job?.diagnostics) ? job.diagnostics : {};
  const issues = Array.isArray(source.issues)
    ? source.issues.filter((entry) => typeof entry === 'string').slice(0, 3).map((entry) => String(entry).slice(0, 240))
    : [];
  const code = typeof source.code === 'string' ? source.code.slice(0, 80) : '';
  const providerCode = typeof source.provider_code === 'string' ? source.provider_code.slice(0, 80) : '';
  const providerMessage = typeof source.provider_message === 'string' ? source.provider_message.slice(0, 240) : '';
  const message = issues[0] || (providerCode ? `${providerCode}${providerMessage ? ` — ${providerMessage}` : ''}` : '');
  return { code, provider_code: providerCode, provider_message: providerMessage, issues, message };
}

/** 终态 G1 失败 → 外层任务的精确失败（绝不 completed）。 */
function g1TerminalFailure(job) {
  const diagnostics = boundedG1JobDiagnostics(job);
  const needsAttention = g1JobStatus(job) === 'needs_attention';
  const code = diagnostics.code || (needsAttention ? 'G1_JOB_NEEDS_ATTENTION' : 'G1_JOB_FAILED');
  const message = diagnostics.message
    || (needsAttention ? '生成作业需要人工关注（作业已进入 needs_attention）。' : '生成作业已失败。');
  return { code, message, needs_attention: needsAttention };
}

/** 有界生成状态视图（随 result_data 持久化，供页面呈现准确的作业状态）。 */
function boundedGenerationStatusView(job) {
  const status = g1JobStatus(job);
  if (!status) return null;
  const diagnostics = boundedG1JobDiagnostics(job);
  return {
    job_id: typeof job.id === 'string' ? job.id.slice(0, 40) : null,
    status,
    mode: typeof job.mode === 'string' ? job.mode.slice(0, 20) : null,
    model_name: typeof job.model_name === 'string' ? job.model_name.slice(0, 80) : null,
    diagnostic_code: diagnostics.code || null,
    diagnostic_issues: diagnostics.issues.slice(0, 3),
  };
}

/**
 * 刷新回合遇到终态 G1 失败时的步骤快照：保留已接受提交步骤的记录形状，
 * 标记失败并携带精确有界终态诊断——外层任务聚合为 failed（绝不
 * completed、绝不 partial）。
 */
function terminalGenerationFailureSnapshot(step, prior, terminal, jobId, jobStatus, finishedAt) {
  return stepSnapshot(step, {
    state: STEP_STATE_FAILED,
    item_count: Number(prior.item_count) || 0,
    reused_count: Number(prior.reused_count) || 0,
    executed_count: Number(prior.executed_count) || 0,
    failed_count: Math.max(1, Number(prior.failed_count) || 1),
    refs: Array.isArray(prior.refs) ? prior.refs : [],
    ...(Array.isArray(prior.completed_items) ? { completed_items: prior.completed_items } : {}),
    resume_output: prior.resume_output || null,
    ...(jobStatus ? { job_status: jobStatus } : {}),
    finished_at: finishedAt,
    error: {
      code: String(terminal.code).slice(0, 80),
      operation: bounded(step.operation, 80),
      message: String(terminal.message).slice(0, 240),
      ...(jobId ? { job_id: bounded(jobId, 200) } : {}),
      g1_terminal: true,
      g1_needs_attention: terminal.needs_attention === true,
    },
  });
}

function evidenceFromItem(value) {
  if (plainObject(value?.evidence)) return value.evidence;
  if (plainObject(value) && typeof value.id === 'string' && typeof value.source_url === 'string') return value;
  return null;
}

function itemsFromResult(result, key) {
  const data = result?.data && plainObject(result.data) ? result.data : result;
  const candidates = [data?.[key], result?.[key]];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.slice(0, MAX_FAN_OUT);
  }
  return null;
}

function boundedResumeOutput(value) {
  if (!plainObject(value)) return null;
  const copy = structuredClone(value);
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_RESUME_OUTPUT_BYTES) {
    throw boundedError('RETRY_CONTEXT_TOO_LARGE', '步骤结果超过可恢复上下文上限；为避免重复付费，任务已失败关闭。', { retry_unsafe: true });
  }
  return copy;
}

function boundedTerminalResult(value) {
  if (!plainObject(value)) return null;
  const copy = structuredClone(value);
  if (Buffer.byteLength(JSON.stringify(copy), 'utf8') > MAX_TERMINAL_RESULT_BYTES) {
    throw boundedError('TERMINAL_RESULT_TOO_LARGE', '工具结果超过页面可安全返回的上限，已失败关闭。');
  }
  return copy;
}

function normalizedModelResult(result) {
  const data = plainObject(result?.data) ? result.data : result;
  const row = Array.isArray(data?.analyses) ? data.analyses[0] : null;
  if (!plainObject(row)) return null;
  const { model, executed_at: executedAt, usage: rowUsage, cost: rowCost, result: nestedResult, ...analysisFields } = row;
  return {
    model,
    result: plainObject(nestedResult) ? nestedResult : analysisFields,
    executed_at: executedAt,
    usage: plainObject(rowUsage) ? rowUsage : data?.usage,
    cost: plainObject(rowCost) ? rowCost : data?.cost,
  };
}

function stepIdempotencyKey(taskId, plan, step, itemIndex) {
  return `d-${sha256Hex(`${taskId}\0${plan.fingerprint}\0${step.step}\0${itemIndex}`).slice(0, 32)}`;
}

function exactToolCall(taskId, plan, trustedContext, step, itemIndex, payload) {
  // expected_revision is an envelope field in the exact tool contract (never
  // a payload field); the payload must contain exactly the definition's
  // fields when it reaches validateToolCall.
  const revision = payload.expected_revision;
  if (revision !== undefined) delete payload.expected_revision;
  const call = {
    schema_version: 'ams_harness_tool_v1',
    operation: step.operation,
    payload,
    idempotency_key: stepIdempotencyKey(taskId, plan, step, itemIndex),
  };
  if (revision != null) call.expected_revision = revision;
  // Internal construction guard: a planner or template bug surfaces here as
  // INTERNAL_PLAN_VALIDATION_ERROR with zero bridge calls. Only the canonical
  // external call above is ever returned (and forwarded to the tool client);
  // the enriched validated value never crosses the client boundary.
  const checked = validateToolCall(call, trustedContext);
  if (!checked.ok) {
    throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `内部调用校验失败（${checked.code}）：未发起任何业务调用。`);
  }
  return call;
}

// ---------------------------------------------------------------------------
// Deterministic payload builders. Each returns the exact payload field set
// for the operation (per TOOL_DEFINITIONS); the executor then validates the
// complete call with validateToolCall before any bridge contact.
// ---------------------------------------------------------------------------

function searchPayload(plan, operation) {
  const payload = { keyword: plan.slots.keyword, count: plan.slots.count };
  if (plan.slots.sort != null) payload.sort = plan.slots.sort;
  if (operation === 'research.search_reddit') {
    if (plan.slots.subreddit != null) payload.subreddit = plan.slots.subreddit;
    if (plan.slots.time_filter != null) payload.time_filter = plan.slots.time_filter;
  }
  if (plan.project_id) payload.project_id = plan.project_id;
  return payload;
}

function p19WritePayload(plan, ctx, record, { withFingerprint = false, expectedFingerprint = null } = {}) {
  if (!ctx.revision || !Number.isSafeInteger(ctx.revision)) {
    throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '写入步骤缺少可信的项目修订号：未发起任何业务调用。');
  }
  // expected_fingerprint is a required payload field for analysis/card/brief/
  // handoff writes (null = no same-entity baseline; the boundary enforces the
  // project revision guard from expected_revision) and must NOT appear for
  // evidence.create, whose exact contract has only project_id + evidence.
  return {
    project_id: plan.project_id,
    ...(withFingerprint ? { expected_fingerprint: expectedFingerprint } : {}),
    ...record,
    expected_revision: ctx.revision,
  };
}

function deriveEvidenceRecord(item) {
  // toP19EvidenceInput throws bounded errors (P22_EVIDENCE_HASH_MISMATCH,
  // P22_EVIDENCE_INVALID) when the collected item is not exact; a failed
  // derivation is a bounded step failure, never a guessed record.
  return item?.platform === 'private_attachment'
    ? toP19AttachmentEvidenceInput(item)
    : toP19EvidenceInput(item);
}

function attachmentThreadId(plan) {
  const ref = plan?.attachments?.[0]?.ref;
  const match = typeof ref === 'string'
    ? /^harness-thread-attachments:[0-9a-f-]{36}\/(thr_[0-9a-f-]{36})\//i.exec(ref)
    : null;
  if (!match) throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '附件计划缺少准确的会话身份。');
  return match[1];
}

function deriveAnalysisRecord({ plan, evidence, modelResult, existing }) {
  if (!plainObject(modelResult) || !plainObject(modelResult.result)) {
    throw boundedError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析结果缺失，已拒绝保存分析记录。');
  }
  const model = bounded(modelResult.model, 80);
  if (!model) throw boundedError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析缺少模型身份，已拒绝保存分析记录。');
  const totalTokens = Number(modelResult.usage && modelResult.usage.total_tokens);
  if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) {
    throw boundedError('ANALYSIS_MODEL_RESULT_INVALID', '模型分析用量无效，已拒绝保存分析记录。');
  }
  const executedAt = bounded(modelResult.executed_at, 80) || new Date().toISOString();
  const ruleOutputs = runDeterministicRules(evidence);
  const mediaIds = (Array.isArray(evidence.media_assets) ? evidence.media_assets : []).map((asset) => bounded(asset?.id, 200)).filter(Boolean);
  const extension = {
    schema_version: MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: MULTIMODAL_PROVIDER,
    model,
    method: MULTIMODAL_METHOD,
    executed_at: executedAt,
    media_ids: mediaIds,
    result: structuredClone(modelResult.result),
    usage: {
      total_tokens: totalTokens,
      ...(plainObject(modelResult.cost) ? {
        ...(Number.isFinite(Number(modelResult.cost.actual_usd)) ? { actual_usd: Math.round(Number(modelResult.cost.actual_usd) * 1e6) / 1e6 } : {}),
        ...(Number.isFinite(Number(modelResult.cost.recorded_cny)) ? { recorded_cny: Math.round(Number(modelResult.cost.recorded_cny) * 1e6) / 1e6 } : {}),
        ...(modelResult.cost.reservation_id ? { reservation_id: bounded(modelResult.cost.reservation_id, 80) } : {}),
      } : {}),
    },
  };
  const id = existing?.id || `an-${sha256Hex(`${plan.project_id}\0${evidence.id}\0${evidence.fingerprint}`).slice(0, 24)}`;
  const version = existing ? Number(existing.version || 1) + 1 : 1;
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    id,
    project_id: plan.project_id,
    evidence_id: evidence.id,
    kind: ANALYSIS_KIND,
    rule_ids: ruleOutputs.map((rule) => rule.rule_id),
    provenance: {
      method: ANALYSIS_KIND,
      generated_by: ANALYSIS_ENGINE_VERSION,
      model,
      executed_at: new Date().toISOString(),
      statement: '本分析包含 P29 服务端多模态 Qwen 分析（model_analysis 扩展）与确定性规则补充；由 Harness 确定性执行器登记。',
    },
    model_analysis: extension,
    result: {
      summary: {
        label: '多模态 Qwen 分析（模型结果 + 确定性补充）',
        keyword_count: 0,
        top_keywords: [],
        exclamations: 0,
        questions: 0,
      },
      rules: ruleOutputs.map((rule) => ({ rule_id: rule.rule_id, label: rule.label, output: structuredClone(rule.output) })),
    },
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    version,
    fingerprint: '',
  };
}

function deriveLocalAnalysisRecord({ plan, evidence, existing, comparison }) {
  const ruleOutputs = runDeterministicRules(evidence);
  const id = existing?.id || `an-${sha256Hex(`${plan.project_id}\0${evidence.id}\0local-comparison`).slice(0, 24)}`;
  const version = existing ? Number(existing.version || 1) + 1 : 1;
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    id,
    project_id: plan.project_id,
    evidence_id: evidence.id,
    kind: ANALYSIS_KIND,
    rule_ids: ruleOutputs.map((rule) => rule.rule_id),
    provenance: {
      method: ANALYSIS_KIND,
      generated_by: ANALYSIS_ENGINE_VERSION,
      model: null,
      executed_at: new Date().toISOString(),
      statement: '本分析由 Harness 确定性执行器在本地计算（比较工作流），不调用任何模型、不联网、不产生费用。',
    },
    result: {
      summary: {
        label: '确定性比较分析（本地计算，无模型）',
        keyword_count: 0,
        top_keywords: [],
        exclamations: 0,
        questions: 0,
        ...(comparison ? { comparison: bounded(comparison, 800) } : {}),
      },
      rules: ruleOutputs.map((rule) => ({ rule_id: rule.rule_id, label: rule.label, output: structuredClone(rule.output) })),
    },
    evidence_fingerprint: evidence.fingerprint,
    evidence_version: evidence.version,
    version,
    fingerprint: '',
  };
}

function boundedStringArray(value, maxItems, maxLength, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const output = value
    .map((entry) => (typeof entry === 'string' ? entry : plainObject(entry) ? String(entry.label || entry.text || entry.title || '').trim() : ''))
    .map((entry) => bounded(entry, maxLength).trim())
    .filter(Boolean);
  return output.length > 0 ? output.slice(0, maxItems) : [...fallback];
}

function deriveCardRecord({ evidence, analysis }) {
  const extension = analysis?.model_analysis;
  const result = plainObject(extension?.result) ? extension.result : {};
  const signals = boundedStringArray(result.signals, 6, 200, ['需人工复核']);
  const methods = boundedStringArray(result.reusable_methods, 8, 200, ['保持来源结构']);
  const risks = boundedStringArray(result.risks, 8, 240, ['平台审核风险需复核']);
  const textExpression = bounded(result.text_expression, 5000) || bounded(evidence?.content_text, 5000) || '来源正文';
  const mediaAnalysis = Array.isArray(result.media_analysis) ? result.media_analysis : [];
  return {
    schema_version: KNOWLEDGE_CARD_SCHEMA_VERSION,
    id: `kc-${sha256Hex(`${analysis.id}\0${analysis.fingerprint}`).slice(0, 24)}`,
    project_id: evidence.project_id,
    evidence_id: evidence.id,
    analysis_id: analysis.id,
    analysis_fingerprint: analysis.fingerprint,
    source_observations: {
      post_text: bounded(evidence?.content_text, 5000),
      uncertainties: risks,
      media: {
        duration_seconds: 0,
        resolution: 'text',
        audio_track_present: false,
        timeline: ['start', 'middle', 'end'],
        transcript_segments: mediaAnalysis.length > 0 ? ['模型分析片段'] : [],
      },
    },
    creative_analysis: {
      hook: bounded(signals[0], 200),
      copy_device: bounded(methods[0], 200),
      visual_impact: mediaAnalysis.length > 0 ? '包含媒体内容' : '以文本为主',
      seductive_tone: bounded(signals[1] || methods[1] || '以价值表达驱动', 200),
      narrative_arc: bounded(signals[2] || '开头-展开-收束', 200),
      audio_role: mediaAnalysis.length > 0 ? '媒体补充表达' : '无音频',
      semantic_layers: boundedStringArray([textExpression], 5, 200, ['来源语义层']),
      audience_response_mechanisms: boundedStringArray(result.virality_drivers, 6, 200, ['互动驱动']),
      replicable_features: methods,
      risk_labels: {
        sexual_suggestiveness: 'none',
        platform_moderation: 'low',
        brand_suitability: 'broad',
        notes: risks,
      },
    },
    evidence_links: [
      { claim: bounded(textExpression.slice(0, 200), 200), evidence_type: 'post_text', source_ref: bounded(evidence?.source_url, 200), time_range: null, confidence: 0.8 },
      { claim: bounded(textExpression.slice(200, 400), 200) || '内容结构特征', evidence_type: 'post_text', source_ref: bounded(evidence?.source_url, 200), time_range: null, confidence: 0.6 },
      { claim: bounded(methods[0] || '内容策略', 200), evidence_type: 'post_text', source_ref: bounded(evidence?.source_url, 200), time_range: null, confidence: 0.6 },
    ],
    generation_guidance: {
      reusable_pattern: bounded(methods[0] || '保留来源结构', 200),
      must_preserve: boundedStringArray([bounded(evidence?.source_url, 200)], 4, 200, ['来源身份']),
      must_not_invent: ['不得虚构事实'],
      prompt_ingredients: boundedStringArray(signals, 5, 200, ['来源信号']),
      variation_space: ['措辞变化', '结构微调'],
    },
    generation_readiness: {
      usable: true,
      score: 70,
      reasons: ['分析已完成', '来源绑定精确'],
      blockers: [],
    },
    analysis_provenance: {
      method: MULTIMODAL_METHOD,
      provider: MULTIMODAL_PROVIDER,
      model: bounded(extension?.model, 80) || 'qwen-plus',
      executed_at: bounded(extension?.executed_at, 80) || new Date().toISOString(),
      source_analysis_id: analysis.id,
      media_ids: Array.isArray(extension?.media_ids) ? extension.media_ids.map((id) => bounded(id, 200)).filter(Boolean) : [],
      statement: '知识卡由 Harness 确定性执行器从精确绑定的分析记录派生。',
    },
    version: 1,
    fingerprint: '',
  };
}

function deriveBriefRecord({ plan, project, cards, analyses, existing }) {
  // Complete validated set: every cited card must be an exact canonical
  // identity bound to this exact project (an illegal or mis-bound card fails
  // closed in validatedCardIds before any Brief identity is derived or written).
  const citationIds = [...new Set(validatedCardIds(cards, plan.project_id))];
  const analysisIds = [...new Set(analyses.map((analysis) => analysis.id))];
  // Canonical identity contract: a Brief ID is reused only when it exactly
  // satisfies brief-<24 位小写十六进制>. A historical non-canonical identity
  // (e.g. a 25-character legacy suffix) is never truncated, overwritten or
  // mutated — the new version derives the deterministic canonical identity
  // from the exact project plus the complete sorted Knowledge Card identity
  // set (deriveCanonicalBriefId) and starts a fresh version lineage, while the
  // historical record stays untouched. Already-canonical Brief versioning and
  // reuse remain unchanged.
  const canonicalExisting = existing && BRIEF_ID_PATTERN.test(String(existing.id || '')) ? existing : null;
  const version = canonicalExisting ? Number(canonicalExisting.version || 1) + 1 : 1;
  const id = canonicalExisting?.id || deriveCanonicalBriefId(plan.project_id, citationIds);
  const topic = bounded(project?.topic, 5000) || 'AI 营销内容策划';
  const objective = bounded(project?.objective, 5000) || '基于已保存公开来源生成可复用内容规律。';
  const constraints = Array.isArray(project?.constraints) ? project.constraints.map((entry) => bounded(entry, 5000)) : ['不虚构事实', '不抄袭原文'];
  return {
    schema_version: BRIEF_SCHEMA_VERSION,
    id,
    project_id: plan.project_id,
    version,
    status: 'pending_review',
    topic,
    objective,
    knowledge_citation_ids: citationIds,
    structural_guidance: ['开头吸引注意', '正文结构化', '结尾明确行动'],
    constraints,
    evidence_provenance: {
      evidence_ids: [...new Set(cards.map((card) => card.evidence_id).filter(Boolean))],
      evidence_fingerprints: Object.fromEntries(cards.map((card) => [card.evidence_id, card.analysis_fingerprint || '']).filter(([key]) => key)),
      statement: 'Brief 由 Harness 确定性执行器从精确引用的知识卡集合派生。',
    },
    review: {
      schema_version: BRIEF_REVIEW_SCHEMA_VERSION,
      brief_id: id,
      comments: [],
      decision: null,
    },
    analysis_provenance: {
      method: MULTIMODAL_METHOD,
      provider: MULTIMODAL_PROVIDER,
      model: 'qwen-plus',
      executed_at: new Date().toISOString(),
      analysis_ids: analysisIds,
      media_count: analyses.reduce((sum, analysis) => sum + (Array.isArray(analysis.model_analysis?.media_ids) ? analysis.model_analysis.media_ids.length : 0), 0),
      statement: 'Brief 引用的分析来自精确绑定证据的多模态分析记录。',
    },
    fingerprint: '',
  };
}

async function deriveHandoffRecord({ plan, project, brief }) {
  if (!brief) throw boundedError('HANDOFF_BRIEF_REQUIRED', '交接包需要当前项目存在 Brief。');
  const decision = brief.review?.decision;
  if (brief.status !== 'approved' || !decision || decision.value !== 'approved') {
    throw boundedError('HANDOFF_BRIEF_NOT_APPROVED', '交接包创建被拒绝：当前 Brief 修订未被人工批准。');
  }
  const sourceProject = {
    ...structuredClone(project || {}),
    id: plan.project_id,
    brief: structuredClone(brief),
    handoff: null,
    handoffs: [],
  };
  try {
    return (await deriveHandoffPackage(sourceProject)).handoff;
  } catch (error) {
    throw boundedError(error?.code || 'HANDOFF_SOURCE_BINDING_INVALID', error?.message || '交接包无法从当前持久化来源链精确派生。');
  }
/*
  const citations = (Array.isArray(brief.knowledge_citation_ids) ? brief.knowledge_citation_ids : []).map((id) => ({
    knowledge_id: bounded(id, 200),
    type: 'knowledge_card',
    title: `知识卡 ${bounded(id, 32)}`,
    excerpt: '',
    evidence_refs: Array.isArray(brief.evidence_provenance?.evidence_ids) ? brief.evidence_provenance.evidence_ids.map((ref) => bounded(ref, 200)) : [],
    evidence_completeness: null,
    trust_status: 'verified_local',
    validation_status: 'bound_exact',
  }));
  return {
    schema_version: HANDOFF_SCHEMA_VERSION,
    id: `handoff-pkg-${sha256Hex(`${plan.project_id}\0${brief.id}\0${brief.version}`).slice(0, 24)}`,
    version: 1,
    kind: HANDOFF_KIND,
    status: HANDOFF_STATUS,
    payload_label: HANDOFF_PAYLOAD_LABEL,
    is_external_task: false,
    submission_pending: true,
    local_only: true,
    repo_external: true,
    brief_provenance: {
      brief_id: brief.id,
      brief_version: brief.version,
      brief_schema_version: brief.schema_version,
      brief_status: brief.status,
    },
    human_decision: {
      value: 'approved',
      source: 'local_manual',
      rationale: '用户通过 Harness 确认创建交接包（handoff_creation 批准）。',
      decided_by: bounded(plan.user_id, 200),
      decided_at: new Date().toISOString(),
    },
    topic: bounded(project?.topic, 5000) || 'AI 营销内容',
    objective: bounded(project?.objective, 5000) || '外部生成任务交接',
    knowledge_citations: citations,
    evidence_provenance: {
      local_only: true,
      store: 'p19_staging',
      created_from: 'harness_deterministic_executor',
      knowledge_count: citations.length,
      statement: '交接包由 Harness 确定性执行器从人工批准的 Brief 派生。',
    },
    structural_guidance: {
      reusable_patterns: Array.isArray(brief.structural_guidance) ? brief.structural_guidance.map((entry) => bounded(entry, 500)) : [],
      must_preserve: ['来源身份与引用'],
      variation_space: ['措辞变化'],
    },
    constraints: {
      must_not_invent: ['不得虚构事实'],
      evidence_boundary: '仅使用 Brief 精确引用的知识卡与证据。',
    },
    external_project_boundary: {
      destination: 'external_generation_system',
      statement: '仅用于已批准的外部生成交接。',
    },
    fingerprint: '',
  };
}

*/
}

// ---------------------------------------------------------------------------
// Reuse evaluation (exact identity contracts; never substring/first/fallback).
// ---------------------------------------------------------------------------

function exactEvidenceReuse(project, candidate, projectId) {
  const matches = (project?.evidence || []).filter((record) => {
    if (record.project_id !== projectId) return false;
    if (String(record.source_url || '').trim() !== String(candidate.source_url || '').trim()) return false;
    const candidateHash = String(candidate.content_sha256 || '').trim();
    if (candidateHash) {
      return String(record.media_metadata?.sha256 || record.provenance?.content_sha256 || '').trim() === candidateHash;
    }
    const candidateId = String(candidate.external_id || '').trim();
    if (candidateId) return String(record.provenance?.external_id || '').trim() === candidateId;
    return true;
  });
  if (matches.length === 0) return { reused: false };
  if (matches.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
  return { reused: true, ref: matches[0].id };
}

function exactAnalysisReuse(analyses, projectId, evidenceId, evidenceFingerprint, evidenceVersion, withModel = true, expectedId = null) {
  const matches = (analyses || []).filter((record) => record.project_id === projectId
    && (expectedId == null || record.id === expectedId)
    && record.evidence_id === evidenceId
    && record.evidence_fingerprint === evidenceFingerprint
    && record.evidence_version === evidenceVersion
    && record.schema_version === ANALYSIS_SCHEMA_VERSION
    && (withModel
      ? plainObject(record.model_analysis)
        && record.model_analysis.schema_version === MODEL_ANALYSIS_SCHEMA_VERSION
        && record.model_analysis.provider === MULTIMODAL_PROVIDER
        && record.model_analysis.method === MULTIMODAL_METHOD
      : !record.model_analysis));
  if (matches.length === 0) return { reused: false };
  if (matches.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
  return { reused: true, ref: matches[0].id };
}

function exactModelAnalysisRecord(analyses, projectId, evidence) {
  if (!evidence?.id || !evidence?.fingerprint || !Number.isSafeInteger(evidence?.version)) return null;
  const matches = (analyses || []).filter((record) => record.project_id === projectId
    && record.evidence_id === evidence.id
    && record.evidence_fingerprint === evidence.fingerprint
    && record.evidence_version === evidence.version
    && record.schema_version === ANALYSIS_SCHEMA_VERSION
    && plainObject(record.model_analysis)
    && record.model_analysis.schema_version === MODEL_ANALYSIS_SCHEMA_VERSION
    && record.model_analysis.provider === MULTIMODAL_PROVIDER
    && record.model_analysis.method === MULTIMODAL_METHOD);
  if (matches.length > 1) {
    throw boundedError('REUSE_AMBIGUOUS', '当前证据匹配到多份模型分析，已失败关闭。');
  }
  return matches[0] || null;
}

function exactCardReuse(cards, projectId, analysisId, analysisFingerprint) {
  const matches = (cards || []).filter((record) => record.project_id === projectId
    && record.schema_version === KNOWLEDGE_CARD_SCHEMA_VERSION
    && record.analysis_id === analysisId
    && record.analysis_fingerprint === analysisFingerprint);
  if (matches.length === 0) return { reused: false };
  if (matches.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
  return { reused: true, ref: matches[0].id };
}

function exactBriefReuse(briefs, projectId, citationIds) {
  const candidates = (briefs || []).filter((record) => record.project_id === projectId
    && record.schema_version === BRIEF_SCHEMA_VERSION);
  const sorted = [...candidates].sort((left, right) => Number(right.version || 0) - Number(left.version || 0));
  const latest = sorted[0];
  if (!latest) return { reused: false };
  // Canonical identity contract: only an exactly canonical brief-<24 位
  // 十六进制> identity is ever a reuse target. A historical non-canonical
  // Brief (e.g. a 25-character legacy suffix) is preserved untouched but can
  // never satisfy a reuse — assembly always supersedes it with a fresh
  // deterministic canonical identity so a later G1 quote binds exactly.
  if (!BRIEF_ID_PATTERN.test(String(latest.id || ''))) return { reused: false, existing: latest };
  const cited = new Set(Array.isArray(latest.knowledge_citation_ids) ? latest.knowledge_citation_ids : []);
  const sameSet = cited.size === citationIds.length && citationIds.every((id) => cited.has(id));
  if (sameSet) {
    const duplicates = sorted.filter((record) => record.version === latest.version && record.id === latest.id);
    if (duplicates.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
    return { reused: true, ref: latest.id };
  }
  return { reused: false, existing: latest };
}

function exactHandoffReuse(handoffs, projectId, brief) {
  if (!brief) return { reused: false };
  const matches = (handoffs || []).filter((record) => record.project_id === projectId
    && record.schema_version === HANDOFF_SCHEMA_VERSION
    && record.brief_provenance?.brief_id === brief.id
    && record.brief_provenance?.brief_version === brief.version);
  if (matches.length === 0) return { reused: false };
  if (matches.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
  return { reused: true, ref: matches[0].id };
}

function preCollectEvidenceReuse(project, url, projectId) {
  const statusId = (/\/status\/(\d+)(?:\/|$)/i.exec(String(url || '')) || [])[1] || null;
  const matches = (project?.evidence || []).filter((record) => {
    if (record.project_id !== projectId) return false;
    if (String(record.source_url || '').trim() === String(url).trim()) return true;
    return Boolean(statusId) && String(record.provenance?.external_id || '').trim() === statusId;
  });
  if (matches.length === 0) return { reused: false };
  if (matches.length !== 1) return { reused: false, code: 'REUSE_AMBIGUOUS' };
  return { reused: true, ref: matches[0].id };
}

/**
 * Canonical deterministic metric contract for compare_project. Only persisted
 * evidence fields are ever read — the executor never invents a metric.
 *
 * - `views` reads exactly the canonical views field
 *   (`source_metadata.engagement.views`). The planner maps 展现量/浏览量/
 *   播放量/曝光量 intents to this same metric; an absent field is 0, and the
 *   requested metric is never substituted by aggregate engagement.
 * - `engagement` is the single documented deterministic formula, preserved
 *   from the existing comparison engine:
 *   views + likes + retweets + replies + reddit_score + reddit_comments.
 *
 * Missing and non-finite values are 0 (sorted last); values are never
 * guessed, scaled or invented.
 */
export function metricValue(record, metric) {
  const engagement = record?.source_metadata?.engagement || {};
  if (metric === 'views') {
    const views = Number(engagement.views);
    return Number.isFinite(views) && views > 0 ? views : 0;
  }
  const views = Number(engagement.views || 0);
  const likes = Number(engagement.likes || 0);
  const retweets = Number(engagement.retweets || 0);
  const replies = Number(engagement.replies || 0);
  const redditScore = Number(engagement.reddit_score || engagement.score || 0);
  const redditComments = Number(engagement.reddit_comments || engagement.comments || 0);
  const total = views + likes + retweets + replies + redditScore + redditComments;
  return Number.isFinite(total) ? total : 0;
}

function compareMetric(plan) {
  return plan.slots?.metric === 'views' ? 'views' : 'engagement';
}

/**
 * Deterministic comparison context for compare_project: sorts the project's
 * persisted evidence by the requested metric (descending), breaks ties by
 * evidence id ascending (stable and reproducible), bounds the result to the
 * requested count and records the exact metric/zero/tie semantics in the
 * comparison statement. Never calls a bridge, a model or a paid operation.
 */
function buildComparisonContext({ derived, plan, project }) {
  const evidenceList = [...(project?.evidence || [])];
  const metric = compareMetric(plan);
  const count = Math.min(Number(plan.slots?.count) || 5, MAX_FAN_OUT);
  const ranking = [...evidenceList]
    .map((record) => ({ record, value: metricValue(record, metric) }))
    .sort((left, right) => {
      const byMetric = right.value - left.value;
      if (byMetric !== 0) return byMetric;
      const leftId = String(left.record?.id || '');
      const rightId = String(right.record?.id || '');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  const top = ranking.slice(0, count);
  derived.compare_evidence = top.map((entry) => entry.record);
  derived.compare_ranking = top.map((entry, index) => ({
    rank: index + 1,
    evidence_id: bounded(entry.record?.id, 200),
    source_url: bounded(entry.record?.source_url, 500),
    metric_value: entry.value,
    views: metricValue(entry.record, 'views'),
    engagement: metricValue(entry.record, 'engagement'),
  }));
  const persist = plan.slots?.persist === true;
  const comparison = `按「${COMPARE_METRIC_LABELS[metric]}」指标对 ${evidenceList.length} 条既有证据做确定性比较：缺失或为零的指标记为 0 并排后，同分按证据 ID 升序稳定排序；选取前 ${count} 条${persist ? '，并在批准后保存本地比较分析。' : '，仅只读返回，不产生任何写入或费用。'}`;
  return { metric, count, ranking, comparison };
}

/**
 * Bounded terminal result for a read-only comparison: the exact requested
 * metric, its documented source, the deterministic ranking and the persisted
 * flag. Only bounded evidence identity fields are included — no payload
 * values, tokens, headers or secrets can reach the page.
 */
function buildCompareResult({ plan, metric, ranking, evidenceList, comparison }) {
  return {
    workflow: 'compare_project',
    metric,
    metric_label: COMPARE_METRIC_LABELS[metric],
    metric_source: 'evidence.source_metadata.engagement',
    persisted: plan.slots?.persist === true,
    compared_total: Array.isArray(evidenceList) ? evidenceList.length : 0,
    count: ranking.length,
    comparison,
    ranking,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function stepSnapshot(step, update = {}) {
  return {
    key: step.step,
    label: step.label,
    operation: step.operation,
    state: STEP_STATE_PLANNED,
    item_count: 0,
    reused_count: 0,
    executed_count: 0,
    failed_count: 0,
    ...update,
  };
}

/**
 * Execute one confirmed plan deterministically. `taskView` is the live task
 * (step states mutate through it), `emit` persists step-level events, and
 * `toolClient`/`stateReader` are the only bridge-facing surfaces.
 */
export async function executeConfirmedPlan({
  taskView,
  plan,
  signal,
  emit,
  toolClient,
  stateReader,
  now = () => new Date().toISOString(),
}) {
  const planCheck = validatePlanShape(plan);
  if (!planCheck.ok) {
    const firstStep = Array.isArray(plan?.steps) && plan.steps.length > 0
      ? plan.steps[0]
      : { step: 'st-0', label: '校验执行计划', operation: null };
    const failed = stepSnapshot(firstStep, {
      state: STEP_STATE_FAILED,
      failed_count: 0,
      finished_at: now(),
      error: {
        code: 'INTERNAL_PLAN_VALIDATION_ERROR',
        operation: firstStep.operation || null,
        message: `计划形状校验失败（${planCheck.code}）：未发起任何业务调用。`,
        retry_unsafe: true,
      },
      updated_at: now(),
    });
    const states = taskView.step_states || (taskView.step_states = {});
    states[firstStep.step || 'st-0'] = failed;
    emit?.({ event: 'step_state', task_id: taskView.id, step: firstStep.step || 'st-0', state: STEP_STATE_FAILED });
    return {
      outcome: 'failed',
      final_response: `执行计划校验失败（${planCheck.code}），未发起任何业务调用。`,
      artifact_refs: [],
      partial_completion: false,
      retry_unsafe_step: firstStep.step || 'st-0',
    };
  }
  const confirmation = taskView.confirmation;
  if (!plainObject(confirmation)) throw boundedError('CONFIRMATION_REQUIRED', '任务缺少确认，无法执行。');
  for (const scope of APPROVAL_SCOPES) {
    if (plan.approvals[scope] === true && confirmation.approval?.[scope] !== true) {
      throw boundedError('APPROVAL_REQUIRED', `确认缺少计划声明的批准范围：${scope}。`);
    }
  }
  const trustedContext = {
    task_id: taskView.id,
    user_id: plan.user_id,
    project_id: plan.project_id || null,
    approval: confirmation.approval,
  };
  const stepStates = taskView.step_states || (taskView.step_states = {});
  const retryTarget = taskView.retry_target?.step_id || null;
  const retrying = retryTarget !== null;
  const derived = {};
  const results = {};
  const ctx = { plan, derived, revision: null, evidenceId: null, analysisId: null };
  let retryUnsafeStep = null;
  const actualCallCounts = new Map();

  // On a retry the deterministic context is rebuilt from the fresh project
  // state by exact canonical identity (never from guesses or refs), so no
  // completed paid call or write is ever repeated.
  const hydrateFromState = (step) => {
    if (step.operation === 'research.collect_url') {
      const verdict = preCollectEvidenceReuse(derived.project, plan.slots.url, plan.project_id);
      if (verdict.reused) {
        const existing = (derived.project?.evidence || []).find((record) => record.id === verdict.ref);
        if (existing) {
          derived.collected_evidence = existing;
          derived.created_evidence_id = existing.id;
          derived.collected_item = p22ItemFromEvidence(existing) || existing;
        }
      }
    }
    if (step.operation === 'research.analyze_persisted') {
      const evidenceId = derived.created_evidence_id;
      const evidence = evidenceId ? (derived.project?.evidence || []).find((record) => record.id === evidenceId) : null;
      const analysis = exactModelAnalysisRecord(derived.project?.analyses, plan.project_id, evidence);
      // A paid result restored from the retry sidecar is authoritative. Durable
      // state may only fill a missing result when its full Evidence/model
      // lineage matches the current source exactly.
      if (analysis && !plainObject(derived.analysis_results?.[evidenceId])) {
        const extension = analysis.model_analysis;
        derived.analysis_results = {
          ...(derived.analysis_results || {}),
          [evidenceId]: {
            model: extension.model,
            result: extension.result,
            executed_at: extension.executed_at,
            usage: extension.usage,
            cost: extension.cost || {},
          },
        };
      }
    }
  };

  const resumeOutputFor = (step) => {
    switch (step.operation) {
      case 'research.inspect_attachments':
        return derived.collected_item
          ? boundedResumeOutput({ collected_item: derived.collected_item, attachment_model_result: derived.attachment_model_result })
          : null;
      case 'research.collect_url':
        return derived.collected_item ? boundedResumeOutput({ collected_item: derived.collected_item }) : null;
      case 'research.search_x':
        return boundedResumeOutput({
          search_items: derived.search_items || [],
          search_x_items: derived.search_x_items || [],
        });
      case 'research.search_reddit':
        return boundedResumeOutput({
          search_items: derived.search_items || [],
          search_reddit_items: derived.search_reddit_items || [],
          combined_items: derived.combined_items || [],
        });
      case 'research.analyze_persisted':
        return derived.analysis_results ? boundedResumeOutput({ analysis_results: derived.analysis_results }) : null;
      case 'generation.submit':
        return derived.quote || derived.job
          ? boundedResumeOutput({ quote: derived.quote, job: derived.job })
          : null;
      default:
        return null;
    }
  };

  const hydrateFromResumeOutput = (step, prior) => {
    const resume = prior?.resume_output;
    if (!plainObject(resume)) return;
    const allowed = {
      'research.inspect_attachments': ['collected_item', 'attachment_model_result'],
      'research.collect_url': ['collected_item'],
      'research.search_x': ['search_items', 'search_x_items'],
      'research.search_reddit': ['search_items', 'search_reddit_items', 'combined_items'],
      'research.analyze_persisted': ['analysis_results'],
      'generation.submit': ['quote', 'job'],
    }[step.operation] || [];
    for (const key of allowed) {
      if (resume[key] !== undefined) derived[key] = structuredClone(resume[key]);
    }
  };

  const recordStep = (step, update) => {
    const snapshot = { ...(results[step.step] || stepSnapshot(step)), ...update, updated_at: now() };
    results[step.step] = snapshot;
    stepStates[step.step] = snapshot;
    emit?.({ event: 'step_state', task_id: taskView.id, step: snapshot.key, state: snapshot.state });
  };

  const refreshState = async () => {
    const state = await stateReader(trustedContext, plan.project_id, signal);
    if (!state || state.ok !== true) {
      throw boundedError(state?.code || 'PROJECT_STATE_READ_FAILED', state?.diagnostics?.issues?.[0] || '刷新当前项目状态失败。', {
        operation: bounded(state?.diagnostics?.operation || 'workspace.project.read', 80),
        ...(state?.diagnostics?.field ? { field: bounded(state.diagnostics.field, 80) } : {}),
      });
    }
    ctx.revision = state.revision;
    return state.project;
  };

  const captureDerived = (step, result, item) => {
    switch (step.operation) {
      case 'research.inspect_attachments': {
        const collected = itemsFromResult(result, 'items')?.[0] || result?.entity || null;
        const modelResult = itemsFromResult(result, 'analyses')?.[0] || normalizedModelResult(result);
        if (collected && plainObject(collected)) derived.collected_item = collected;
        if (modelResult && plainObject(modelResult)) derived.attachment_model_result = modelResult;
        break;
      }
      case 'research.collect_url': {
        const collected = itemsFromResult(result, 'items')?.[0] || result?.entity || null;
        if (collected && plainObject(collected)) derived.collected_item = collected;
        break;
      }
      case 'research.search_x': {
        const items = itemsFromResult(result, 'items') || [];
        derived.search_items = items;
        // Preserve the X result set in its own slot before Reddit is
        // processed: the combined workflow reads combined_items (never the
        // shared search_items slot), so the X set can neither be overwritten
        // by Reddit items nor duplicated through aliasing.
        derived.search_x_items = items.slice();
        break;
      }
      case 'research.search_reddit': {
        const items = itemsFromResult(result, 'items') || [];
        // Single-platform workflow reads search_items; the combined workflow
        // reads combined_items (search_x items first, then reddit items).
        derived.search_items = items;
        derived.search_reddit_items = items;
        // Combined workflow: X results first, then Reddit results. Each
        // platform contributes at most `count` items — the exact per-platform
        // contract bound. An overall cap would silently drop one platform
        // (platform loss) at the maximum search count.
        const perPlatform = Math.min(Math.max(Number(plan.slots.count) || 5, 1), MAX_FAN_OUT);
        derived.combined_items = [
          ...(derived.search_x_items || []).slice(0, perPlatform),
          ...items.slice(0, perPlatform),
        ];
        break;
      }
      case 'research.analyze_persisted': {
        const evidenceId = evidenceFromItem(item)?.id || derived.created_evidence_id;
        if (evidenceId) {
          const row = normalizedModelResult(result);
          if (row && plainObject(row)) derived.analysis_results = { ...(derived.analysis_results || {}), [evidenceId]: row };
        }
        break;
      }
      case 'workspace.evidence.create': {
        const entity = result?.entity;
        if (entity && entity.type === 'evidence' && entity.id) derived.created_evidence_id = entity.id;
        break;
      }
      case 'generation.quote': {
        const quote = result?.data?.quote || result?.quote || null;
        if (quote && plainObject(quote)) derived.quote = quote;
        break;
      }
      case 'generation.submit': {
        const job = result?.data?.job || result?.job || null;
        if (job && plainObject(job)) derived.job = job;
        break;
      }
      case 'generation.status': {
        const job = result?.data?.job || result?.job || null;
        if (job && plainObject(job)) derived.job = job;
        break;
      }
      default:
        break;
    }
  };

  const resolveItems = (step) => {
    if (!step.fan_out) return { items: [{ itemIndex: 0, item: singleItemFor(step) }], sourceCount: 0 };
    const source = derived[step.fan_out.source];
    if (!Array.isArray(source)) {
      throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `扇出来源 ${step.fan_out.source} 缺失：未发起任何业务调用。`);
    }
    const requestedBound = plan.slots[step.fan_out.limit_slot];
    if (!Number.isSafeInteger(requestedBound)) {
      throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `扇出上限 ${step.fan_out.limit_slot || 'unknown'} 无效：未发起任何业务调用。`);
    }
    const bound = Math.min(step.fan_out.max, MAX_FAN_OUT, requestedBound);
    return {
      // The fan-out source size is recorded (bounded) so step snapshots prove
      // the exact contract bound of the source set — e.g. the combined
      // X + Reddit set is never silently truncated by an overall cap.
      sourceCount: source.length,
      items: source.slice(0, bound).map((entry, itemIndex) => ({ itemIndex, item: entry })),
    };
  };

  const singleItemFor = (step) => {
    switch (step.key) {
      case 'collect':
        return derived.collected_item;
      case 'save_evidence':
        return derived.collected_item;
      case 'analyze':
        return { evidence: derived.collected_evidence };
      case 'save_analysis':
        return { evidence: derived.collected_evidence, modelResult: derived.analysis_results?.[derived.created_evidence_id] };
      case 'make_card':
        return { evidence: derived.collected_evidence, modelResult: derived.analysis_results?.[derived.created_evidence_id] };
      default:
        return { item: null };
    }
  };

  const payloadBuilderFor = (step, item) => {
    switch (step.operation) {
      case 'workspace.project.read':
        return () => ({ project_id: plan.project_id });
      case 'research.status':
        return () => ({ project_id: plan.project_id });
      case 'research.collect_url':
        return () => ({ ...(plan.project_id ? { project_id: plan.project_id } : {}), url: plan.slots.url });
      case 'research.inspect_attachments':
        return () => ({
          project_id: plan.project_id,
          thread_id: attachmentThreadId(plan),
          attachments: structuredClone(plan.attachments),
        });
      case 'research.search_x':
      case 'research.search_reddit':
        return () => searchPayload(plan, step.operation);
      case 'research.analyze_persisted': {
        const evidenceId = evidenceFromItem(item)?.id || derived.created_evidence_id;
        if (!evidenceId) throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '分析步骤缺少精确的证据身份：未发起任何业务调用。');
        return () => ({ project_id: plan.project_id, evidence_id: evidenceId });
      }
      case 'research.generate_similar':
        return () => {
          const payload = { project_id: plan.project_id, evidence_id: ctx.evidenceId };
          if (ctx.analysisId) payload.analysis_id = ctx.analysisId;
          return payload;
        };
      case 'workspace.evidence.create':
        return async () => p19WritePayload(plan, ctx, { evidence: await deriveEvidenceRecord(item) });
      case 'workspace.analysis.create': {
        if (step.key === 'save_comparison') {
          const evidence = evidenceFromItem(item);
          const existing = (derived.project?.analyses || []).find((entry) => entry.id === `an-${sha256Hex(`${plan.project_id}\0${evidence.id}\0local-comparison`).slice(0, 24)}`) || null;
          return () => p19WritePayload(plan, ctx, { analysis: deriveLocalAnalysisRecord({ plan, evidence, existing, comparison: ctx.comparison }) }, { withFingerprint: true, expectedFingerprint: existing?.fingerprint || null });
        }
        return () => {
          const evidence = evidenceFromItem(item) || derived.collected_evidence;
          const modelResult = item?.modelResult || derived.analysis_results?.[evidence?.id];
          if (!evidence?.id || !plainObject(modelResult)) {
            throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '分析记录缺少精确的证据绑定或模型结果：未发起任何业务调用。');
          }
          const existing = (derived.project?.analyses || []).find((entry) => entry.id === `an-${sha256Hex(`${plan.project_id}\0${evidence.id}\0${evidence.fingerprint}`).slice(0, 24)}`) || null;
          const record = deriveAnalysisRecord({ plan, evidence, modelResult, existing });
          return p19WritePayload(plan, ctx, { analysis: record }, { withFingerprint: true, expectedFingerprint: existing?.fingerprint || null });
        };
      }
      case 'workspace.card.create':
        return () => {
          const evidence = evidenceFromItem(item) || derived.collected_evidence;
          const analysis = exactModelAnalysisRecord(derived.project?.analyses, plan.project_id, evidence);
          if (!evidence?.id || !analysis) {
            throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '知识卡缺少精确的分析血缘：未发起任何业务调用。');
          }
          const record = deriveCardRecord({ evidence, analysis });
          const existing = (derived.project?.knowledge_cards || []).find((entry) => entry.id === record.id && entry.version === record.version) || null;
          return p19WritePayload(plan, ctx, { card: record }, { withFingerprint: true, expectedFingerprint: existing?.fingerprint || null });
        };
      case 'workspace.brief.assemble':
        return () => {
          const historical = derived.project?.brief || null;
          // 规范身份契约：仅当历史 Brief 身份恰好符合 brief-<24 位小写十六
          // 进制>时才沿用其身份与同实体指纹基线；非规范历史身份保持原样
          // （绝不改写/删除），新 Brief 写入由当前项目派生的确定性规范身份，
          // 无同实体基线（expected_fingerprint 为 null）。
          const existing = historical && BRIEF_ID_PATTERN.test(String(historical.id || '')) ? historical : null;
          const record = deriveBriefRecord({
            plan,
            project: derived.project,
            cards: derived.project?.knowledge_cards || [],
            analyses: derived.project?.analyses || [],
            existing,
          });
          return p19WritePayload(plan, ctx, { brief: record }, { withFingerprint: true, expectedFingerprint: existing?.fingerprint || null });
        };
      case 'workspace.handoff.create':
        return async () => {
          const record = await deriveHandoffRecord({ plan, project: derived.project, brief: derived.project?.brief || null });
          const existing = (derived.project?.handoffs || []).find((entry) => entry.id === record.id && entry.version === record.version) || null;
          return p19WritePayload(plan, ctx, { handoff: record }, { withFingerprint: true, expectedFingerprint: existing?.fingerprint || null });
        };
      case 'generation.quote':
        return () => {
          const payload = {
            project_id: plan.project_id,
            brief_id: plan.slots.brief_id,
            mode: plan.slots.mode,
            prompt: plan.slots.prompt,
          };
          for (const field of ['negative_prompt', 'aspect_ratio', 'duration_seconds', 'resolution', 'reference_asset_id']) {
            if (plan.slots[field] != null) payload[field] = plan.slots[field];
          }
          return payload;
        };
      case 'generation.submit':
        return () => {
          const quote = derived.quote;
          if (!plainObject(quote) || !quote.quote_id || !quote.quote_fingerprint) {
            throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '付费提交缺少 quote 步骤的精确绑定：未发起任何业务调用。');
          }
          if (!ctx.revision || !Number.isSafeInteger(ctx.revision)) {
            throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', '付费提交缺少可信的项目修订号：未发起任何业务调用。');
          }
          const payload = {
            project_id: plan.project_id,
            brief_id: plan.slots.brief_id,
            mode: plan.slots.mode,
            prompt: plan.slots.prompt,
            quote_id: quote.quote_id,
            quote_fingerprint: quote.quote_fingerprint,
            estimated_max_cost_cny: Number(quote.estimated_max_cost_cny) || Number(quote.price_cny_max) || null,
            expected_revision: ctx.revision,
          };
          for (const field of ['negative_prompt', 'aspect_ratio', 'duration_seconds', 'resolution', 'reference_asset_id']) {
            if (plan.slots[field] != null) payload[field] = plan.slots[field];
          }
          return payload;
        };
      case 'generation.status':
        return () => ({ project_id: plan.project_id, job_id: plan.slots.job_id });
      case 'generation.artifact':
        return () => ({ project_id: plan.project_id, job_id: plan.slots.job_id, artifact_id: plan.slots.artifact_id });
      default:
        throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `计划引用了未实现的确定性调用 ${step.operation}：未发起任何业务调用。`);
    }
  };

  const reuseCheckFor = (step, item) => {
    if (!step.reuse) return null;
    const project = derived.project;
    switch (step.reuse.kind) {
      case 'evidence': {
        if (step.operation === 'research.collect_url') {
          return preCollectEvidenceReuse(project, plan.slots.url, plan.project_id);
        }
        return exactEvidenceReuse(project, item, plan.project_id);
      }
      case 'analysis': {
        if (step.key === 'save_comparison') {
          const evidence = evidenceFromItem(item);
          if (!evidence?.id) return null;
          const comparisonId = `an-${sha256Hex(`${plan.project_id}\0${evidence.id}\0local-comparison`).slice(0, 24)}`;
          return exactAnalysisReuse(project?.analyses, plan.project_id, evidence.id, evidence.fingerprint, evidence.version, false, comparisonId);
        }
        const evidence = evidenceFromItem(item) || derived.collected_evidence;
        if (!evidence?.id) return null;
        return exactAnalysisReuse(project?.analyses, plan.project_id, evidence.id, evidence.fingerprint, evidence.version, true);
      }
      case 'card': {
        const evidence = evidenceFromItem(item) || derived.collected_evidence;
        const analysis = exactModelAnalysisRecord(project?.analyses, plan.project_id, evidence);
        if (!analysis) return null;
        return exactCardReuse(project?.knowledge_cards, plan.project_id, analysis.id, analysis.fingerprint);
      }
      case 'brief': {
        // An illegal or mis-bound card identity fails closed here — before any
        // reuse verdict or write — so a broken card set can never silently
        // reuse an existing Brief or derive a colliding identity.
        const citationIds = [...new Set(validatedCardIds(project?.knowledge_cards || [], plan.project_id))];
        const verdict = exactBriefReuse(project?.brief ? [project.brief] : [], plan.project_id, citationIds);
        if (!verdict.reused && verdict.existing) derived.existing_brief = verdict.existing;
        return verdict;
      }
      case 'handoff':
        return exactHandoffReuse(project?.handoffs || [], plan.project_id, project?.brief || null);
      default:
        return null;
    }
  };

  const runOneCall = async (step, itemIndex, payloadBuilder) => {
    if (signal?.aborted) throw Object.assign(new Error('Task cancelled.'), { code: 'CANCELLED' });
    // The canonical external tool-call shape crosses the tool client, which
    // performs the single bridge-boundary validation on it.
    const call = exactToolCall(taskView.id, plan, trustedContext, step, itemIndex, await payloadBuilder());
    recordStep(step, { state: STEP_STATE_RUNNING });
    actualCallCounts.set(step.step, (actualCallCounts.get(step.step) || 0) + 1);
    const result = await toolClient(call, trustedContext, signal);
    if (!result || result.ok !== true) {
      const code = String(result?.code || 'BOUNDARY_FAILED');
      const ambiguous = step.cost === true && PAID_AMBIGUOUS_CODES.includes(code);
      if (ambiguous) retryUnsafeStep = step.step;
      throw boundedError(code, result?.diagnostics?.issues?.[0] || `边界拒绝了操作：${code}。`, {
        step: step.step,
        operation: bounded(result?.diagnostics?.operation || step.operation, 80),
        ...boundedModelFailureDiagnostics(result?.diagnostics),
        retry_unsafe: ambiguous === true,
      });
    }
    return result;
  };

  // Exact read-only generation.status read for the submitted job. Zero
  // approval, zero cost, zero writes — it can never resubmit the paid job or
  // cause a provider call; the canonical external call crosses the same tool
  // client/bridge boundary as every other operation.
  const invokeGenerationStatus = async (step, jobId) => {
    if (signal?.aborted) throw Object.assign(new Error('Task cancelled.'), { code: 'CANCELLED' });
    const call = {
      schema_version: 'ams_harness_tool_v1',
      operation: 'generation.status',
      payload: { project_id: plan.project_id, job_id: jobId },
      idempotency_key: `d-${sha256Hex(`${taskView.id}\0${plan.fingerprint}\0generation-status\0${jobId}`).slice(0, 32)}`,
    };
    const checked = validateToolCall(call, trustedContext);
    if (!checked.ok) {
      throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `内部调用校验失败（${checked.code}）：未发起任何业务调用。`);
    }
    const result = await toolClient(call, trustedContext, signal);
    if (!result || result.ok !== true) {
      throw boundedError(String(result?.code || 'BOUNDARY_FAILED'), result?.diagnostics?.issues?.[0] || `边界拒绝了操作：${result?.code || 'BOUNDARY_FAILED'}。`, {
        step: step.step,
        operation: 'generation.status',
        ...(result?.diagnostics?.field ? { field: bounded(result.diagnostics.field, 80) } : {}),
      });
    }
    return result;
  };

  const prepareStep = (step) => {
    if (step.operation === 'research.generate_similar') {
      const project = derived.project;
      const evidenceList = project?.evidence || [];
      const evidenceId = plan.slots.evidence_id || (evidenceList.length === 1 ? evidenceList[0].id : null);
      if (!evidenceId) {
        throw boundedError(plan.slots.evidence_id ? 'EVIDENCE_NOT_FOUND' : 'EXACT_SOURCE_AMBIGUOUS', plan.slots.evidence_id ? '计划引用的证据身份不存在。' : '项目证据不唯一：请在意图中给出精确的 Evidence 身份。');
      }
      if (!evidenceList.some((record) => record.id === evidenceId)) {
        throw boundedError('EVIDENCE_NOT_FOUND', '计划引用的证据身份不存在。');
      }
      ctx.evidenceId = evidenceId;
      const analysisId = plan.slots.analysis_id;
      if (analysisId && !(project?.analyses || []).some((record) => record.id === analysisId && record.evidence_id === evidenceId)) {
        throw boundedError('ANALYSIS_NOT_FOUND', '计划引用的分析身份不存在或未绑定该证据。');
      }
      ctx.analysisId = analysisId;
    }
    if (step.key === 'save_comparison') {
      const built = buildComparisonContext({ derived, plan, project: derived.project });
      ctx.comparison = built.comparison;
    }
  };

  for (const [stepIndex, step] of plan.steps.entries()) {
    const previous = stepStates[step.step]?.state;
    const isRetryTarget = retryTarget === step.step;
    const dependencies = step.depends_on.map((id) => results[id] || stepStates[id]);
    const dependencyFailure = dependencies.find((entry) => entry && entry.state === STEP_STATE_FAILED);
    const dependencyBlocked = dependencies.find((entry) => entry && (entry.state === STEP_STATE_BLOCKED || entry.state === STEP_STATE_SKIPPED));

    if (!isRetryTarget && dependencyFailure) {
      recordStep(step, { state: STEP_STATE_BLOCKED, error: { code: 'DEPENDENCY_BLOCKED', message: '前置步骤失败，本步骤被阻断。' } });
      continue;
    }
    if (!isRetryTarget && dependencyBlocked) {
      recordStep(step, { state: STEP_STATE_SKIPPED, item_count: 0 });
      continue;
    }
    // Refresh/reopen of an accepted asynchronous generation.submit: the paid
    // submit is never repeated — the recorded job is re-checked through an
    // exact read-only generation.status read so the outer task follows the
    // real asynchronous G1 job state (running → completed/failed/
    // needs_attention).
    if (!isRetryTarget && step.operation === 'generation.submit' && SUCCESS_STEP_STATES.has(previous)) {
      const prior = stepStates[step.step];
      hydrateFromResumeOutput(step, prior);
      const job = derived.job;
      const recordedStatus = prior.job_status;
      const jobId = plainObject(job) && typeof job.id === 'string' && G1_JOB_ID_PATTERN.test(job.id) ? job.id : null;
      if (jobId && (recordedStatus === 'queued' || recordedStatus === 'running')) {
        let status = recordedStatus;
        let refreshed = null;
        try {
          refreshed = await invokeGenerationStatus(step, jobId);
          const nextJob = refreshed?.data?.job || refreshed?.job || null;
          if (plainObject(nextJob)) derived.job = nextJob;
          const nextStatus = g1JobStatus(derived.job);
          if (nextStatus) status = nextStatus;
        } catch (statusError) {
          if (statusError?.code === 'CANCELLED') throw statusError;
          // A transient status-read failure must neither resubmit nor falsely
          // complete the task: keep the recorded non-terminal state and
          // surface the bounded read error for the next refresh.
          recordStep(step, {
            ...prior,
            job_status: recordedStatus,
            status_read_error: {
              code: String(statusError?.code || 'BOUNDARY_FAILED').slice(0, 80),
              message: String(statusError?.message || '生成状态读取失败。').slice(0, 240),
            },
            updated_at: now(),
          });
          continue;
        }
        if (status === 'failed' || status === 'needs_attention') {
          // Terminal G1 failure: the outer task must be accurately failed/
          // needs-attention rather than completed. Recorded here (not thrown)
          // because the refresh branch runs before the step try/catch.
          const terminal = g1TerminalFailure(derived.job);
          recordStep(step, terminalGenerationFailureSnapshot(step, prior, terminal, jobId, g1JobStatus(derived.job), now()));
          continue;
        }
        const refs = [...new Set([...(Array.isArray(prior.refs) ? prior.refs : []), ...(Array.isArray(refreshed?.artifact_refs) ? refreshed.artifact_refs : [])])].slice(0, 50);
        recordStep(step, { ...prior, job_status: status, refs, status_read_error: null, updated_at: now() });
      } else {
        recordStep(step, { ...prior, updated_at: prior.updated_at });
      }
      continue;
    }
    if (!isRetryTarget && SUCCESS_STEP_STATES.has(previous)) {
      const prior = stepStates[step.step];
      recordStep(step, { ...prior, updated_at: prior.updated_at });
      if (retrying) {
        // A retry never re-runs completed steps, but the deterministic
        // context they produced is rebuilt from their exact recorded refs so
        // downstream steps keep the same precise bindings.
        if (step.kind === 'read_state') {
          const state = await stateReader(trustedContext, plan.project_id, signal);
          if (!state || state.ok !== true) {
            throw boundedError(state?.code || 'PROJECT_STATE_READ_FAILED', state?.diagnostics?.issues?.[0] || '刷新当前项目状态失败。', {
              operation: bounded(state?.diagnostics?.operation || 'workspace.project.read', 80),
              ...(state?.diagnostics?.field ? { field: bounded(state.diagnostics.field, 80) } : {}),
            });
          }
          derived.project = state.project;
          ctx.revision = state.revision;
          if (plan.workflow === 'analyze_evidence') {
            const count = Math.min(Number(plan.slots.count) || 5, MAX_FAN_OUT);
            derived.evidence_items = (state.project?.evidence || []).slice(0, count);
          }
          if (plan.workflow === 'compare_project') {
            ctx.comparison = buildComparisonContext({ derived, plan, project: state.project }).comparison;
          }
        }
        hydrateFromResumeOutput(step, prior);
        if (step.operation === 'research.collect_url' || step.operation === 'research.analyze_persisted') hydrateFromState(step);
      }
      continue;
    }
    if (!isRetryTarget && previous === STEP_STATE_FAILED) {
      recordStep(step, { state: STEP_STATE_FAILED, error: stepStates[step.step].error });
      continue;
    }

    let stepProgress = null;
    const retrySnapshot = isRetryTarget ? structuredClone(stepStates[step.step] || {}) : null;
    const priorActualCalls = isRetryTarget && Number.isSafeInteger(retrySnapshot?.failed_count)
      ? Math.max(0, retrySnapshot.failed_count)
      : 0;
    actualCallCounts.set(step.step, priorActualCalls);
    recordStep(step, { state: STEP_STATE_RUNNING, failed_count: priorActualCalls, started_at: now(), error: null });
    try {
      if (step.kind === 'read_state') {
        if (!plan.project_id) throw boundedError('PROJECT_BINDING_REQUIRED', '当前任务未绑定项目，无法读取项目状态。');
        const state = await stateReader(trustedContext, plan.project_id, signal);
        if (!state || state.ok !== true) {
          throw boundedError(state?.code || 'PROJECT_STATE_READ_FAILED', state?.diagnostics?.issues?.[0] || '读取当前项目状态失败。', {
            operation: bounded(state?.diagnostics?.operation || 'workspace.project.read', 80),
            ...(state?.diagnostics?.field ? { field: bounded(state.diagnostics.field, 80) } : {}),
          });
        }
        derived.project = state.project;
        ctx.revision = state.revision;
        if (plan.workflow === 'analyze_evidence') {
          const count = Math.min(Number(plan.slots.count) || 5, MAX_FAN_OUT);
          derived.evidence_items = (state.project?.evidence || []).slice(0, count);
        }
        if (plan.workflow === 'compare_project') {
          ctx.comparison = buildComparisonContext({ derived, plan, project: state.project }).comparison;
        }
        recordStep(step, { state: STEP_STATE_SUCCEEDED, item_count: 1, executed_count: 1, finished_at: now() });
        continue;
      }

      if (step.kind === 'local') {
        // Deterministic local computation only: the comparison ranks the
        // project state the read_state step already loaded and produces the
        // bounded terminal result. Zero bridge calls, zero paid operations,
        // zero writes — the save_comparison write step only exists in the
        // plan when persist was explicitly approved.
        if (step.key !== 'compare' || plan.workflow !== 'compare_project') {
          throw boundedError('INTERNAL_PLAN_VALIDATION_ERROR', `计划引用了未实现的本地步骤 ${step.key}：未发起任何业务调用。`);
        }
        const built = buildComparisonContext({ derived, plan, project: derived.project });
        ctx.comparison = built.comparison;
        recordStep(step, {
          state: STEP_STATE_SUCCEEDED,
          item_count: derived.compare_evidence.length,
          executed_count: 1,
          finished_at: now(),
        });
        continue;
      }

      if (step.operation === 'workspace.lineage.audit') {
        const call = exactToolCall(taskView.id, plan, trustedContext, step, 0, { project_id: plan.project_id });
        recordStep(step, { state: STEP_STATE_RUNNING });
        actualCallCounts.set(step.step, (actualCallCounts.get(step.step) || 0) + 1);
        const result = await toolClient(call, trustedContext, signal);
        if (!result || result.ok !== true) {
          throw boundedError(String(result?.code || 'BOUNDARY_FAILED'), result?.diagnostics?.issues?.[0] || '血缘审计失败。', {
            step: step.step,
            operation: bounded(result?.diagnostics?.operation || step.operation, 80),
            ...(result?.diagnostics?.field ? { field: bounded(result.diagnostics.field, 80) } : {}),
          });
        }
        derived.terminal_results = { ...(derived.terminal_results || {}), [step.key]: boundedTerminalResult(result.data || result) };
        recordStep(step, { state: STEP_STATE_SUCCEEDED, item_count: 1, executed_count: 1, finished_at: now() });
        continue;
      }

      prepareStep(step);
      const { items, sourceCount } = resolveItems(step);
      const priorCompleted = isRetryTarget && Array.isArray(retrySnapshot?.completed_items)
        ? retrySnapshot.completed_items
        : [];
      if (isRetryTarget) hydrateFromResumeOutput(step, retrySnapshot);
      const outcomes = priorCompleted.map((entry) => ({ reused: entry.reused === true, resumed: true, ref: entry.ref || null }));
      const refs = Array.isArray(retrySnapshot?.refs) ? [...retrySnapshot.refs] : [];
      const completedIndexes = new Set(priorCompleted.map((entry) => entry.item_index));
      stepProgress = { outcomes, refs, sourceCount, completed_items: [...priorCompleted] };
      for (const { itemIndex, item } of items) {
        if (completedIndexes.has(itemIndex)) continue;
        const reuse = reuseCheckFor(step, item);
        if (reuse && reuse.code) {
          throw boundedError(reuse.code, `复用判定失败（${reuse.code}）：未选择任何记录。`);
        }
        if (reuse && reuse.reused) {
          outcomes.push({ reused: true, ref: reuse.ref });
          stepProgress.completed_items.push({ item_index: itemIndex, reused: true, ref: reuse.ref || null });
          if (reuse.ref) refs.push(reuse.ref);
          if (step.operation === 'research.collect_url' && reuse.ref) {
            // A reused collection hydrates the downstream steps from the exact
            // existing record — no re-collection, no re-write, no new cost.
            const existing = (derived.project?.evidence || []).find((record) => record.id === reuse.ref);
            if (existing) {
              derived.collected_evidence = existing;
              derived.created_evidence_id = existing.id;
              derived.collected_item = p22ItemFromEvidence(existing) || existing;
            }
          }
          continue;
        }
        const result = await runOneCall(step, itemIndex, payloadBuilderFor(step, item));
        outcomes.push({ reused: false, result });
        captureDerived(step, result, item);
        if (step.operation === 'generation.submit') {
          // An accepted asynchronous submit means queued/running — never
          // completed. While the job is non-terminal, one exact read-only
          // generation.status read per execution round refreshes the real
          // state (zero approval, zero cost, never a resubmission); a
          // terminal failed/needs_attention job fails the outer task with
          // bounded diagnostics instead of completing it.
          const submitted = derived.job;
          let status = g1JobStatus(submitted);
          const jobId = plainObject(submitted) && typeof submitted.id === 'string' && G1_JOB_ID_PATTERN.test(submitted.id) ? submitted.id : null;
          if (jobId && (status === 'queued' || status === 'running')) {
            try {
              const refreshed = await invokeGenerationStatus(step, jobId);
              const job = refreshed?.data?.job || refreshed?.job || null;
              if (plainObject(job)) derived.job = job;
              const nextStatus = g1JobStatus(derived.job);
              if (nextStatus) status = nextStatus;
            } catch (statusError) {
              if (statusError?.code === 'CANCELLED') throw statusError;
              ctx.generationStatusReadError = {
                code: String(statusError?.code || 'BOUNDARY_FAILED').slice(0, 80),
                message: String(statusError?.message || '生成状态读取失败。').slice(0, 240),
              };
            }
          }
          if (status === 'failed' || status === 'needs_attention') {
            const terminal = g1TerminalFailure(derived.job);
            throw boundedError(terminal.code, terminal.message, {
              step: step.step,
              operation: step.operation,
              ...(jobId ? { job_id: jobId } : {}),
              g1_terminal: true,
              g1_needs_attention: terminal.needs_attention === true,
            });
          }
          ctx.generationJobId = jobId;
          ctx.generationJobStatus = status || 'running';
        }
        const isTerminal = !plan.steps.some((candidate) => candidate.depends_on.includes(step.step));
        if (isTerminal && step.write !== true) {
          const value = boundedTerminalResult(result.data || result);
          if (value) derived.terminal_results = { ...(derived.terminal_results || {}), [step.key]: value };
        }
        if (Array.isArray(result.artifact_refs)) refs.push(...result.artifact_refs);
        stepProgress.completed_items.push({
          item_index: itemIndex, reused: false, ref: result?.artifact_refs?.[0] || result?.entity?.id || null,
          entity: result?.entity && typeof result.entity.type === 'string' && typeof result.entity.id === 'string'
            ? { type: result.entity.type, id: result.entity.id } : null,
        });
        if (step.write === true) {
          // Every P19 mutation advances the project revision. Refresh after
          // each single-item write so the next fan-out item carries the exact
          // authoritative revision rather than a stale batch-start revision.
          derived.project = await refreshState();
          if (step.operation === 'workspace.evidence.create' && derived.created_evidence_id) {
            const saved = (derived.project?.evidence || []).find((record) => record.id === derived.created_evidence_id);
            if (!saved) throw boundedError('EVIDENCE_NOT_FOUND', '保存的证据未出现在项目状态中。');
            derived.collected_evidence = saved;
            if (plainObject(derived.attachment_model_result)) {
              derived.analysis_results = {
                ...(derived.analysis_results || {}),
                [saved.id]: derived.attachment_model_result,
              };
            }
          }
        }
      }
      if (step.fan_out && outcomes.length === 0) {
        throw boundedError(
          'FAN_OUT_SOURCE_EMPTY',
          `步骤 ${step.label} 没有可处理的来源记录：未发起任何业务调用。`,
        );
      }
      const reusedCount = outcomes.filter((entry) => entry.reused).length;
      const executedCount = outcomes.length - reusedCount;
      const state = executedCount === 0 ? STEP_STATE_REUSED : STEP_STATE_SUCCEEDED;
      const resumeOutput = resumeOutputFor(step);
      recordStep(step, {
        state,
        item_count: outcomes.length,
        ...(step.fan_out ? { source_count: sourceCount } : {}),
        reused_count: reusedCount,
        executed_count: executedCount,
        refs: [...new Set(refs)].slice(0, 50),
        completed_items: stepProgress.completed_items.slice(0, MAX_FAN_OUT),
        ...(resumeOutput ? { resume_output: resumeOutput } : {}),
        ...(step.operation === 'generation.submit' && ctx.generationJobStatus ? {
          job_status: ctx.generationJobStatus,
          ...(ctx.generationJobId ? { job_id: ctx.generationJobId } : {}),
          ...(ctx.generationStatusReadError ? { status_read_error: ctx.generationStatusReadError } : {}),
        } : {}),
        finished_at: now(),
      });
      if (plan.project_id && step.write !== true && (step.key === 'collect' || step.key === 'analyze' || step.key === 'make_card' || step.key === 'assemble_brief')) {
        // Refresh authoritative project state after writes so downstream reuse
        // checks and revision guards see the exact persisted records.
        derived.project = await refreshState();
        if (step.operation === 'workspace.evidence.create' && derived.created_evidence_id) {
          const saved = (derived.project?.evidence || []).find((record) => record.id === derived.created_evidence_id);
          if (!saved) throw boundedError('EVIDENCE_NOT_FOUND', '保存的证据未出现在项目状态中。');
          derived.collected_evidence = saved;
          if (plainObject(derived.attachment_model_result)) {
            derived.analysis_results = {
              ...(derived.analysis_results || {}),
              [saved.id]: derived.attachment_model_result,
            };
          }
        }
      }
    } catch (error) {
      if (error?.code === 'CANCELLED') throw error;
      const completedOutcomes = stepProgress?.outcomes || [];
      const completedRefs = [...new Set(stepProgress?.refs || [])].slice(0, 50);
      const resumeOutput = resumeOutputFor(step);
      const failedSnapshot = stepSnapshot(step, {
        state: STEP_STATE_FAILED,
        item_count: completedOutcomes.length,
        ...(stepProgress ? { source_count: stepProgress.sourceCount } : {}),
        reused_count: completedOutcomes.filter((entry) => entry.reused).length,
        executed_count: completedOutcomes.filter((entry) => !entry.reused).length,
        failed_count: actualCallCounts.get(step.step) || 0,
        refs: completedRefs,
        ...(stepProgress ? { completed_items: stepProgress.completed_items.slice(0, MAX_FAN_OUT) } : {}),
        ...(resumeOutput ? { resume_output: resumeOutput } : {}),
        ...(step.operation === 'generation.submit' && g1JobStatus(derived.job) ? { job_status: g1JobStatus(derived.job) } : {}),
        finished_at: now(),
        error: {
          code: String(error?.code || 'HARNESS_FAILED').slice(0, 80),
          operation: bounded(error?.diagnostics?.operation || step.operation, 80),
          message: String(error?.message || '步骤执行失败。').slice(0, 240),
          ...boundedModelFailureDiagnostics(error?.diagnostics),
          ...(error?.diagnostics?.job_id ? { job_id: bounded(error.diagnostics.job_id, 200) } : {}),
          ...(error?.diagnostics?.g1_terminal === true ? { g1_terminal: true } : {}),
          ...(error?.diagnostics?.g1_needs_attention === true ? { g1_needs_attention: true } : {}),
          retry_unsafe: error?.diagnostics?.retry_unsafe === true || error?.code === 'INTERNAL_PLAN_VALIDATION_ERROR',
        },
      });
      if (retryUnsafeStep === step.step) failedSnapshot.error.retry_unsafe = true;
      recordStep(step, failedSnapshot);
      // The first necessary step failure blocks every remaining step that
      // transitively depends on it; only registry-independent branches may
      // continue (marked skipped here so the UI never shows them as pending).
      const blockedIds = new Set([step.step]);
      for (const remaining of plan.steps.slice(stepIndex + 1)) {
        const blocked = remaining.depends_on.some((dep) => blockedIds.has(dep))
          || remaining.depends_on.some((dep) => dependsOnFailed(dep, plan.steps, blockedIds));
        if (blocked) {
          blockedIds.add(remaining.step);
          recordStep(remaining, { state: STEP_STATE_BLOCKED, error: { code: 'DEPENDENCY_BLOCKED', message: '前置步骤失败，本步骤被阻断。' } });
        } else {
          recordStep(remaining, { state: STEP_STATE_SKIPPED, item_count: 0 });
        }
      }
      break;
    }
  }

  function dependsOnFailed(stepId, allSteps, failedSet) {
    const entry = allSteps.find((candidate) => candidate.step === stepId);
    if (!entry) return false;
    if (failedSet.has(entry.step)) return true;
    return entry.depends_on.some((dep) => dependsOnFailed(dep, allSteps, failedSet));
  }

  const steps = plan.steps.map((step) => ({ step: step.step, state: stepStates[step.step]?.state || STEP_STATE_PLANNED }));
  const succeeded = steps.filter((entry) => SUCCESS_STEP_STATES.has(entry.state));
  const failed = steps.filter((entry) => entry.state === STEP_STATE_FAILED);
  const validationFailure = failed.some((entry) => {
    const code = stepStates[entry.step]?.error?.code;
    return code === 'INTERNAL_PLAN_VALIDATION_ERROR' || code === 'REUSE_AMBIGUOUS';
  });
  // Bounded task-state contract: the outer outcome is `partial` only when
  // genuinely successful independent deliverables coexist with a failed
  // required action. A prerequisite read (read_state) is never a deliverable —
  // e.g. a definitive quote rejection that blocks submit produces no
  // deliverable at all and must be `failed`. The existing contract keeps two
  // read-only-before-failure shapes partial: an ambiguous paid failure
  // (outcome unknowable, retry_unsafe) and a zero-call empty fan-out failure.
  const stepByKey = new Map(plan.steps.map((step) => [step.step, step]));
  const stepError = (entry) => stepStates[entry.step]?.error || {};
  const hasGenuineDeliverable = succeeded.some((entry) => stepByKey.get(entry.step)?.kind !== 'read_state');
  const hasAmbiguousFailure = failed.some((entry) => stepError(entry).retry_unsafe === true);
  const hasEmptyFanOutFailure = failed.some((entry) => stepError(entry).code === 'FAN_OUT_SOURCE_EMPTY');
  const independentProgress = hasGenuineDeliverable || hasAmbiguousFailure || hasEmptyFanOutFailure;
  // A terminal G1 failure (failed/needs_attention) is never a partial success
  // and never a completion — the outer task must be accurately failed.
  const hasTerminalGenerationFailure = failed.some((entry) => stepError(entry).g1_terminal === true);
  // An accepted submit whose recorded job is still queued/running is
  // non-terminal pending/running state, not a completion.
  const generationPending = plan.steps.some((step) => {
    if (step.operation !== 'generation.submit') return false;
    const snapshot = stepStates[step.step] || {};
    return snapshot.state === STEP_STATE_SUCCEEDED && (snapshot.job_status === 'queued' || snapshot.job_status === 'running');
  });
  const outcome = failed.length > 0
    ? (hasTerminalGenerationFailure || validationFailure || !(succeeded.length > 0 && independentProgress) ? 'failed' : 'partial')
    : (generationPending ? 'running' : 'succeeded');
  const refs = [...new Set(plan.steps.flatMap((step) => stepStates[step.step]?.refs || []))].slice(0, 50);
  const artifactEntities = [...new Map(plan.steps.flatMap((step) => stepStates[step.step]?.completed_items || [])
    .map((item) => item?.entity).filter((entity) => entity?.id && entity?.type)
    .map((entity) => [`${entity.type}:${entity.id}`, entity])).values()].slice(0, 50);
  const response = {
    outcome,
    final_response: buildSummary({ plan, stepStates }),
    artifact_refs: refs,
    artifact_entities: artifactEntities,
    partial_completion: outcome === 'partial',
  };
  if (failed.some((entry) => stepError(entry).g1_needs_attention === true)) response.needs_attention = true;
  if (generationPending) {
    response.final_response = `生成作业已提交并正在执行（尚未完成，刷新可恢复最新状态）。\n${response.final_response}`;
  } else if (response.needs_attention === true) {
    response.final_response = `生成作业需要人工关注（详见作业诊断）。\n${response.final_response}`;
  }
  if (plan.workflow === 'search_x_reddit' && Number(plan.slots.save_count) === 0) {
    const combined = boundedTerminalResult({ items: derived.combined_items || [] });
    if (combined) derived.terminal_results = { search_x_reddit: combined };
  }
  // A read-only comparison always returns its bounded ranking (and a
  // persisted comparison returns the same deterministic ranking alongside
  // its written analyses). Rebuilt at the end so a retried run restores the
  // exact same terminal result without re-running the local step.
  if (plan.workflow === 'compare_project' && Array.isArray(derived.compare_evidence)) {
    const compare = boundedTerminalResult(buildCompareResult({
      plan,
      metric: compareMetric(plan),
      ranking: derived.compare_ranking || [],
      evidenceList: derived.project?.evidence || [],
      comparison: ctx.comparison,
    }));
    if (compare) derived.terminal_results = { ...(derived.terminal_results || {}), compare };
  }
  // A bounded generation status view follows the real asynchronous job state
  // (queued/running/completed/failed/needs_attention) into the persisted
  // terminal result so the page shows the accurate state after refresh.
  if (plan.workflow === 'generate_media' && plainObject(derived.job)) {
    const statusView = boundedGenerationStatusView(derived.job);
    if (statusView) derived.terminal_results = { ...(derived.terminal_results || {}), generation_status: statusView };
  }
  // H5 result recovery: persist only stable private-object identities and the
  // bounded model result. Signed URLs are intentionally created on demand by
  // the authenticated browser and are never stored in the task snapshot.
  if (plan.workflow === 'inspect_private_attachments' && plainObject(derived.collected_item)) {
    const attachmentPipeline = boundedTerminalResult({
      source: derived.collected_item,
      analysis: plainObject(derived.attachment_model_result) ? derived.attachment_model_result : null,
    });
    if (attachmentPipeline) {
      derived.terminal_results = {
        ...(derived.terminal_results || {}),
        attachment_pipeline: attachmentPipeline,
      };
    }
  }
  if (plainObject(derived.terminal_results) && Object.keys(derived.terminal_results).length > 0) {
    response.result_data = boundedTerminalResult(derived.terminal_results);
  }
  if (retryUnsafeStep) response.retry_unsafe_step = retryUnsafeStep;
  return response;
}

function buildSummary({ plan, stepStates }) {
  const lines = [`工作流「${plan.workflow_title}」执行完成。`];
  for (const step of plan.steps) {
    const snapshot = stepStates[step.step] || {};
    const label = STEP_LABELS[snapshot.state] || snapshot.state || 'planned';
    lines.push(`${step.label}：${label}${snapshot.reused_count > 0 ? `（复用 ${snapshot.reused_count}）` : ''}${snapshot.executed_count > 0 ? `（执行 ${snapshot.executed_count}）` : ''}`);
  }
  const reused = plan.steps.filter((step) => stepStates[step.step]?.state === STEP_STATE_REUSED).length;
  if (reused > 0) lines.push(`其中 ${reused} 个步骤直接复用了既有产物，未产生新的费用或写入。`);
  return lines.join('\n');
}

/**
 * Bridge-side state reader: reads the current project through the exact tool
 * contract (workspace.project.read). `toolClient` is the same bridge client
 * the executor uses for every other call, and — like every executor call —
 * receives the canonical external tool-call shape; the client performs the
 * single bridge-boundary validation on it. Failures keep the exact bounded
 * diagnostics (code, operation, field) supplied by the boundary or the
 * validator so the executor can surface them in the final step failure.
 */
export function createBridgeStateReader(toolClient) {
  return async (trustedContext, projectId, signal) => {
    const call = {
      schema_version: 'ams_harness_tool_v1',
      operation: 'workspace.project.read',
      payload: { project_id: projectId },
      idempotency_key: 'state-read',
    };
    // Construction guard: an invalid state read never touches the client.
    const checked = validateToolCall(call, trustedContext);
    if (!checked.ok) return { ok: false, code: checked.code, diagnostics: checked.diagnostics };
    const result = await toolClient(call, trustedContext, signal);
    if (!result || result.ok !== true) {
      return {
        ok: false,
        code: result?.code || 'PROJECT_STATE_READ_FAILED',
        ...(result?.diagnostics ? { diagnostics: result.diagnostics } : {}),
      };
    }
    const project = result.data?.project || result.project || null;
    if (!plainObject(project)) return { ok: false, code: 'PROJECT_STATE_INVALID' };
    return { ok: true, project, revision: Number.isSafeInteger(project.version) ? project.version : null };
  };
}
