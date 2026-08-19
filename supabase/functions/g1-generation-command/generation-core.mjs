// G1 百炼图片/视频生成执行层：Edge Function 命令核心（纯 ESM，
// 浏览器 / node:test / Deno 均可导入；未部署）。
//
// - 用户身份只来自已验证 JWT 的 subject（deriveUserIdFromClaims），
//   绝不来自请求输入或 user_metadata；
// - 只接受显式动作清单（ACTION_ALLOWLIST），未知动作/未知字段一律 fail closed；
// - 完整校验有界字段（prompt/negative prompt/画幅/时长/分辨率/引用素材/
//   Brief/quote/approval/幂等键），与 SQL 边界同一套有界契约；
// - approve_submit 的显式批准对象（quote_id/quote_fingerprint/
//   request_fingerprint/estimated_max_cost_cny/expires_at/source）由本核心
//   校验形状，精确绑定校验由 SQL 边界原子完成（任何变化都在 provider
//   调用之前使 quote 失效）；
// - 返回有界结构化诊断（固定文案，<=512 字符，绝不回显无界原始值）；
// - 不执行任何模型/网络/提供商/生成行为。

import {
  BRIEF_ID_PATTERN,
  EVIDENCE_ID_PATTERN,
  MAX_DIAGNOSTIC_LENGTH,
  PROJECT_ID_PATTERN,
  isNonEmptyString,
  isPlainObject,
} from '../../../src/services/p19-contracts.js';

export const G1_EDGE_SCHEMA_VERSION = 'g1_generation_command_v1';
export const G1_REQUEST_SCHEMA_VERSION = 'g1_generation_request_v1';

export const G1_MODES = Object.freeze(['image', 'video_t2v', 'video_i2v']);
export const G1_ASPECT_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']);
export const G1_RESOLUTIONS = Object.freeze(['720p', '1080p']);
export const G1_REFERENCE_ASSET_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const G1_JOB_ID_PATTERN = /^g1j-[0-9a-f]{24}$/;
export const G1_ARTIFACT_ID_PATTERN = /^g1x-[0-9a-f]{24}$/;
export const G1_QUOTE_ID_PATTERN = /^g1q-[0-9a-f]{24}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const MAX_PROMPT_CHARS = 2000;
export const MAX_NEGATIVE_PROMPT_CHARS = 500;
export const MAX_DURATION_SECONDS = 10;
export const MAX_IDEMPOTENCY_KEY = 200;
export const MAX_QUOTE_MAX_COST = 100000;

/** 动作清单与所需最低 staging 角色（与已验收 p19 角色阶梯一致）。 */
export const ACTION_ALLOWLIST = Object.freeze({
  quote: { role: 'viewer', label: '请求不可变报价' },
  approve_submit: { role: 'operator', label: '显式批准并提交付费生成作业' },
  status: { role: 'viewer', label: '读取生成作业状态' },
  list: { role: 'viewer', label: '列出当前项目生成作业' },
  artifact: { role: 'viewer', label: '读取产物与签名 URL' },
  providers: { role: 'viewer', label: '读取固定 provider 注册表' },
  list_reference_assets: { role: 'viewer', label: '列出已批准引用素材' },
});

export const ROLE_RANK = Object.freeze({ viewer: 0, reviewer: 1, operator: 2, admin: 3 });

/** 每动作允许的顶层字段（未知字段 fail closed）。 */
const ACTION_FIELDS = Object.freeze({
  quote: ['project_id', 'brief_id', 'mode', 'prompt', 'negative_prompt', 'aspect_ratio',
    'duration_seconds', 'resolution', 'reference_asset_id', 'knowledge_card_ids', 'evidence_ids'],
  approve_submit: ['project_id', 'brief_id', 'mode', 'prompt', 'negative_prompt', 'aspect_ratio',
    'duration_seconds', 'resolution', 'reference_asset_id', 'knowledge_card_ids', 'evidence_ids',
    'quote_id', 'quote_fingerprint', 'request_fingerprint', 'estimated_max_cost_cny',
    'expires_at', 'source', 'expected_revision', 'idempotency_key'],
  status: ['project_id', 'job_id'],
  list: ['project_id', 'limit'],
  artifact: ['project_id', 'job_id', 'artifact_id'],
  providers: [],
  list_reference_assets: [],
});

function fail(code, message, extra = {}) {
  return { ok: false, code, message, diagnostics: { issues: [message] }, ...extra };
}

function boundedDiagnostics(issues) {
  return {
    issues: issues.slice(0, 8).map((text) => (
      text.length > MAX_DIAGNOSTIC_LENGTH ? `${text.slice(0, MAX_DIAGNOSTIC_LENGTH)}…` : text
    )),
  };
}

export function deriveUserIdFromClaims(claims) {
  const sub = claims && typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!sub || sub.length > 200) {
    const error = new Error('JWT 缺少有效的 subject，无法确定 user_id。');
    error.code = 'INVALID_SUBJECT';
    throw error;
  }
  return sub;
}

export function hasRequiredRole(accessRole, requiredRole) {
  return ROLE_RANK[accessRole] !== undefined && ROLE_RANK[accessRole] >= ROLE_RANK[requiredRole];
}

/**
 * fail-closed 有界字符串：原始输入长度超过上限（任何截断都会隐藏溢出）→ 返回
 * null；非字符串同样返回 null。绝不先截断再校验。
 */
function boundedString(value, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) return null;
  return value.trim();
}

function boundedArray(value, pattern, maxItems, label) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!Array.isArray(value) || value.length > maxItems) return fail(`${label}_INVALID`, `${label} 必须是数组且不超过 ${maxItems} 项。`);
  for (const item of value) {
    if (typeof item !== 'string' || !pattern.test(item)) return fail(`${label}_INVALID`, `${label} 包含非法身份。`);
  }
  return { ok: true, value: [...value] };
}

/**
 * 解析并校验 G1 Edge 请求信封：版本、动作、未知字段、有界字段。
 * 返回 {ok, action, idempotency_key, payload}。
 */
export function parseEdgeRequest(input) {
  if (!isPlainObject(input)) return fail('INVALID_REQUEST', '请求不是 JSON 对象。');
  if (input.schema_version !== G1_EDGE_SCHEMA_VERSION) {
    return fail('SCHEMA_VERSION_MISMATCH', '请求 schema_version 不是精确的 g1_generation_command_v1。');
  }
  const action = input.action;
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_ALLOWLIST, action)) {
    return fail('UNKNOWN_ACTION', `动作不在允许清单内，已 fail closed（${String(action || '').slice(0, 40)}）。`);
  }
  const allowed = ACTION_FIELDS[action];
  // idempotency_key 是 Harness 边界统一携带的幂等信封字段；仅 approve_submit
  // 使用并强制校验，其余动作忽略。
  const unknown = Object.keys(input).filter((key) => !['schema_version', 'action', 'idempotency_key', ...allowed].includes(key));
  if (unknown.length > 0) {
    return fail('UNKNOWN_FIELDS', `请求包含未知字段（${unknown.length} 个），已 fail closed。`, { action });
  }

  const payload = { ...input };
  delete payload.schema_version;
  delete payload.action;

  if (action === 'approve_submit') {
    const key = payload.idempotency_key;
    if (!isNonEmptyString(key) || key.length > MAX_IDEMPOTENCY_KEY) {
      return fail('IDEMPOTENCY_KEY_INVALID', '幂等键缺失或超长。');
    }
  }

  const projectId = boundedString(payload.project_id, 64);
  if (payload.project_id !== undefined) {
    if (!projectId || !PROJECT_ID_PATTERN.test(projectId)) return fail('PROJECT_ID_INVALID', '项目绑定格式无效，已拒绝。');
  }
  if (payload.mode !== undefined && !G1_MODES.includes(payload.mode)) {
    return fail('MODE_INVALID', 'mode 不在允许清单内（image / video_t2v / video_i2v）。');
  }
  if (payload.prompt !== undefined) {
    // 原始长度超限（截断会隐藏溢出）→ fail closed；trim 后为空同样拒绝。
    const prompt = boundedString(payload.prompt, MAX_PROMPT_CHARS);
    if (!prompt || prompt.length < 1) return fail('PROMPT_BOUNDS', 'prompt 必须在 1–2000 字符内。');
  }
  if (payload.negative_prompt !== undefined) {
    // 原始长度超限 → fail closed（0–500 字符；空字符串允许）。
    const negative = boundedString(payload.negative_prompt, MAX_NEGATIVE_PROMPT_CHARS);
    if (negative === null) return fail('NEGATIVE_PROMPT_BOUNDS', 'negative_prompt 必须在 0–500 字符内。');
  }
  if (payload.aspect_ratio !== undefined && !G1_ASPECT_RATIOS.includes(payload.aspect_ratio)) {
    return fail('ASPECT_RATIO_INVALID', 'aspect_ratio 不在允许清单内。');
  }
  if (payload.duration_seconds !== undefined) {
    if (typeof payload.duration_seconds !== 'number' || !Number.isSafeInteger(payload.duration_seconds)
      || payload.duration_seconds < 1 || payload.duration_seconds > MAX_DURATION_SECONDS) {
      return fail('DURATION_BOUNDS', 'duration_seconds 必须在 1–10 秒内。');
    }
  }
  if (payload.resolution !== undefined && !G1_RESOLUTIONS.includes(payload.resolution)) {
    return fail('RESOLUTION_INVALID', 'resolution 不在允许清单内（720p / 1080p）。');
  }
  if (payload.reference_asset_id !== undefined) {
    const reference = boundedString(payload.reference_asset_id, 64);
    if (!reference || !G1_REFERENCE_ASSET_PATTERN.test(reference)) {
      return fail('REFERENCE_ASSET_INVALID', 'reference_asset_id 必须是合法的素材 UUID。');
    }
  }
  // 知识卡身份兼容两种既有生成约定（kc- / card-）。
  const cards = boundedArray(payload.knowledge_card_ids, /^(kc|card)-[0-9a-f]{24}$/, 50, 'KNOWLEDGE_CARD_IDS');
  if (!cards.ok) return cards;
  const evidence = boundedArray(payload.evidence_ids, EVIDENCE_ID_PATTERN, 50, 'EVIDENCE_IDS');
  if (!evidence.ok) return evidence;
  if (payload.brief_id !== undefined) {
    const briefId = boundedString(payload.brief_id, 64);
    if (!briefId || !BRIEF_ID_PATTERN.test(briefId)) return fail('BRIEF_ID_INVALID', 'brief_id 格式无效，已拒绝。');
  }
  if (payload.job_id !== undefined && !G1_JOB_ID_PATTERN.test(String(payload.job_id || ''))) {
    return fail('JOB_ID_INVALID', 'job_id 格式无效，已拒绝。');
  }
  if (payload.artifact_id !== undefined && !G1_ARTIFACT_ID_PATTERN.test(String(payload.artifact_id || ''))) {
    return fail('ARTIFACT_ID_INVALID', 'artifact_id 格式无效，已拒绝。');
  }
  if (payload.quote_id !== undefined && !G1_QUOTE_ID_PATTERN.test(String(payload.quote_id || ''))) {
    return fail('QUOTE_ID_INVALID', 'quote_id 格式无效，已拒绝。');
  }
  for (const field of ['quote_fingerprint', 'request_fingerprint']) {
    if (payload[field] !== undefined && !SHA256_PATTERN.test(String(payload[field] || ''))) {
      return fail(`${field === 'quote_fingerprint' ? 'QUOTE' : 'REQUEST'}_FINGERPRINT_INVALID`, `${field} 必须是 64 位十六进制。`);
    }
  }
  if (payload.estimated_max_cost_cny !== undefined) {
    const max = Number(payload.estimated_max_cost_cny);
    if (!Number.isFinite(max) || max <= 0 || max > MAX_QUOTE_MAX_COST) {
      return fail('ESTIMATED_MAX_COST_INVALID', 'estimated_max_cost_cny 必须是有界正数。');
    }
  }
  if (payload.expires_at !== undefined) {
    const expires = new Date(String(payload.expires_at));
    if (Number.isNaN(expires.getTime())) return fail('APPROVAL_EXPIRY_INVALID', 'approval expires_at 不是合法时间。');
  }
  if (payload.source !== undefined && (typeof payload.source !== 'string' || !payload.source.trim() || payload.source.length > 40)) {
    return fail('APPROVAL_SOURCE_INVALID', 'approval source 必须是 1–40 字符。');
  }
  if (payload.expected_revision !== undefined
    && (typeof payload.expected_revision !== 'number' || !Number.isSafeInteger(payload.expected_revision) || payload.expected_revision < 1)) {
    return fail('EXPECTED_REVISION_INVALID', 'expected_revision 必须是正整数。');
  }
  if (payload.limit !== undefined) {
    if (typeof payload.limit !== 'number' || !Number.isSafeInteger(payload.limit) || payload.limit < 1 || payload.limit > 50) {
      return fail('LIMIT_INVALID', 'limit 必须在 1–50 之间。');
    }
  }
  return {
    ok: true,
    action,
    idempotency_key: action === 'approve_submit' ? payload.idempotency_key : null,
    payload,
  };
}

/**
 * 由已解析动作构造发送给 SQL 边界的 p_request（quote / approve_submit）。
 * 仅包含 SQL 边界认识的字段；缺省绑定由 SQL 从 Brief 精确引用集合派生。
 */
export function buildBoundaryRequest(parsed) {
  const source = parsed.payload;
  const request = {
    schema_version: G1_REQUEST_SCHEMA_VERSION,
    project_id: source.project_id,
    brief_id: source.brief_id,
    mode: source.mode,
    prompt: source.prompt,
  };
  for (const field of ['negative_prompt', 'duration_seconds', 'resolution', 'reference_asset_id']) {
    if (source[field] !== undefined) request[field] = source[field];
  }
  // 画幅：显式提供必须精确保留（恰好一次）；缺省按 mode 派生，与 SQL 边界
  // g1_normalize_request 的缺省一致（image → 1:1，video → 16:9）。
  if (source.aspect_ratio !== undefined) {
    request.aspect_ratio = source.aspect_ratio;
  } else if (G1_MODES.includes(source.mode)) {
    request.aspect_ratio = source.mode === 'image' ? '1:1' : '16:9';
  }
  if (Array.isArray(source.knowledge_card_ids)) request.knowledge_card_ids = source.knowledge_card_ids;
  if (Array.isArray(source.evidence_ids)) request.evidence_ids = source.evidence_ids;
  return request;
}

/** 由已解析动作构造 p_approval（仅 approve_submit；与 SQL 精确交叉校验）。 */
export function buildBoundaryApproval(parsed) {
  const source = parsed.payload;
  const approval = { quote_id: source.quote_id };
  if (source.quote_fingerprint !== undefined) approval.quote_fingerprint = source.quote_fingerprint;
  if (source.request_fingerprint !== undefined) approval.request_fingerprint = source.request_fingerprint;
  if (source.estimated_max_cost_cny !== undefined) approval.estimated_max_cost_cny = Number(source.estimated_max_cost_cny);
  if (source.expires_at !== undefined) approval.expires_at = new Date(source.expires_at).toISOString();
  approval.source = source.source || 'browser';
  return approval;
}

/**
 * 有界错误 → HTTP 状态映射。G1_QUOTE_STALE / G1_QUOTE_EXPIRED /
 * G1_PROJECT_REVISION_STALE / G1_IDEMPOTENCY_CONFLICT / G1_APPROVAL_MISMATCH
 * 是并发/绑定冲突（409-equivalent），绝不降级为 INTERNAL_ERROR（500）。
 */
export const BOUNDED_STATUS = Object.freeze({
  G1_QUOTE_STALE: 409,
  G1_QUOTE_EXPIRED: 409,
  G1_PROJECT_REVISION_STALE: 409,
  G1_IDEMPOTENCY_CONFLICT: 409,
  G1_APPROVAL_MISMATCH: 409,
  G1_BRIEF_REVISION_STALE: 409,
  G1_BINDING_MISMATCH: 409,
});

/**
 * 把 SQL 边界的 G1_<CODE> 异常映射为有界错误对象。完整代码必须保留（绝不剥离
 * G1_ 前缀或降级为 INTERNAL_ERROR）；取最后一次出现的代码；匹配有界
 * （≤80 字符，与 SQL p_code 上界一致）；未识别错误原样透传。
 */
export function mapBoundaryError(error) {
  const message = String(error instanceof Error ? error.message : error);
  const matches = [...message.matchAll(/G1_[A-Z0-9_]{1,77}/g)].map((matched) => matched[0]);
  const code = matches.at(-1);
  if (code) {
    const mapped = new Error(message);
    mapped.code = code;
    return mapped;
  }
  return error;
}

export function boundedDiagnosticsFrom(error) {
  return boundedDiagnostics([String(error?.message || error || '请求未能完成。').slice(0, MAX_DIAGNOSTIC_LENGTH)]);
}
