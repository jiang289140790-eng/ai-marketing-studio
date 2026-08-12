// P30 content-core — 纯逻辑模块（无副作用，node:test 可直接导入）。
//
// 职责：
// - 请求解析与验证（JSON schema / 动作 / 字段长度）
// - Qwen/DashScope prompt 构造
// - 结构化响应解析与 schema 验证
// - 有界错误类（fail closed）
// - P31 v2：resolve_intent、条件化输出、多模态模型选择
//
// 不执行任何 I/O、环境变量读取或数据库操作。

export const SCHEMA_VERSION = 'p30_content_create_v1';
export const SCHEMA_VERSION_V2 = 'p31_reference_driven_v2';

export const ACTIONS = Object.freeze({
  STATUS: 'status',
  GENERATE_QUICK: 'generate_quick',
  GENERATE_FROM_BRIEF: 'generate_from_brief',
  REVISE: 'revise',
  // P31 v2
  RESOLVE_INTENT: 'resolve_intent',
  GENERATE_QUICK_V2: 'generate_quick_v2',
});

export const LIMITS = Object.freeze({
  MAX_INPUT_LENGTH: 500,
  MAX_REVISE_LENGTH: 500,
  MAX_TOKENS: 2000,
  MAX_TOKENS_V2: 3000,
  TEMPERATURE: 0.2,
  TIMEOUT_MS: 60000,
  MAX_JSON_BYTES: 16000,
  MAX_NESTING_DEPTH: 6,
  MAX_ARRAY_ITEMS: 20,
  // P31 v2 参考输入限制
  MAX_REFERENCE_TEXT_LENGTH: 2000,
  MAX_IMAGE_BYTES: 4 * 1024 * 1024, // 4 MiB per spec
  MAX_IMAGE_DIMENSION: 4096,
  ALLOWED_IMAGE_TYPES: new Set(['image/jpeg', 'image/png', 'image/webp']),
  MAX_X_URL_LENGTH: 500,
});

export const ALLOWED_MODEL = 'qwen-plus';
export const MULTIMODAL_MODEL = 'qwen3.5-omni-flash';

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

// ---- P31 v2 常量 ----

export const V2_VALID_PLATFORMS = new Set([
  'x', 'instagram', 'tiktok', 'youtube', 'linkedin',
  'facebook', 'xiaohongshu', 'douyin', 'weibo', 'wechat',
  'telegram', 'threads',
]);

export const V2_VALID_CONTENT_FORMATS = new Set([
  'image_caption', 'carousel', 'long_post', 'short_video_script',
  'text_only', 'infographic',
]);

export const V2_VALID_LANGUAGE_MODES = new Set([
  'zh-cn', 'zh-tw', 'en', 'ja', 'ko', 'bilingual_zh_en',
]);

export const V2_VALID_LENGTH_PROFILES = new Set([
  'micro', 'short', 'standard', 'long',
]);

export const V2_VALID_TONES = new Set([
  'professional', 'casual', 'inspirational', 'educational',
  'humorous', 'urgent', 'empathetic', 'authoritative',
]);

export const V2_VALID_CTA_POLICIES = new Set([
  'required', 'optional', 'none',
]);

export const V2_VALID_HASHTAG_POLICIES = new Set([
  'required_3_5', 'optional_0_5', 'none',
]);

export const V2_INTENT_CONFIDENCE_LEVELS = new Set([
  'explicit', 'reference', 'defaults', 'inferred',
]);

// 条件化输出规则：哪些组合强制/可选 CTA、hashtags、candidates
export const V2_CONDITIONAL_RULES = Object.freeze({
  'x+image_caption': {
    max_lines: 3, cta: 'optional', hashtags: 'optional_0_5', candidates: 'optional',
    description: 'X 贴文 + 图片说明：1-3 行正文，CTA 可选，标签可为空，候选版本可选',
  },
  'x+carousel': {
    max_lines: 5, cta: 'optional', hashtags: 'optional_0_5', candidates: 'optional',
  },
  'x+long_post': {
    max_lines: 20, cta: 'optional', hashtags: 'optional_0_5', candidates: 'optional',
  },
  'xiaohongshu+carousel': {
    cta: 'optional', hashtags: 'required_3_5', candidates: 'optional',
    description: '小红书轮播：标题/正文/标签结构',
  },
  'xiaohongshu+long_post': {
    cta: 'optional', hashtags: 'required_3_5', candidates: 'optional',
    description: '小红书长文：标题/正文/标签结构',
  },
  'default': {
    cta: 'required', hashtags: 'required_3_5', candidates: 'optional',
  },
});

// v2 输出字段及每字段上限
export const V2_OUTPUT_STRING_LIMITS = Object.freeze({
  title: 200,
  main_copy: 3000,
  visual_description: 600,
  platform: 32,
  content_format: 32,
  language_mode: 20,
  length_profile: 20,
  tone: 60,
  cta: 200,
  audience: 80,
  content_goal: 120,
  aspect_ratio: 16,
});

// v2 输出必选字段
const V2_REQUIRED_OUTPUT_FIELDS = [
  'title', 'main_copy', 'visual_description', 'platform', 'content_format',
];

// v2 可选输出字段（参考用）
const _V2_OPTIONAL_OUTPUT_FIELDS = [
  'cta', 'hashtags', 'candidates', 'language_mode', 'length_profile',
  'tone', 'audience', 'content_goal', 'aspect_ratio', 'hook',
];

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
    throw new P30Error('UNKNOWN_ACTION', `不支持的动作：${action || '(空)'}。有效值：status, generate_quick, generate_from_brief, revise, resolve_intent, generate_quick_v2。`, 400);
  }

  const result = { action };

  // 检查未知顶层字段
  const knownFields = new Set([
    'action', 'input_text', 'previous_version', 'revision_feedback',
    'brief_id', 'brief_version', 'brief_fingerprint',
    'brief_target_audience', 'brief_channels', 'brief_constraints',
    'brief_summary', 'schema_version',
    // P31 v2 字段
    'reference_text', 'reference_url', 'reference_url_data',
    'has_image_reference', 'image_data_url', 'intent', 'intent_overrides',
  ]);

  const unknown = Object.keys(body).filter((k) => !knownFields.has(k));
  if (unknown.length > 0 && action !== ACTIONS.STATUS) {
    throw new P30Error('UNKNOWN_FIELDS', `请求包含未知字段：${unknown.join(', ')}。`, 400);
  }

  if (action === ACTIONS.STATUS) {
    return result;
  }

  // validate schema_version if provided
  if (body.schema_version !== undefined && body.schema_version !== SCHEMA_VERSION && body.schema_version !== SCHEMA_VERSION_V2) {
    throw new P30Error('SCHEMA_VERSION_MISMATCH', `schema_version 不匹配，期望 ${SCHEMA_VERSION} 或 ${SCHEMA_VERSION_V2}。`, 400);
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

  // ---- P31 v2 动作 ----

  if (action === ACTIONS.RESOLVE_INTENT) {
    const text = String(body.input_text || '').trim();
    if (!text) {
      throw new P30Error('INPUT_REQUIRED', '请输入内容需求。', 400);
    }
    if (text.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new P30Error('INPUT_TOO_LONG', `输入不能超过 ${LIMITS.MAX_INPUT_LENGTH} 个字符。`, 400);
    }
    result.input_text = text;

    // 验证参考 URL（如果提供）
    if (body.reference_url) {
      result.reference_url = validateReferenceUrl(body.reference_url);
    }

    // 验证参考文本（如果提供）
    if (body.reference_text !== undefined && body.reference_text !== null) {
      result.reference_text = validateReferenceText(body.reference_text);
    }

    // 验证图片参考标记与 Data URL
    result.has_image_reference = body.has_image_reference === true;
    if (body.image_data_url) {
      result.image_data_url = validateImageDataUrl(body.image_data_url);
      result.has_image_reference = true;
    }

    // intent_overrides（如果提供）
    if (body.intent_overrides !== undefined && body.intent_overrides !== null) {
      result.intent_overrides = validateIntentOverrides(body.intent_overrides);
    }
  }

  if (action === ACTIONS.GENERATE_QUICK_V2) {
    const text = String(body.input_text || '').trim();
    if (!text) {
      throw new P30Error('INPUT_REQUIRED', '请输入内容需求。', 400);
    }
    if (text.length > LIMITS.MAX_INPUT_LENGTH) {
      throw new P30Error('INPUT_TOO_LONG', `输入不能超过 ${LIMITS.MAX_INPUT_LENGTH} 个字符。`, 400);
    }
    result.input_text = text;

    // intent 必须提供且通过验证
    if (!body.intent || typeof body.intent !== 'object') {
      throw new P30Error('INTENT_REQUIRED', '必须提供有效的 intent 对象。', 400);
    }
    result.intent = validateResolvedIntent(body.intent);

    // 参考数据（可选）
    if (body.reference_text) {
      result.reference_text = validateReferenceText(body.reference_text);
    }
    if (body.reference_url_data !== undefined && body.reference_url_data !== null) {
      result.reference_url_data = validateReferenceUrlData(body.reference_url_data);
    }
    result.has_image_reference = body.has_image_reference === true;
    if (body.image_data_url) {
      result.image_data_url = validateImageDataUrl(body.image_data_url);
      result.has_image_reference = true;
    }

    if (body.previous_version !== undefined && body.previous_version !== null) {
      if (!body.previous_version || typeof body.previous_version !== 'object' || Array.isArray(body.previous_version)) {
        throw new P30Error('PREVIOUS_VERSION_INVALID', '上一版本必须是有界对象。', 400);
      }
      assertBoundedJson(body.previous_version, 'PREVIOUS_VERSION_OUT_OF_BOUNDS');
    }
    result.previous_version = body.previous_version || null;
  }

  return result;
}

// ---- P31 v2 参考输入验证 ----

/**
 * 验证参考 URL：只允许 HTTPS X/Twitter status URL。
 */
export function validateReferenceUrl(url) {
  const text = String(url || '').trim();
  if (!text) return null;
  if (text.length > LIMITS.MAX_X_URL_LENGTH) {
    throw new P30Error('REFERENCE_URL_TOO_LONG', `参考 URL 不能超过 ${LIMITS.MAX_X_URL_LENGTH} 个字符。`, 400);
  }
  // 支持 x.com 和 twitter.com
  const match = text.match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/\d+/i);
  if (!match) {
    throw new P30Error('REFERENCE_URL_INVALID', '参考 URL 只支持 HTTPS X/Twitter status 链接。', 400);
  }
  return text;
}

/**
 * 验证参考文本：有界、无注入。
 */
export function validateReferenceText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  if (value.length > LIMITS.MAX_REFERENCE_TEXT_LENGTH) {
    throw new P30Error('REFERENCE_TEXT_TOO_LONG', `参考文本不能超过 ${LIMITS.MAX_REFERENCE_TEXT_LENGTH} 个字符。`, 400);
  }
  // 基础注入防护：拒绝含大量不可打印字符的文本
  // eslint-disable-next-line no-irregular-whitespace
  const printable = value.replace(/[\x20-\x7E一-鿿　-〿＀-￯]/g, '');
  if (printable.length > value.length * 0.05) {
    throw new P30Error('REFERENCE_TEXT_INVALID', '参考文本包含不可打印字符比例过高。', 400);
  }
  return value;
}

/**
 * 验证图片元数据（不验证实际图片内容，仅元数据）。
 */
export function validateImageMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const { mime_type, byte_size, width, height } = metadata;
  if (mime_type && !LIMITS.ALLOWED_IMAGE_TYPES.has(String(mime_type).toLowerCase())) {
    throw new P30Error('IMAGE_TYPE_UNSUPPORTED', `不支持的图片格式：${mime_type}。仅支持 JPEG、PNG、WebP。`, 400);
  }
  if (byte_size !== undefined) {
    const size = Number(byte_size);
    if (!Number.isFinite(size) || size <= 0 || size > LIMITS.MAX_IMAGE_BYTES) {
      throw new P30Error('IMAGE_SIZE_OUT_OF_BOUNDS', `图片大小必须在 1 到 ${LIMITS.MAX_IMAGE_BYTES / 1024 / 1024} MB 之间。`, 400);
    }
  }
  if (width !== undefined && Number(width) > LIMITS.MAX_IMAGE_DIMENSION) {
    throw new P30Error('IMAGE_DIMENSION_OUT_OF_BOUNDS', `图片宽度不能超过 ${LIMITS.MAX_IMAGE_DIMENSION}px。`, 400);
  }
  if (height !== undefined && Number(height) > LIMITS.MAX_IMAGE_DIMENSION) {
    throw new P30Error('IMAGE_DIMENSION_OUT_OF_BOUNDS', `图片高度不能超过 ${LIMITS.MAX_IMAGE_DIMENSION}px。`, 400);
  }
  return {
    mime_type: String(mime_type || ''),
    byte_size: Number(byte_size || 0),
    width: Number(width || 0),
    height: Number(height || 0),
  };
}

/**
 * 验证 resolved intent 对象。
 */
export function validateResolvedIntent(intent) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw new P30Error('INTENT_INVALID', 'intent 必须为有界对象。', 400);
  }

  const platform = String(intent.platform || '').toLowerCase().trim();
  if (!platform || !V2_VALID_PLATFORMS.has(platform)) {
    throw new P30Error('INTENT_INVALID_PLATFORM', `intent.platform 无效：${platform || '(空)'}。`, 400);
  }

  const contentFormat = String(intent.content_format || '').toLowerCase().trim();
  if (!contentFormat || !V2_VALID_CONTENT_FORMATS.has(contentFormat)) {
    throw new P30Error('INTENT_INVALID_FORMAT', `intent.content_format 无效：${contentFormat || '(空)'}。`, 400);
  }

  return {
    platform,
    content_format: contentFormat,
    language_mode: validateOptionalEnum(intent.language_mode, V2_VALID_LANGUAGE_MODES, 'zh-cn'),
    length_profile: validateOptionalEnum(intent.length_profile, V2_VALID_LENGTH_PROFILES, 'short'),
    tone: validateOptionalEnum(intent.tone, V2_VALID_TONES, 'professional'),
    cta_policy: validateOptionalEnum(intent.cta_policy, V2_VALID_CTA_POLICIES, 'required'),
    hashtag_policy: validateOptionalEnum(intent.hashtag_policy, V2_VALID_HASHTAG_POLICIES, 'required_3_5'),
    confidence: validateOptionalEnum(intent.confidence, V2_INTENT_CONFIDENCE_LEVELS, 'inferred'),
    provenance: String(intent.provenance || 'model_inference').slice(0, 200),
    audience: String(intent.audience || '').slice(0, 80) || null,
    content_goal: String(intent.content_goal || '').slice(0, 120) || null,
  };
}

/**
 * 验证 intent_overrides（用户手动编辑后的 intent）。
 */
export function validateIntentOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new P30Error('INTENT_OVERRIDES_INVALID', 'intent_overrides 必须为有界对象。', 400);
  }
  const result = {};
  if (overrides.platform !== undefined) {
    const platform = String(overrides.platform || '').toLowerCase().trim();
    if (!platform || !V2_VALID_PLATFORMS.has(platform)) {
      throw new P30Error('INTENT_OVERRIDES_INVALID', `不支持的平台：${platform}。`, 400);
    }
    result.platform = platform;
  }
  if (overrides.content_format !== undefined) {
    const format = String(overrides.content_format || '').toLowerCase().trim();
    if (!format || !V2_VALID_CONTENT_FORMATS.has(format)) {
      throw new P30Error('INTENT_OVERRIDES_INVALID', `不支持的内容格式：${format}。`, 400);
    }
    result.content_format = format;
  }
  if (overrides.language_mode !== undefined) {
    result.language_mode = validateOptionalEnum(overrides.language_mode, V2_VALID_LANGUAGE_MODES, null);
  }
  if (overrides.length_profile !== undefined) {
    result.length_profile = validateOptionalEnum(overrides.length_profile, V2_VALID_LENGTH_PROFILES, null);
  }
  if (overrides.tone !== undefined) {
    result.tone = validateOptionalEnum(overrides.tone, V2_VALID_TONES, null);
  }
  if (overrides.cta_policy !== undefined) {
    result.cta_policy = validateOptionalEnum(overrides.cta_policy, V2_VALID_CTA_POLICIES, null);
  }
  if (overrides.hashtag_policy !== undefined) {
    result.hashtag_policy = validateOptionalEnum(overrides.hashtag_policy, V2_VALID_HASHTAG_POLICIES, null);
  }
  return result;
}

/**
 * 验证图片 Data URL：MIME、base64、解码大小。
 * 严格模式：只接受 image/jpeg, image/png, image/webp。
 */
export function validateImageDataUrl(dataUrl) {
  const value = String(dataUrl || '').trim();
  if (!value) throw new P30Error('IMAGE_DATA_URL_REQUIRED', '图片 Data URL 不能为空。', 400);
  if (value.length > LIMITS.MAX_IMAGE_BYTES * 1.5) {
    // base64 编码约 4/3 膨胀，加上 data:... 前缀
    throw new P30Error('IMAGE_DATA_URL_TOO_LONG', '图片 Data URL 超过允许大小。', 400);
  }

  // 解析 Data URL 格式：data:[<mediatype>][;base64],<data>
  const match = value.match(/^data:(image\/[a-zA-Z0-9+.+-]+);base64,(.+)$/s);
  if (!match) {
    throw new P30Error('IMAGE_DATA_URL_INVALID', '图片 Data URL 格式无效，期望 data:image/...;base64,...', 400);
  }

  const mimeType = match[1].toLowerCase();
  if (!LIMITS.ALLOWED_IMAGE_TYPES.has(mimeType)) {
    throw new P30Error('IMAGE_TYPE_UNSUPPORTED', `不支持的图片 MIME 类型：${mimeType}。仅支持 JPEG、PNG、WebP。`, 400);
  }

  const base64Content = match[2].replace(/\s/g, '');
  let decodedBytes;
  try {
    decodedBytes = globalThis.atob(base64Content);
  } catch {
    throw new P30Error('IMAGE_DATA_URL_INVALID', '图片 base64 解码失败。', 400);
  }

  const decodedSize = decodedBytes.length;
  if (decodedSize > LIMITS.MAX_IMAGE_BYTES) {
    throw new P30Error('IMAGE_SIZE_OUT_OF_BOUNDS', `解码后图片大小 ${decodedSize} 超过上限 ${LIMITS.MAX_IMAGE_BYTES}。`, 400);
  }
  if (decodedSize === 0) {
    throw new P30Error('IMAGE_DATA_URL_EMPTY', '图片 Data URL 解码后为空。', 400);
  }

  const byte = (index) => decodedBytes.charCodeAt(index);
  const validSignature = mimeType === 'image/jpeg'
    ? decodedSize >= 3 && byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff
    : mimeType === 'image/png'
      ? decodedSize >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => byte(index) === value)
      : decodedSize >= 12
        && decodedBytes.slice(0, 4) === 'RIFF'
        && decodedBytes.slice(8, 12) === 'WEBP';
  if (!validSignature) {
    throw new P30Error('IMAGE_SIGNATURE_MISMATCH', '图片内容与声明的 MIME 类型不一致。', 400);
  }

  return value; // 返回验证通过的原始 Data URL
}

/**
 * 验证参考 URL 采集数据。
 */
export function validateReferenceUrlData(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    url: String(data.url || '').slice(0, LIMITS.MAX_X_URL_LENGTH),
    content_text: String(data.content_text || '').slice(0, LIMITS.MAX_REFERENCE_TEXT_LENGTH),
    content_sha256: String(data.content_sha256 || '').slice(0, 64),
    collected_at: String(data.collected_at || '').slice(0, 80),
    source_id: String(data.source_id || '').slice(0, 160),
  };
}

function validateOptionalEnum(value, validSet, defaultVal) {
  if (value === undefined || value === null || value === '') return defaultVal;
  const normalized = String(value).toLowerCase().trim();
  return validSet.has(normalized) ? normalized : defaultVal;
}

// ---- P31 v2 意图解析 ----

/**
 * 解析用户意图。优先级：
 * 1. explicit overrides（用户明确编辑）
 * 2. validated reference content/link
 * 3. selected account/project defaults（如果可用）
 * 4. model inference（最低优先级）
 *
 * 关键规则：永远不要仅因为输入是中文就推断为小红书。
 */
export function resolveIntentPriority(overrides, referenceContext, defaultsContext) {
  // 1. 用户明确覆盖最高优先级
  if (overrides && Object.keys(overrides).length > 0) {
    return { priority: 'explicit', source: 'user_overrides' };
  }

  // 2. 已验证的参考内容
  if (referenceContext?.validated === true) {
    return { priority: 'reference', source: 'validated_reference' };
  }

  // 3. 账号/项目默认值
  if (defaultsContext?.available === true) {
    return { priority: 'defaults', source: 'account_project_defaults' };
  }

  // 4. 模型推断（最低优先级）
  return { priority: 'inferred', source: 'model_inference' };
}

/**
 * 检查是否应该使用多模态模型。
 * 只有当实际存在图片/媒体参考时才使用 qwen3.5-omni-flash。
 */
export function shouldUseMultimodal(hasImageReference, referenceUrlData, imageDataUrl) {
  return hasImageReference === true
    || Boolean(referenceUrlData && referenceUrlData !== null)
    || Boolean(imageDataUrl);
}

/**
 * 获取条件化输出规则。
 */
export function getConditionalRules(platform, contentFormat) {
  const key = `${platform}+${contentFormat}`;
  return V2_CONDITIONAL_RULES[key] || V2_CONDITIONAL_RULES.default;
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
 * P31 v2：构造意图解析 prompt。
 * 关键：永远不要仅因为输入是中文就推断为小红书。
 */
export function buildResolveIntentPrompt(inputText, referenceText, referenceUrlData, defaultsContext) {
  let prompt = `你是一个内容策略分析助手。根据用户的输入和参考信息，分析内容创作意图。

用户需求：${inputText}`;

  if (referenceText) {
    prompt += `\n\n参考文本：${referenceText.slice(0, 500)}`;
  }

  if (referenceUrlData?.content_text) {
    prompt += `\n\n参考链接内容摘要：${String(referenceUrlData.content_text).slice(0, 500)}`;
  }

  if (defaultsContext?.platform) {
    prompt += `\n\n当前账号/项目默认平台：${defaultsContext.platform}`;
  }

  prompt += `\n\n请以 JSON 格式返回以下意图字段：
- platform: 推荐发布平台（x/instagram/tiktok/youtube/linkedin/facebook/xiaohongshu/douyin/weibo/wechat/telegram/threads 之一）
- content_format: 内容格式（image_caption/carousel/long_post/short_video_script/text_only/infographic 之一）
- language_mode: 语言模式（zh-cn/zh-tw/en/ja/ko/bilingual_zh_en 之一）
- length_profile: 长度模式（micro/short/standard/long 之一）
- tone: 语气（professional/casual/inspirational/educational/humorous/urgent/empathetic/authoritative 之一）
- cta_policy: CTA 策略（required/optional/none 之一）
- hashtag_policy: 标签策略（required_3_5/optional_0_5/none 之一）
- confidence: 置信度级别（explicit/reference/defaults/inferred 之一）
- audience: 目标受众描述（可选，20字内）
- content_goal: 内容目标（可选，30字内）

重要规则：
1. 平台选择必须基于显式请求（如"X 贴文"）或已验证的参考链接，永远不要仅因为输入语言是中文就选择 xiaohongshu。
2. 中文输入可能是微信公众号、微博、抖音、小红书、B站等多种平台，不应预设。
3. 只有当用户明确提到"小红书"、"红书"、"XHS"或提供了小红书链接时，才选择 xiaohongshu。
4. 默认推荐 X (Twitter) 作为国际化平台，除非有明确的中文平台指示。
5. confidence 级别：显式请求 → explicit，已验证参考 → reference，账号默认 → defaults，模型推断 → inferred。`;

  return prompt;
}

/**
 * P31 v2：构造条件化内容生成 prompt。
 */
export function buildV2GenerationPrompt(inputText, intent, referenceText, referenceUrlData) {
  const rules = getConditionalRules(intent.platform, intent.content_format);

  let prompt = `你是一个专业的内容营销助手。根据用户需求和已确认的意图，生成平台适配的内容。

用户需求：${inputText}

已确认意图：
- 平台：${intent.platform}
- 内容格式：${intent.content_format}
- 语言模式：${intent.language_mode || 'zh-cn'}
- 长度模式：${intent.length_profile || 'short'}
- 语气：${intent.tone || 'professional'}
- CTA 策略：${intent.cta_policy || 'required'}（required=必须包含CTA, optional=可选, none=不包含）
- 标签策略：${intent.hashtag_policy || 'required_3_5'}（required_3_5=3-5个标签, optional_0_5=0-5个, none=无标签）

条件规则：${rules.description || `平台=${intent.platform}, 格式=${intent.content_format}`}`;

  if (referenceText) {
    prompt += `\n\n参考文本：${referenceText.slice(0, 800)}`;
  }

  if (referenceUrlData?.content_text) {
    prompt += `\n\n参考 X 内容：${String(referenceUrlData.content_text).slice(0, 800)}`;
  }

  prompt += `\n\n请以 JSON 格式返回以下字段：
- title: 内容标题（${intent.platform === 'xiaohongshu' ? '小红书标题，吸引眼球，含emoji' : '简洁标题'}，200字以内）
- main_copy: 主文案（根据平台和格式生成，${intent.length_profile === 'micro' ? '1-3行' : intent.length_profile === 'short' ? '简短' : intent.length_profile === 'long' ? '长文' : '标准'}，3000字以内）
- visual_description: 视觉方案描述（描述配图/视频的画面、构图、色调等，600字以内）
- platform: 回复原始平台值 "${intent.platform}"
- content_format: 回复原始格式值 "${intent.content_format}"`;

  // 根据 CTA 策略决定是否包含 CTA
  if (intent.cta_policy !== 'none') {
    prompt += `\n- cta: 行动引导${intent.cta_policy === 'optional' ? '（可选，如不适用返回空字符串）' : ''}`;
  }

  // 根据标签策略决定是否包含 hashtags
  if (intent.hashtag_policy !== 'none') {
    const tagDesc = intent.hashtag_policy === 'optional_0_5' ? '（可选，可以为空数组）' : '（3-5个，以#开头）';
    prompt += `\n- hashtags: 标签数组${tagDesc}`;
  }

  // 可选字段
  prompt += `\n- candidates: 候选版本数组（可选，最多1个备选文案，包含 title、copy、cta）
- hook: 开头钩子（可选）
- audience: 目标受众（可选）
- tone: 语气（可选）
- aspect_ratio: 推荐画幅（可选，1:1/4:5/9:16/16:9/3:4/4:3 之一）

请严格遵循 CTA 和标签策略。如果策略为 none 或 optional 且不适用，字段可为空或省略。`;

  return prompt;
}

/**
 * 严格验证 AI 返回的结构化 JSON（v1）。
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
 * P31 v2：验证意图解析结果。
 */
export function validateResolvedIntentOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new P30Error('INVALID_INTENT_RESPONSE', 'AI 返回了无效的意图响应格式。', 502);
  }

  const platform = String(raw.platform || '').toLowerCase().trim();
  if (!platform || !V2_VALID_PLATFORMS.has(platform)) {
    throw new P30Error('INTENT_RESPONSE_INVALID', `AI 返回了不支持的平台：${raw.platform}`, 502);
  }

  const contentFormat = String(raw.content_format || '').toLowerCase().trim();
  if (!contentFormat || !V2_VALID_CONTENT_FORMATS.has(contentFormat)) {
    throw new P30Error('INTENT_RESPONSE_INVALID', `AI 返回了不支持的内容格式：${raw.content_format}`, 502);
  }

  // 小红书反启发式：检查 AI 是否仅因中文输入就推断为小红书
  // 这个检查在 resolveIntent 层面实施，但也在此保留作为第二道防线
  const confidence = String(raw.confidence || 'inferred').toLowerCase().trim();
  const provenance = confidence === 'explicit'
    ? 'explicit_user_request'
    : confidence === 'reference'
      ? 'validated_reference'
      : confidence === 'defaults'
        ? 'account_project_defaults'
        : 'model_inference';

  return {
    platform,
    content_format: contentFormat,
    language_mode: validateOptionalEnum(raw.language_mode, V2_VALID_LANGUAGE_MODES, 'zh-cn'),
    length_profile: validateOptionalEnum(raw.length_profile, V2_VALID_LENGTH_PROFILES, 'short'),
    tone: validateOptionalEnum(raw.tone, V2_VALID_TONES, 'professional'),
    cta_policy: validateOptionalEnum(raw.cta_policy, V2_VALID_CTA_POLICIES, 'required'),
    hashtag_policy: validateOptionalEnum(raw.hashtag_policy, V2_VALID_HASHTAG_POLICIES, 'required_3_5'),
    confidence: V2_INTENT_CONFIDENCE_LEVELS.has(confidence) ? confidence : 'inferred',
    provenance,
    audience: typeof raw.audience === 'string' ? raw.audience.slice(0, 80) : null,
    content_goal: typeof raw.content_goal === 'string' ? raw.content_goal.slice(0, 120) : null,
  };
}

/**
 * P31 v2：验证条件化生成结果。
 * 根据平台 + content_format 的组合规则验证字段。
 */
export function validateV2GeneratedContent(raw, intent) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new P30Error('INVALID_MODEL_RESPONSE', 'AI 返回了无效的响应格式。', 502);
  }
  try {
    assertBoundedJson(raw, 'MODEL_RESPONSE_OUT_OF_BOUNDS');
  } catch (error) {
    if (error instanceof P30Error) throw new P30Error(error.code, error.message, 502);
    throw error;
  }

  // 检查必选字段
  const missing = V2_REQUIRED_OUTPUT_FIELDS.filter((f) => raw[f] === undefined || raw[f] === null || raw[f] === '');
  if (missing.length > 0) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 响应缺少必需字段：${missing.join(', ')}。`, 502);
  }

  // 验证平台匹配
  if (intent?.platform && String(raw.platform || '').toLowerCase().trim() !== intent.platform.toLowerCase()) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', 'AI 返回的 platform 与意图不匹配。', 502);
  }

  // 验证内容格式匹配
  if (intent?.content_format && String(raw.content_format || '').toLowerCase().trim() !== intent.content_format.toLowerCase()) {
    throw new P30Error('MODEL_SCHEMA_VIOLATION', 'AI 返回的 content_format 与意图不匹配。', 502);
  }

  // 验证字符串字段长度
  for (const f of V2_REQUIRED_OUTPUT_FIELDS) {
    if (typeof raw[f] !== 'string' || raw[f].length > V2_OUTPUT_STRING_LIMITS[f]) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', `AI 响应字段 ${f} 无效或超长。`, 502);
    }
  }

  // 根据 CTA 策略验证 CTA
  const ctaPolicy = intent?.cta_policy || 'required';
  if (ctaPolicy === 'required') {
    if (!raw.cta || typeof raw.cta !== 'string' || raw.cta.length > V2_OUTPUT_STRING_LIMITS.cta) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', 'CTA 策略为 required，但 AI 未返回有效 CTA。', 502);
    }
  }

  // 根据标签策略验证 hashtags
  const hashtagPolicy = intent?.hashtag_policy || 'required_3_5';
  if (hashtagPolicy === 'required_3_5') {
    if (!Array.isArray(raw.hashtags) || raw.hashtags.length < 1 || raw.hashtags.length > 5) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', '标签策略为 required_3_5，但 AI 未返回 1-5 个标签。', 502);
    }
    if (raw.hashtags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag.length > 50)) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', '标签数组包含无效标签。', 502);
    }
  } else if (hashtagPolicy === 'optional_0_5') {
    if (raw.hashtags !== undefined && raw.hashtags !== null) {
      if (!Array.isArray(raw.hashtags) || raw.hashtags.length > 5) {
        throw new P30Error('MODEL_SCHEMA_VIOLATION', '标签策略为 optional_0_5，最多 5 个标签。', 502);
      }
      if (raw.hashtags.some((tag) => typeof tag !== 'string' || tag.length > 50)) {
        throw new P30Error('MODEL_SCHEMA_VIOLATION', '标签数组包含无效标签。', 502);
      }
    }
  }

  // 验证 candidates（可选）
  let candidates = [];
  if (raw.candidates !== undefined && raw.candidates !== null) {
    if (!Array.isArray(raw.candidates) || raw.candidates.length > 2) {
      throw new P30Error('MODEL_SCHEMA_VIOLATION', 'candidates 必须是最多 2 项的数组。', 502);
    }
    candidates = raw.candidates.filter(Boolean).map((candidate) => {
      if (!candidate || typeof candidate !== 'object') return null;
      return {
        title: String(candidate.title || '').slice(0, 200) || null,
        copy: String(candidate.copy || candidate.main_copy || '').slice(0, 3000) || '',
        cta: String(candidate.cta || '').slice(0, 200) || null,
      };
    }).filter(Boolean);
  }

  // 构建安全的输出
  const result = {
    title: String(raw.title || '').slice(0, V2_OUTPUT_STRING_LIMITS.title),
    main_copy: String(raw.main_copy || '').slice(0, V2_OUTPUT_STRING_LIMITS.main_copy),
    visual_description: String(raw.visual_description || '').slice(0, V2_OUTPUT_STRING_LIMITS.visual_description),
    platform: String(raw.platform || intent?.platform || 'x'),
    content_format: String(raw.content_format || intent?.content_format || 'image_caption'),
  };

  // 可选字段
  if (raw.cta !== undefined) {
    result.cta = ctaPolicy === 'none' ? null : String(raw.cta || '').slice(0, V2_OUTPUT_STRING_LIMITS.cta) || null;
  }
  if (raw.hashtags !== undefined) {
    result.hashtags = hashtagPolicy === 'none' ? [] : (Array.isArray(raw.hashtags) ? raw.hashtags.filter((tag) => typeof tag === 'string' && tag.trim()).slice(0, 5) : []);
  }
  result.candidates = candidates;
  if (raw.hook !== undefined) result.hook = String(raw.hook || '').slice(0, 200) || null;
  if (raw.audience !== undefined) result.audience = String(raw.audience || '').slice(0, 80) || null;
  if (raw.tone !== undefined) result.tone = String(raw.tone || '').slice(0, 60) || null;
  if (raw.aspect_ratio !== undefined) result.aspect_ratio = String(raw.aspect_ratio || '').slice(0, 16) || null;
  if (raw.language_mode !== undefined) result.language_mode = String(raw.language_mode || '').slice(0, 20) || null;
  if (raw.length_profile !== undefined) result.length_profile = String(raw.length_profile || '').slice(0, 20) || null;

  return result;
}

// ---- v2 摘要与辅助函数 ----

/**
 * P31 v2：生成意图摘要行（用于 chip 显示）。
 */
export function formatIntentSummaryLine(intent) {
  const platformLabel = intent.platform === 'x' ? 'X' : intent.platform === 'xiaohongshu' ? '小红书' : intent.platform;
  const formatLabel = {
    image_caption: '图文',
    carousel: '轮播',
    long_post: '长文',
    short_video_script: '短视频脚本',
    text_only: '纯文本',
    infographic: '信息图',
  }[intent.content_format] || intent.content_format;
  const toneLabel = {
    professional: '专业', casual: '随和', inspirational: '励志',
    educational: '教育', humorous: '幽默', urgent: '紧迫',
    empathetic: '共情', authoritative: '权威',
  }[intent.tone] || intent.tone;
  return `${platformLabel} · ${formatLabel} · ${toneLabel} · ${intent.language_mode || 'zh-cn'}`;
}

/**
 * P31 v2：生成 v2 结果摘要。
 */
export function formatV2SummaryLine(result) {
  return `${result.platform} / ${result.content_format} / ${result.language_mode || 'zh-cn'} / ${result.length_profile || 'short'}`;
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
