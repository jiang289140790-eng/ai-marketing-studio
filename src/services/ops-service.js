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

const ORDER_FIELDS = {
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
  contentMetrics: 'collected_at',
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
  const orderBy = options.orderBy || ORDER_FIELDS[key] || null;
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
  return loadKeys(['contentPackages', 'legacyContent', 'campaigns', 'strategies', 'accounts', 'assets', 'legacyAssets', 'characters', 'workflowRuns']);
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

export function getContentPackages(data) {
  const primary = (data.contentPackages || []).map((item) => ({ ...item, sourceLabel: FRIENDLY_SOURCE.contentPackages }));
  const legacy = (data.legacyContent || []).map((item) => ({ ...item, sourceLabel: FRIENDLY_SOURCE.legacyContent }));

  return [...primary, ...legacy].map((item) => ({
    id: item.id,
    title: item.title || item.name || '未命名内容',
    campaignId: item.campaign_id,
    strategyId: item.strategy_plan_id || item.source_analysis_id,
    platform: item.platform || item.target_platform || '未指定平台',
    status: item.status || 'draft',
    approvalStatus: item.approval_status,
    accountId: item.account_id || item.social_account_id,
    referenceAccountId: item.reference_account_id,
    body: item.content_text || item.final_text || item.body || item.summary || '',
    hook: item.hook || item.opening || '',
    cta: item.cta || '',
    tags: item.tags || item.hashtags || [],
    keywords: item.keywords || [],
    languageStyle: item.language_style || item.tone || item.copy_style || '',
    assetRequirement: item.asset_requirement || item.visual_brief || item.media_brief || '',
    assetId: item.asset_id || item.final_asset_id,
    characterId: item.character_id,
    scheduledAt: item.scheduled_at || item.scheduled_time || item.publish_time,
    createdAt: item.created_at,
    sourceLabel: item.sourceLabel,
    raw: item,
  }));
}

export function getAssets(data) {
  return [...(data.assets || []), ...(data.legacyAssets || [])].map((item) => ({
    id: item.id,
    name: item.name || item.title || item.asset_type || '未命名素材',
    type: item.type || item.asset_type || 'asset',
    url: item.url || item.output_url || item.media_url,
    thumbnail: item.thumbnail,
    status: item.status || item.generation_status || 'completed',
    prompt: item.prompt || item.generation_prompt || '',
    model: item.model || item.checkpoint || '',
    workflow: item.workflow || item.workflow_name || '',
    rightsStatus: item.rights_status || item.rights_confirmed || item.rights_asserted,
    characterId: item.character_id,
    contentId: item.content_id || item.content_package_id,
    campaignId: item.campaign_id,
    createdAt: item.created_at,
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
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => displayText(item, '')).filter(Boolean).join('、') || fallback;
  if (typeof value === 'object') {
    return value.title || value.name || value.summary || value.description || value.result || fallback;
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

function classifyReadError(error) {
  const message = error?.message || String(error);
  if (/does not exist|schema cache|Could not find/i.test(message)) return `数据表或字段不存在：${message}`;
  if (/permission denied|row-level security|rls|not authorized|JWT/i.test(message)) return `权限或 RLS 拒绝：${message}`;
  if (/Failed to fetch|network|timeout/i.test(message)) return `网络错误：${message}`;
  return message;
}
