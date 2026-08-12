// P30 内容创建前端服务。
//
// 调用 supabase/functions/p30-content-create Edge Function。
// 提供 quick generate、brief generate、revise 和 status 检查。
// 不直接调用 Qwen/外部 API；全部通过 Edge Function 代理。

import { supabase, isSupabaseConfigured } from './supabase-client';

const FUNCTION_NAME = 'p30-content-create';
const SCHEMA_VERSION = 'p30_content_create_v1';

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
 * 将生成结果保存到 content_library（用户自己的 draft）。
 * 使用现有 authenticated/RLS 边界，不要求 campaign、strategy 或 Day。
 *
 * @param {string} userId - 当前用户 ID
 * @param {object} result - 生成结果
 * @param {object} context - 保存上下文（原始需求、来源等）
 * @returns {{ id: string }} 保存的记录 ID
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
