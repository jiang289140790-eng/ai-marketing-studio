import { supabase } from './supabase-client.js';
import { sha256Hex, validateMediaAssets, validateSourceMetadata } from './p19-contracts.js';
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
  const error = new Error(String(message || '智能研究服务暂时不可用。').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, MAX_MESSAGE));
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
    analyze: (items) => invoke({ action: 'analyze', items }),
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
    platform: 'x',
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
  if (provider !== 'apify:xquik/x-tweet-scraper') throw safeError('P22_EVIDENCE_INVALID', '采集提供方不符合 P22 合同。');
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
    label: String(item.label || 'X 公开内容').slice(0, 200),
    platform: 'X · Apify',
    content_text: contentText,
    recorded_at: collectedAt,
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1',
      manual: false,
      method: 'apify_public_collection',
      provider,
      source_platform: 'x',
      source_id: sourceId,
      external_id: externalId,
      source_url: sourceUrl,
      run_id: runId,
      collected_at: collectedAt,
      usage_total_usd: usageTotalUsd,
      budget_reservation_id: requireText(provenance.budget_reservation_id, '预算预留 ID', 80),
      content_sha256: declaredHash,
      collection_proof: collectionProof,
      statement: '该证据由 P22 通过 Apify 从 X 公开来源采集，并由服务端来源证明绑定正文、身份与采集运行。',
    },
    media_metadata: {
      filename: `p22-x-${String(externalId || sourceId).replace(/[^a-z0-9_-]/gi, '_').slice(0, 160)}.txt`,
      mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(contentText).byteLength,
      last_modified: collectedAt,
      sha256: declaredHash,
    },
    source_metadata: sourceMetadata,
    media_assets: mediaAssets,
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

function requireXSourceUrl(value) {
  const text = String(value ?? '').trim();
  let url;
  try {
    url = new globalThis.URL(text);
  } catch {
    throw safeError('P32_ITEM_INVALID', '结果来源 URL 无效，已拒绝导入。');
  }
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
    throw safeError('P32_ITEM_INVALID', '结果来源不是 X 公开链接，已拒绝导入。');
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
  requireXSourceUrl(item.source_url);
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
  const value = `p32-search-batch\0${String(batch.keyword ?? '')}\0${String(batch.count ?? '')}\0${String(batch.sort_intent || '')}\0${String(runId)}\0${String(batch.collected_at || '')}\0${identities}`;
  const digestValue = await sha256Hex(value);
  return `p32-search-${digestValue.slice(0, 24)}`;
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
  if (typeof batch.batch_id !== 'string' || !P32_SEARCH_BATCH_ID_PATTERN.test(batch.batch_id)) {
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
