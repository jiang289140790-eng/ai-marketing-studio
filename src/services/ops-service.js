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

export async function readRows(key, options = {}) {
  const table = TABLES[key];
  if (!table) return [];

  const client = requireSupabase();
  const limit = options.limit || 80;
  const orderBy = options.orderBy || 'created_at';
  const ascending = Boolean(options.ascending);

  let query = client.from(table).select('*').limit(limit);

  if (options.eq) query = query.eq(options.eq[0], options.eq[1]);
  if (options.in) query = query.in(options.in[0], options.in[1]);
  if (orderBy) query = query.order(orderBy, { ascending });

  const { data, error } = await query;
  if (error) return [];
  return data || [];
}

export async function loadKeys(keys) {
  const entries = await Promise.all(keys.map(async (key) => [key, await readRows(key)]));
  return Object.fromEntries(entries);
}

export async function loadCommandCenterData() {
  return loadKeys([
    'accounts',
    'accountProfiles',
    'campaigns',
    'strategies',
    'contentPackages',
    'legacyContent',
    'assets',
    'legacyAssets',
    'characters',
    'publishTasks',
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
  return loadKeys(['publishTasks', 'platformConnections', 'accounts', 'legacyContent', 'contentPackages', 'assets', 'legacyAssets']);
}

export async function loadPlatformConnectionData() {
  return loadKeys(['platformConnections', 'accounts']);
}

export async function loadSystemStatusData() {
  return loadKeys(['agentRuns', 'workflowRuns', 'publishTasks', 'contentMetrics']);
}

export async function loadWorkflowConfigData() {
  return loadKeys(['comfyWorkflows', 'characters', 'assets', 'legacyAssets', 'workflowRuns']);
}

export function getContentPackages(data) {
  const primary = data.contentPackages || [];
  const legacy = (data.legacyContent || []).map((item) => ({
    ...item,
    sourceType: '内容库',
  }));
  return [...primary, ...legacy].map((item) => ({
    id: item.id,
    title: item.title || item.name || '未命名内容',
    campaignId: item.campaign_id,
    strategyId: item.strategy_plan_id || item.source_analysis_id,
    platform: item.platform || item.target_platform || '未指定平台',
    status: item.status || 'draft',
    accountId: item.account_id || item.social_account_id,
    referenceAccountId: item.reference_account_id,
    body: item.content_text || item.final_text || item.body || item.summary || '',
    hook: item.hook || item.opening || '',
    cta: item.cta || '',
    tags: item.tags || item.hashtags || [],
    keywords: item.keywords || [],
    assetId: item.asset_id || item.final_asset_id,
    characterId: item.character_id,
    scheduledAt: item.scheduled_at || item.scheduled_time || item.publish_time,
    createdAt: item.created_at,
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
  if (Array.isArray(value)) return value.filter(Boolean).join('、') || fallback;
  if (typeof value === 'object') {
    return value.title || value.name || value.summary || value.description || fallback;
  }
  return String(value);
}
