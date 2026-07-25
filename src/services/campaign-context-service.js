import { requireSupabase } from './supabase-client.js';

const ACTIVE_STATUSES = new Set(['active', 'draft', 'paused']);
export const ACCEPTANCE_CAMPAIGN_NAME = 'X 媒体优先短内容测试';
const REVIEWED_PACKAGE_STATUSES = new Set(['approved', 'scheduled', 'published', 'completed']);
const ACCOUNT_ROLES = {
  primary: new Set(['owned', 'brand', 'personal']),
  reference: new Set(['competitor', 'inspiration']),
};

export function getAccountRole(account = {}) {
  return String(
    account.account_role || account.account_type || account.account_category || 'owned',
  ).toLowerCase();
}

export function extractCampaignAccountIds(campaign = {}) {
  const metadata = asObject(campaign.metadata);
  const values = [
    metadata.primary_account_id,
    ...(asArray(metadata.competitor_account_ids)),
    ...(asArray(metadata.inspiration_account_ids)),
    ...(asArray(campaign.target_accounts)),
  ];
  return unique(values.map((item) => {
    if (typeof item === 'string') return item;
    return item?.account_id || item?.social_account_id || item?.id;
  }).filter(Boolean));
}

export function normalizeDailyPlan(value) {
  if (!value) return [];
  const entries = Array.isArray(value)
    ? value.map((item, index) => [item?.day || item?.day_label || `Day ${index + 1}`, item])
    : Object.entries(value);

  return entries.map(([key, raw], index) => {
    const item = typeof raw === 'string' ? { topic: raw } : (raw || {});
    const parsedDay = Number(
      item.day_index
      || item.dayIndex
      || String(item.day || item.day_label || key).match(/\d+/)?.[0]
      || index + 1,
    );
    return {
      ...item,
      dayIndex: Number.isFinite(parsedDay) ? parsedDay : index + 1,
      dayLabel: item.day_label || item.day || (/^day/i.test(String(key)) ? key : `Day ${index + 1}`),
      pillar: item.pillar || item.theme || item.topic || item.title || item.content || '',
      platform: item.platform || item.channel || asArray(item.platforms)[0] || '',
    };
  }).sort((left, right) => left.dayIndex - right.dayIndex);
}

export function selectActiveCampaignFromList(campaigns = [], preferredId = '') {
  if (!campaigns.length) return null;
  const preferred = campaigns.find((campaign) => campaign.id === preferredId);
  if (preferred) return preferred;
  const acceptanceCampaign = campaigns.find(
    (campaign) => String(campaign.name || '').trim() === ACCEPTANCE_CAMPAIGN_NAME,
  );
  if (acceptanceCampaign) return acceptanceCampaign;
  if (campaigns.length === 1) return campaigns[0];
  return campaigns.find((campaign) => ACTIVE_STATUSES.has(String(campaign.status || '').toLowerCase()))
    || campaigns[0];
}

export function isHistoricalOrTestCampaign(campaign = {}) {
  const name = String(campaign.name || campaign.title || '').trim();
  if (name === ACCEPTANCE_CAMPAIGN_NAME) return false;
  return /(?:^|\b)(phase\s*[2789]|debug|test|测试数据|回归测试|round[\s_-]*trip|nightly)(?:\b|$)/i.test(name);
}

export function filterCampaignRows(rows = [], campaignId, strategyIds = []) {
  if (!campaignId) return [];
  const strategySet = new Set(strategyIds.filter(Boolean));
  return rows.filter((row) => (
    String(row.campaign_id || '') === String(campaignId)
    || (row.strategy_plan_id && strategySet.has(row.strategy_plan_id))
  ));
}

export function buildCampaignContextFromRows(campaign, rows = {}) {
  if (!campaign) return null;
  const accounts = rows.accounts || [];
  const campaignAccountIds = extractCampaignAccountIds(campaign);
  const linkedAccounts = accounts.filter((account) => campaignAccountIds.includes(account.id));
  const metadata = asObject(campaign.metadata);
  const primaryAccount = linkedAccounts.find((account) => account.id === metadata.primary_account_id)
    || linkedAccounts.find((account) => ACCOUNT_ROLES.primary.has(getAccountRole(account)))
    || linkedAccounts[0]
    || null;
  const competitorAccounts = linkedAccounts.filter(
    (account) => account.id !== primaryAccount?.id && ACCOUNT_ROLES.reference.has(getAccountRole(account)),
  );

  const strategies = (rows.strategies || [])
    .filter((strategy) => String(strategy.campaign_id || '') === String(campaign.id))
    .sort(compareCurrentRecords);
  const currentStrategy = strategies[0] || null;
  const dailyPlan = normalizeDailyPlan(
    currentStrategy?.daily_plan
    || currentStrategy?.plan?.daily_plan
    || currentStrategy?.strategy?.daily_plan,
  );
  const strategyIds = strategies.map((strategy) => strategy.id);
  const contentPackages = filterCampaignRows(rows.contentPackages, campaign.id, strategyIds)
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));
  const packageIds = new Set(contentPackages.map((item) => item.id));
  const publishTasks = (rows.publishTasks || []).filter(
    (task) => task.content_package_id && packageIds.has(task.content_package_id),
  );
  const publishTaskIds = new Set(publishTasks.map((task) => task.id));
  const mediaAssets = (rows.mediaAssets || []).filter((asset) => (
    String(asset.campaign_id || '') === String(campaign.id)
    || packageIds.has(asset.content_package_id)
    || strategyIds.includes(asset.strategy_plan_id)
  ));
  const contentItems = (rows.contentItems || []).filter((item) => (
    packageIds.has(item.content_package_id)
    || publishTasks.some((task) => task.content_id && task.content_id === item.id)
  ));
  const metrics = (rows.contentMetrics || []).filter((metric) => (
    packageIds.has(metric.content_package_id)
    || publishTaskIds.has(metric.publish_task_id)
    || contentItems.some((item) => item.id === metric.content_id)
  ));
  const publishMetrics = (rows.publishMetrics || []).filter(
    (metric) => publishTaskIds.has(metric.publish_task_id || metric.id),
  );
  const reports = (rows.accountReports || []).filter(
    (report) => campaignAccountIds.includes(report.social_account_id || report.account_id),
  ).sort(compareCurrentRecords);
  const insights = (rows.insights || []).filter(
    (item) => String(item.campaign_id || asObject(item.metadata).campaign_id || '') === String(campaign.id),
  );
  const characters = rows.characters || [];
  const characterBindings = contentPackages.map((contentPackage) => {
    const image = asObject(contentPackage.image_requirements);
    const video = asObject(contentPackage.video_requirements);
    const characterId = image.character_id || video.character_id || contentPackage.character_id;
    return {
      contentPackageId: contentPackage.id,
      characterId: characterId || null,
      character: characters.find((item) => item.id === characterId) || null,
      lora: image.lora || image.lora_info || video.lora || video.lora_info || null,
    };
  }).filter((item) => item.characterId || item.lora);

  const context = {
    campaign,
    primaryAccount,
    competitorAccounts,
    accountBrain: primaryAccount?.brain_data || reports[0] || null,
    currentStrategy,
    dailyPlan,
    contentPackages,
    contentItems,
    characterBindings,
    mediaAssets,
    publishTasks,
    metricsSummary: summarizeMetrics(metrics, publishMetrics),
    insights,
  };
  context.blockingItems = getCampaignBlockingItems(context);
  context.progress = getCampaignProgress(context);
  return context;
}

export function getCampaignBlockingItems(context) {
  if (!context?.campaign) return [{ code: 'campaign_missing', label: '尚未选择运营活动' }];
  const items = [];
  if (!context.primaryAccount) items.push({ code: 'primary_account_missing', label: '尚未关联主运营账号' });
  if (!context.accountBrain) items.push({ code: 'account_brain_missing', label: '主账号分析报告尚未完成' });
  if (!context.currentStrategy) items.push({ code: 'strategy_missing', label: '尚未生成运营策略' });
  if (context.currentStrategy && context.dailyPlan.length < 7) {
    items.push({ code: 'daily_plan_missing', label: '策略尚未形成完整的 7 天计划' });
  }
  const dayOne = findDayOnePackage(context);
  if (!dayOne) items.push({ code: 'day1_package_missing', label: '尚未创建 Day 1 内容包' });
  if (dayOne && !hasCopy(dayOne)) items.push({ code: 'day1_copy_missing', label: 'Day 1 文案尚未完成' });
  const dayOneBinding = dayOne && context.characterBindings.find((item) => item.contentPackageId === dayOne.id);
  if (dayOne && !dayOneBinding?.characterId) items.push({ code: 'day1_character_missing', label: 'Day 1 尚未绑定角色 / LoRA' });
  if (dayOne && !context.mediaAssets.some((asset) => asset.content_package_id === dayOne.id && isUsableAsset(asset))) {
    items.push({ code: 'day1_asset_missing', label: 'Day 1 尚无可用素材' });
  }
  if (dayOne && !REVIEWED_PACKAGE_STATUSES.has(packageStatus(dayOne))) {
    items.push({ code: 'day1_review_missing', label: 'Day 1 尚未通过人工审核' });
  }
  if (dayOne && !context.publishTasks.some((task) => task.content_package_id === dayOne.id)) {
    items.push({ code: 'day1_publish_missing', label: 'Day 1 尚未进入发布流程' });
  }
  if (dayOne && !hasMetrics(context, dayOne.id)) {
    items.push({ code: 'day1_metrics_missing', label: 'Day 1 尚未回收发布指标' });
  }
  return items;
}

export function getCampaignProgress(context) {
  const dayOne = findDayOnePackage(context);
  const dayOneAsset = dayOne && context?.mediaAssets?.some(
    (asset) => asset.content_package_id === dayOne.id && isUsableAsset(asset),
  );
  const dayOneTask = dayOne && context?.publishTasks?.find((task) => task.content_package_id === dayOne.id);
  const stages = [
    { key: 'benchmark', label: '对标分析', complete: Boolean(context?.accountBrain) },
    { key: 'strategy', label: '策略', complete: Boolean(context?.currentStrategy) },
    { key: 'plan', label: '7 天计划', complete: (context?.dailyPlan?.length || 0) >= 7 },
    { key: 'content', label: 'Day 1 内容', complete: Boolean(dayOne && hasCopy(dayOne)) },
    { key: 'asset', label: 'Day 1 素材', complete: Boolean(dayOneAsset) },
    { key: 'review', label: 'Day 1 审核', complete: Boolean(dayOne && REVIEWED_PACKAGE_STATUSES.has(packageStatus(dayOne))) },
    { key: 'publish', label: 'Day 1 发布', complete: Boolean(dayOneTask && String(dayOneTask.status).toLowerCase() === 'published') },
    { key: 'metrics', label: 'Day 1 数据回收', complete: Boolean(dayOne && hasMetrics(context, dayOne.id)) },
  ];
  const currentIndex = stages.findIndex((stage) => !stage.complete);
  return {
    stages,
    completed: stages.filter((stage) => stage.complete).length,
    total: stages.length,
    percent: Math.round((stages.filter((stage) => stage.complete).length / stages.length) * 100),
    currentStage: currentIndex === -1 ? '最小闭环已完成' : stages[currentIndex].label,
  };
}

export async function listCampaigns(userId, { status } = {}) {
  if (!userId) return [];
  let query = requireSupabase()
    .from('campaigns')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function getCampaign(userId, campaignId) {
  if (!userId || !campaignId) return null;
  const { data, error } = await requireSupabase()
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getActiveCampaign(userId, preferredId = '') {
  const campaigns = await listCampaigns(userId);
  return selectActiveCampaignFromList(campaigns, preferredId);
}

export async function setActiveCampaign(userId, campaignId) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) throw new Error('该运营活动不存在或你没有访问权限。');
  return campaign;
}

export async function getCampaignContext(userId, campaignId) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) return null;
  const client = requireSupabase();
  const queries = {
    accounts: client.from('social_accounts').select('*').eq('user_id', userId),
    strategies: client.from('strategy_plans').select('*').eq('campaign_id', campaign.id),
    contentPackages: client.from('content_packages').select('*').eq('campaign_id', campaign.id),
    mediaAssets: client.from('asset_library').select('*').eq('campaign_id', campaign.id),
    contentItems: client.from('content_library').select('*').eq('user_id', userId),
    characters: client.from('characters').select('*').eq('user_id', userId),
    insights: client.from('insights').select('*').eq('campaign_id', campaign.id),
  };
  const baseRows = {};
  await Promise.all(Object.entries(queries).map(async ([key, query]) => {
    const { data, error } = await query;
    if (error) throw error;
    baseRows[key] = data || [];
  }));

  const accountIds = extractCampaignAccountIds(campaign);
  const strategyIds = baseRows.strategies.map((item) => item.id);
  if (strategyIds.length) {
    const { data } = await client.from('content_packages').select('*').in('strategy_plan_id', strategyIds);
    baseRows.contentPackages = uniqueById([...baseRows.contentPackages, ...(data || [])]);
  }
  const packageIds = baseRows.contentPackages.map((item) => item.id);
  const followups = await Promise.all([
    accountIds.length
      ? client.from('account_intelligence_reports').select('*').in('account_id', accountIds)
      : Promise.resolve({ data: [] }),
    packageIds.length
      ? client.from('publish_tasks').select('*').in('content_package_id', packageIds)
      : Promise.resolve({ data: [] }),
    packageIds.length
      ? client.from('content_metrics').select('*').in('content_package_id', packageIds)
      : Promise.resolve({ data: [] }),
    packageIds.length
      ? client.from('asset_library').select('*').in('content_package_id', packageIds)
      : Promise.resolve({ data: [] }),
  ]);
  baseRows.accountReports = followups[0].data || [];
  baseRows.publishTasks = followups[1].data || [];
  baseRows.contentMetrics = followups[2].data || [];
  baseRows.mediaAssets = uniqueById([...baseRows.mediaAssets, ...(followups[3].data || [])]);
  const taskIds = baseRows.publishTasks.map((item) => item.id);
  baseRows.publishMetrics = taskIds.length
    ? (await client.from('publish_metrics').select('*').in('publish_task_id', taskIds)).data || []
    : [];
  return buildCampaignContextFromRows(campaign, baseRows);
}

function findDayOnePackage(context) {
  return context?.contentPackages?.find((item) => {
    const values = [
      item.day_index,
      asObject(item.metadata).day_index,
      asObject(item.source_insights).day_index,
      String(item.title || '').match(/day\s*1\b/i)?.[0],
    ];
    return values.some((value) => Number(value) === 1 || /day\s*1/i.test(String(value || '')));
  }) || context?.contentPackages?.[0] || null;
}

function hasCopy(item) {
  return Boolean(item?.body || item?.content || item?.content_text || item?.caption || item?.hook);
}

function packageStatus(item) {
  return String(item?.review_status || item?.status || 'draft').toLowerCase();
}

function isUsableAsset(asset) {
  return ['completed', 'approved', 'ready', 'published'].includes(String(asset.status || asset.review_status || '').toLowerCase())
    || Boolean(asset.output_url || asset.url || asset.storage_path);
}

function hasMetrics(context, packageId) {
  return Boolean(context?.metricsSummary?.byPackage?.[packageId]);
}

function summarizeMetrics(contentMetrics = [], publishMetrics = []) {
  const byPackage = {};
  for (const metric of contentMetrics) {
    if (metric.content_package_id) byPackage[metric.content_package_id] = metric;
  }
  return {
    contentMetrics,
    publishMetrics,
    byPackage,
    totals: [...contentMetrics, ...publishMetrics].reduce((totals, item) => ({
      impressions: totals.impressions + Number(item.impressions || item.views || item.reach || 0),
      engagements: totals.engagements + Number(item.engagements || item.likes || 0),
    }), { impressions: 0, engagements: 0 }),
  };
}

function compareCurrentRecords(left, right) {
  const priority = { active: 0, approved: 1, review: 2, draft: 3, completed: 4, archived: 5 };
  const statusDelta = (priority[String(left.status).toLowerCase()] ?? 9)
    - (priority[String(right.status).toLowerCase()] ?? 9);
  if (statusDelta) return statusDelta;
  return String(right.updated_at || right.created_at || '').localeCompare(
    String(left.updated_at || left.created_at || ''),
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values) {
  return [...new Set(values)];
}

function uniqueById(rows) {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}
