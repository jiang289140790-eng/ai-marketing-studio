// P30 content-core — 纯逻辑模块（无副作用，node:test 可直接导入）。
//
// 职责：
// - 请求解析与验证（JSON schema / 动作 / 字段长度）
// - Qwen/DashScope prompt 构造
// - 结构化响应解析与 schema 验证
// - 有界错误类（fail closed）
//
// 不执行任何 I/O、环境变量读取或数据库操作。

export const SCHEMA_VERSION = 'p30_content_create_v1';

export const ACTIONS = Object.freeze({
  STATUS: 'status',
  GENERATE_QUICK: 'generate_quick',
  GENERATE_FROM_BRIEF: 'generate_from_brief',
  REVISE: 'revise',
});

export const LIMITS = Object.freeze({
  MAX_INPUT_LENGTH: 500,
  MAX_REVISE_LENGTH: 500,
  MAX_TOKENS: 2000,
  TEMPERATURE: 0.2,
  TIMEOUT_MS: 60000,
  MAX_JSON_BYTES: 16000,
  MAX_NESTING_DEPTH: 6,
  MAX_ARRAY_ITEMS: 20,
});

export const ALLOWED_MODEL = 'qwen-plus';

const REQUIRED_OUTPUT_FIELDS = [
  'platform', 'audience', 'tone', 'content_goal',
  'hook', 'cta', 'main_copy', 'hashtags',
  'visual_type', 'visual_description', 'aspect_ratio',
];

const VALID_PLATFORMS = new Set([
  'x', 'instagram', 'tiktok', 'youtube', 'linkedin',
  'facebook', 'xiaohongshu', 'douyin', 'weibo', 'wechat',
]);

const VALID_VISUAL_TYPES = new Set([
  'single_image', 'carousel', 'short_video', 'long_video',
  'text_only', 'infographic',
]);

const VALID_ASPECT_RATIOS = new Set([
  '1:1', '4:5', '9:16', '16:9', '3:4', '4:3',
]);

const OUTPUT_STRING_LIMITS = Object.freeze({
  platform: 32,
  audience: 80,
  tone: 60,
  content_goal: 120,
  hook: 120,
  cta: 120,
  main_copy: 2000,
  visual_type: 32,
  visual_description: 500,
  aspect_ratio: 16,
});

function assertBoundedJson(value, code = 'PAYLOAD_OUT_OF_BOUNDS') {
  const seen = new WeakSet();
  function walk(node, depth) {
    if (depth > LIMITS.MAX_NESTING_DEPTH) throw new P30Error(code, '结构嵌套过深。', 400);
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) throw new P30Error(code, '结构不能包含循环引用。', 400);
    seen.add(node);
    const values = Array.isArray(node) ? node : Object.values(node);
    if (values.length > LIMITS.MAX_ARRAY_ITEMS) throw new P30Error(code, '结构项目数量超限。', 400);
    values.forEach((item) => walk(item, depth + 1));
  }
  walk(value, 0);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new P30Error(code, '结构无法序列化。', 400); }
  if (new globalThis.TextEncoder().encode(serialized).length > LIMITS.MAX_JSON_BYTES) {
    throw new P30Error(code, '结构总大小超限。', 400);
  }
  return value;
}

export class P30Error extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'P30Error';
    this.code = code;
    this.status = status;
  }
}

/**
 * 解析并验证请求正文；对未知字段、畸形 JSON、超长输入 fail closed。
 */
export function parseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new P30Error('INVALID_BODY', '请求正文必须为 JSON 对象。', 400);
  }

  const action = String(body.action || '').trim().toLowerCase();
  if (!Object.values(ACTIONS).includes(action)) {
    throw new P30Error('UNKNOWN_ACTION', `不支持的动作：${action || '(空)'}。有效值：status, generate_quick, generate_from_brief, revise。`, 400);
  }

  const result = { action };

  // 检查未知顶层字段（只在非 status 动作时严格检查）
  const knownFields = new Set([
    'action', 'input_text', 'previous_version', 'revision_feedback',
    'brief_id', 'brief_version', 'brief_fingerprint',
    'brief_target_audience', 'brief_channels', 'brief_constraints',
    'brief_summary', 'schema_version',
  ]);

  const unknown = Object.keys(body).filter((k) => !knownFields.has(k));
  if (unknown.length > 0 && action !== ACTIONS.STATUS) {
    throw new P30Error('UNKNOWN_FIELDS', `请求包含未知字段：${unknown.join(', ')}。`, 400);
  }

  if (action === ACTIONS.STATUS) {
    return result;
  }

  // validate schema_version if provided
  if (body.schema_version !== undefined && body.schema_version !== SCHEMA_VERSION) {
    throw new P30Error('SCHEMA_VERSION_MISMATCH', `schema_version 不匹配，期望 ${SCHEMA_VERSION}。`, 400);
  }

  if (action === ACTIONS.GENERATE_QUICK) {
    const text = String(body.input_text || '').trim();
    if (!text) {
      throw new P30Error('INPUT_REQUIRED', '请输入你想要生成的内容需求。', 400);
    }
    if (text.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new P30Error('INPUT_TOO_LONG', `输入不能超过 ${LIMITS.MAX_INPUT_LENGTH} 个字符。`, 400);
    }
    result.input_text = text;
    if (body.previous_version !== undefined && body.previous_version !== null) {
      if (!body.previous_version || typeof body.previous_version !== 'object' || Array.isArray(body.previous_version)) {
        throw new P30Error('PREVIOUS_VERSION_INVALID', '上一版本必须是有界对象。', 400);
      }
      assertBoundedJson(body.previous_version, 'PREVIOUS_VERSION_OUT_OF_BOUNDS');
    }
    result.previous_version = body.previous_version || null;
  }

  if (action === ACTIONS.GENERATE_FROM_BRIEF) {
    if (!body.brief_id) {
      throw new P30Error('BRIEF_REQUIRED', '必须提供 brief_id。', 400);
    }
    const briefVersion = Number(body.brief_version);
    if (!Number.isInteger(briefVersion) || briefVersion < 1) {
      throw new P30Error('BRIEF_VERSION_REQUIRED', '必须提供有效的 brief_version。', 400);
    }
    const briefFingerprint = String(body.brief_fingerprint || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(briefFingerprint)) {
      throw new P30Error('BRIEF_FINGERPRINT_REQUIRED', '必须提供有效的 brief_fingerprint。', 400);
    }
    result.brief_id = String(body.brief_id);
    result.brief_version = briefVersion;
    result.brief_fingerprint = briefFingerprint;
  }

  if (action === ACTIONS.REVISE) {
    const feedback = String(body.revision_feedback || '').trim();
    if (!feedback) {
      throw new P30Error('REVISION_FEEDBACK_REQUIRED', '请提供修改意见。', 400);
    }
    if (feedback.length > LIMITS.MAX_REVISE_LENGTH) {
      throw new P30Error('REVISION_TOO_LONG', `修改意见不能超过 ${LIMITS.MAX_REVISE_LENGTH} 个字符。`, 400);
    }
    result.revision_feedback = feedback;
    if (!body.previous_version || typeof body.previous_version !== 'object') {
      throw new P30Error('PREVIOUS_VERSION_REQUIRED', '修改必须提供前一版本内容。', 400);
    }
    assertBoundedJson(body.previous_version, 'PREVIOUS_VERSION_OUT_OF_BOUNDS');
    result.previous_version = body.previous_version;
  }

  return result;
}

/**
 * 构造发送给 Qwen 的 prompt。
 */
export function buildQuickPrompt(inputText, previousVersion = null) {
  const basePrompt = `你是一个专业的内容营销助手。根据用户的一句话需求，生成一条完整的内容营销文案和视觉方案。

用户需求：${inputText}

请以 JSON 格式返回以下字段（所有字段必填）：
- platform: 推荐发布平台（x/instagram/tiktok/youtube/linkedin/facebook/xiaohongshu/douyin/weibo/wechat 之一）
- audience: 目标受众描述（中文，20字以内）
- tone: 语气/风格（中文，15字以内）
- content_goal: 内容目标（中文，30字以内）
- hook: 开头钩子（中文，80字以内）
- cta: 行动引导（中文，40字以内）
- main_copy: 主文案（中文，300字以内）
- hashtags: 标签数组（3-5个，以#开头）
- visual_type: 视觉类型（single_image/carousel/short_video/long_video/text_only/infographic 之一）
- visual_description: 视觉描述（中文，100字以内）
- aspect_ratio: 推荐画幅（1:1/4:5/9:16/16:9/3:4 之一）
- candidates: 候选版本数组，包含最多 2 个备选文案，每个包含 hook、copy、cta 字段`;

  if (previousVersion) {
    return `${basePrompt}

前一版本内容（请在此基础上根据以下反馈进行修改）：
${JSON.stringify(previousVersion, null, 2)}

请仔细考虑修改意见，只修改相关部分，保留其他内容的连贯性。返回完整的 JSON 结果。`;
  }

  return basePrompt;
}

/**
 * 构造从 Brief 生成的 prompt。
 */
export function buildBriefPrompt(briefData) {
  assertBoundedJson(briefData, 'BRIEF_PAYLOAD_OUT_OF_BOUNDS');
  return `你是一个专业的内容营销助手。根据以下创意简报，生成一条完整的内容营销文案和视觉方案。

创意简报：
- 主题：${briefData.brief_topic || '未指定'}
- 目标：${briefData.brief_objective || '未指定'}
- 目标受众：${briefData.brief_target_audience || '未指定'}
- 发布渠道：${briefData.brief_channels || '未指定'}
- 约束条件：${briefData.brief_constraints || '未指定'}
- 简报摘要：${briefData.brief_summary || '未指定'}
- 结构指导：${JSON.stringify(briefData.structural_guidance || [])}
- 知识引用 ID：${JSON.stringify(briefData.knowledge_citation_ids || [])}
- 证据来源：${JSON.stringify(briefData.evidence_provenance || {})}

请以 JSON 格式返回以下字段（所有字段必填）：
- platform: 推荐发布平台
- audience: 目标受众描述（中文，20字以内）
- tone: 语气/风格（中文，15字以内）
- content_goal: 内容目标（中文，30字以内）
- hook: 开头钩子（中文，80字以内）
- cta: 行动引导（中文，40字以内）
- main_copy: 主文案（中文，300字以内）
- hashtags: 标签数组（3-5个，以#开头）
- visual_type: 视觉类型
- visual_description: 视觉描述（中文，100字以内）
- aspect_ratio: 推荐画幅
- candidates: 候选版本数组，包含最多 2 个备选文案`;
}

/**
 * 严格验证 AI 返回的结构化 JSON。
 * 字段缺失、类型错误、枚举值非法均 fail closed。
 */
export function validateGeneratedContent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new P30Error('INVALID_MODEL_RESPONSE', 'AI 返回了无效的响应格式。', 502);
  }
  try {
    assertBoundedJson(raw, 'MODEL_RESPONSE_OUT_OF_BOUNDS');
  } catch (error) {
    if (error instanceof P30Error) throw new P30Error(error.code, error.message, 502);
    throw error;
  }

  const allowedOutput = new Set([...REQUIRED_OUTPUT_FIELDS, 'candidates']);
  const unknownOutput = Object.keys(raw).filter((key) => !allowedOutput.has(key));
  if (unknownOutput.length) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 响应包含未知字段：${unknownOutput.join(', ')}。`, 502);
  }

  const missing = REQUIRED_OUTPUT_FIELDS.filter((f) => raw[f] === undefined || raw[f] === null);
  if (missing.length > 0) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 响应缺少必需字段：${missing.join(', ')}。`, 502);
  }

  // 类型检查
  const stringFields = ['platform', 'audience', 'tone', 'content_goal', 'hook', 'cta', 'main_copy', 'visual_type', 'visual_description', 'aspect_ratio'];
  for (const f of stringFields) {
    if (typeof raw[f] !== 'string' || !raw[f].trim() || raw[f].length > OUTPUT_STRING_LIMITS[f]) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 响应字段 ${f} 类型错误（期望字符串）。`, 502);
    }
  }

  if (!Array.isArray(raw.hashtags)) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', 'AI 响应字段 hashtags 类型错误（期望数组）。', 502);
  }
  if (raw.hashtags.length < 1 || raw.hashtags.length > 5 || raw.hashtags.some((tag) => (
    typeof tag !== 'string' || !tag.trim() || tag.length > 50 || !tag.startsWith('#')
  ))) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', 'hashtags 必须包含 1-5 个有界 #标签。', 502);
  }

  // 枚举验证
  if (!VALID_PLATFORMS.has(raw.platform.toLowerCase())) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 返回了不支持的平台：${raw.platform}`, 502);
  }

  if (!VALID_VISUAL_TYPES.has(raw.visual_type.toLowerCase())) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 返回了不支持的视觉类型：${raw.visual_type}`, 502);
  }

  if (!VALID_ASPECT_RATIOS.has(raw.aspect_ratio.toLowerCase())) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 返回了不支持的画幅：${raw.aspect_ratio}`, 502);
  }

  // 长度检查
  if (!Array.isArray(raw.candidates) || raw.candidates.length > 2) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', 'candidates 必须是最多 2 项的数组。', 502);
  }
  const candidates = raw.candidates.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', '候选版本格式无效。', 502);
    }
    const keys = Object.keys(candidate);
    if (keys.some((key) => !['hook', 'copy', 'cta'].includes(key))) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', '候选版本包含未知字段。', 502);
    }
    for (const [key, max] of [['hook', 120], ['copy', 2000], ['cta', 120]]) {
      if (typeof candidate[key] !== 'string' || !candidate[key].trim() || candidate[key].length > max) {
        throw new P30Error('MODEL_SCHEMA_VIOLATION', `候选版本字段 ${key} 无效。`, 502);
      }
    }
    return { hook: candidate.hook, copy: candidate.copy, cta: candidate.cta };
  });

  return {
    platform: raw.platform,
    audience: raw.audience,
    tone: raw.tone,
    content_goal: raw.content_goal,
    hook: raw.hook,
    cta: raw.cta,
    main_copy: raw.main_copy,
    hashtags: [...raw.hashtags],
    visual_type: raw.visual_type,
    visual_description: raw.visual_description,
    aspect_ratio: raw.aspect_ratio,
    candidates,
  };
}

/**
 * 脱敏错误消息：去掉 Token、Secret、JWT、URL、原始模型响应。
 */
export function sanitizeError(error) {
  if (error instanceof P30Error) {
    return { code: error.code, message: error.message, status: error.status };
  }

  const message = String(error?.message || error || '服务内部异常');

  // 脱敏：隐藏常见敏感模式
  const sanitized = message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[a-zA-Z0-9]+/g, '[REDACTED]')
    .replace(/Authorization[=:]\s*\S+/gi, 'Authorization=[REDACTED]')
    .replace(/https?:\/\/\S+/g, '[URL_REDACTED]')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '[TOKEN_REDACTED]');

  return {
    code: 'INTERNAL_ERROR',
    message: `服务内部异常：${sanitized.slice(0, 200)}`,
    status: 500,
  };
}

/**
 * 验证周期持续时间
 */
export function validateCycleDuration(days) {
  const num = Number(days);
  if (!Number.isFinite(num) || num < 1 || num > 30) {
    throw new P30Error('INVALID_CYCLE', '周期天数必须在 1-30 之间。', 400);
  }
  return num;
}

/**
 * 生成摘要行（用于快速显示）
 */
export function formatSummaryLine(result) {
  return `${result.platform} / ${result.audience} / ${result.tone} / ${result.visual_type === 'single_image' ? '单图' : result.visual_type === 'short_video' ? '短视频' : result.visual_type}`;
}
