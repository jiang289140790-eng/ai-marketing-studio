import { supabase } from './supabase-client.js';
import {
  P29_MEDIA_ID_PATTERN,
  P29_MEDIA_KINDS,
  SHA256_PATTERN,
  sha256Hex,
  validateMediaAssets,
  validateSourceMetadata,
} from './p19-contracts.js';
import { addEvidenceBatch } from './p19-workspace-service.js';

export const P22_ASSIST_SCHEMA_VERSION = 'p22_research_assist_v1';
const MAX_MESSAGE = 240;
const SAFE_DETAIL_FIELDS = new Set(['provider', 'stage', 'status', 'run_id', 'run_status', 'reason']);

// ---- P32-B 热门主题搜索：数量与批量导入边界 ----
export const P32_SEARCH_COUNT_DEFAULT = 10;
export const P32_SEARCH_COUNT_MAX = 20;
export const P32_BATCH_IMPORT_MIN = 1;
export const P32_BATCH_IMPORT_MAX = 5;
export const P32_SEARCH_BATCH_ID_PATTERN = /^p32-search-[0-9a-f]{24}$/;
export const P32_REDDIT_SEARCH_BATCH_ID_PATTERN = /^p32-reddit-search-[0-9a-f]{24}$/;

/**
 * P32-B 确定性排序口径（纯展示层，绝不是 X 官方热门榜）：
 * - views / likes / retweets / total_engagement / engagement_rate；
 * - total_engagement = likes + retweets + replies + quotes + bookmarks，只累加已提供的
 *   非负整数；全部缺失时为 null（不可用），绝不伪造为 0；
 * - engagement_rate = total_engagement / views，仅当 views 为正且总互动可用时计算。
 */
export const P32_SEARCH_SORT_KEYS = Object.freeze(['views', 'likes', 'retweets', 'total_engagement', 'engagement_rate']);
export const P32_SEARCH_SORT_LABELS = Object.freeze({
  views: '浏览量',
  likes: '点赞',
  retweets: '转发',
  total_engagement: '总互动',
  engagement_rate: '互动率',
});
export const P32_REDDIT_SORT_KEYS = Object.freeze(['reddit_score', 'reddit_comments', 'reddit_total_engagement', 'reddit_interaction_rate']);
export const P32_REDDIT_SORT_LABELS = Object.freeze({
  reddit_score: 'Reddit score',
  reddit_comments: '评论数',
  reddit_total_engagement: '总互动（score + 评论）',
  reddit_interaction_rate: '互动速率（赞成率，如可用）',
});

/** 只保留服务端有界诊断中的白名单字段；令牌、正文、URL 等一律丢弃。 */
function sanitizeDetails(details) {
  const output = {};
  for (const key of SAFE_DETAIL_FIELDS) {
    const value = details?.[key];
    if (key === 'status') {
      if (Number.isInteger(value) && value >= 100 && value <= 599) output.status = value;
      continue;
    }
    if (typeof value === 'string' && value.length > 0 && value.length <= 80) output[key] = value;
  }
  return output;
}

function safeError(code, message, details = {}, status = null) {
  // M2 脱敏：错误输出不得包含 Bearer 令牌、JWT 或 service_role/secret/token/
  // password 形式的 Secret 值（与命令适配器 redactSensitiveText 同一口径）。
  const error = new Error(String(message || '智能研究服务暂时不可用。')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .replace(/((?:service[_-]?role|secret|token|password))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, MAX_MESSAGE));
  error.code = String(code || 'P22_REQUEST_FAILED').slice(0, 80);
  if (details && typeof details === 'object') error.details = sanitizeDetails(details);
  if (Number.isInteger(status) && status >= 100 && status <= 599) error.status = status;
  return error;
}

export function createP22ResearchAssistClient({ client = supabase } = {}) {
  async function invoke(body) {
    if (!client) throw safeError('P22_NOT_CONFIGURED', 'Supabase staging 尚未配置。');
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (sessionError || !token) throw safeError('AUTH_REQUIRED', '请先登录后使用智能研究。');
    const { data, error } = await client.functions.invoke('p22-research-assist', {
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
    if (error) {
      const context = typeof error.context?.json === 'function' ? await error.context.json().catch(() => null) : null;
      const safeStatus = Number.isInteger(context?.status) ? context.status : Number.isInteger(error.context?.status) ? error.context.status : null;
      if (context && typeof context === 'object' && context.code) {
        throw safeError(context.code, context.message, context.details, safeStatus);
      }
      throw safeError('P22_UPSTREAM_UNAVAILABLE', '智能研究服务暂时不可用。', {}, safeStatus);
    }
    if (!data || data.ok !== true || data.schema_version !== P22_ASSIST_SCHEMA_VERSION) {
      throw safeError(data?.code || 'P22_RESPONSE_INVALID', data?.message || '智能研究返回了无效响应。', data?.details);
    }
    return data;
  }
  return Object.freeze({
    status: () => invoke({ action: 'status' }),
    collect: (topic, count = 5) => invoke({ action: 'collect', topic, count }),
    collectUrl: (url) => invoke({ action: 'collect_url', url }),
    search: (keyword, count = P32_SEARCH_COUNT_DEFAULT, sort = 'latest') => invoke({ action: 'search', keyword, count, sort }),
    searchReddit: (keyword, { count = P32_SEARCH_COUNT_DEFAULT, sort = 'relevance', subreddit = null, timeFilter = 'all' } = {}) => invoke({
      action: 'search_reddit', keyword, count, sort, subreddit, time_filter: timeFilter,
    }),
    analyze: (items) => invoke({ action: 'analyze', items }),
    analyzePersisted: (projectId, evidenceId) => invoke({ action: 'analyze_persisted', project_id: projectId, evidence_id: evidenceId }),
    generateSimilar: (projectId, evidenceId, analysisId) => invoke({ action: 'generate_similar', project_id: projectId, evidence_id: evidenceId, analysis_id: analysisId }),
  });
}

export function looksLikePublicUrl(value) {
  const text = String(value || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  return /^(?:www\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|reddit\.com|linkedin\.com)\//i.test(text)
    || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\//i.test(text);
}

// ---- P32-B 确定性互动指标（纯函数，绝不伪造缺失指标）----

const ENGAGEMENT_SUM_KEYS = ['likes', 'retweets', 'replies', 'quotes', 'bookmarks'];

function providedEngagementCount(item, key) {
  const value = item?.source_metadata?.engagement?.[key];
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 计算单条搜索结果的展示指标。缺失字段保持 null（界面显示「—」），
 * 绝不把缺失指标伪造为 0。
 */
export function computeEngagementMetrics(item) {
  const views = providedEngagementCount(item, 'views');
  const likes = providedEngagementCount(item, 'likes');
  const retweets = providedEngagementCount(item, 'retweets');
  const parts = ENGAGEMENT_SUM_KEYS.map((key) => providedEngagementCount(item, key)).filter((value) => value !== null);
  const totalEngagement = parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null;
  const engagementRate = views !== null && views > 0 && totalEngagement !== null ? totalEngagement / views : null;
  return { views, likes, retweets, total_engagement: totalEngagement, engagement_rate: engagementRate };
}

function searchItemIdentity(item) {
  return `${String(item?.source_url || '')}\0${item?.external_id == null ? '' : String(item.external_id)}\0${String(item?.content_sha256 || '')}`;
}

/**
 * P32-B 确定性稳定排序（纯函数，不修改输入数组）：
 * - 主指标降序；缺失主指标的结果排在可用结果之后；
 * - 主指标相同时按 published_at（缺失后置，较新在前）、完整来源身份
 *   （source_url → external_id → content_sha256 字典序）稳定决序；
 * - 该排序只是本地展示口径，不代表 X 官方热门榜。
 */
export function rankSearchResults(items, sortKey) {
  const key = String(sortKey || '');
  if (!P32_SEARCH_SORT_KEYS.includes(key)) {
    throw safeError('P32_SORT_UNSUPPORTED', '不支持的排序方式。');
  }
  const rows = (Array.isArray(items) ? items : []).map((item) => ({ item, metrics: computeEngagementMetrics(item) }));
  const byMetric = (a, b) => {
    const va = a.metrics[key];
    const vb = b.metrics[key];
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // 缺失后置
    if (vb === null) return -1;
    return vb - va; // 降序
  };
  const byTieBreak = (a, b) => {
    const pa = String(a.item?.source_metadata?.published_at || '');
    const pb = String(b.item?.source_metadata?.published_at || '');
    if (pa && pb) {
      if (pa !== pb) return pa < pb ? 1 : -1; // 较新在前（ISO-8601 字典序 = 时间序）
    } else if (pa && !pb) {
      return -1;
    } else if (!pa && pb) {
      return 1;
    }
    const ia = searchItemIdentity(a.item);
    const ib = searchItemIdentity(b.item);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
  return rows.sort((a, b) => byMetric(a, b) || byTieBreak(a, b)).map((row) => row.item);
}

export function rankRedditSearchResults(items, sortKey) {
  const key = String(sortKey || 'reddit_score');
  if (!P32_REDDIT_SORT_KEYS.includes(key)) throw safeError('P32_SORT_UNSUPPORTED', '不支持的 Reddit 排序方式。');
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => {
    const redditMetric = (item) => {
      const engagement = item?.source_metadata?.engagement || {};
      if (key === 'reddit_total_engagement') {
        return Number.isInteger(engagement.reddit_score) && Number.isInteger(engagement.reddit_comments)
          ? engagement.reddit_score + engagement.reddit_comments
          : null;
      }
      if (key === 'reddit_interaction_rate') return engagement.reddit_upvote_ratio;
      return engagement[key];
    };
    const lv = redditMetric(left);
    const rv = redditMetric(right);
    const leftAvailable = Number.isFinite(lv);
    const rightAvailable = Number.isFinite(rv);
    if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
    if (leftAvailable && rv !== lv) return rv - lv;
    const lp = String(left?.source_metadata?.published_at || '');
    const rp = String(right?.source_metadata?.published_at || '');
    if (lp !== rp) return lp < rp ? 1 : -1;
    return searchItemIdentity(left).localeCompare(searchItemIdentity(right));
  });
}

export function isP22Duplicate(project, item) {
  const sourceUrl = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  return (project?.evidence || []).some((row) => {
    return String(row.source_url || '').trim() === sourceUrl
      && hash
      && String(row.media_metadata?.sha256 || row.provenance?.content_sha256 || '').trim() === hash;
  });
}

export function findP22Evidence(project, item) {
  const sourceUrl = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  return (project?.evidence || []).find((row) => String(row.source_url || '').trim() === sourceUrl
    && hash
    && String(row.media_metadata?.sha256 || row.provenance?.content_sha256 || '').trim() === hash) || null;
}

export function p22ItemFromEvidence(evidence) {
  const provenance = evidence?.provenance;
  if (provenance?.schema_version !== 'p22_apify_evidence_provenance_v1' || provenance.manual !== false) return null;
  return {
    id: provenance.source_id,
    source_url: evidence.source_url,
    label: evidence.label,
    platform: provenance.source_platform || 'x',
    content_text: evidence.content_text,
    external_id: provenance.external_id ?? null,
    content_sha256: provenance.content_sha256,
    source_metadata: evidence.source_metadata !== undefined ? evidence.source_metadata : null,
    media_assets: evidence.media_assets !== undefined ? evidence.media_assets : [],
    collection_proof: provenance.collection_proof,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: provenance.provider,
      run_id: provenance.run_id,
      collected_at: provenance.collected_at,
      usage_total_usd: provenance.usage_total_usd,
      budget_reservation_id: provenance.budget_reservation_id,
    },
  };
}

function requireText(value, field, max) {
  const text = String(value ?? '');
  if (!text.trim() || text.length > max) throw safeError('P22_EVIDENCE_INVALID', `${field} 缺失或超过长度上限。`);
  return text;
}

export async function toP19EvidenceInput(item) {
  const provenance = item?.provenance || {};
  const contentText = requireText(item?.content_text, '来源正文', 5000);
  const declaredHash = String(item?.content_sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredHash) || await sha256Hex(contentText) !== declaredHash) {
    throw safeError('P22_EVIDENCE_HASH_MISMATCH', '来源正文与 SHA-256 不一致，已拒绝保存。');
  }
  const sourceUrl = requireText(item?.source_url, '来源 URL', 1000);
  const collectedAt = requireText(provenance.collected_at, '采集时间', 80);
  const runId = requireText(provenance.run_id, '采集运行 ID', 200);
  const provider = requireText(provenance.provider, '采集提供方', 120);
  const sourcePlatform = String(item?.platform || '').toLowerCase();
  const providerByPlatform = {
    x: 'apify:xquik/x-tweet-scraper',
    reddit: 'apify:endspec/reddit-instant-search-scraper',
  };
  if (!providerByPlatform[sourcePlatform] || provider !== providerByPlatform[sourcePlatform]) throw safeError('P22_EVIDENCE_INVALID', '采集提供方与来源平台不符合 P22/P32 合同。');
  const usageTotalUsd = Number(provenance.usage_total_usd);
  if (!Number.isFinite(usageTotalUsd) || usageTotalUsd < 0 || usageTotalUsd > 10) {
    throw safeError('P22_EVIDENCE_INVALID', '采集费用证据无效。');
  }
  const sourceId = requireText(item?.id, '来源 ID', 160);
  const collectionProof = requireText(item?.collection_proof, '服务端来源证明', 256);
  const externalId = item?.external_id == null ? null : requireText(item.external_id, '平台内容 ID', 160);
  // P29 版本化扩展：来源快照与有序媒体资产随证据持久化（有界；完整性由服务端证明绑定）。
  let sourceMetadata = null;
  if (item.source_metadata !== undefined && item.source_metadata !== null) {
    const snapshot = validateSourceMetadata(item.source_metadata);
    if (!snapshot.valid) throw safeError('P22_EVIDENCE_INVALID', '来源快照不符合 P29 有界契约，已拒绝保存。');
    sourceMetadata = item.source_metadata;
  }
  let mediaAssets = [];
  if (item.media_assets !== undefined) {
    const assets = validateMediaAssets(item.media_assets);
    if (!assets.valid) throw safeError('P22_EVIDENCE_INVALID', '媒体资产不符合 P29 有界契约（越界/重复/乱序/畸形），已拒绝保存。');
    mediaAssets = item.media_assets;
  }
  return {
    source_url: sourceUrl,
    label: String(item.label || (sourcePlatform === 'reddit' ? 'Reddit 公开内容' : 'X 公开内容')).slice(0, 200),
    platform: sourcePlatform === 'reddit' ? 'Reddit · Apify' : 'X · Apify',
    content_text: contentText,
    recorded_at: collectedAt,
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1',
      manual: false,
      method: 'apify_public_collection',
      provider,
      source_platform: sourcePlatform,
      source_id: sourceId,
      external_id: externalId,
      source_url: sourceUrl,
      run_id: runId,
      collected_at: collectedAt,
      usage_total_usd: usageTotalUsd,
      budget_reservation_id: requireText(provenance.budget_reservation_id, '预算预留 ID', 80),
      content_sha256: declaredHash,
      collection_proof: collectionProof,
      statement: `该证据由 P22/P32 通过 Apify 从 ${sourcePlatform === 'reddit' ? 'Reddit' : 'X'} 公开来源采集，并由服务端来源证明绑定正文、身份与采集运行。`,
    },
    media_metadata: {
      filename: `p22-${sourcePlatform}-${String(externalId || sourceId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 150)}.txt`,
      mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(contentText).byteLength,
      last_modified: collectedAt,
      sha256: declaredHash,
    },
    source_metadata: sourceMetadata,
    media_assets: mediaAssets,
  };
}

export async function toP19AttachmentEvidenceInput(item) {
  const provenance = item?.provenance || {};
  if (String(item?.platform || '') !== 'private_attachment') {
    throw safeError('H5_ATTACHMENT_EVIDENCE_INVALID', 'Attachment evidence platform is invalid.');
  }
  const contentText = requireText(item?.content_text, 'attachment extracted content', 5000);
  const contentSha256 = String(item?.content_sha256 || '').toLowerCase();
  if (!SHA256_PATTERN.test(contentSha256) || await sha256Hex(contentText) !== contentSha256) {
    throw safeError('H5_ATTACHMENT_HASH_MISMATCH', 'Attachment evidence content hash is invalid.');
  }
  const bindings = Array.isArray(provenance.object_bindings) ? provenance.object_bindings : [];
  if (bindings.length < 1 || bindings.length > 10) {
    throw safeError('H5_ATTACHMENT_BINDING_INVALID', 'Attachment evidence object bindings are invalid.');
  }
  const seen = new Set();
  for (const binding of bindings) {
    const ref = String(binding?.ref || '');
    if (!/^harness-thread-attachments:[^\s]{1,900}$/.test(ref) || seen.has(ref)
      || typeof binding?.name !== 'string' || !binding.name.trim() || binding.name.length > 200
      || !Number.isSafeInteger(binding?.size) || binding.size < 1 || binding.size > 25 * 1024 * 1024
      || typeof binding?.mime_type !== 'string' || !binding.mime_type.trim() || binding.mime_type.length > 120
      || !SHA256_PATTERN.test(String(binding?.sha256 || ''))) {
      throw safeError('H5_ATTACHMENT_BINDING_INVALID', 'Attachment evidence contains a missing, duplicate, or malformed object binding.');
    }
    seen.add(ref);
  }
  const sourceUrl = requireText(item?.source_url, 'attachment source URL', 1000);
  const collectedAt = requireText(provenance.collected_at, 'attachment verification time', 80);
  const runId = requireText(provenance.run_id, 'attachment task identity', 200);
  const threadId = requireText(provenance.thread_id, 'attachment thread identity', 200);
  const sourceId = requireText(item?.id, 'attachment source identity', 160);
  return {
    source_url: sourceUrl,
    label: String(item.label || `Private attachments (${bindings.length})`).slice(0, 200),
    platform: 'Private attachment (verified)',
    content_text: contentText,
    recorded_at: collectedAt,
    provenance: {
      schema_version: 'h5_verified_attachment_provenance_v1',
      manual: false,
      method: 'verified_private_attachment',
      provider: 'supabase-storage+dashscope',
      source_platform: 'private_attachment',
      source_id: sourceId,
      source_url: sourceUrl,
      run_id: runId,
      thread_id: threadId,
      collected_at: collectedAt,
      usage_total_usd: Number(provenance.usage_total_usd || 0),
      budget_reservation_id: requireText(provenance.budget_reservation_id, 'attachment reservation identity', 80),
      content_sha256: contentSha256,
      collection_proof: requireText(item.collection_proof, 'attachment verification proof', 256),
      object_bindings: bindings.map((binding) => ({
        ref: binding.ref,
        name: binding.name,
        size: binding.size,
        mime_type: binding.mime_type,
        sha256: binding.sha256,
      })),
      statement: 'Private attachments were verified against authenticated Storage objects and analyzed through the bounded H5 server pipeline.',
    },
    media_metadata: {
      filename: `h5-${sourceId}.txt`,
      mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(contentText).byteLength,
      last_modified: collectedAt,
      sha256: contentSha256,
    },
  };
}

// ---- P32-B 批量导入：搜索批次重验证（前端工作区层面的原子门禁）----

/**
 * 找出与搜索结果冲突的既有证据：同一 canonical source URL、同一外部 ID、
 * 或同一正文哈希任一命中即为冲突（同一身份不得产生重复 Evidence）。
 */
export function findConflictingEvidence(project, item) {
  const url = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  const extId = item?.external_id == null ? '' : String(item.external_id);
  return (project?.evidence || []).find((row) => {
    const rowUrl = String(row?.source_url || '').trim();
    const rowHash = String(row?.media_metadata?.sha256 || row?.provenance?.content_sha256 || '').trim();
    const rowExtId = String(row?.provenance?.external_id || '').trim();
    return (url && rowUrl === url) || (hash && rowHash === hash) || (extId && rowExtId === extId);
  }) || null;
}

/**
 * 权威对账：判断一条 P19 证据记录是否与原始搜索结果身份一致（同一来源 URL、
 * 同一外部 ID、或同一正文哈希任一命中）。在线部分失败后必须用重载后的权威
 * Evidence 逐条重新对账（响应丢失但写入已成功的情况绝不能误报为待重试）。
 */
export function evidenceMatchesSearchIdentity(record, item) {
  const url = String(item?.source_url || '').trim();
  const hash = String(item?.content_sha256 || '').trim();
  const extId = item?.external_id == null ? '' : String(item.external_id);
  const rowUrl = String(record?.source_url || '').trim();
  const rowHash = String(record?.media_metadata?.sha256 || record?.provenance?.content_sha256 || '').trim();
  const rowExtId = String(record?.provenance?.external_id || '').trim();
  return (url && rowUrl === url) || (hash && rowHash === hash) || (extId && rowExtId === extId);
}

function requireSearchSourceUrl(value, platform) {
  const text = String(value ?? '').trim();
  let url;
  try {
    url = new globalThis.URL(text);
  } catch {
    throw safeError('P32_ITEM_INVALID', '结果来源 URL 无效，已拒绝导入。');
  }
  const host = url.hostname.toLowerCase();
  const valid = platform === 'reddit'
    ? (host === 'reddit.com' || host === 'www.reddit.com' || host.endsWith('.reddit.com'))
    : ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host);
  if (!valid) {
    throw safeError('P32_ITEM_INVALID', '结果来源平台与 URL 不一致，已拒绝导入。');
  }
  return text;
}

/**
 * 单条搜索结果重验证（fail closed）：正文哈希重算、来源 URL、服务端来源证明
 * 格式与有效期、来源快照与媒体资产形状。任何一条失败即整批拒绝。
 */
export async function validateSearchResultItem(item, { nowMs = Date.now() } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw safeError('P32_ITEM_INVALID', '搜索结果格式无效，已拒绝导入。');
  }
  const declaredHash = String(item.content_sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(declaredHash)) {
    throw safeError('P32_ITEM_INVALID', '结果缺少有效内容哈希，已拒绝导入。');
  }
  const contentText = String(item.content_text || '');
  if (!contentText.trim()) {
    throw safeError('P32_ITEM_INVALID', '结果缺少正文，已拒绝导入。');
  }
  if (await sha256Hex(contentText) !== declaredHash) {
    throw safeError('P32_HASH_MISMATCH', '结果正文与 SHA-256 不一致（内容被篡改），已拒绝导入。');
  }
  const platform = String(item.platform || '').toLowerCase();
  if (!['x', 'reddit'].includes(platform)) throw safeError('P32_ITEM_INVALID', '结果平台无效，已拒绝导入。');
  requireSearchSourceUrl(item.source_url, platform);
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 160) {
    throw safeError('P32_ITEM_INVALID', '结果缺少有效来源 ID，已拒绝导入。');
  }
  const proof = String(item.collection_proof || '');
  const proofMatch = /^(\d{10})\.([0-9a-f]{64})$/i.exec(proof);
  if (!proofMatch) {
    throw safeError('P32_PROOF_INVALID', '结果缺少有效的服务端来源证明，已拒绝导入。');
  }
  if (Number(proofMatch[1]) * 1000 < nowMs) {
    throw safeError('P32_PROOF_EXPIRED', '来源证明已过期，请重新搜索后再导入。');
  }
  if (item.source_metadata !== undefined && item.source_metadata !== null && !validateSourceMetadata(item.source_metadata).valid) {
    throw safeError('P32_ITEM_INVALID', '来源快照不符合有界契约，已拒绝导入。');
  }
  if (item.media_assets !== undefined && !validateMediaAssets(item.media_assets).valid) {
    throw safeError('P32_ITEM_INVALID', '媒体资产不符合有界契约（越界/重复/乱序/畸形），已拒绝导入。');
  }
  return true;
}

/**
 * P32-B 客户端批次身份重算：镜像服务端 searchBatchId 的规范形式（确定性绑定
 * 精确关键词、数量、排序意图、采集运行、采集时间与全部结果的
 * （URL|外部 ID|正文哈希）有序身份集合）。导入端必须重算并比对 batch_id，
 * 而不是只检查正则形状：任何字段缺失、篡改、乱序、错绑都会产生不同身份。
 * 无法确定唯一采集运行（缺运行或运行不一致）时返回 null → 导入失败关闭。
 */
export async function recomputeSearchBatchId(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch) || !Array.isArray(batch.items)) return null;
  if (batch.items.length === 0) return null; // 无结果无法绑定采集运行 → 身份不可确定 → 失败关闭
  const runIds = new Set(batch.items.map((item) => String(item?.provenance?.run_id || '')).filter(Boolean));
  if (runIds.size !== 1) return null; // 缺运行或批次内运行不一致 → 身份不可确定 → 失败关闭
  const runId = [...runIds][0];
  const identities = batch.items
    .map((item) => `${String(item?.source_url || '')}|${item?.external_id == null ? '' : String(item.external_id)}|${String(item?.content_sha256 || '')}`)
    .join(';');
  const isReddit = batch.platform === 'reddit';
  const value = isReddit
    ? `p32-reddit-search-batch\0${String(batch.keyword ?? '')}\0${String(batch.subreddit || '')}\0${String(batch.count ?? '')}\0${String(batch.sort_intent || '')}\0${String(batch.time_filter || '')}\0${String(runId)}\0${String(batch.collected_at || '')}\0${identities}`
    : `p32-search-batch\0${String(batch.keyword ?? '')}\0${String(batch.count ?? '')}\0${String(batch.sort_intent || '')}\0${String(runId)}\0${String(batch.collected_at || '')}\0${identities}`;
  const digestValue = await sha256Hex(value);
  return `${isReddit ? 'p32-reddit-search' : 'p32-search'}-${digestValue.slice(0, 24)}`;
}

/**
 * 搜索批次重验证（原子门禁）：项目 ID、搜索批次 ID（重算绑定内容，绝不只查
 * 正则形状）、结果身份、正文哈希、collection proof、媒体与来源快照。任何结果
 * 已过期、被篡改、乱序或批次元数据被错改时整批失败关闭，当前项目完全不变。
 */
export async function validateSearchBatch({ project, batch, selectedIds, nowMs = Date.now() } = {}) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    throw safeError('P32_BATCH_INVALID', '搜索结果批次缺失或无效，请重新搜索。');
  }
  const expectedPattern = batch.platform === 'reddit' ? P32_REDDIT_SEARCH_BATCH_ID_PATTERN : P32_SEARCH_BATCH_ID_PATTERN;
  if (typeof batch.batch_id !== 'string' || !expectedPattern.test(batch.batch_id)) {
    throw safeError('P32_BATCH_INVALID', '搜索结果批次身份无效，请重新搜索。');
  }
  // 批次身份必须与内容重算一致：乱序结果、篡改正文哈希、错改关键词/数量/
  // 排序/采集时间/采集运行都会产生不同身份，导入端据此失败关闭。
  const recomputed = await recomputeSearchBatchId(batch);
  if (recomputed === null || recomputed !== batch.batch_id) {
    throw safeError('P32_BATCH_INVALID', '搜索结果批次与内容不一致（已重新计算批次身份），请重新搜索后再导入。');
  }
  if (typeof batch.project_id !== 'string' || !project || batch.project_id !== project.id) {
    throw safeError('P32_BATCH_PROJECT_MISMATCH', '结果批次不属于当前研究项目；切换项目后旧选择已被清空，请重新搜索。');
  }
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  if (ids.length < P32_BATCH_IMPORT_MIN || ids.length > P32_BATCH_IMPORT_MAX) {
    throw safeError('P32_SELECTION_OUT_OF_RANGE', `请选择 ${P32_BATCH_IMPORT_MIN}–${P32_BATCH_IMPORT_MAX} 条结果导入。`);
  }
  const batchItems = Array.isArray(batch.items) ? batch.items : [];
  const byId = new Map(batchItems.map((item) => [item.id, item]));
  const uniqueIds = new Set();
  const seenTriple = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || uniqueIds.has(id)) {
      throw safeError('P32_SELECTION_DUPLICATE', '选择中包含重复或无效的结果，已整批拒绝导入。');
    }
    uniqueIds.add(id);
    const item = byId.get(id);
    if (!item) {
      throw safeError('P32_ITEM_NOT_IN_BATCH', '选择的结果不在当前搜索结果批次中（结果已过期、乱序或被替换），已整批拒绝导入。');
    }
    await validateSearchResultItem(item, { nowMs });
    const triple = `${String(item.source_url || '')}|${item.external_id == null ? '' : String(item.external_id)}|${String(item.content_sha256 || '')}`;
    if (seenTriple.has(triple)) {
      throw safeError('P32_DUPLICATE_SOURCE', '所选结果中存在重复来源（同一 URL/外部 ID/正文哈希），已整批拒绝导入。');
    }
    seenTriple.add(triple);
  }
  return ids.map((id) => byId.get(id));
}

/**
 * 把选中的搜索结果按搜索时保存的不可变来源证明批量导入当前项目。
 * 重验证通过后在工作区层面一次性保存（addEvidenceBatch）：任一条无效时
 * 当前项目完全不变。不自动批准 Brief、不自动路由、不生成、不发布。
 *
 * `skipAlreadyImported`（默认 false）：严格模式下已导入身份整批失败关闭
 * （P32_ALREADY_IMPORTED）。在线模式重试必须幂等 —— 同一选择重试只写入
 * 尚未导入的身份，已导入身份跳过并计入 `alreadyImported`，绝不产生重复 Evidence；
 * 全部已导入时返回 imported=0 且不写任何记录。
 */
export async function importSearchSelection({ project, batch, selectedIds, nowMs = Date.now(), skipAlreadyImported = false } = {}) {
  const items = await validateSearchBatch({ project, batch, selectedIds, nowMs });
  const inputs = [];
  let alreadyImported = 0;
  for (const item of items) {
    const conflicting = findConflictingEvidence(project, item);
    if (conflicting) {
      if (!skipAlreadyImported) {
        throw safeError('P32_ALREADY_IMPORTED', `结果「${String(item.label || '').slice(0, 40)}」已导入当前项目（同一 URL/外部 ID/正文哈希），禁止重复导入。`);
      }
      alreadyImported += 1; // 幂等重试：该身份已在权威项目中，跳过，不产生重复记录
      continue;
    }
    inputs.push(await toP19EvidenceInput(item));
  }
  if (inputs.length === 0) {
    return { imported: 0, alreadyImported, project, inputs: [], items };
  }
  const next = await addEvidenceBatch(project, inputs);
  return { imported: inputs.length, alreadyImported, project: next, inputs, items };
}

// ---- P38 旧视频证据恢复：严格媒体可分析性判定与原位恢复链 ----
//
// 旧合同（P29 早期）保存的 X 视频证据可渲染播放器，但其媒体绑定（URL 哈希、
// t.co 短链、非白名单主机、类型/MIME 失配、缺失内容字节）未经过真实内容验证，
// 绝不能直接交给 Qwen。P38 提供：
// - assessMediaAnalyzability：唯一、失败关闭的媒体可分析性判定（纯函数）；
// - bindRehydratedItemToEvidence：重新采集结果与当前 Evidence 的精确一对一
//   身份绑定（缺失/重复/错绑立即失败关闭，纯函数）；
// - rehydrateEvidenceMediaAndAnalyze：原位恢复链 —— 一次 collect_url →
//   唯一身份绑定 → 一次 evidence.update（不创建新证据）→ 权威在线读取确认
//   同一 evidence_id 的新版本与媒体指纹 → 之后才 analyze_persisted（仅预览）。
// 所有错误为有界、脱敏的结构化错误；绝不输出 token、Secret、Authorization、
// 媒体签名参数或上游原始响应（错误文案不包含任何 URL 或哈希值）。

/** P38 严格媒体 CDN 白名单（与服务端 fetchMediaContentHash 完全一致）。 */
export const P38_MEDIA_CDN_ALLOWLIST = Object.freeze(['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);

const P38_KIND_MIME_PATTERN = Object.freeze({
  image: /^image\//,
  video: /^video\//,
  gif: /^(?:image\/gif|video\/)/,
});
const P38_TCO_HOST_PATTERN = /(?:^|\.)t\.co$/i;
const P38_MAX_ISSUES = 8;

/**
 * 唯一、失败关闭的媒体可分析性判定。每个媒体资产必须同时满足：
 * 非空且有界的 m-<24位十六进制> id、与零基下标一致的准确 order、
 * image/video/gif 类型、匹配类型的 MIME、HTTPS 且主机在 X/Twitter 严格 CDN
 * 白名单（t.co 与任意非白名单主机拒绝）、sha256/content 内容哈希、
 * 正整数 byte_size。
 *
 * 无媒体资产 = 纯文本来源（走文本分析路径，可直接分析）；有资产但任一项
 * 不满足 = needs_rehydration（必须先恢复媒体，禁止直接调用 Qwen）。
 * 判定文案为固定有界字符串，绝不回显媒体 URL（可能含签名参数）或哈希值。
 */
export function assessMediaAnalyzability(evidence) {
  const issues = [];
  const assets = Array.isArray(evidence?.media_assets) ? evidence.media_assets : [];
  if (assets.length === 0) {
    return {
      analyzable: true,
      status: 'text_only',
      issues: [],
      reason: '该来源没有媒体资产（纯文本来源，可走文本分析路径）。',
    };
  }
  assets.forEach((asset, index) => {
    const at = `媒体 #${index + 1}`;
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      issues.push(`${at} 不是有效的媒体资产。`);
      return;
    }
    if (typeof asset.id !== 'string' || !P29_MEDIA_ID_PATTERN.test(asset.id)) {
      issues.push(`${at} 缺少有界的媒体 id。`);
    }
    if (!Number.isInteger(asset.order) || asset.order !== index) {
      issues.push(`${at} 序号不准确（乱序）。`);
    }
    if (!P29_MEDIA_KINDS.includes(asset.kind)) {
      issues.push(`${at} 类型无效（必须是 image / video / gif）。`);
    }
    const mime = typeof asset.mime_type === 'string' ? asset.mime_type : '';
    if (!mime || !P38_KIND_MIME_PATTERN[asset.kind]?.test(mime)) {
      issues.push(`${at} 的类型与 MIME 不匹配。`);
    }
    let protocol = '';
    let host = '';
    try {
      const parsed = new globalThis.URL(String(asset.media_url || ''));
      protocol = parsed.protocol;
      host = parsed.hostname.toLowerCase();
    } catch {
      // URL 无法解析：按「非白名单」与「非 HTTPS」同时判失败
    }
    if (protocol !== 'https:') issues.push(`${at} 的媒体 URL 不是 HTTPS。`);
    if (host && P38_TCO_HOST_PATTERN.test(host)) {
      issues.push(`${at} 使用了 t.co 短链，不是可验证的媒体文件。`);
    } else if (!P38_MEDIA_CDN_ALLOWLIST.includes(host)) {
      issues.push(`${at} 的主机不在 X/Twitter 严格 CDN 白名单内。`);
    }
    const hash = asset.hash && typeof asset.hash === 'object' ? asset.hash : null;
    if (!hash || hash.algorithm !== 'sha256' || typeof hash.value !== 'string' || !SHA256_PATTERN.test(hash.value)) {
      issues.push(`${at} 缺少有效的 SHA-256 完整性记录。`);
    }
    if (hash && hash.kind !== 'content') {
      issues.push(`${at} 的完整性记录是旧 URL 哈希而非内容哈希，未验证真实媒体内容。`);
    }
    if (!Number.isInteger(asset.byte_size) || asset.byte_size < 1) {
      issues.push(`${at} 缺少正整数的内容字节大小。`);
    }
  });
  const analyzable = issues.length === 0;
  return {
    analyzable,
    status: analyzable ? 'analyzable' : 'needs_rehydration',
    issues: issues.slice(0, P38_MAX_ISSUES),
    reason: analyzable ? '媒体已通过严格安全验证。' : issues[0],
  };
}

/**
 * 重新采集结果与当前 Evidence 的精确一对一身份绑定（失败关闭）：
 * source_url、平台、external_id、source_id 与正文（content_sha256 逐字一致）
 * 必须全部精确匹配；任一缺失、重复、错绑立即抛 P38_* 结构化错误。
 * 新结果必须含至少一个（实际要求全部）通过严格媒体校验的资产；
 * 返回可直接交给 evidence.update 的 patch（仅来源快照与媒体绑定）。
 * 绑定过程不创建、不删除、不产生任何重复身份。
 */
export function bindRehydratedItemToEvidence(evidence, item) {
  if (!evidence || typeof evidence !== 'object') {
    throw safeError('P38_EVIDENCE_INVALID', '当前证据记录无效，已失败关闭。');
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw safeError('P38_REHYDRATION_IDENTITY_MISMATCH', '重新采集未返回来源结果，已失败关闭。');
  }
  const expected = evidence.provenance && typeof evidence.provenance === 'object' ? evidence.provenance : {};
  const platform = String(item.platform || '').toLowerCase();
  const expectedPlatform = String(expected.source_platform || '').toLowerCase();
  const externalId = item.external_id == null ? '' : String(item.external_id);
  const expectedExternalId = expected.external_id == null ? '' : String(expected.external_id);
  const sourceId = String(item.id || '');
  const expectedSourceId = String(expected.source_id || '');
  const contentSha = String(item.content_sha256 || '').toLowerCase();
  const expectedContentSha = String(expected.content_sha256 || '').toLowerCase();
  if (String(item.source_url || '').trim() !== String(evidence.source_url || '').trim()) {
    throw safeError('P38_REHYDRATION_SOURCE_URL_MISMATCH', '重新采集的来源 URL 与当前证据不一致，已失败关闭。');
  }
  if (!expectedPlatform || platform !== expectedPlatform) {
    throw safeError('P38_REHYDRATION_PLATFORM_MISMATCH', '重新采集的平台与当前证据不一致，已失败关闭。');
  }
  if (externalId !== expectedExternalId) {
    throw safeError('P38_REHYDRATION_EXTERNAL_ID_MISMATCH', '重新采集的外部 ID 与当前证据不一致，已失败关闭。');
  }
  if (!expectedSourceId || sourceId !== expectedSourceId) {
    throw safeError('P38_REHYDRATION_SOURCE_ID_MISMATCH', '重新采集的来源 ID 与当前证据不一致，已失败关闭。');
  }
  if (!expectedContentSha || contentSha !== expectedContentSha || String(item.content_text ?? '') !== String(evidence.content_text ?? '')) {
    throw safeError('P38_REHYDRATION_CONTENT_MISMATCH', '重新采集的帖子正文与已保存证据不一致（同一来源身份必须逐字一致），已失败关闭。');
  }
  // 待恢复证据本身含媒体：重新采集结果必须含至少一个通过严格媒体校验的资产，
  // 缺失媒体同样失败关闭（同一帖子重新采集不可能丢失全部媒体）。
  if (!Array.isArray(item.media_assets) || item.media_assets.length === 0) {
    throw safeError('P38_REHYDRATED_MEDIA_INVALID', '重新采集结果缺少媒体资产，已失败关闭。');
  }
  const gate = assessMediaAnalyzability({ media_assets: item.media_assets });
  if (!gate.analyzable) {
    throw safeError('P38_REHYDRATED_MEDIA_INVALID', `重新采集的媒体仍未通过安全验证（${String(gate.issues[0] || '媒体无效').slice(0, 120)}），已失败关闭。`);
  }
  const patch = {};
  patch.recorded_at = item.provenance?.collected_at;
  patch.provenance = {
    schema_version: 'p22_apify_evidence_provenance_v1',
    manual: false,
    method: 'apify_public_collection',
    provider: item.provenance?.provider,
    source_platform: platform,
    source_id: sourceId,
    external_id: item.external_id ?? null,
    source_url: item.source_url,
    run_id: item.provenance?.run_id,
    collected_at: item.provenance?.collected_at,
    usage_total_usd: item.provenance?.usage_total_usd,
    budget_reservation_id: item.provenance?.budget_reservation_id,
    content_sha256: contentSha,
    collection_proof: item.collection_proof,
    statement: `该证据由 P22/P38 通过 Apify 从 X 公开来源重新采集，并由服务端来源证明原子绑定正文、身份、媒体与采集运行。`,
  };
  if (item.source_metadata !== undefined && item.source_metadata !== null) {
    patch.source_metadata = item.source_metadata;
  }
  patch.media_assets = item.media_assets;
  return { patch };
}

/**
 * P38 原位恢复链（顺序严格，任一步失败立即失败关闭且不产生副作用）：
 * 1) 判定需要恢复（已验证证据直接拒绝，绝不重新采集）；
 * 2) 仅以当前 Evidence 的规范 source_url 调用一次 collect_url；
 * 3) 结果与当前 Evidence 精确一对一身份绑定（bindRehydratedItemToEvidence）；
 * 4) 通过既有 updateEvidence 原位升级（不创建新证据，版本 +1、指纹变化，
 *    下游旧分析/知识卡/Brief/交接按现有合同失效或过时）；
 * 5) 绑定唯一 evidence.update 在线命令并执行（execute 内含权威在线读取）；
 * 6) 权威确认同一 evidence_id 的新版本与媒体指纹后才调用 analyze_persisted；
 * 7) Qwen 结果仅返回预览，由调用方决定是否持久化。
 *
 * client.collectUrl / client.analyzePersisted 为注入的 P22 客户端方法；
 * updateEvidenceFn / buildCommandFn / executeCommandFn 为注入的领域与在线
 * 命令执行器（页面注入 buildOnlineCommand 与 onlineStore.execute）。
 */
export async function rehydrateEvidenceMediaAndAnalyze({
  project,
  evidenceId,
  client,
  updateEvidenceFn,
  buildCommandFn,
  executeCommandFn,
} = {}) {
  if (!client || typeof client.collectUrl !== 'function' || typeof client.analyzePersisted !== 'function') {
    throw safeError('P38_NOT_CONFIGURED', '重新采集服务尚未配置。');
  }
  if (typeof updateEvidenceFn !== 'function' || typeof buildCommandFn !== 'function' || typeof executeCommandFn !== 'function') {
    throw safeError('P38_NOT_CONFIGURED', '原位升级执行器尚未配置。');
  }
  const evidence = (Array.isArray(project?.evidence) ? project.evidence : []).find((row) => row.id === evidenceId);
  if (!evidence) throw safeError('P38_EVIDENCE_NOT_FOUND', '要恢复的证据不存在。');
  const gate = assessMediaAnalyzability(evidence);
  if (gate.analyzable) {
    throw safeError('P38_MEDIA_ALREADY_VERIFIED', '该证据的媒体已通过安全验证，无需重新采集。');
  }
  // 1) 仅以当前 Evidence 的规范 source URL 重新采集一次
  const response = await client.collectUrl(evidence.source_url);
  const items = Array.isArray(response?.items) ? response.items : [];
  if (items.length !== 1) {
    throw safeError('P38_REHYDRATION_IDENTITY_MISMATCH', `重新采集必须精确返回 1 条同一来源结果（当前 ${items.length} 条），已失败关闭。`);
  }
  const { patch } = bindRehydratedItemToEvidence(evidence, items[0]);
  // 2) 本地原位升级：同一 evidence_id，版本 +1、指纹变化，绝不创建新证据
  const afterEvidence = await updateEvidenceFn(project, evidenceId, patch);
  const spec = buildCommandFn(project, afterEvidence);
  if (!spec || typeof spec !== 'object' || spec.command !== 'evidence.update' || spec.payload?.evidence_id !== evidenceId) {
    throw safeError('P38_UPDATE_BINDING_INVALID', '原位升级未能绑定唯一 evidence.update 命令，已失败关闭。');
  }
  // 3) 一次 evidence.update + 权威在线读取（execute 内部按项目重载权威状态）
  const persisted = await executeCommandFn(spec.command, spec.payload, spec.options);
  const upgraded = (Array.isArray(persisted?.evidence) ? persisted.evidence : []).find((row) => row.id === evidenceId);
  if (!upgraded) throw safeError('P38_REHYDRATION_MISSING', '权威重载后未找到同一 evidence_id，已失败关闭。');
  if (upgraded.version !== evidence.version + 1) {
    throw safeError('P38_REHYDRATION_VERSION_INVALID', `权威版本 ${upgraded.version} 与预期版本 ${evidence.version + 1} 不一致，已失败关闭。`);
  }
  if (upgraded.fingerprint === evidence.fingerprint) {
    throw safeError('P38_REHYDRATION_FINGERPRINT_UNCHANGED', '权威指纹未变化，媒体绑定未更新，已失败关闭。');
  }
  const upgradedGate = assessMediaAnalyzability(upgraded);
  if (!upgradedGate.analyzable) {
    throw safeError('P38_REHYDRATION_INCOMPLETE', '权威证据的媒体仍未通过安全验证，已失败关闭。');
  }
  // 4) 权威确认后才调用 Qwen 多模态分析（结果仅预览，由用户确认保存）
  const analysisResponse = await client.analyzePersisted(project.id, evidenceId);
  const modelResult = (Array.isArray(analysisResponse?.analyses) ? analysisResponse.analyses : [])
    .find((row) => row.source_id === evidence.provenance?.source_id);
  if (!modelResult) {
    throw safeError('P38_ANALYSIS_IDENTITY_MISSING', '分析结果未精确绑定来源身份，已停止。');
  }
  // M3 费用绑定（范围 10）：服务端实际返回的 provider 费用记录随预览返回，
  // 由调用方在保存分析时随记录绑定；绝不虚构费用。
  return {
    project: persisted,
    evidence: upgraded,
    modelResult,
    usage: analysisResponse.usage || {},
    cost: analysisResponse.cost || undefined,
  };
}
