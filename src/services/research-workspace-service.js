// 研究工作台 V2：真实 Supabase 只读数据适配器（SELECT only）
//
// 只通过应用运行时已提供的公开浏览器配置（supabase-client.js）执行 SELECT 读取，
// 绝不执行 insert / update / delete / rpc / storage / realtime，也绝不读取任何
// .env 或凭据。本服务在测试中以注入的 mock client 驱动，测试环境不发起任何网络请求。
//
// 真实后端映射与生产内容情报只读契约一致（对照 src/services/intelligence-service.js
// 的 listCompetitorAccounts / listViralContents / listContentAnalysis 实现，以及
// supabase/migrations/20260720073957_account_intelligence_architecture.sql）：
//   social_accounts（单一账号实体；研究来源取 account_role ∈ {competitor, inspiration}）
//     -> viral_contents.social_account_id（账号关系以 social_accounts 为事实来源）
//     -> content_analysis.viral_content_id（显式外键 content_analysis_viral_content_id_fkey；
//        content_analysis 存在两个指向 viral_contents 的历史外键，必须显式命名规范关系）
// 历史遗留的 competitor_accounts / viral_contents.account_id 关系已被账号情报架构
// 迁移取代，生产实现不使用它，本适配器同样只按现行契约读取。
// 知识卡与可审核 Brief 在后端没有对应数据表，页面必须显式标注
// “当前后端数据不可用”，而不是臆造字段或回退示例数据。

import {
  isSupabaseConfigured,
  requireSupabase,
} from './supabase-client.js';
import {
  RESEARCH_DEMO_ANALYSES,
  RESEARCH_DEMO_BRIEF,
  RESEARCH_DEMO_EVIDENCE,
  RESEARCH_DEMO_KNOWLEDGE,
} from '../data/research-workspace-demo.js';

// 严格 false 的研究管线执行标志：本页不执行任何采集、生成、路由、网络或发布动作。
export const RESEARCH_EXECUTION_FLAGS = Object.freeze({
  generation_executed: false,
  routing_executed: false,
  network_executed: false,
  publish_executed: false,
});

// 与生产 intelligence-service.js 完全一致的只读契约 select 字符串：
//   social_accounts 为单一账号实体；viral_contents 经 social_account_id 关联；
//   content_analysis 到 viral_contents 显式命名规范外键（表内存在两个历史外键）。
const socialAccountSelect = '*, account_profiles(*)';
const viralContentSelect = '*, social_accounts:social_account_id(id,account_name,username,platform,account_role,target_audience,content_strategy,posting_frequency)';
const analysisSelect = '*, viral_contents:viral_contents!content_analysis_viral_content_id_fkey(title,platform,url,views,likes,comments,content_text,published_at,viral_reason,ai_recommendation,social_accounts:social_account_id(account_name,username,platform,account_role))';

const INTELLIGENCE_ACCOUNT_ROLES = Object.freeze(['competitor', 'inspiration']);

// 与生产 getAccountRole 一致：account_role / account_type / account_category 依次取
// 第一个属于研究情报角色的值；都没有时取第一个值，否则视为自有账号（owned）。
function resolveAccountRole(account) {
  const roles = [account.account_role, account.account_type, account.account_category]
    .map((role) => String(role || '').trim().toLowerCase())
    .filter(Boolean);
  return roles.find((role) => INTELLIGENCE_ACCOUNT_ROLES.includes(role)) || roles[0] || 'owned';
}

function isIntelligenceAccount(account) {
  return INTELLIGENCE_ACCOUNT_ROLES.includes(resolveAccountRole(account));
}

// 实际读取的表与字段（结果报告与页面溯源共用，与 fetchResearchWorkspaceData 的实现保持一致）。
export const RESEARCH_READ_SCOPE = Object.freeze({
  ops: 'select_only',
  tables: Object.freeze(['social_accounts', 'viral_contents', 'content_analysis']),
  fields: Object.freeze({
    social_accounts: Object.freeze([
      'id', 'account_name', 'username', 'platform', 'account_role', 'account_type',
      'account_category', 'account_url', 'target_audience', 'content_strategy',
      'posting_frequency', 'followers', 'ops_notes', 'created_at',
      'account_profiles(target_audience, content_direction, content_style, posting_frequency)',
    ]),
    viral_contents: Object.freeze([
      'id', 'social_account_id', 'platform', 'source_platform', 'url', 'title',
      'content_text', 'media_url', 'views', 'likes', 'comments', 'engagement_score',
      'viral_reason', 'content_type', 'ai_recommendation', 'published_at', 'created_at',
      'social_accounts:social_account_id(id, account_name, username, platform, account_role, target_audience, content_strategy, posting_frequency)',
    ]),
    content_analysis: Object.freeze([
      'id', 'viral_content_id', 'content_id', 'social_account_id', 'analysis', 'hook',
      'structure', 'strategy', 'source_platform', 'engagement_score', 'viral_reason',
      'ai_recommendation', 'replication_notes', 'fit_score', 'created_at',
      'viral_contents:viral_contents!content_analysis_viral_content_id_fkey(title, platform, url, views, likes, comments, content_text, published_at, viral_reason, ai_recommendation, social_accounts:social_account_id(account_name, username, platform, account_role))',
    ]),
  }),
  note: '仅使用应用运行时提供的公开浏览器配置执行 SELECT 读取；无写操作、无 RPC、无存储、无实时订阅。',
  knowledge: Object.freeze({
    available: false,
    reason: '当前后端数据不可用：后端没有知识卡数据表，知识卡由知识引擎在本地生成，尚未入库。',
  }),
  brief: Object.freeze({
    available: false,
    reason: '当前后端数据不可用：后端没有 Brief 数据表，可审核 Brief 由知识引擎在本地生成并等待人工审核。',
  }),
});

function emptyCounts() {
  return { sources: 0, evidence: 0, analyses: 0, knowledge: 0, brief: 0 };
}

function emptyKnowledge() {
  return { available: false, items: [], reason: RESEARCH_READ_SCOPE.knowledge.reason };
}

function emptyBrief() {
  return { available: false, data: null, reason: RESEARCH_READ_SCOPE.brief.reason };
}

function buildProvenance() {
  return {
    ops: RESEARCH_READ_SCOPE.ops,
    tablesRead: [...RESEARCH_READ_SCOPE.tables],
    note: RESEARCH_READ_SCOPE.note,
  };
}

function buildBaseView(status, extra = {}) {
  return {
    status,
    counts: emptyCounts(),
    sources: [],
    evidence: [],
    analyses: [],
    knowledge: emptyKnowledge(),
    brief: emptyBrief(),
    provenance: buildProvenance(),
    executionFlags: RESEARCH_EXECUTION_FLAGS,
    error: null,
    ...extra,
  };
}

// 当前运行时的实时后端配置状态（页面据此区分“已配置 / 未配置”）。
export function getResearchRuntimeStatus() {
  return {
    configured: isSupabaseConfigured,
    readOnly: true,
  };
}

// 显式构建“读取失败”视图：状态与错误信息如实呈现，绝不含示例数据。
export function buildReadErrorView(message) {
  return buildBaseView('read_error', {
    error: { message: String(message || '读取实时后端数据失败。') },
  });
}

/**
 * 读取真实只读数据并组合为 evidence -> analysis -> knowledge -> Brief 视图。
 *
 * 参数均可注入以便测试（测试使用 mock client，不发任何网络请求）：
 *   - client:     Supabase 查询客户端（默认取运行时 requireSupabase()）
 *   - userId:     当前登录用户 id（由页面从既有 auth/session 上下文传入）
 *   - configured: 是否已配置（默认取运行时 isSupabaseConfigured）
 *
 * 返回状态：not_configured / not_signed_in / read_error / empty / live。
 * 任何读取失败都返回 read_error，绝不静默回退示例数据。
 */
export async function fetchResearchWorkspaceData({ client, userId, configured } = {}) {
  const isConfigured = configured === undefined ? isSupabaseConfigured : configured;

  if (!isConfigured) {
    return buildBaseView('not_configured', {
      configured: false,
      signedIn: false,
      note: '实时后端未配置：设置 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY（公开浏览器配置）后刷新本页。',
    });
  }

  if (!userId) {
    return buildBaseView('not_signed_in', {
      configured: true,
      signedIn: false,
      note: '已配置实时后端，但当前没有已恢复的登录会话：请先在应用内完成登录后再回来查看实时数据。',
    });
  }

  const supabaseClient = client || requireSupabase();

  const readSocialAccounts = async () => {
    let query = supabaseClient
      .from('social_accounts')
      .select(socialAccountSelect)
      .eq('user_id', userId);
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(`读取 social_accounts 失败：${error.message}`);
    return (data || []).filter(isIntelligenceAccount);
  };

  const readViralContents = async () => {
    let query = supabaseClient
      .from('viral_contents')
      .select(viralContentSelect)
      .eq('user_id', userId);
    query = query.order('engagement_score', { ascending: false });
    query = query.limit(50);
    const { data, error } = await query;
    if (error) throw new Error(`读取 viral_contents 失败：${error.message}`);
    return data || [];
  };

  const readContentAnalysis = async () => {
    let query = supabaseClient
      .from('content_analysis')
      .select(analysisSelect)
      .eq('user_id', userId);
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(`读取 content_analysis 失败：${error.message}`);
    return data || [];
  };

  let accounts;
  let viralContents;
  let analyses;
  try {
    [accounts, viralContents, analyses] = await Promise.all([
      readSocialAccounts(),
      readViralContents(),
      readContentAnalysis(),
    ]);
  } catch (readError) {
    return buildReadErrorView(readError.message);
  }

  if (accounts.length === 0 && viralContents.length === 0 && analyses.length === 0) {
    return buildBaseView('empty', {
      configured: true,
      signedIn: true,
      note: '实时后端为空：当前账号还没有任何来源、爆款内容或分析记录，请在内容采集流程产出后再查看。',
    });
  }

  const sources = accounts.map((account) => {
    const profile = (account.account_profiles && account.account_profiles[0]) || {};
    return {
      id: account.id,
      name: account.username || account.account_name,
      platform: account.platform,
      category: resolveAccountRole(account),
      audience: profile.target_audience || account.target_audience,
      followers: Number(account.followers || 0),
      url: account.account_url,
      notes: account.ops_notes,
      provenance: '表 social_accounts（仅 SELECT）',
    };
  });

  const evidence = viralContents.map((content) => ({
    id: content.id,
    name: content.title,
    platform: content.platform,
    url: content.url,
    mediaUrl: content.media_url,
    snippet: content.content_text,
    views: content.views,
    likes: content.likes,
    comments: content.comments,
    engagementScore: content.engagement_score,
    publishedAt: content.published_at,
    accountId: content.social_account_id,
    account: content.social_accounts || null,
    provenance: content.url
      ? `来源链接：${content.url}（仅展示，不请求）`
      : '该记录没有保存来源链接',
  }));

  const evidenceAnalyses = analyses.map((item) => ({
    id: item.id,
    evidenceId: item.viral_content_id,
    title: (item.viral_contents && item.viral_contents.title) || null,
    hook: item.hook,
    structure: item.structure,
    strategy: item.strategy,
    analysis: item.analysis,
    viralReason: item.viral_reason,
    recommendation: item.ai_recommendation || item.recommendation,
    replicationNotes: item.replication_notes,
    fitScore: item.fit_score,
    createdAt: item.created_at,
  }));

  const counts = {
    sources: sources.length,
    evidence: evidence.length,
    analyses: evidenceAnalyses.length,
    knowledge: 0,
    brief: 0,
  };

  return buildBaseView('live', {
    configured: true,
    signedIn: true,
    counts,
    sources,
    evidence,
    analyses: evidenceAnalyses,
    provenance: {
      ops: RESEARCH_READ_SCOPE.ops,
      tablesRead: [...RESEARCH_READ_SCOPE.tables],
      fieldsRead: RESEARCH_READ_SCOPE.fields,
      note: `已读取 ${counts.sources} 个来源、${counts.evidence} 条内容、${counts.analyses} 条分析（仅 SELECT，未执行任何写操作）。`,
    },
  });
}

/**
 * 开发用本地示例回退视图：仅供未配置实时后端时，在用户显式开启“开发用本地示例”后展示。
 * 默认关闭；已配置的运行时绝不会展示本视图，实时读取失败也绝不回退到这里。
 */
export function buildDevFallbackView() {
  return {
    status: 'dev_fallback',
    configured: false,
    signedIn: false,
    devFallback: true,
    counts: {
      sources: RESEARCH_DEMO_EVIDENCE.length,
      evidence: RESEARCH_DEMO_EVIDENCE.length,
      analyses: RESEARCH_DEMO_ANALYSES.length,
      knowledge: RESEARCH_DEMO_KNOWLEDGE.length,
      brief: 1,
    },
    sources: [],
    evidence: RESEARCH_DEMO_EVIDENCE,
    analyses: RESEARCH_DEMO_ANALYSES,
    knowledge: {
      available: true,
      items: RESEARCH_DEMO_KNOWLEDGE,
      reason: '开发用本地示例数据，非实时后端数据。',
    },
    brief: {
      available: true,
      data: RESEARCH_DEMO_BRIEF,
      reason: '开发用本地示例数据，非实时后端数据。',
    },
    provenance: {
      ops: 'local_preview_only',
      tablesRead: [],
      note: '开发用本地示例：仅用于未配置实时后端时的界面预览，不代表任何真实读取或执行。',
    },
    executionFlags: RESEARCH_EXECUTION_FLAGS,
    error: null,
  };
}
