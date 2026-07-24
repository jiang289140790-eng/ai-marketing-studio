import { requireSupabase } from './supabase-client';

const TABLES = {
  accounts: 'social_accounts',
  accountProfiles: 'account_profiles',
  accountReports: 'account_intelligence_reports',
  platformConnections: 'platform_connections',
  campaigns: 'campaigns',
  strategies: 'strategy_plans',
  contentPackages: 'content_packages',
  legacyContent: 'content_library',
  assets: 'assets',
  legacyAssets: 'asset_library',
  characters: 'characters',
  publishTasks: 'publish_tasks',
  publishMetrics: 'publish_metrics',
  contentMetrics: 'content_metrics',
  knowledge: 'knowledge_entries',
  insights: 'insights',
  contentMemory: 'content_memory',
  strategyMemory: 'strategy_memory',
  agentRuns: 'agent_runs',
  workflowRuns: 'workflow_runs',
  comfyWorkflows: 'comfy_workflows',
};

export const ORDER_FIELDS = {
  accounts: 'created_at',
  accountProfiles: 'updated_at',
  accountReports: 'created_at',
  platformConnections: 'last_sync',
  campaigns: 'created_at',
  strategies: 'created_at',
  contentPackages: 'created_at',
  legacyContent: 'created_at',
  assets: 'created_at',
  legacyAssets: 'created_at',
  characters: 'created_at',
  publishTasks: 'created_at',
  publishMetrics: 'last_sync',
  contentMetrics: 'fetched_at',
  knowledge: 'created_at',
  insights: 'created_at',
  contentMemory: 'created_at',
  strategyMemory: 'created_at',
  agentRuns: 'created_at',
  workflowRuns: 'created_at',
  comfyWorkflows: 'created_at',
};

const FRIENDLY_SOURCE = {
  contentPackages: '内容包',
  legacyContent: '历史内容',
  assets: '素材',
  legacyAssets: '历史素材',
  accountProfiles: '账号画像',
  accountReports: '账号智能报告',
};

export async function readRows(key, options = {}) {
  const table = TABLES[key];
  if (!table) return [];

  const client = requireSupabase();
  const limit = options.limit || 80;
  const orderBy = options.orderBy === null ? null : (options.orderBy || ORDER_FIELDS[key] || null);
  const ascending = Boolean(options.ascending);

  let query = client.from(table).select('*').limit(limit);

  if (options.eq) query = query.eq(options.eq[0], options.eq[1]);
  if (options.in) query = query.in(options.in[0], options.in[1]);
  if (orderBy) query = query.order(orderBy, { ascending });

  const { data, error } = await query;
  if (error) {
    const detail = classifyReadError(error);
    throw new Error(`${FRIENDLY_SOURCE[key] || table} 读取失败：${detail}`);
  }
  return data || [];
}

export async function loadKeys(keys) {
  const errors = [];
  const entries = await Promise.all(keys.map(async (key) => {
    try {
      return [key, await readRows(key)];
    } catch (error) {
      errors.push({ key, message: error.message });
      return [key, []];
    }
  }));
  return { ...Object.fromEntries(entries), __errors: errors };
}

export async function loadCommandCenterData() {
  return loadKeys([
    'accounts',
    'accountProfiles',
    'accountReports',
    'campaigns',
    'strategies',
    'contentPackages',
    'legacyContent',
    'assets',
    'legacyAssets',
    'characters',
    'publishTasks',
    'publishMetrics',
    'contentMetrics',
    'knowledge',
    'insights',
    'contentMemory',
    'strategyMemory',
    'agentRuns',
    'workflowRuns',
    'platformConnections',
  ]);
}

export async function loadCampaignData() {
  return loadKeys(['campaigns', 'strategies', 'accounts', 'accountReports', 'knowledge', 'strategyMemory', 'contentMetrics']);
}

export async function loadContentWorkspaceData() {
  return loadKeys([
    'contentPackages',
    'legacyContent',
    'campaigns',
    'strategies',
    'accounts',
    'assets',
    'legacyAssets',
    'characters',
    'workflowRuns',
    'publishTasks',
  ]);
}

export async function loadPublishQueueData() {
  return loadKeys(['publishTasks', 'publishMetrics', 'platformConnections', 'accounts', 'legacyContent', 'contentPackages', 'assets', 'legacyAssets']);
}

export async function loadPlatformConnectionData() {
  return loadKeys(['platformConnections', 'accounts']);
}

export async function loadSystemStatusData() {
  return loadKeys(['agentRuns', 'workflowRuns', 'publishTasks', 'publishMetrics', 'contentMetrics']);
}

export async function loadWorkflowConfigData() {
  return loadKeys(['comfyWorkflows', 'characters', 'assets', 'legacyAssets', 'workflowRuns']);
}

export async function saveContentProductionBinding(item, binding) {
  if (!item?.id) throw new Error('缺少内容记录 ID，无法保存生产关联。');

  const client = requireSupabase();
  const referenceAssetIds = normalizeIdList(binding.referenceAssetIds);
  const selectedAssetId = referenceAssetIds[0] || null;

  if (item.sourceKey === 'legacyContent') {
    let query = client
      .from(TABLES.legacyContent)
      .update({
        character_id: binding.characterId || null,
        asset_id: selectedAssetId,
      })
      .eq('id', item.id);

    if (item.raw?.user_id) query = query.eq('user_id', item.raw.user_id);
    const { data, error } = await query.select('*').single();
    if (error) throw new Error(`保存生产关联失败：${classifyWriteError(error)}`);
    return data;
  }

  const imageRequirements = normalizeObject(item.raw?.image_requirements || item.imageRequirements);
  const videoRequirements = normalizeObject(item.raw?.video_requirements || item.videoRequirements);
  const productionBinding = {
    character_id: binding.characterId || null,
    lora_id: binding.loraId || null,
    lora_info: binding.loraInfo || null,
    reference_asset_ids: referenceAssetIds,
    reference_source: binding.referenceSource || '',
    generation_mode: binding.generationMode || 'character_lora_video',
  };

  let query = client
    .from(TABLES.contentPackages)
    .update({
      strategy_plan_id: binding.strategyId || null,
      image_requirements: {
        ...imageRequirements,
        ...productionBinding,
        media_type: 'image',
      },
      video_requirements: {
        ...videoRequirements,
        ...productionBinding,
        media_type: 'video',
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', item.id);

  if (item.raw?.user_id) query = query.eq('user_id', item.raw.user_id);
  const { data, error } = await query.select('*').single();
  if (error) throw new Error(`保存生产关联失败：${classifyWriteError(error)}`);
  return data;
}

export async function applyContextAIResult(item, mode, result) {
  if (!item?.id) throw new Error('缺少内容记录 ID，无法应用 AI 结果。');
  const client = requireSupabase();
  const value = result && typeof result === 'object' ? result : {};

  if (item.sourceKey === 'legacyContent') {
    const generationBrief = normalizeObject(item.raw?.generation_brief);
    const update = mode === 'rewrite_copy' || mode === 'generate_hook'
      ? {
          title: value.title || item.title || null,
          content_text: value.body || item.body || null,
          cta: value.cta || item.cta || null,
          hashtags: normalizeList(value.hashtags || item.tags),
        }
      : {
          generation_brief: {
            ...generationBrief,
            context_ai: {
              ...(generationBrief.context_ai || {}),
              [mode]: value,
            },
          },
        };

    let query = client.from(TABLES.legacyContent).update(update).eq('id', item.id);
    if (item.raw?.user_id) query = query.eq('user_id', item.raw.user_id);
    const { data, error } = await query.select('*').single();
    if (error) throw new Error(`应用 Context AI 结果失败：${classifyWriteError(error)}`);
    return data;
  }

  const update = { updated_at: new Date().toISOString() };
  if (mode === 'rewrite_copy' || mode === 'generate_hook') {
    update.title = value.title || item.title || null;
    update.hook = value.hook || item.hook || null;
    update.body = value.body || item.body || null;
    update.cta = value.cta || item.cta || null;
    update.hashtags = normalizeList(value.hashtags || item.tags);
    update.keywords = normalizeList(value.keywords || item.keywords);
    if (value.tone) update.language_style = value.tone;
  } else if (mode === 'generate_image_prompt') {
    update.image_requirements = {
      ...normalizeObject(item.raw?.image_requirements || item.imageRequirements),
      ...value,
      context_ai_model: 'qwen',
    };
  } else if (mode === 'generate_video_script') {
    update.video_requirements = {
      ...normalizeObject(item.raw?.video_requirements || item.videoRequirements),
      ...value,
      context_ai_model: 'qwen',
    };
  } else if (mode === 'generate_lora_prompt') {
    const loraInfo = {
      name: value.character_description || value.visual_identity || 'Context AI LoRA',
      prompt: value.lora_prompt || '',
      negative_prompt: value.lora_negative_prompt || '',
      weight: Number(value.recommended_weight || 0.8),
      generated: true,
    };
    update.image_requirements = {
      ...normalizeObject(item.raw?.image_requirements || item.imageRequirements),
      lora_info: loraInfo,
    };
    update.video_requirements = {
      ...normalizeObject(item.raw?.video_requirements || item.videoRequirements),
      lora_info: loraInfo,
    };
  } else if (mode === 'generate_strategy') {
    update.source_insights = {
      ...normalizeObject(item.raw?.source_insights || item.sourceInsights),
      context_ai_strategy: value,
    };
  }

  let query = client.from(TABLES.contentPackages).update(update).eq('id', item.id);
  if (item.raw?.user_id) query = query.eq('user_id', item.raw.user_id);
  const { data, error } = await query.select('*').single();
  if (error) throw new Error(`应用 Context AI 结果失败：${classifyWriteError(error)}`);
  return data;
}

export function getContentPackages(data) {
  const primary = (data.contentPackages || []).map((item) => ({ ...item, sourceKey: 'contentPackages', sourceLabel: FRIENDLY_SOURCE.contentPackages }));
  const legacy = (data.legacyContent || []).map((item) => ({ ...item, sourceKey: 'legacyContent', sourceLabel: FRIENDLY_SOURCE.legacyContent }));
  const seen = new Set();

  return [...primary, ...legacy]
    .filter((item) => {
      const key = String(item.id || item.content_id || item.title || Math.random());
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((item) => {
      const imageRequirements = normalizeObject(item.image_requirements);
      const videoRequirements = normalizeObject(item.video_requirements);
      const hasImageRequirements = Object.keys(imageRequirements).length > 0;
      const hasVideoRequirements = Object.keys(videoRequirements).length > 0;
      const assetRequirement = firstValue(
        item.asset_requirement,
        item.visual_brief,
        item.media_brief,
        hasImageRequirements ? imageRequirements : null,
        hasVideoRequirements ? videoRequirements : null,
        item.raw_requirements,
      );
      const embeddedCharacter = firstValue(
        imageRequirements.character_id,
        videoRequirements.character_id,
        imageRequirements.character?.id,
        videoRequirements.character?.id,
      );
      const embeddedLora = firstValue(
        imageRequirements.lora_info,
        videoRequirements.lora_info,
        imageRequirements.lora,
        videoRequirements.lora,
      );
      const referenceAssetIds = firstNonEmptyIdList(
        item.reference_asset_ids,
        item.reference_assets,
        item.asset_ids,
        imageRequirements.reference_asset_ids,
        videoRequirements.reference_asset_ids,
        imageRequirements.reference_assets,
        videoRequirements.reference_assets,
        item.sourceKey === 'legacyContent' ? item.asset_id : null,
      );

      return {
        id: item.id,
        title: item.title || item.name || item.headline || '未命名内容',
        campaignId: item.campaign_id,
        strategyId: item.strategy_plan_id || item.strategy_id || item.source_analysis_id,
        platform: item.platform || item.target_platform || '未指定平台',
        status: item.status || item.pipeline_status || 'draft',
        reviewStatus: item.review_status || item.approval_status || item.status || 'draft',
        approvalStatus: item.approval_status,
        accountId: item.account_id || item.social_account_id || item.target_account_id,
        referenceAccountId: item.reference_account_id || item.source_account_id,
        sourceAccount: item.source_account || item.source_username || '',
        body: item.content_text || item.final_text || item.body || item.caption || item.summary || '',
        hook: item.hook || item.opening || item.title_hook || '',
        cta: item.cta || item.call_to_action || '',
        tags: normalizeList(item.tags || item.hashtags),
        keywords: normalizeList(item.keywords),
        languageStyle: item.language_style || item.tone || item.copy_style || item.style || '',
        replicateStrategy: item.replicate_strategy || item.ai_recommendation || item.strategy || '',
        publishSuggestion: item.publish_suggestion || item.scheduling_recommendation || item.best_time || '',
        assetRequirement,
        imageRequirements: firstValue(hasImageRequirements ? imageRequirements : null, assetRequirement?.image, item.visual_brief),
        videoRequirements: firstValue(hasVideoRequirements ? videoRequirements : null, assetRequirement?.video, item.video_brief),
        assetId: item.asset_id || item.final_asset_id,
        finalAssetId: item.final_asset_id || item.asset_id,
        characterId: item.character_id || embeddedCharacter,
        loraId: item.lora_id || item.lora?.id || item.lora_info?.id || embeddedLora?.id,
        loraInfo: item.lora_info || item.lora || embeddedLora || null,
        referenceAssetIds,
        referenceSource: firstValue(imageRequirements.reference_source, videoRequirements.reference_source, item.reference_source),
        generationMode: firstValue(videoRequirements.generation_mode, imageRequirements.generation_mode),
        copyConfirmed: Boolean(item.copy_confirmed || item.final_copy_confirmed || item.copy_approved),
        assetConfirmed: Boolean(item.asset_confirmed || item.final_asset_confirmed || item.asset_approved),
        approvedForPublishing: Boolean(item.approved_for_publishing || item.approval_status === 'approved' || item.review_status === 'approved'),
        scheduledAt: item.scheduled_at || item.scheduled_time || item.publish_time,
        createdAt: item.created_at,
        updatedAt: item.updated_at || item.completed_at || item.created_at,
        sourceKey: item.sourceKey,
        sourceLabel: item.sourceLabel,
        raw: item,
      };
    });
}

export function getAssets(data) {
  return [...(data.assets || []), ...(data.legacyAssets || [])].map((item) => ({
    id: item.id,
    name: item.name || item.title || item.asset_type || item.type || '未命名素材',
    type: item.type || item.asset_type || 'asset',
    url: item.url || item.output_url || item.media_url || item.storage_url,
    thumbnail: item.thumbnail || item.thumbnail_url || item.preview_url,
    status: item.status || item.generation_status || 'completed',
    prompt: item.prompt || item.generation_prompt || '',
    model: item.model || item.checkpoint || item.generation_model || '',
    workflow: item.workflow || item.workflow_name || item.workflow_id || '',
    source: item.source || item.generation_provider || item.origin || '',
    sourceAccount: item.source_account || item.source_username || '',
    sourcePostUrl: item.source_post_url || item.external_url || '',
    rightsStatus: item.rights_status || item.rights_confirmed || item.rights_asserted,
    usedByContentId: item.used_by_content_id || item.content_package_id || item.content_id,
    characterId: item.character_id,
    contentId: item.content_id || item.content_package_id,
    campaignId: item.campaign_id,
    createdAt: item.created_at,
    updatedAt: item.updated_at || item.created_at,
    raw: item,
  }));
}

export function getKnowledgeItems(data) {
  return [
    ...(data.knowledge || []),
    ...(data.insights || []),
    ...(data.contentMemory || []),
    ...(data.strategyMemory || []),
    ...(data.accountReports || []),
    ...(data.accountProfiles || []),
  ];
}

export function getLatest(rows, count = 5) {
  return [...(rows || [])]
    .sort((a, b) => new Date(b.created_at || b.updated_at || b.createdAt || 0) - new Date(a.created_at || a.updated_at || a.createdAt || 0))
    .slice(0, count);
}

export function countWhere(rows, predicate) {
  return (rows || []).filter(predicate).length;
}

export function findById(rows, id) {
  if (!id) return null;
  return (rows || []).find((row) => String(row.id) === String(id)) || null;
}

export function displayText(value, fallback = '—') {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value)) {
    const text = value.filter(Boolean).map((item) => displayText(item, '')).filter(Boolean).join('、');
    return text || fallback;
  }
  if (typeof value === 'object') {
    return value.title
      || value.name
      || value.summary
      || value.description
      || value.result
      || value.text
      || value.prompt
      || fallback;
  }
  return String(value);
}

export function normalizeStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['success', 'completed', 'published', 'connected', 'approved', 'active'].includes(status)) return 'success';
  if (['failed', 'error', 'rejected', 'expired'].includes(status)) return 'failed';
  if (['running', 'generating', 'publishing', 'queued'].includes(status)) return 'running';
  return status || 'pending';
}

export function normalizeList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[,\n，、#]/).map((item) => item.trim()).filter(Boolean);
  }
  if (value && typeof value === 'object') return Object.values(value).filter(Boolean);
  return [];
}

function normalizeIdList(value) {
  return normalizeList(value).map((item) => (typeof item === 'object' ? item.id : item)).filter(Boolean);
}

export function normalizeObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstNonEmptyIdList(...values) {
  for (const value of values) {
    const ids = normalizeIdList(value);
    if (ids.length) return ids;
  }
  return [];
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') || null;
}

function classifyReadError(error) {
  const message = error?.message || String(error);
  if (/does not exist|schema cache|Could not find/i.test(message)) return `数据表或字段不存在：${message}`;
  if (/permission denied|row-level security|rls|not authorized|JWT/i.test(message)) return `权限或 RLS 拒绝：${message}`;
  if (/Failed to fetch|network|timeout/i.test(message)) return `网络错误：${message}`;
  return message;
}

function classifyWriteError(error) {
  const message = error?.message || String(error);
  if (/permission denied|row-level security|rls|not authorized|JWT/i.test(message)) return '当前账号没有修改这条内容的权限。';
  if (/does not exist|schema cache|Could not find/i.test(message)) return '线上数据结构与当前页面不兼容。';
  if (/Failed to fetch|network|timeout/i.test(message)) return '网络连接异常，请稍后重试。';
  return '保存未完成，请检查必填项后重试。';
}
