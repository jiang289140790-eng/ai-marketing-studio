import { requireSupabase } from './supabase-client';

const viralContentSelect = '*, competitor_accounts(username,category,audience,followers)';
const analysisSelect = '*, viral_contents(title,platform,url,views,likes,comments,content_text,published_at,viral_reason,ai_recommendation,competitor_accounts(username))';

export async function listCompetitorAccounts(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('competitor_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.category) query = query.ilike('category', `%${filters.category}%`);
  if (filters.search) query = query.or(`username.ilike.%${filters.search}%,notes.ilike.%${filters.search}%,audience.ilike.%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createCompetitorAccount(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('competitor_accounts')
    .insert({
      user_id: userId,
      platform: payload.platform,
      source_platform: payload.source_platform || payload.platform,
      account_type: payload.account_type || 'competitor',
      username: payload.username,
      url: payload.url || null,
      category: payload.category || null,
      audience: payload.audience || null,
      followers: Number(payload.followers || 0),
      content_strategy: payload.content_strategy || null,
      posting_frequency: payload.posting_frequency || null,
      notes: payload.notes || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCompetitorAccount(id) {
  const client = requireSupabase();
  const { error } = await client.from('competitor_accounts').delete().eq('id', id);
  if (error) throw error;
}

export async function listViralContents(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('viral_contents')
    .select(viralContentSelect)
    .eq('user_id', userId)
    .order('engagement_score', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.accountId) query = query.eq('account_id', filters.accountId);
  if (filters.search) query = query.or(`title.ilike.%${filters.search}%,content_text.ilike.%${filters.search}%,viral_reason.ilike.%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createViralContent(userId, payload) {
  const score = calculateEngagementScore(payload);
  const client = requireSupabase();
  const { data, error } = await client
    .from('viral_contents')
    .insert({
      user_id: userId,
      account_id: payload.account_id || null,
      platform: payload.platform,
      source_platform: payload.source_platform || payload.platform,
      url: payload.url || null,
      title: payload.title,
      content_text: payload.content_text || null,
      media_url: payload.media_url || null,
      views: Number(payload.views || 0),
      likes: Number(payload.likes || 0),
      comments: Number(payload.comments || 0),
      content_type: payload.content_type || inferContentType(payload),
      engagement_score: Number(payload.engagement_score || score),
      viral_reason: payload.viral_reason || null,
      ai_recommendation: payload.ai_recommendation || null,
      published_at: payload.published_at || null,
    })
    .select(viralContentSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteViralContent(id) {
  const client = requireSupabase();
  const { error } = await client.from('viral_contents').delete().eq('id', id);
  if (error) throw error;
}

export async function listContentAnalysis(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('content_analysis')
    .select(analysisSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.viralContentId) query = query.eq('viral_content_id', filters.viralContentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createContentAnalysis(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_analysis')
    .insert({
      user_id: userId,
      viral_content_id: payload.viral_content_id || null,
      analysis: payload.analysis || null,
      hook: payload.hook || null,
      structure: payload.structure || null,
      strategy: payload.strategy || null,
      source_platform: payload.source_platform || null,
      engagement_score: Number(payload.engagement_score || 0),
      viral_reason: payload.viral_reason || null,
      content_type: payload.content_type || null,
      ai_recommendation: payload.ai_recommendation || null,
      replication_notes: payload.replication_notes || null,
      fit_score: Number(payload.fit_score || 0),
    })
    .select(analysisSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function analyzeViralContent(userId, viralContent) {
  const hook = extractHook(viralContent);
  const structure = buildStructure(viralContent);
  const viralReason = viralContent.viral_reason || buildViralReason(viralContent);
  const replicationNotes = buildReplicationStrategy(viralContent);
  const fitScore = calculateFitScore(viralContent);
  const recommendation = viralContent.ai_recommendation || buildRecommendation(viralContent, fitScore);

  return createContentAnalysis(userId, {
    viral_content_id: viralContent.id,
    hook,
    structure,
    strategy: replicationNotes,
    source_platform: viralContent.source_platform || viralContent.platform,
    engagement_score: Number(viralContent.engagement_score || calculateEngagementScore(viralContent)),
    viral_reason: viralReason,
    content_type: viralContent.content_type || inferContentType(viralContent),
    ai_recommendation: recommendation,
    replication_notes: replicationNotes,
    fit_score: fitScore,
    analysis: [
      `为什么爆：${viralReason}`,
      `如何复刻：${replicationNotes}`,
      `是否适合我的账号：${recommendation}`,
      `参考指标：${Number(viralContent.views || 0)} views / ${Number(viralContent.likes || 0)} likes / ${Number(viralContent.comments || 0)} comments`,
    ].join('\n\n'),
  });
}

export async function getIntelligenceStats(userId) {
  const [accounts, viralContents, analyses] = await Promise.all([
    listCompetitorAccounts(userId),
    listViralContents(userId),
    listContentAnalysis(userId),
  ]);

  const platformCounts = new Map();
  const accountCounts = new Map();

  for (const item of viralContents) {
    platformCounts.set(item.platform, (platformCounts.get(item.platform) || 0) + 1);
    const username = item.competitor_accounts?.username;
    if (username) accountCounts.set(username, (accountCounts.get(username) || 0) + 1);
  }

  return {
    competitorAccounts: accounts.length,
    viralContents: viralContents.length,
    analyses: analyses.length,
    topPlatform: [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
    topAccount: [...accountCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
  };
}

export function buildIntelligenceStrategy(viralContents) {
  const topItems = viralContents.slice(0, 5);
  const hooks = topItems.map((item) => extractHook(item)).filter(Boolean);

  return {
    kind: 'content_intelligence_strategy',
    source_count: viralContents.length,
    top_platform: topItems[0]?.platform || '—',
    hooks,
    suggestions: [
      '优先复用高互动内容的开头结构，但替换为自己的账号语气和角色设定。',
      '把爆款原因拆成 Hook、视觉、情绪、CTA 四部分，再进入内容生成。',
      '只复刻结构，不复制素材和原文。',
      '把适合度高的内容直接转为 Content Idea，进入内容库 idea 状态。',
    ],
  };
}

function calculateEngagementScore(item) {
  return Number(item.views || 0) + Number(item.likes || 0) * 10 + Number(item.comments || 0) * 20;
}

function calculateFitScore(item) {
  const score = calculateEngagementScore(item);
  if (score >= 100000) return 95;
  if (score >= 30000) return 85;
  if (score >= 10000) return 75;
  if (score >= 3000) return 65;
  return 50;
}

function inferContentType(item) {
  if (item.content_type) return item.content_type;
  if (item.media_url?.match(/\.(mp4|mov|webm)$/i)) return 'video';
  if (item.media_url) return 'image';
  return 'text';
}

function extractHook(viralContent) {
  const text = viralContent.content_text || viralContent.title || '';
  const firstLine = text.split(/\n|。|！|!|\?/).find(Boolean);
  return firstLine || viralContent.title || '未提取到开头钩子';
}

function buildViralReason(viralContent) {
  const signals = [];
  if (Number(viralContent.views || 0) > 10000) signals.push('曝光高');
  if (Number(viralContent.likes || 0) > 500) signals.push('点赞强');
  if (Number(viralContent.comments || 0) > 100) signals.push('评论讨论多');
  if (!signals.length) signals.push('具备可学习结构');
  return `${signals.join('、')}；核心 Hook 是“${extractHook(viralContent)}”。`;
}

function buildStructure(viralContent) {
  return [
    '1. 开头：用问题、反差、结果或痛点抓注意力。',
    '2. 中段：展示过程、证据、案例或对比，压缩信息密度。',
    '3. 结尾：给出行动建议，引导保存、评论、点击或注册。',
    `参考指标：views=${viralContent.views || 0}, likes=${viralContent.likes || 0}, comments=${viralContent.comments || 0}`,
  ].join('\n');
}

function buildReplicationStrategy(viralContent) {
  return [
    `复刻对象：${viralContent.title}`,
    `平台：${viralContent.platform}`,
    '标题策略：保留强结果或强痛点，替换成你的产品/角色语境。',
    '视觉策略：复用节奏和镜头关系，不直接复制素材。',
    '标签策略：拆成品牌词、场景词、痛点词。',
    '发布时间策略：记录发布时间，后续与互动数据做对比。',
  ].join('\n');
}

function buildRecommendation(viralContent, fitScore) {
  if (fitScore >= 80) return '适合进入你的内容库，建议转成 idea 并交给内容生成 Agent。';
  if (viralContent.platform === 'Telegram') return '适合 Telegram 频道做深度拆解，可先做短文版本测试。';
  return '可以作为灵感参考，建议先改写 Hook，不要直接进入发布。';
}
