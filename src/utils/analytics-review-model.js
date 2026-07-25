export const ANALYTICS_METRICS = [
  { key: 'impressions', label: '曝光', aliases: ['impressions', 'views', 'reach'] },
  { key: 'likes', label: '点赞', aliases: ['likes'] },
  { key: 'comments', label: '评论', aliases: ['comments', 'replies'] },
  { key: 'shares', label: '转发', aliases: ['shares', 'reposts'] },
  { key: 'saves', label: '收藏', aliases: ['saves', 'bookmarks'] },
  { key: 'profile_visits', label: '主页访问', aliases: ['profile_visits', 'profile_views'] },
  { key: 'link_clicks', label: '链接点击', aliases: ['link_clicks', 'clicks'] },
  { key: 'follows', label: '新增关注', aliases: ['follows', 'new_followers'] },
  { key: 'registrations', label: '注册', aliases: ['registrations', 'signups'] },
  { key: 'conversions', label: '转化', aliases: ['conversions'] },
];

export const ANALYTICS_DIMENSIONS = [
  { key: 'campaign', label: '运营活动' },
  { key: 'account', label: '账号' },
  { key: 'day', label: 'Day' },
  { key: 'content', label: '内容' },
  { key: 'platform', label: '平台' },
  { key: 'contentType', label: '内容类型' },
  { key: 'hook', label: 'Hook' },
  { key: 'assetType', label: '素材类型' },
  { key: 'publishedAt', label: '发布时间' },
];

export function metricContainer(item = {}) {
  return item.metrics?.values
    || item.metrics_json?.values
    || item.metrics
    || item.metrics_json
    || {};
}

export function readMetric(item, metricKey) {
  const definition = ANALYTICS_METRICS.find((entry) => entry.key === metricKey);
  if (!definition) return { status: 'unavailable', value: null };
  const availability = item.metrics?.availability?.[metricKey]
    || item.metrics_json?.availability?.[metricKey];
  if (availability?.status === 'unavailable') {
    return { status: 'unavailable', value: null, reason: availability.reason || '平台暂不提供' };
  }

  const containers = [metricContainer(item), item];
  for (const container of containers) {
    for (const alias of definition.aliases) {
      const raw = container?.[alias];
      if (raw === null || raw === undefined || raw === '') continue;
      const value = Number(raw);
      if (Number.isFinite(value)) return { status: 'available', value };
    }
  }
  return { status: 'unavailable', value: null, reason: '平台暂不提供' };
}

export function aggregateMetrics(rows = []) {
  return Object.fromEntries(ANALYTICS_METRICS.map((metric) => {
    const values = rows.map((row) => readMetric(row, metric.key)).filter((entry) => entry.status === 'available');
    return [
      metric.key,
      values.length
        ? { status: 'available', value: values.reduce((sum, entry) => sum + entry.value, 0), sampleCount: values.length }
        : { status: 'unavailable', value: null, sampleCount: 0 },
    ];
  }));
}

export function normalizeAnalyticsRow(item = {}, context = {}) {
  const packageItem = context.packageById?.get(String(item.content_package_id || '')) || {};
  const task = context.taskById?.get(String(item.publish_task_id || item.publish_task_id || '')) || {};
  const sourceInsights = packageItem.source_insights || {};
  const day = Number(sourceInsights.day_index || sourceInsights.day || readDay(packageItem.title));
  return {
    id: item.id || item.publish_task_id,
    campaign: context.campaignName || '当前运营活动',
    account: context.accountName || '运营账号未关联',
    day: Number.isFinite(day) && day > 0 ? `Day ${day}` : 'Day 未标注',
    content: packageItem.title || item.title || item.content_ref || item.platform_post_id || '内容表现',
    platform: item.platform || task.platform || packageItem.platform || '平台未标注',
    contentType: sourceInsights.format || sourceInsights.content_type || packageItem.content_type || '未标注',
    hook: packageItem.hook || sourceInsights.hook_type || '未标注',
    assetType: readAssetType(packageItem, task),
    publishedAt: task.published_at || task.publish_time || task.scheduled_at || item.fetched_at || item.last_sync || null,
    metrics: Object.fromEntries(ANALYTICS_METRICS.map((metric) => [metric.key, readMetric(item, metric.key)])),
    raw: item,
  };
}

export function filterAnalyticsRows(rows = [], dimension = 'all', value = 'all') {
  if (dimension === 'all' || value === 'all') return rows;
  return rows.filter((row) => String(row[dimension] || '') === String(value));
}

export function buildReviewSuggestions(review = {}) {
  const findings = Array.isArray(review.findings) ? review.findings : [];
  return findings.slice(0, 3).map((finding, index) => ({
    id: finding.id || `finding-${index + 1}`,
    conclusion: finding.conclusion || finding.title || '待补充结论',
    evidence: finding.evidence || '尚无可引用证据',
    sampleCount: Number(finding.sample_count || review.sample_count || 0),
    confidence: normalizeConfidence(finding.confidence ?? review.confidence),
    scope: finding.scope || review.scope || '当前 Campaign · Day 1',
    dataStatus: normalizeFindingStatus(finding.classification || finding.status),
    recommendedAction: finding.recommended_action || finding.next_action || '保留为待验证假设',
  }));
}

export function isSmallSample(rows = [], threshold = 3) {
  return rows.length > 0 && rows.length < threshold;
}

function readDay(title) {
  const match = String(title || '').match(/day\s*(\d+)/i);
  return match ? Number(match[1]) : NaN;
}

function readAssetType(packageItem, task) {
  const publishContent = task.publish_content || {};
  if (publishContent.video_url || packageItem.video_requirements?.selected_asset_id) return '视频';
  if (publishContent.media_url || publishContent.image_url || packageItem.image_requirements?.selected_asset_id) return '图片';
  return '纯文字';
}

function normalizeConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.round((number <= 1 ? number * 100 : number) * 10) / 10;
}

function normalizeFindingStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['verified', 'validated', 'verified_conclusion'].includes(status)) return '已验证';
  if (['preliminary', 'initial_signal', 'signal'].includes(status)) return '初步信号';
  return '待验证';
}
