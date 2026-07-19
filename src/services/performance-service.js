import { requireSupabase } from './supabase-client';
import { createAuditLog } from './stability-service';

const metricSelect = '*, content_library(title, content_type, platform, account_category, media_url)';
const strategySelect = '*';
const campaignLinkSelect = '*, content_library(title, content_type, platform)';

export async function listContentMetrics(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('content_metrics')
    .select(metricSelect)
    .eq('user_id', userId)
    .order('collected_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.contentId) query = query.eq('content_id', filters.contentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createContentMetric(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_metrics')
    .insert({
      user_id: userId,
      content_id: payload.content_id,
      platform: payload.platform,
      views: Number(payload.views || 0),
      likes: Number(payload.likes || 0),
      comments: Number(payload.comments || 0),
      shares: Number(payload.shares || 0),
      clicks: Number(payload.clicks || 0),
      registrations: Number(payload.registrations || 0),
      revenue: Number(payload.revenue || 0),
      collected_at: payload.collected_at || new Date().toISOString(),
    })
    .select(metricSelect)
    .single();

  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'campaign',
    entity_id: data.id,
    action: 'create',
    after_data: data,
  });
  return data;
}

export async function deleteContentMetric(metricId) {
  const client = requireSupabase();
  const { error } = await client.from('content_metrics').delete().eq('id', metricId);
  if (error) throw error;
}

export async function listCampaignLinks(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('campaign_links')
    .select(campaignLinkSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.contentId) query = query.eq('content_id', filters.contentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createCampaignLink(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('campaign_links')
    .insert({
      user_id: userId,
      content_id: payload.content_id || null,
      platform: payload.platform || 'Telegram',
      utm_source: payload.utm_source || 'telegram',
      utm_campaign: payload.utm_campaign || null,
      url: appendUtmParams(payload.url, {
        utm_source: payload.utm_source || 'telegram',
        utm_campaign: payload.utm_campaign || '',
      }),
      clicks: Number(payload.clicks || 0),
      registrations: Number(payload.registrations || 0),
      revenue: Number(payload.revenue || 0),
    })
    .select(campaignLinkSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updateCampaignLink(id, payload) {
  const client = requireSupabase();
  const updatePayload = cleanPayload({
    content_id: payload.content_id,
    platform: payload.platform,
    utm_source: payload.utm_source,
    utm_campaign: payload.utm_campaign,
    url: payload.url,
    clicks: payload.clicks === undefined ? undefined : Number(payload.clicks || 0),
    registrations: payload.registrations === undefined ? undefined : Number(payload.registrations || 0),
    revenue: payload.revenue === undefined ? undefined : Number(payload.revenue || 0),
    updated_at: new Date().toISOString(),
  });

  const { data, error } = await client
    .from('campaign_links')
    .update(updatePayload)
    .eq('id', id)
    .select(campaignLinkSelect)
    .single();

  if (error) throw error;
  await createAuditLog(data.user_id, {
    entity_type: 'campaign',
    entity_id: id,
    action: 'update',
    after_data: data,
  });
  return data;
}

export async function deleteCampaignLink(id) {
  const client = requireSupabase();
  const { data: before } = await client.from('campaign_links').select('*').eq('id', id).single();
  const { error } = await client.from('campaign_links').delete().eq('id', id);
  if (error) throw error;
  if (before?.user_id) {
    await createAuditLog(before.user_id, {
      entity_type: 'campaign',
      entity_id: id,
      action: 'delete',
      before_data: before,
    });
  }
}

export async function upsertPublishMetrics(userId, publishTaskId, metricsJson) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('publish_metrics')
    .upsert({
      user_id: userId,
      publish_task_id: publishTaskId,
      metrics_json: metricsJson || {},
      last_sync: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listPublishMetrics(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('publish_metrics')
    .select('*, publish_tasks(platform, status, scheduled_time, published_at, content_library(title, content_type))')
    .eq('user_id', userId)
    .order('last_sync', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function listContentStrategies(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_strategies')
    .select(strategySelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createContentStrategy(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_strategies')
    .insert({
      user_id: userId,
      title: payload.title,
      source: payload.source || 'analysis-agent',
      input_data: payload.input_data || {},
      optimization_strategy: payload.optimization_strategy || {},
    })
    .select(strategySelect)
    .single();

  if (error) throw error;
  return data;
}

export function summarizePerformance(metrics, publishMetrics = []) {
  const totals = metrics.reduce(
    (sum, metric) => ({
      views: sum.views + Number(metric.views || 0),
      likes: sum.likes + Number(metric.likes || 0),
      comments: sum.comments + Number(metric.comments || 0),
      shares: sum.shares + Number(metric.shares || 0),
      clicks: sum.clicks + Number(metric.clicks || 0),
      registrations: sum.registrations + Number(metric.registrations || 0),
      revenue: sum.revenue + Number(metric.revenue || 0),
    }),
    { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, registrations: 0, revenue: 0 },
  );

  const topContent = [...metrics].sort(metricScore).at(0);
  const platformMap = groupMetrics(metrics, (metric) => metric.platform || 'Unknown');
  const contentTypeMap = groupMetrics(metrics, (metric) => metric.content_library?.content_type || 'unknown');
  const accountMap = groupMetrics(metrics, (metric) => metric.content_library?.account_category || 'unknown');
  const topPlatform = topEntry(platformMap, (value) => value.revenue || value.views);
  const topAccount = topEntry(accountMap, (value) => value.registrations || value.revenue || value.views);
  const topContentType = topEntry(contentTypeMap, (value) => value.views + value.clicks + value.registrations * 10);

  return {
    totals,
    metricsCount: metrics.length,
    publishMetricSyncs: publishMetrics.length,
    topContentTitle: topContent?.content_library?.title || '—',
    topContentScore: topContent ? scoreMetric(topContent) : 0,
    topPlatform: topPlatform?.key || '—',
    platformRoi: totals.clicks ? Number((totals.revenue / totals.clicks).toFixed(2)) : 0,
    topAccount: topAccount?.key || '—',
    topContentType: topContentType?.key || '—',
    platformRows: Object.entries(platformMap).map(([platform, value]) => ({ platform, ...value })),
    accountRows: Object.entries(accountMap).map(([account, value]) => ({ account, ...value })),
    contentTypeRows: Object.entries(contentTypeMap).map(([contentType, value]) => ({ contentType, ...value })),
  };
}

export function summarizeConversions(campaignLinks = []) {
  const totals = campaignLinks.reduce(
    (sum, link) => ({
      clicks: sum.clicks + Number(link.clicks || 0),
      registrations: sum.registrations + Number(link.registrations || 0),
      revenue: sum.revenue + Number(link.revenue || 0),
    }),
    { clicks: 0, registrations: 0, revenue: 0 },
  );

  return {
    ...totals,
    conversionRate: totals.clicks ? Number(((totals.registrations / totals.clicks) * 100).toFixed(1)) : 0,
    revenuePerClick: totals.clicks ? Number((totals.revenue / totals.clicks).toFixed(2)) : 0,
  };
}

export function buildOptimizationStrategy(metrics, viralContents = []) {
  const summary = summarizePerformance(metrics);
  const bestMetric = [...metrics].sort(metricScore).at(0);
  const bestViral = [...viralContents].sort((a, b) => Number(b.views || 0) - Number(a.views || 0)).at(0);

  return {
    focus: summary.topPlatform === '—' ? '先积累至少 3 条内容表现数据。' : `优先强化 ${summary.topPlatform} 上的高表现内容。`,
    best_content: bestMetric?.content_library?.title || null,
    best_viral_reference: bestViral?.title || bestViral?.url || null,
    platform_roi: summary.platformRoi,
    recommendations: [
      summary.topContentType !== '—' ? `优先复用 ${summary.topContentType} 类型内容结构。` : '先标记每条内容的内容类型，便于后续排行。',
      summary.totals.registrations > 0 ? '把有注册转化的内容拆成 Hook / CTA / 素材三段模板。' : '下一批内容需要补强 CTA，并记录 clicks 与 registrations。',
      bestViral ? '用爆款库内容对照自己的最高表现内容，生成可复刻开头和视觉脚本。' : '继续采集爆款内容，让 Analysis Agent 有外部参照。',
    ],
  };
}

export function buildRoiOptimizationStrategy(metrics, viralContents = [], campaignLinks = []) {
  const base = buildOptimizationStrategy(metrics, viralContents);
  const conversions = summarizeConversions(campaignLinks);
  return {
    ...base,
    roi: {
      clicks: conversions.clicks,
      registrations: conversions.registrations,
      revenue: conversions.revenue,
      conversion_rate: conversions.conversionRate,
      revenue_per_click: conversions.revenuePerClick,
    },
    recommendations: [
      ...base.recommendations,
      conversions.clicks > 0 && conversions.registrations === 0
        ? 'Telegram 链接已有点击但无注册：优先检查落地页承诺、注册入口和首屏 CTA。'
        : '为每条 Telegram 发布绑定 campaign_link，持续记录点击、注册和收入。',
      conversions.revenue > 0
        ? '把有收入的帖子拆解为“主题 / Hook / CTA / 发布时间”模板，进入下一轮内容生成。'
        : '当前收入数据不足，先用 clicks 与 registrations 判断内容质量，再补 revenue 回传。',
    ],
  };
}

function groupMetrics(metrics, keyFn) {
  return metrics.reduce((map, metric) => {
    const key = keyFn(metric);
    const current = map[key] || { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, registrations: 0, revenue: 0 };
    map[key] = {
      views: current.views + Number(metric.views || 0),
      likes: current.likes + Number(metric.likes || 0),
      comments: current.comments + Number(metric.comments || 0),
      shares: current.shares + Number(metric.shares || 0),
      clicks: current.clicks + Number(metric.clicks || 0),
      registrations: current.registrations + Number(metric.registrations || 0),
      revenue: current.revenue + Number(metric.revenue || 0),
    };
    return map;
  }, {});
}

function topEntry(map, scoreFn) {
  return Object.entries(map)
    .map(([key, value]) => ({ key, value, score: scoreFn(value) }))
    .sort((a, b) => b.score - a.score)
    .at(0);
}

function metricScore(a, b) {
  return scoreMetric(b) - scoreMetric(a);
}

function scoreMetric(metric) {
  return Number(metric.views || 0)
    + Number(metric.likes || 0) * 3
    + Number(metric.comments || 0) * 5
    + Number(metric.shares || 0) * 8
    + Number(metric.clicks || 0) * 10
    + Number(metric.registrations || 0) * 30
    + Number(metric.revenue || 0) * 5;
}

function appendUtmParams(url, params) {
  if (!url) return '';
  try {
    const parsed = new globalThis.URL(url);
    Object.entries(params).forEach(([key, value]) => {
      if (value && !parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
    });
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
