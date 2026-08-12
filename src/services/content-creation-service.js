// P30 内容创建前端服务。P31 v2 扩展：resolveIntent / generateQuickV2 / v2 save。
//
// 调用 supabase/functions/p30-content-create Edge Function。
// 不直接调用 Qwen/外部 API；全部通过 Edge Function 代理。

import { supabase, isSupabaseConfigured } from './supabase-client';

const FUNCTION_NAME = 'p30-content-create';
const SCHEMA_VERSION = 'p30_content_create_v1';
const SCHEMA_VERSION_V2 = 'p31_reference_driven_v2';

/**
 * 获取 P30 Edge Function 状态。
 * 返回 { ok, role, model } 或抛出错误。
 */
export async function getContentCreationStatus() {
  if (!isSupabaseConfigured) {
    return { ok: false, message: '数据服务未配置' };
  }

  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
      body: { action: 'status', schema_version: SCHEMA_VERSION },
    });

    if (error) {
      return { ok: false, message: error.message || '服务暂不可用' };
    }

    return {
      ok: data?.ok === true,
      role: data?.data?.role || 'unknown',
      model: data?.data?.model || 'qwen-plus',
      multimodal_model: data?.data?.multimodal_model || 'qwen3.5-omni-flash',
      message: data?.message || '',
    };
  } catch (err) {
    return { ok: false, message: err?.message || '无法连接生成服务' };
  }
}

/**
 * 快速生成内容（一句话需求 → AI 自动补全）。
 *
 * @param {string} inputText - 用户输入的一句话需求
 * @param {object|null} previousVersion - 前一版本（用于 revise）
 * @returns {{ ok, data, meta, message }}
 */
export async function generateQuickContent(inputText, previousVersion = null) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置，无法生成内容。');
  }

  const body = {
    action: 'generate_quick',
    input_text: inputText,
    schema_version: SCHEMA_VERSION,
  };

  if (previousVersion) {
    body.previous_version = previousVersion;
  }

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

  if (error) {
    throw new Error(error.message || '内容生成失败，请稍后重试。');
  }

  if (!data?.ok) {
    throw new Error(data?.message || '内容生成失败。');
  }

  return {
    ok: true,
    data: data.data,
    meta: data.meta || {},
    message: data.message || '',
  };
}

/**
 * P31 v2：解析意图（resolve_intent）。
 *
 * @param {string} inputText - 用户输入的需求
 * @param {object} options - 参考输入 { referenceUrl, referenceUrlData, referenceText, image_data_url, intentOverrides }
 * @returns {{ ok, data: { intent, summary }, meta }}
 */
export async function resolveIntent(inputText, options = {}) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置，无法解析意图。');
  }

  const body = {
    action: 'resolve_intent',
    input_text: inputText,
    schema_version: SCHEMA_VERSION_V2,
  };

  if (options.referenceUrl) body.reference_url = options.referenceUrl;
  if (options.referenceUrlData) body.reference_url_data = options.referenceUrlData;
  if (options.referenceText) body.reference_text = options.referenceText;
  if (options.image_data_url) {
    body.image_data_url = options.image_data_url;
    body.has_image_reference = true;
  }
  if (options.intentOverrides && typeof options.intentOverrides === 'object') {
    body.intent_overrides = options.intentOverrides;
  }

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

  if (error) {
    throw new Error(error.message || '意图解析失败，请稍后重试。');
  }

  if (!data?.ok) {
    throw new Error(data?.message || '意图解析失败。');
  }

  return {
    ok: true,
    data: {
      intent: data.data?.intent || {},
      summary: data.data?.summary || '',
    },
    meta: data.meta || {},
  };
}

/**
 * P31 v2：根据已解析的意图生成内容。
 *
 * @param {string} inputText - 用户输入的需求
 * @param {object} intent - 已解析的意图对象
 * @param {object} options - { referenceText, referenceUrlData, image_data_url, previousVersion }
 * @returns {{ ok, data, meta, message }}
 */
export async function generateQuickContentV2(inputText, intent, options = {}) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置，无法生成内容。');
  }

  const body = {
    action: 'generate_quick_v2',
    input_text: inputText,
    intent,
    schema_version: SCHEMA_VERSION_V2,
  };

  if (options.referenceText) body.reference_text = options.referenceText;
  if (options.referenceUrlData) body.reference_url_data = options.referenceUrlData;
  if (options.image_data_url) {
    body.image_data_url = options.image_data_url;
    body.has_image_reference = true;
  }
  if (options.previousVersion) body.previous_version = options.previousVersion;

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

  if (error) {
    throw new Error(error.message || '内容生成失败，请稍后重试。');
  }

  if (!data?.ok) {
    throw new Error(data?.message || '内容生成失败。');
  }

  return {
    ok: true,
    data: data.data,
    meta: data.meta || {},
    message: data.message || '',
  };
}

/**
 * 从 Brief 生成内容。
 *
 * @param {object} briefData - Brief 数据
 * @returns {{ ok, data, meta, message }}
 */
export async function generateFromBrief(briefData) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置，无法生成内容。');
  }

  const body = {
    action: 'generate_from_brief',
    brief_id: briefData.id,
    brief_version: briefData.version,
    brief_fingerprint: briefData.fingerprint,
    schema_version: SCHEMA_VERSION,
  };

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

  if (error) {
    throw new Error(error.message || '从 Brief 生成内容失败，请稍后重试。');
  }

  if (!data?.ok) {
    throw new Error(data?.message || '内容生成失败。');
  }

  return {
    ok: true,
    data: data.data,
    meta: data.meta || {},
    message: data.message || '',
  };
}

/**
 * 根据反馈修改内容。
 *
 * @param {string} feedback - 修改意见
 * @param {object} previousVersion - 前一版本完整数据
 * @returns {{ ok, data, meta, message }}
 */
export async function reviseContent(feedback, previousVersion) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置，无法修改内容。');
  }

  const body = {
    action: 'revise',
    revision_feedback: feedback,
    previous_version: previousVersion,
    schema_version: SCHEMA_VERSION,
  };

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, { body });

  if (error) {
    throw new Error(error.message || '内容修改失败，请稍后重试。');
  }

  if (!data?.ok) {
    throw new Error(data?.message || '内容修改失败。');
  }

  return {
    ok: true,
    data: data.data,
    meta: data.meta || {},
    message: data.message || '',
  };
}

/**
 * 将 v1 生成结果保存到 content_library（用户自己的 draft）。
 */
export async function saveContentDraft(userId, result, context = {}) {
  if (!isSupabaseConfigured || !userId) {
    throw new Error('请先登录后再保存。');
  }

  const platformMap = {
    x: 'X',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    telegram: 'Telegram',
  };
  const contentTypeMap = {
    text_only: 'text',
    single_image: 'image',
    infographic: 'image',
    carousel: 'carousel',
    short_video: 'short_video',
    long_video: 'video',
  };
  const normalizedPlatform = platformMap[String(result.platform || '').toLowerCase()] || null;
  const normalizedContentType = contentTypeMap[String(result.visual_type || '').toLowerCase()] || 'text';

  const row = {
    user_id: userId,
    title: result.hook?.slice(0, 100) || '未命名内容',
    content_text: result.main_copy || '',
    platform: normalizedPlatform,
    content_type: normalizedContentType,
    status: 'draft',
    pipeline_stage: 'draft',
    hashtags: result.hashtags || [],
    cta: result.cta || '',
    model: context.model || 'qwen-plus',
    generation_brief: {
      schema_version: 'p30_single_content_draft_v1',
      original_input: context.originalInput || '',
      summary: context.summary || '',
      visual_plan: result.visual_description || '',
      provider: context.provider || 'dashscope/qwen',
      model: context.model || 'qwen-plus',
      usage: context.usage || {},
      source: context.source || 'quick_generate',
      generated_fields: {
        platform: result.platform || '',
        audience: result.audience || '',
        tone: result.tone || '',
        content_goal: result.content_goal || '',
        hook: result.hook || '',
        visual_type: result.visual_type || '',
        visual_description: result.visual_description || '',
        aspect_ratio: result.aspect_ratio || '1:1',
      },
      brief_references: context.briefReferences || null,
      knowledge_references: context.knowledgeReferences || null,
      evidence_references: context.evidenceReferences || null,
    },
  };

  const { data, error } = await supabase
    .from('content_library')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    throw new Error(`保存失败：${error.message || '数据库写入异常'}`);
  }

  return { id: data.id };
}

/**
 * P31 v2：将 v2 生成结果保存到 content_library。
 * 保存精确的 v2 intent、参考来源（URL/text hash/image hash 和媒体元数据；不含原始图片）。
 *
 * @param {string} userId - 当前用户 ID
 * @param {object} result - v2 生成结果
 * @param {object} intent - 已解析的意图
 * @param {object} context - 保存上下文
 * @returns {{ id: string }}
 */
export async function saveContentDraftV2(userId, result, intent, context = {}) {
  if (!isSupabaseConfigured || !userId) {
    throw new Error('请先登录后再保存。');
  }

  const platformMap = {
    x: 'X',
    instagram: 'Instagram',
    tiktok: 'TikTok',
    youtube: 'YouTube',
    telegram: 'Telegram',
    xiaohongshu: '小红书',
    douyin: '抖音',
    weibo: '微博',
    wechat: '微信',
    facebook: 'Facebook',
    linkedin: 'LinkedIn',
    threads: 'Threads',
  };

  const formatTypeMap = {
    image_caption: 'image',
    carousel: 'carousel',
    long_post: 'long_post',
    short_video_script: 'short_video',
    text_only: 'text',
    infographic: 'infographic',
  };

  const normalizedPlatform = platformMap[String(intent?.platform || result.platform || '').toLowerCase()] || String(intent?.platform || result.platform || '');
  const normalizedContentType = formatTypeMap[String(intent?.content_format || result.content_format || '').toLowerCase()] || 'text';

  // 构建参考来源（不含原始图片，仅元数据和哈希）
  const referenceProvenance = {};
  if (context.referenceUrl) {
    referenceProvenance.url = String(context.referenceUrl).slice(0, 500);
  }
  if (context.referenceUrlData) {
    referenceProvenance.url_content_sha256 = String(context.referenceUrlData.content_sha256 || '').slice(0, 64);
    referenceProvenance.collected_at = String(context.referenceUrlData.collected_at || '').slice(0, 80);
    referenceProvenance.source_id = String(context.referenceUrlData.source_id || '').slice(0, 160);
  }
  if (context.referenceTextHash) {
    referenceProvenance.text_sha256 = String(context.referenceTextHash).slice(0, 64);
  }
  if (context.imageMetadata) {
    referenceProvenance.image_metadata = {
      mime_type: String(context.imageMetadata.mime_type || '').slice(0, 40),
      byte_size: Number(context.imageMetadata.byte_size || 0),
      width: Number(context.imageMetadata.width || 0),
      height: Number(context.imageMetadata.height || 0),
      sha256: String(context.imageMetadata.sha256 || '').slice(0, 64),
    };
    // 验证不含原始图片数据
    delete referenceProvenance.image_metadata.data;
    delete referenceProvenance.image_metadata.base64;
    delete referenceProvenance.image_metadata.content;
  }

  const row = {
    user_id: userId,
    title: (result.title || result.hook || '未命名内容').slice(0, 200),
    content_text: result.main_copy || '',
    platform: normalizedPlatform,
    content_type: normalizedContentType,
    status: 'draft',
    pipeline_stage: 'draft',
    hashtags: result.hashtags || [],
    cta: result.cta || '',
    model: context.model || 'qwen-plus',
    generation_brief: {
      schema_version: 'p31_reference_driven_v2',
      original_input: context.originalInput || '',
      summary: context.summary || '',
      visual_plan: result.visual_description || '',
      provider: context.provider || 'dashscope/qwen',
      model: context.model || 'qwen-plus',
      usage: context.usage || {},
      source: context.source || 'quick_generate_v2',
      // v2 intent
      intent: intent ? {
        platform: intent.platform || '',
        content_format: intent.content_format || '',
        language_mode: intent.language_mode || '',
        length_profile: intent.length_profile || '',
        tone: intent.tone || '',
        cta_policy: intent.cta_policy || '',
        hashtag_policy: intent.hashtag_policy || '',
        confidence: intent.confidence || '',
        provenance: intent.provenance || '',
        audience: intent.audience || null,
        content_goal: intent.content_goal || null,
      } : null,
      // v2 reference provenance (no raw image)
      reference_provenance: Object.keys(referenceProvenance).length > 0 ? referenceProvenance : null,
      // generated fields
      generated_fields: {
        title: result.title || '',
        main_copy: result.main_copy || '',
        visual_description: result.visual_description || '',
        platform: result.platform || '',
        content_format: result.content_format || '',
        cta: result.cta || null,
        hashtags: result.hashtags || [],
        aspect_ratio: result.aspect_ratio || null,
      },
    },
  };

  const { data, error } = await supabase
    .from('content_library')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    throw new Error(`保存失败：${error.message || '数据库写入异常'}`);
  }

  return { id: data.id };
}

/**
 * 从 content_library 按 ID 加载草稿。
 *
 * @param {string} draftId - 草稿 ID
 * @returns {{ ok, draft }}
 */
export async function loadDraftById(draftId) {
  if (!isSupabaseConfigured) {
    throw new Error('数据服务未配置。');
  }

  const { data, error } = await supabase
    .from('content_library')
    .select('*')
    .eq('id', draftId)
    .single();

  if (error) {
    throw new Error(`加载草稿失败：${error.message}`);
  }

  return { ok: true, draft: data };
}
