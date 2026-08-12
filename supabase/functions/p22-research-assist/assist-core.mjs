export const P22_SCHEMA_VERSION = 'p22_research_assist_v1';
/** P22 采集证明 v3：绑定正文哈希 + 来源身份 + 作者/时间/互动快照 + 每条有序媒体身份/哈希。 */
export const P22_COLLECTION_PROOF_VERSION = 'p22_collection_proof_v3';
/** 旧版证明（无媒体绑定）；仅接受不含 P29 扩展字段的存量记录。 */
export const P22_COLLECTION_PROOF_V2_VERSION = 'p22_collection_proof_v2';
export const P22_LIMITS = Object.freeze({
  collect: 5,
  /** P32-B 热门主题搜索：结果条数默认 10、最大 20（与 collect 单次 5 条分离）。 */
  search_default: 10,
  search_max: 20,
  /** P32-B 搜索关键词规范化后的长度上限。 */
  search_keyword_max: 120,
  analyze: 2,
  persist_text: 5000,
  proof_ttl_ms: 15 * 60 * 1000,
  apify_reservation_cny: 2,
  qwen_reservation_cny: 1,
  apify_wait_ms: 60 * 1000,
  apify_poll_interval_ms: 1000,
  apify_sequence_ms: 120 * 1000,
  /** 终态 SUCCEEDED 后的费用稳定读取上限（含首次读取）；两次连续相等才算稳定。 */
  cost_stabilize_polls: 3,
  /** 稳定读取之间的有界等待间隔；整个稳定步骤在 apify_sequence_ms 总超时内。 */
  cost_stabilize_interval_ms: 1500,
  /** 单帖媒体声明上限（正常 X 帖子上限）；超出必须硬失败，绝不静默截断。 */
  max_media: 8,
  /** 内容哈希抓取：单媒体超时。 */
  media_fetch_timeout_ms: 15000,
  /** 内容哈希抓取：单媒体字节上限（12 MiB，与媒体元数据边界一致）。 */
  media_max_bytes: 12 * 1024 * 1024,
  /** 内容哈希抓取：重定向跳数上限（每跳都必须仍是严格 X/Twitter CDN 白名单）。 */
  media_redirect_max: 5,
});

// ---- P29 多模态证据扩展常量（与 p19-contracts.js 保持语义一致；本文件自包含以便 Deno 部署）----
export const P29_MAX_MEDIA = 8;
export const P29_MEDIA_KINDS = Object.freeze(['image', 'video', 'gif']);
export const P29_HASH_KINDS = Object.freeze(['url', 'content']);
export const P29_ENGAGEMENT_KEYS = Object.freeze(['likes', 'retweets', 'replies', 'quotes', 'views', 'bookmarks']);
export const P29_MAX_ENGAGEMENT = 1000000000000;
export const P29_MAX_MEDIA_BYTES = 12 * 1024 * 1024;
export const P29_MEDIA_ID_PATTERN = /^m-[0-9a-f]{24}$/;
export const P29_MODEL_SCHEMA_VERSION = 'p29_multimodal_model_v1';
export const P29_MODEL = 'qwen3.5-omni-flash';
export const P29_MODEL_PROVIDER = 'dashscope';
export const P29_MODEL_METHOD = 'multimodal_model';
/** 内容哈希抓取只允许的严格 X/Twitter CDN 主机（重定向目标必须再次命中白名单）。 */
export const P22_MEDIA_CDN_ALLOWLIST = new Set(['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);
const P22_ISO8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const P22_X_CREATED_AT_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/;
const P22_X_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
const P22_X_WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const P22_MEDIA_EXT_MIME = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
});
export const P22_EXECUTION_FLAGS = Object.freeze({ generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false });
/** 人民币兑美元汇率，仅用于把有界的 Apify 预留金额换算成 API 的有界成本上限。 */
export const P22_CNY_PER_USD = 7.5;

const ACTION_FIELDS = Object.freeze({
  status: new Set(['action']),
  collect: new Set(['action', 'topic', 'count']),
  collect_url: new Set(['action', 'url']),
  search: new Set(['action', 'keyword', 'count', 'sort']),
  analyze: new Set(['action', 'items']),
});
const ITEM_FIELDS = new Set(['id', 'source_url', 'label', 'platform', 'content_text', 'external_id', 'content_sha256', 'provenance', 'collection_proof', 'source_metadata', 'media_assets']);
const PROVENANCE_FIELDS = new Set(['schema_version', 'provider', 'run_id', 'collected_at', 'usage_total_usd', 'budget_reservation_id']);

export class P22Error extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = 'P22Error';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = clonePlain(value[key]);
    return out;
  }
  return value;
}

function text(value, field, max, required = true) {
  if (typeof value !== 'string') {
    if (!required && value == null) return null;
    throw new P22Error('INVALID_REQUEST', `${field} 必须是字符串。`, 400, { field });
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw new P22Error('INVALID_REQUEST', `${field} 为空或超过长度上限。`, 400, { field });
  }
  return normalized || null;
}

function boundedModelText(value, field, max) {
  if (typeof value !== 'string') {
    throw new P22Error('MODEL_RESPONSE_INVALID', `${field} invalid.`, 502, { field });
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    throw new P22Error('MODEL_RESPONSE_INVALID', `${field} empty.`, 502, { field });
  }
  return Array.from(normalized).slice(0, max).join('');
}

function exactFields(value, allowed, field = 'request') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new P22Error('UNKNOWN_FIELD', `${field} 包含未授权字段。`, 400, { field: key });
  }
}

function normalizeCollectedProvenance(value, field) {
  const provenance = object(value);
  if (!provenance) throw new P22Error('INVALID_SOURCE_PROVENANCE', '来源证明缺失。', 400, { field });
  exactFields(provenance, PROVENANCE_FIELDS, field);
  if (provenance.schema_version !== 'p22_collected_source_v1') {
    throw new P22Error('INVALID_SOURCE_PROVENANCE', '来源证明版本无效。', 400, { field: `${field}.schema_version` });
  }
  const collectedAt = text(provenance.collected_at, `${field}.collected_at`, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(collectedAt)) {
    throw new P22Error('INVALID_SOURCE_PROVENANCE', '采集时间无效。', 400, { field: `${field}.collected_at` });
  }
  const usage = Number(provenance.usage_total_usd);
  if (!Number.isFinite(usage) || usage < 0 || usage > 10) {
    throw new P22Error('INVALID_SOURCE_PROVENANCE', '采集用量无效。', 400, { field: `${field}.usage_total_usd` });
  }
  const reservationId = text(provenance.budget_reservation_id, `${field}.budget_reservation_id`, 80);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reservationId)) {
    throw new P22Error('INVALID_SOURCE_PROVENANCE', '预算预留身份无效。', 400, { field: `${field}.budget_reservation_id` });
  }
  return {
    schema_version: 'p22_collected_source_v1',
    provider: text(provenance.provider, `${field}.provider`, 120),
    run_id: text(provenance.run_id, `${field}.run_id`, 200),
    collected_at: collectedAt,
    usage_total_usd: usage,
    budget_reservation_id: reservationId,
  };
}

export function parseP22Request(raw) {
  const input = object(raw);
  if (!input) throw new P22Error('INVALID_REQUEST', '请求必须是对象。');
  const action = text(input.action, 'action', 24);
  if (!ACTION_FIELDS[action]) throw new P22Error('UNKNOWN_ACTION', '未知操作。', 400, { field: 'action' });
  exactFields(input, ACTION_FIELDS[action]);
  if (action === 'status') return { action };
  if (action === 'collect') {
    const count = Number(input.count ?? P22_LIMITS.collect);
    if (!Number.isInteger(count) || count < 1 || count > P22_LIMITS.collect) {
      throw new P22Error('COUNT_OUT_OF_RANGE', '采集数量必须为 1–5。', 400, { field: 'count' });
    }
    return { action, topic: text(input.topic, 'topic', 240), count };
  }
  if (action === 'collect_url') {
    const identity = identifyPublicPostUrl(text(input.url, 'url', 1000));
    if (!identity.supported) {
      throw new P22Error('UNSUPPORTED_PLATFORM', `${identity.platform} 链接已识别，但当前采集器尚未接入该平台。`, 422, { field: 'url' });
    }
    return { action, url: identity.canonical_url, platform: identity.platform, external_id: identity.external_id, count: 1 };
  }
  if (action === 'search') {
    // P32-B：关键词规范化（trim + 折叠空白）并有界；URL 一律失败关闭——
    // 搜索绝不把任意链接当关键词，单帖读取必须走 collect_url。
    const keyword = text(input.keyword, 'keyword', P22_LIMITS.search_keyword_max).replace(/\s+/gu, ' ');
    if (isUrlLikeKeyword(keyword)) {
      throw new P22Error('KEYWORD_IS_URL', '热门主题搜索不接受链接作为关键词；读取单帖请使用「单帖 URL 读取」。', 400, { field: 'keyword' });
    }
    const count = Number(input.count ?? P22_LIMITS.search_default);
    if (!Number.isInteger(count) || count < 1 || count > P22_LIMITS.search_max) {
      throw new P22Error('COUNT_OUT_OF_RANGE', `搜索数量必须为 1–${P22_LIMITS.search_max}。`, 400, { field: 'count' });
    }
    // 排序意图服务端固定为 latest（可扩展但本里程碑只执行该意图）；
    // Actor 输入由服务端构造，绝不接受客户端任意 Actor 输入。
    const sort = input.sort === undefined ? 'latest' : String(input.sort).trim().toLowerCase();
    if (!['latest'].includes(sort)) {
      throw new P22Error('SORT_INTENT_UNSUPPORTED', '当前仅支持按最新发布采集搜索结果。', 400, { field: 'sort' });
    }
    return { action, keyword, count, sort };
  }
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > P22_LIMITS.analyze) {
    throw new P22Error('ITEM_COUNT_OUT_OF_RANGE', '分析项目必须为 1–2 条。', 400, { field: 'items' });
  }
  const ids = new Set();
  const items = input.items.map((rawItem, index) => {
    const item = object(rawItem);
    if (!item) throw new P22Error('INVALID_ITEM', '分析项目必须是对象。', 400, { field: `items[${index}]` });
    exactFields(item, ITEM_FIELDS, `items[${index}]`);
    const sourceMetadata = item.source_metadata === undefined ? undefined : (item.source_metadata === null ? null : object(item.source_metadata));
    if (item.source_metadata !== undefined && (item.source_metadata === null ? false : !sourceMetadata)) {
      throw new P22Error('INVALID_ITEM', '来源快照必须是对象或 null。', 400, { field: `items[${index}].source_metadata` });
    }
    if (sourceMetadata !== undefined && !validateSourceMetadataShape(sourceMetadata)) {
      throw new P22Error('SOURCE_METADATA_INVALID', '来源快照形状无效（畸形作者/时间/互动已失败关闭）。', 400, { field: `items[${index}].source_metadata` });
    }
    const mediaAssets = item.media_assets === undefined ? undefined : item.media_assets;
    if (mediaAssets !== undefined && !validateMediaAssetsShape(mediaAssets)) {
      throw new P22Error('MEDIA_ASSETS_INVALID', '媒体资产形状无效（越界/重复/乱序/畸形已失败关闭）。', 400, { field: `items[${index}].media_assets` });
    }
    const normalized = {
      id: text(item.id, `items[${index}].id`, 160),
      source_url: normalizeXUrl(text(item.source_url, `items[${index}].source_url`, 1000)),
      label: text(item.label, `items[${index}].label`, 200),
      platform: text(item.platform, `items[${index}].platform`, 40).toLowerCase(),
      content_text: text(item.content_text, `items[${index}].content_text`, P22_LIMITS.persist_text),
      external_id: text(item.external_id, `items[${index}].external_id`, 160, false),
      content_sha256: text(item.content_sha256, `items[${index}].content_sha256`, 64),
      provenance: normalizeCollectedProvenance(item.provenance, `items[${index}].provenance`),
      collection_proof: text(item.collection_proof, `items[${index}].collection_proof`, 256),
      source_metadata: sourceMetadata,
      media_assets: mediaAssets === undefined ? undefined : mediaAssets.map((asset) => clonePlain(asset)),
    };
    if (!/^[a-f0-9]{64}$/i.test(normalized.content_sha256)) throw new P22Error('INVALID_HASH', '内容哈希无效。', 400, { field: `items[${index}].content_sha256` });
    if (normalized.platform !== 'x') throw new P22Error('UNSUPPORTED_PLATFORM', '当前只支持 X 公开来源。', 400, { field: `items[${index}].platform` });
    if (ids.has(normalized.id)) throw new P22Error('DUPLICATE_ITEM', '分析项目 ID 重复。', 400, { field: `items[${index}].id` });
    ids.add(normalized.id);
    return normalized;
  });
  return { action, items };
}

export function normalizeXUrl(value) {
  let url;
  try { url = new globalThis.URL(String(value)); } catch { throw new P22Error('INVALID_SOURCE_URL', '来源 URL 无效。', 400, { field: 'source_url' }); }
  if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) {
    throw new P22Error('UNSUPPORTED_SOURCE', '当前只接受 X/Twitter 公开来源。', 400, { field: 'source_url' });
  }
  url.protocol = 'https:';
  url.hostname = 'x.com';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * P32-B：判断关键词是否像链接（协议前缀、已知社交平台主机或「域名/路径」形态）。
 * 搜索动作绝不把任意 URL 当关键词；命中即失败关闭并引导使用单帖读取。
 */
export function isUrlLikeKeyword(value) {
  const text = String(value || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return true;
  return /^(?:www\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be|reddit\.com|linkedin\.com)\//i.test(text)
    || /^[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?\//i.test(text);
}

/**
 * Identify a public post URL without fetching it. Only an exact X status URL is
 * currently executable; other well-known platforms are identified explicitly
 * so the UI can fail closed instead of silently treating a URL as a topic.
 */
export function identifyPublicPostUrl(value) {
  let url;
  try { url = new globalThis.URL(String(value).trim()); }
  catch { throw new P22Error('INVALID_SOURCE_URL', '请输入有效的公开帖子链接。', 400, { field: 'url' }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new P22Error('INVALID_SOURCE_URL', '帖子链接必须使用 HTTPS，且不能包含凭据或自定义端口。', 400, { field: 'url' });
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const known = host === 'x.com' || host === 'twitter.com' ? 'x'
    : host === 'instagram.com' ? 'instagram'
      : host === 'tiktok.com' || host.endsWith('.tiktok.com') ? 'tiktok'
        : host === 'youtube.com' || host === 'youtu.be' ? 'youtube'
          : host === 'reddit.com' || host.endsWith('.reddit.com') ? 'reddit'
            : host === 'linkedin.com' ? 'linkedin'
              : null;
  if (!known) throw new P22Error('UNSUPPORTED_SOURCE', '当前仅识别受支持的公开社交帖子链接。', 422, { field: 'url' });
  if (known !== 'x') {
    url.search = '';
    url.hash = '';
    return { platform: known, supported: false, canonical_url: url.toString().replace(/\/$/, ''), external_id: null };
  }
  const match = /^\/(?:i\/web\/status|[^/]+\/status)\/(\d+)(?:\/.*)?$/i.exec(url.pathname);
  if (!match) throw new P22Error('INVALID_POST_URL', 'X 链接必须指向一条具体帖子，而不是主页、搜索或列表。', 422, { field: 'url' });
  const canonical = new globalThis.URL(normalizeXUrl(value));
  canonical.pathname = `/i/web/status/${match[1]}`;
  return { platform: 'x', supported: true, canonical_url: canonical.toString().replace(/\/$/, ''), external_id: match[1] };
}

function first(...values) { return values.find((value) => value !== undefined && value !== null && value !== ''); }
function visibleText(item) {
  return String(first(item.content_text, item.text, item.full_text, item.fullText, item.note_tweet?.text, ''))
    .replace(/\s+https:\/\/t\.co\/\w+\s*$/i, '').trim();
}

// ---------------------------------------------------------------------------
// P29：有界来源快照（作者/发布时间/互动）与有序媒体资产规范化（fail-closed）
//
// - 接受当前官方 xquik/x-tweet-scraper 字段：media / mediaUrls / imageUrls /
//   videoUrls / gifUrls / author（对象或扁平）/ createdAt / 互动计数；
// - 字段缺省 → null（文本帖或旧数据），字段存在但畸形 → 硬失败，绝不静默丢弃；
// - 媒体顺序零基、id 确定性、URL/顺序唯一；超出声明上限硬失败；
// - 内容 SHA-256 只从严格 X/Twitter CDN 白名单抓取：重定向逐跳复验白名单、
//   强制 content-type、超时与字节上限，任何失配/溢出一律失败关闭；
//   未在白名单的媒体 URL 保留 url 哈希（明确区分，绝不冒充内容哈希）。
// ---------------------------------------------------------------------------

function boundedAuthorText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new P22Error('SOURCE_METADATA_INVALID', `${field} 格式无效（缺失、非字符串或超长）。`, 422, { field });
  }
  return value.trim();
}

function boundedEngagementCount(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isInteger(value) || value < 0 || value > P29_MAX_ENGAGEMENT) {
    throw new P22Error('SOURCE_METADATA_INVALID', `${field} 必须是非负有界整数。`, 422, { field });
  }
  return value;
}

function normalizePublishedAt(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const iso = new globalThis.Date(value < 100000000000 ? value * 1000 : value).toISOString();
    if (!P22_ISO8601_PATTERN.test(iso)) throw new P22Error('SOURCE_METADATA_INVALID', '发布时间格式无效。', 422, { field: 'createdAt' });
    return iso;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) return normalizePublishedAt(Number(trimmed));
    const xCreatedAt = P22_X_CREATED_AT_PATTERN.exec(trimmed);
    if (xCreatedAt) {
      const [, weekday, monthName, dayText, hourText, minuteText, secondText, offsetSign, offsetHourText, offsetMinuteText, yearText] = xCreatedAt;
      const month = P22_X_MONTHS.indexOf(monthName);
      const day = Number(dayText);
      const hour = Number(hourText);
      const minute = Number(minuteText);
      const second = Number(secondText);
      const year = Number(yearText);
      const offsetHour = Number(offsetHourText);
      const offsetMinute = Number(offsetMinuteText);
      const offsetMinutes = (offsetSign === '+' ? 1 : -1) * ((offsetHour * 60) + offsetMinute);
      const invalidOffset = offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0);
      const invalidClock = hour > 23 || minute > 59 || second > 59;
      if (!invalidOffset && !invalidClock) {
        const utcMs = globalThis.Date.UTC(year, month, day, hour, minute, second) - (offsetMinutes * 60_000);
        const local = new globalThis.Date(utcMs + (offsetMinutes * 60_000));
        const exact = local.getUTCFullYear() === year
          && local.getUTCMonth() === month
          && local.getUTCDate() === day
          && local.getUTCHours() === hour
          && local.getUTCMinutes() === minute
          && local.getUTCSeconds() === second
          && P22_X_WEEKDAYS[local.getUTCDay()] === weekday;
        if (exact) return new globalThis.Date(utcMs).toISOString();
      }
      throw new P22Error('SOURCE_METADATA_INVALID', '发布时间格式无效。', 422, { field: 'createdAt' });
    }
    if (!P22_ISO8601_PATTERN.test(trimmed)) throw new P22Error('SOURCE_METADATA_INVALID', '发布时间格式无效。', 422, { field: 'createdAt' });
    return trimmed;
  }
  throw new P22Error('SOURCE_METADATA_INVALID', '发布时间格式无效。', 422, { field: 'createdAt' });
}

/**
 * 从 Actor 原始行规范化作者/发布时间/互动快照。字段缺省为 null；
 * 存在但畸形（类型错、负数、超长、不可解析时间）一律 fail closed。
 */
export function normalizeSourceMetadata(raw) {
  const source = object(raw);
  if (!source) return { author: null, published_at: null, engagement: null };
  const authorRaw = source.author;
  if (authorRaw !== undefined && authorRaw !== null && typeof authorRaw !== 'string' && !object(authorRaw)) {
    throw new P22Error('SOURCE_METADATA_INVALID', 'author 字段格式无效。', 422, { field: 'author' });
  }
  const authorSource = typeof authorRaw === 'string' ? {} : object(authorRaw) || {};
  const name = boundedAuthorText(
    first(authorRaw && typeof authorRaw === 'string' ? authorRaw : null, authorSource.name, authorSource.userName, authorSource.displayName, source.name, source.authorName, source.authorUsername),
    'author.name', 120,
  );
  const handleValue = boundedAuthorText(
    first(authorSource.handle, authorSource.username, authorSource.screenName, source.handle, source.username, source.screenName, source.authorHandle, source.authorUsername, source.authorScreenName),
    'author.handle', 80,
  );
  // 缺省句柄（无作者元数据）规范化为 null；存在且为字符串时精确规范化（去掉前导 @）。
  const handle = handleValue === null ? null : handleValue.replace(/^@/, '');
  const userId = boundedAuthorText(
    first(authorSource.id, authorSource.userId, authorSource.rest_id, source.authorId, source.userId, source.user_id),
    'author.user_id', 80,
  );
  const publishedAt = normalizePublishedAt(first(source.createdAt, source.created_at, source.timestamp, source.date, source.createdAtDate, source.publishedAt, source.tweetDate));
  const engagement = {};
  let engagementPresent = false;
  for (const [canonical, keys] of [
    ['likes', ['likeCount', 'likes', 'favoriteCount', 'favorites']],
    ['retweets', ['retweetCount', 'retweets', 'reTweetCount']],
    ['replies', ['replyCount', 'replies']],
    ['quotes', ['quoteCount', 'quotes']],
    ['views', ['viewCount', 'views', 'impressionCount']],
    ['bookmarks', ['bookmarkCount', 'bookmarks']],
  ]) {
    const value = first(...keys.map((key) => source[key]), ...keys.map((key) => authorSource[key]));
    if (value !== undefined && value !== null && value !== '') engagementPresent = true;
    engagement[canonical] = boundedEngagementCount(value, `engagement.${canonical}`);
  }
  return {
    author: name || handle || userId ? { name, handle, user_id: userId } : null,
    published_at: publishedAt,
    engagement: engagementPresent ? engagement : null,
  };
}

/**
 * Validate an Actor-provided dimension value (width or height). When present
 * (non-null/undefined), it must be a positive integer <= 65536; malformed,
 * negative, zero, non-integer or out-of-bounds values fail closed.
 */
function validateDimensionField(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65536) return value;
  throw new P22Error('MEDIA_ASSETS_INVALID', `${field} 必须为 1–65536 之间的整数。`, 422, { field });
}

/**
 * Validate an Actor-declared MIME type. When present it must be a non-empty
 * ASCII-string matching type/subtype; malformed, excessively long or absent
 * returns null. The returned value is trimmed and bounded to 100 characters.
 */
function validateMediaMimeType(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new P22Error('MEDIA_ASSETS_INVALID', 'MIME 类型必须为字符串。', 422, { field: 'mimeType' });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 100) {
    throw new P22Error('MEDIA_ASSETS_INVALID', 'MIME 类型为空或超长。', 422, { field: 'mimeType' });
  }
  if (!/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/i.test(trimmed)) {
    throw new P22Error('MEDIA_ASSETS_INVALID', 'MIME 类型格式无效，必须为 type/subtype。', 422, { field: 'mimeType' });
  }
  return trimmed;
}

function normalizeMediaKind(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new P22Error('MEDIA_KIND_INVALID', '媒体种类必须是字符串。', 422, { field: 'media' });
  }
  const normalized = value.trim().toLowerCase();
  const aliases = {
    image: 'image',
    photo: 'image',
    video: 'video',
    native_video: 'video',
    gif: 'gif',
    animated_gif: 'gif',
  };
  const kind = aliases[normalized];
  if (!kind) {
    throw new P22Error('MEDIA_KIND_INVALID', '媒体种类必须是 image / video / gif。', 422, { field: 'media' });
  }
  return kind;
}

/** 从 Actor 行的 media/mediaUrls/imageUrls/videoUrls/gifUrls 等官方字段收集候选媒体。 */
function collectMediaCandidates(raw) {
  const candidates = [];
  const seen = new Set();
  const push = (value, hintKind) => {
    if (value === undefined || value === null) return;
    let url = null;
    let kind = hintKind;
    let mimeType = null;
    let width = null;
    let height = null;
    if (typeof value === 'string') {
      url = value.trim();
    } else if (object(value)) {
      // Rich xquik rows carry both a generic post/link URL (`url`, commonly
      // t.co) and the actual CDN binary URL (`mediaUrl`).  Only the latter is
      // suitable for content hashing and multimodal input.  Keep generic URL
      // as a last-resort compatibility field for providers that expose no
      // media-specific URL at all.
      url = first(
        value.mediaUrl,
        value.media_url,
        value.contentUrl,
        value.content_url,
        value.src,
        value.previewUrl,
        value.preview_url,
        value.preview,
        value.thumbnailUrl,
        value.thumbnail_url,
        value.thumbnail,
        value.url,
      );
      const mediaTypeValue = value.mediaType;
      const contentTypeValue = value.contentType;
      const mediaTypeIsMime = typeof mediaTypeValue === 'string' && mediaTypeValue.includes('/');
      const contentTypeIsMime = typeof contentTypeValue === 'string' && contentTypeValue.includes('/');
      if (!kind) kind = first(
        value.type,
        value.kind,
        mediaTypeIsMime ? null : mediaTypeValue,
        contentTypeIsMime ? null : contentTypeValue,
      );
      // Actor-provided MIME / dimensions: strict validation. When present but
      // malformed or out-of-bounds, fail closed instead of silently dropping.
      mimeType = validateMediaMimeType(first(
        value.mimeType,
        value.mime_type,
        contentTypeIsMime ? contentTypeValue : null,
        mediaTypeIsMime ? mediaTypeValue : null,
      ));
      width = validateDimensionField(value.width, 'width');
      height = validateDimensionField(value.height, 'height');
      // 也接受嵌套 dimensions/size 形状（某些 Actor 版本使用）。
      if (object(value.dimensions)) {
        width = validateDimensionField(value.dimensions.width, 'dimensions.width');
        height = validateDimensionField(value.dimensions.height, 'dimensions.height');
      }
      if (object(value.size)) {
        width = validateDimensionField(value.size.width, 'size.width');
        height = validateDimensionField(value.size.height, 'size.height');
      }
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new P22Error('MEDIA_URL_INVALID', '媒体条目缺少有效的 http(s) URL。', 422, { field: 'media' });
    }
    if (!kind) {
      const match = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
      const ext = match && match[1].toLowerCase();
      if (ext === 'gif') kind = 'gif';
      else if (ext === 'mp4' || ext === 'mov' || ext === 'm4v' || ext === 'webm') kind = 'video';
      else kind = 'image';
    }
    kind = normalizeMediaKind(kind);
    if (!P29_MEDIA_KINDS.includes(kind)) throw new P22Error('MEDIA_KIND_INVALID', '媒体种类必须是 image / video / gif。', 422, { field: 'media' });
    if (seen.has(url)) return; // 同一精确 URL 去重（保持首次出现顺序）
    seen.add(url);
    candidates.push({ url, kind, mimeType, width, height });
  };
  if (raw.media !== undefined) {
    const media = Array.isArray(raw.media) ? raw.media : [raw.media];
    for (const entry of media) push(entry, null);
  }
  for (const [key, hint] of [['mediaUrls', null], ['imageUrls', 'image'], ['videoUrls', 'video'], ['gifUrls', 'gif']]) {
    const value = raw[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) push(entry, hint);
    } else {
      push(value, hint);
    }
  }
  return candidates;
}

function mimeForMedia(url, declared) {
  const declaredMime = typeof declared === 'string' && declared.trim() ? declared.trim().slice(0, 100) : '';
  if (declaredMime) return declaredMime;
  const match = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  const ext = match && match[1].toLowerCase();
  return P22_MEDIA_EXT_MIME[ext] || 'application/octet-stream';
}

/**
 * 规范化一条媒体资产：确定性 id、推文绑定、精确 URL、零基顺序、种类、MIME、
 * 可用时尺寸、可验证时字节大小，以及明确种类（url 或 content）的 SHA-256 完整性记录。
 */
async function normalizeMediaAsset(candidate, index, externalId, canonicalTweetUrl, digest) {
  if (index >= P29_MAX_MEDIA) {
    throw new P22Error('MEDIA_BOUND_EXCEEDED', `媒体数量超过声明上限 ${P29_MAX_MEDIA} 条，已硬失败（绝不静默截断）。`, 422, { field: 'media' });
  }
  const url = new globalThis.URL(candidate.url);
  if (url.protocol !== 'https:') {
    throw new P22Error('MEDIA_URL_INVALID', '媒体 URL 必须使用 HTTPS。', 422, { field: 'media' });
  }
  const asset = {
    id: `m-${(await digest(`p29-media\0${externalId || ''}\0${index}\0${candidate.url}`)).slice(0, 24)}`,
    tweet_id: externalId || null,
    external_id: externalId || null,
    canonical_tweet_url: canonicalTweetUrl,
    media_url: candidate.url,
    order: index,
    kind: candidate.kind,
    mime_type: mimeForMedia(candidate.url, candidate.mimeType),
    dimensions: null,
    byte_size: null,
    hash: { algorithm: 'sha256', kind: 'url', value: await digest(candidate.url) },
  };
  // Actor-provided dimensions (pre-validated by collectMediaCandidates).
  // When present, they must be asserted in the resulting Evidence; any
  // inconsistency here fails closed rather than silently dropping.
  if (candidate.width !== null && candidate.height !== null) {
    if (!Number.isInteger(candidate.width) || !Number.isInteger(candidate.height)
      || candidate.width < 1 || candidate.width > 65536
      || candidate.height < 1 || candidate.height > 65536) {
      throw new P22Error('MEDIA_ASSETS_INVALID', '内部一致性错误：维度验证失败。', 500, { field: 'dimensions' });
    }
    asset.dimensions = { width: candidate.width, height: candidate.height };
  }
  return asset;
}

/**
 * 只从严格 X/Twitter CDN 白名单抓取媒体内容哈希。逐跳复验重定向目标必须仍为
 * HTTPS 白名单主机；强制 media content-type；超时与字节上限；任何失配/溢出
 * 失败关闭。未在白名单的 URL 直接抛出 MEDIA_HOST_UNSUPPORTED（绝不抓取、绝不让
 * 未验证 URL 进入 Qwen）。
 */
/**
 * Race a reader.read() promise against the abort signal so a stream that returns
 * headers but then hangs on body chunks is bounded by the same single timeout.
 */
async function readChunkWithAbort(reader, signal) {
  if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  let abortListener;
  const abortPromise = new Promise((_, reject) => {
    abortListener = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([reader.read(), abortPromise]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

export async function fetchMediaContentHash(asset, {
  fetchImpl = globalThis.fetch,
  timeoutMs = P22_LIMITS.media_fetch_timeout_ms,
  maxBytes = P22_LIMITS.media_max_bytes,
  redirectMax = P22_LIMITS.media_redirect_max,
} = {}) {
  let current;
  try {
    current = new globalThis.URL(asset.media_url);
  } catch {
    throw new P22Error('MEDIA_URL_INVALID', '媒体 URL 无效。', 502, { field: 'media_url' });
  }
  if (current.protocol !== 'https:' || !P22_MEDIA_CDN_ALLOWLIST.has(current.hostname.toLowerCase())) {
    throw new P22Error('MEDIA_HOST_UNSUPPORTED', '媒体主机不在严格 CDN 白名单内，已失败关闭。', 422, { field: 'media_url' });
  }
  // Single bounded timeout/abort across the full fetch + entire body read.
  const controller = new globalThis.AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const seen = new Set();
    for (let hop = 0; hop <= redirectMax; hop += 1) {
      if (seen.has(current.href)) throw new P22Error('MEDIA_REDIRECT_REJECTED', '媒体重定向形成循环，已失败关闭。', 502, { field: 'media_url' });
      seen.add(current.href);
      let response;
      try {
        response = await fetchImpl(current.href, { redirect: 'manual', signal: controller.signal });
      } catch (error) {
        if (error?.name === 'AbortError') throw new P22Error('MEDIA_FETCH_TIMEOUT', '媒体内容读取超时，已失败关闭。', 504, { field: 'media_url' });
        throw new P22Error('MEDIA_FETCH_REJECTED', '媒体内容读取失败，已失败关闭。', 502, { field: 'media_url' });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null;
        if (!location) throw new P22Error('MEDIA_REDIRECT_REJECTED', '媒体重定向缺少目标，已失败关闭。', 502, { field: 'media_url' });
        let next;
        try {
          next = new globalThis.URL(location, current);
        } catch {
          throw new P22Error('MEDIA_REDIRECT_REJECTED', '媒体重定向目标无效，已失败关闭。', 502, { field: 'media_url' });
        }
        if (next.protocol !== 'https:' || !P22_MEDIA_CDN_ALLOWLIST.has(next.hostname.toLowerCase())) {
          throw new P22Error('MEDIA_REDIRECT_REJECTED', '媒体重定向目标不在严格 CDN 白名单内，已失败关闭。', 502, { field: 'media_url' });
        }
        current = next;
        continue;
      }
      if (!response.ok) throw new P22Error('MEDIA_FETCH_REJECTED', '媒体内容读取未成功完成，已失败关闭。', 502, { field: 'media_url', details: { status: response.status } });
      const contentType = String(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-type') || '' : '').toLowerCase();
      if (!/^(image|video|audio)\//.test(contentType)) {
        throw new P22Error('MEDIA_CONTENT_TYPE_REJECTED', '媒体内容类型不符合 image/video/audio，已失败关闭。', 502, { field: 'media_url' });
      }
      // 声明大小预检：有效 Content-Length 超过上限立即拒绝，绝不开始读取。
      const contentLengthHeader = response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : null;
      if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
        const declaredBytes = Number(contentLengthHeader);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
          throw new P22Error('MEDIA_SIZE_OVERFLOW', '媒体声明大小超过上限，已失败关闭。', 502, { field: 'media_url' });
        }
      }
      const reader = response.body && typeof response.body.getReader === 'function' ? response.body.getReader() : null;
      if (!reader) throw new P22Error('MEDIA_FETCH_REJECTED', '媒体内容不可读取，已失败关闭。', 502, { field: 'media_url' });
      const chunks = [];
      let bytes = 0;
      for (;;) {
        let result;
        try {
          result = await readChunkWithAbort(reader, controller.signal);
        } catch (error) {
          if (error?.name === 'AbortError') {
            // Cancel the reader so the stream is released on timeout.
            try { await reader.cancel(); } catch (cancelError) { void cancelError; }
            throw new P22Error('MEDIA_FETCH_TIMEOUT', '媒体内容读取超时，已失败关闭。', 504, { field: 'media_url' });
          }
          throw error;
        }
        const { done, value } = result;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new P22Error('MEDIA_SIZE_OVERFLOW', '媒体字节超过声明上限，已失败关闭。', 502, { field: 'media_url' });
        chunks.push(value);
      }
      const digest = await sha256Hex(concatBytes(chunks));
      return { hashValue: digest, byteSize: bytes, contentType };
    }
    throw new P22Error('MEDIA_REDIRECT_REJECTED', '媒体重定向超过跳数上限，已失败关闭。', 502, { field: 'media_url' });
  } finally {
    globalThis.clearTimeout(timer);
    controller.abort();
  }
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function assertMediaKindMatchesContentType(kind, contentType) {
  const matches = (
    (kind === 'image' && /^image\//.test(contentType))
    || (kind === 'video' && /^video\//.test(contentType))
    || (kind === 'gif' && (contentType === 'image/gif' || /^video\//.test(contentType)))
  );
  if (!matches) {
    throw new P22Error(
      'MEDIA_KIND_MIME_MISMATCH',
      '媒体种类与实际内容类型不一致，已失败关闭。',
      422,
      { field: 'media_url' },
    );
  }
}

/**
 * 从 Actor 行生成有序媒体资产数组（内容哈希可选抓取）。所有实际媒体保留；
 * 超出声明上限、URL 畸形、抓取失配/溢出一律硬失败。
 */
export async function normalizeMediaAssets(raw, externalId, canonicalTweetUrl, digest, options = {}) {
  const candidates = collectMediaCandidates(raw);
  const assets = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const asset = await normalizeMediaAsset(candidate, index, externalId, canonicalTweetUrl, digest);
    const fetched = await fetchMediaContentHash(asset, options);
    assertMediaKindMatchesContentType(asset.kind, fetched.contentType);
    // fetchMediaContentHash now throws MEDIA_HOST_UNSUPPORTED for non-CDN hosts
    // instead of returning null; any successful return is a verified content hash.
    asset.hash = { algorithm: 'sha256', kind: 'content', value: fetched.hashValue };
    asset.byte_size = fetched.byteSize;
    asset.mime_type = fetched.contentType.slice(0, 100);
    assets.push(asset);
  }
  return assets;
}

/** P29 媒体资产形状校验（有界；解析 analyze 请求时使用，完整性由证明 HMAC 保证）。 */
export function validateMediaAssetShape(asset) {
  return asset && typeof asset === 'object' && !Array.isArray(asset)
    && typeof asset.id === 'string' && P29_MEDIA_ID_PATTERN.test(asset.id)
    && (asset.tweet_id === null || asset.tweet_id === undefined || (typeof asset.tweet_id === 'string' && asset.tweet_id.length <= 160))
    && (asset.external_id === null || asset.external_id === undefined || (typeof asset.external_id === 'string' && asset.external_id.length <= 160))
    && typeof asset.canonical_tweet_url === 'string' && asset.canonical_tweet_url.length <= 1000
    && typeof asset.media_url === 'string' && asset.media_url.length <= 1000
    && Number.isInteger(asset.order) && asset.order >= 0 && asset.order < P29_MAX_MEDIA
    && P29_MEDIA_KINDS.includes(asset.kind)
    && typeof asset.mime_type === 'string' && asset.mime_type.length <= 100
    && (asset.byte_size === null || asset.byte_size === undefined || (Number.isInteger(asset.byte_size) && asset.byte_size >= 0 && asset.byte_size <= P29_MAX_MEDIA_BYTES))
    && asset.hash && typeof asset.hash === 'object'
    && asset.hash.algorithm === 'sha256' && P29_HASH_KINDS.includes(asset.hash.kind) && /^[0-9a-f]{64}$/.test(asset.hash.value);
}

export function validateMediaAssetsShape(assets) {
  return Array.isArray(assets) && assets.length <= P29_MAX_MEDIA && assets.every(validateMediaAssetShape);
}

/** P29 来源快照形状校验（有界；畸形值失败关闭，缺省为 null 的规范对象）。 */
export function validateSourceMetadataShape(meta) {
  if (meta === null) return true;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const keys = Object.keys(meta);
  if (keys.some((key) => !['author', 'published_at', 'engagement'].includes(key))) return false;
  const author = meta.author;
  if (author !== null && author !== undefined) {
    if (!author || typeof author !== 'object' || Array.isArray(author)) return false;
    if (Object.keys(author).some((key) => !['name', 'handle', 'user_id'].includes(key))) return false;
    for (const [key, max] of [['name', 120], ['handle', 80], ['user_id', 80]]) {
      const value = author[key];
      if (value !== null && value !== undefined && (typeof value !== 'string' || value.trim().length === 0 || value.length > max)) return false;
    }
  }
  if (meta.published_at !== null && meta.published_at !== undefined
    && (typeof meta.published_at !== 'string' || meta.published_at.length > 80 || !P22_ISO8601_PATTERN.test(meta.published_at))) return false;
  const engagement = meta.engagement;
  if (engagement !== null && engagement !== undefined) {
    if (!engagement || typeof engagement !== 'object' || Array.isArray(engagement)) return false;
    if (Object.keys(engagement).some((key) => !P29_ENGAGEMENT_KEYS.includes(key))) return false;
    for (const key of P29_ENGAGEMENT_KEYS) {
      const value = engagement[key];
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 0 || value > P29_MAX_ENGAGEMENT)) return false;
    }
  }
  return true;
}

function stableCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(stableCanonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableCanonicalJson(value[key])]));
  }
  return value;
}

/**
 * 每条媒体资产的证明绑定（固定位置、无损）：完整绑定媒体证据身份。
 * id / URL / 顺序 / 种类 / 尺寸 / MIME / 字节大小 / 推文身份 / 规范推文 URL /
 * 哈希算法 / 哈希种类 / 哈希值 —— 全部在规范固定形式中绑定，
 * 任何字段的缺失、篡改、乱序、多余均导致验证失败关闭。
 */
function mediaBindingPayload(asset) {
  const dimensions = asset.dimensions && typeof asset.dimensions === 'object'
    ? [asset.dimensions.width, asset.dimensions.height]
    : null;
  return [
    asset.id,
    asset.media_url,
    asset.order,
    asset.kind,
    asset.mime_type,
    dimensions,
    asset.byte_size ?? null,
    asset.tweet_id ?? null,
    asset.external_id ?? null,
    asset.canonical_tweet_url,
    asset.hash && asset.hash.algorithm,
    asset.hash && asset.hash.kind,
    asset.hash && asset.hash.value,
  ];
}

/** P29 来源快照与有序媒体绑定（供 v3 证明签署；规范化 JSON 保证确定性）。 */
function p29EvidenceBindingPayload(item) {
  return JSON.stringify({
    source_metadata: stableCanonicalJson(item.source_metadata !== undefined ? item.source_metadata : null),
    media_assets: (Array.isArray(item.media_assets) ? item.media_assets : []).map(mediaBindingPayload),
  });
}

function proofPayload(version, userId, item, expiresAt) {
  // Sign a fixed-position, lossless source identity instead of a JSON object whose
  // display-only fields can be normalized by the P19 boundary. The content body is
  // still bound because verification recomputes content_sha256 before checking HMAC.
  // v3 additionally binds the author/time/engagement snapshot and every ordered
  // media identity/hash (canonical JSON), so mutation, deletion, reordering,
  // duplicate ids/URLs and wrong tweet bindings all fail closed at verification.
  const payload = [
    version,
    userId,
    expiresAt,
    item.id,
    item.source_url,
    item.external_id || null,
    item.content_sha256,
    item.provenance.schema_version,
    item.provenance.provider,
    item.provenance.run_id,
    item.provenance.collected_at,
    item.provenance.usage_total_usd,
    item.provenance.budget_reservation_id,
  ];
  if (version === P22_COLLECTION_PROOF_VERSION) payload.push(p29EvidenceBindingPayload(item));
  return JSON.stringify(payload);
}

async function sha256Hex(value) {
  // Uint8Array 直接按原始字节摘要（绝不 String() 化字节数组）；字符串按 UTF-8 字节。
  const input = value instanceof Uint8Array ? value : new globalThis.TextEncoder().encode(String(value));
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, domain, payload) {
  if (typeof secret !== 'string' || secret.length < 32) throw new P22Error('SERVICE_CONFIG_MISSING', '服务端来源证明配置不可用。', 500);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new globalThis.TextEncoder().encode(`${domain}\0${payload}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 证明域分隔：v2 域固定（存量证明必须继续可验证）；v3 使用独立域。 */
function proofDomain(version) {
  return version === P22_COLLECTION_PROOF_VERSION ? 'p22-collection-proof-v3' : 'p22-collection-proof-v2';
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function issueCollectionProof(secret, userId, item, { nowMs = Date.now() } = {}) {
  const expiresAt = Math.floor((nowMs + P22_LIMITS.proof_ttl_ms) / 1000);
  const signature = await hmacHex(secret, proofDomain(P22_COLLECTION_PROOF_VERSION), proofPayload(P22_COLLECTION_PROOF_VERSION, userId, item, expiresAt));
  return `${expiresAt}.${signature}`;
}

/**
 * 验证 P22 采集证明。v3 绑定来源快照与媒体身份；带 P29 扩展字段（source_metadata /
 * media_assets）的条目必须使用 v3（v2 无媒体绑定，绝不接受带媒体的 v2 证明）。
 * 无扩展字段的存量条目显式接受 v2 证明（向后兼容），同时接受 v3。
 * 证明字符串格式均为 <expires>.<64hex>；版本在签名载荷内部，混合/畸形版本失败关闭。
 */
export async function verifyCollectionProof(secret, userId, item, proof, { nowMs = Date.now() } = {}) {
  const match = /^(\d{10})\.([0-9a-f]{64})$/i.exec(String(proof || ''));
  if (!match) throw new P22Error('SOURCE_PROOF_INVALID', '来源证明无效。', 400, { field: 'collection_proof' });
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 < nowMs) {
    throw new P22Error('SOURCE_PROOF_EXPIRED', '来源证明已过期，请重新采集。', 400, { field: 'collection_proof' });
  }
  if (!/^[0-9a-f]{64}$/.test(String(item?.content_sha256 || ''))
    || await sha256Hex(item?.content_text || '') !== item.content_sha256) {
    throw new P22Error('SOURCE_PROOF_INVALID', '来源证明与正文哈希不匹配。', 400, { field: 'content_sha256' });
  }
  // 仅当存在非空扩展字段时强制 v3（null 快照 / 空媒体数组视为无扩展，
  // 存量 v2 记录继续可验证；v3 证明始终先按 v3 载荷校验）。
  const hasExtension = item && ((item.source_metadata !== undefined && item.source_metadata !== null)
    || (Array.isArray(item.media_assets) && item.media_assets.length > 0));
  if (hasExtension && !(Array.isArray(item.media_assets) && item.media_assets.length <= P22_LIMITS.max_media && item.media_assets.every(validateMediaAssetShape))) {
    throw new P22Error('SOURCE_PROOF_INVALID', '媒体资产形状无效，已失败关闭。', 400, { field: 'media_assets' });
  }
  if (hasExtension && item.source_metadata !== undefined && !validateSourceMetadataShape(item.source_metadata)) {
    throw new P22Error('SOURCE_PROOF_INVALID', '来源快照形状无效，已失败关闭。', 400, { field: 'source_metadata' });
  }
  const expectedV3 = await hmacHex(secret, proofDomain(P22_COLLECTION_PROOF_VERSION), proofPayload(P22_COLLECTION_PROOF_VERSION, userId, item, expiresAt));
  if (constantTimeHexEqual(expectedV3, match[2].toLowerCase())) return true;
  if (!hasExtension) {
    // 存量记录（无 P29 扩展字段）显式接受 v2 证明；带扩展字段的条目绝不接受 v2。
    const expectedV2 = await hmacHex(secret, proofDomain(P22_COLLECTION_PROOF_V2_VERSION), proofPayload(P22_COLLECTION_PROOF_V2_VERSION, userId, item, expiresAt));
    if (constantTimeHexEqual(expectedV2, match[2].toLowerCase())) return true;
  }
  throw new P22Error('SOURCE_PROOF_INVALID', '来源证明与内容不匹配（含来源快照与媒体绑定）。', 400, { field: 'collection_proof' });
}

export async function verifyAnalyzeSources(secret, userId, items, options = {}) {
  if (!Array.isArray(items) || items.length < 1 || items.length > P22_LIMITS.analyze) {
    throw new P22Error('ITEM_COUNT_OUT_OF_RANGE', `分析来源数量必须为 1-${P22_LIMITS.analyze}。`, 400);
  }
  for (const item of items) {
    await verifyCollectionProof(secret, userId, item, item?.collection_proof, options);
  }
  return true;
}

/**
 * 规范化 Actor 行：正文/身份 + 有界来源快照（作者/时间/互动）+ 有序媒体资产。
 * 内容 SHA-256 只从严格 CDN 白名单抓取（fetchMediaContentHash 失败即整体失败关闭，
 * 绝不把抓取失败静默降级为 url 哈希）。`options.fetchMediaImpl` 可注入供测试离线运行。
 * @param {Array<object>} rawItems Actor 原始行数组。
 * @param {object} context 采集上下文（provider/run_id/collected_at/usage/budget）。
 * @param {function(string): Promise<string>} digest 内容 SHA-256 摘要函数。
 * @param {object} [options] 可选配置。
 * @param {number} [options.maxItems] 最大保留条数（P32-B 搜索 20 / 普通采集缺省 5）。
 * @param {function} [options.fetchImpl] 媒体内容哈希抓取的 fetch 实现（可注入供测试离线运行）。
 */
export async function normalizeCollectedItems(rawItems, context, digest, options = {}) {
  if (!Array.isArray(rawItems)) throw new P22Error('PROVIDER_RESPONSE_INVALID', '采集响应不是数组。', 502);
  const output = [];
  const seen = new Set();
  // P32-B：搜索允许最多 P22_LIMITS.search_max 条；单帖/普通采集保持 P22_LIMITS.collect。
  const limit = Math.max(1, Math.min(options.maxItems ?? P22_LIMITS.collect, P22_LIMITS.search_max));
  for (const raw of rawItems.slice(0, limit)) {
    if (!object(raw) || raw.demo === true || raw.noResults === true || raw.resultType === 'diagnostic') continue;
    const externalId = String(first(raw.external_content_id, raw.tweet_id, raw.tweetId, raw.rest_id, raw.id_str, raw.id, '')).trim();
    const candidateUrl = first(raw.url, raw.content_url, raw.webpage_url, raw.tweet_url, externalId ? `https://x.com/i/web/status/${encodeURIComponent(externalId)}` : '');
    if (!candidateUrl) continue;
    const sourceUrl = normalizeXUrl(candidateUrl);
    const contentText = visibleText(raw).slice(0, P22_LIMITS.persist_text);
    if (!contentText) continue;
    const contentSha256 = await digest(contentText);
    const key = `${sourceUrl}|${externalId}|${contentSha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mediaAssets = await normalizeMediaAssets(raw, externalId || sourceUrl.match(/\/status\/(\d+)/)?.[1] || null, sourceUrl, digest, options);
    output.push({
      id: `p22-${contentSha256.slice(0, 24)}`,
      source_url: sourceUrl,
      label: String(first(raw.title, contentText.slice(0, 120), 'X 公开内容')).trim().slice(0, 200),
      platform: 'x',
      content_text: contentText,
      external_id: externalId || sourceUrl.match(/\/status\/(\d+)/)?.[1] || null,
      content_sha256: contentSha256,
      source_metadata: normalizeSourceMetadata(raw),
      media_assets: mediaAssets,
      provenance: {
        schema_version: 'p22_collected_source_v1',
        provider: context.provider,
        run_id: context.run_id,
        collected_at: context.collected_at,
        usage_total_usd: context.usage_total_usd,
        budget_reservation_id: context.budget_reservation_id,
      },
    });
  }
  if (!output.length) throw new P22Error('EMPTY_PROVIDER_RESULT', '没有返回可验证的公开内容。', 422);
  return output;
}

/**
 * Exact-URL collection is a one-post contract. Validate the provider's raw
 * response before normalization can remove duplicate rows.
 */
export function assertUniqueRawCollectedPost(rawItems, requested) {
  if (!Array.isArray(rawItems)) throw new P22Error('PROVIDER_RESPONSE_INVALID', '采集响应不是数组。', 502);
  const expected = identifyPublicPostUrl(requested?.canonical_url || requested?.url || '');
  if (rawItems.length > P22_LIMITS.collect) {
    throw new P22Error('PROVIDER_RESULT_LIMIT_EXCEEDED', '采集返回条目超过单次上限。', 422, { field: 'items' });
  }
  const rows = rawItems.filter((raw) => (
    object(raw) && raw.demo !== true && raw.noResults !== true && raw.resultType !== 'diagnostic'
  ));
  if (rows.length !== 1) {
    throw new P22Error(rows.length ? 'AMBIGUOUS_POST_RESULT' : 'POST_NOT_FOUND', '采集结果无法唯一绑定到请求的帖子。', 422, { field: 'source_url' });
  }
  const raw = rows[0];
  const externalId = String(first(raw.external_content_id, raw.tweet_id, raw.tweetId, raw.rest_id, raw.id_str, raw.id, '')).trim();
  const candidateUrl = first(raw.url, raw.content_url, raw.webpage_url, raw.tweet_url, externalId ? `https://x.com/i/web/status/${encodeURIComponent(externalId)}` : '');
  try {
    const actual = identifyPublicPostUrl(candidateUrl || '');
    if (actual.platform !== expected.platform || actual.external_id !== expected.external_id
      || String(externalId || actual.external_id) !== expected.external_id) {
      throw new Error('identity mismatch');
    }
  } catch {
    throw new P22Error('POST_NOT_FOUND', '采集结果无法绑定到请求的帖子。', 422, { field: 'source_url' });
  }
  return true;
}

/**
 * P32-B：搜索结果唯一性断言（fail closed）。规范化已去重（静默跳过），但搜索是
 * 批量结果契约：任何 source URL / external ID / 正文哈希出现重复，即视为提供方
 * 响应错绑或重复，整批失败关闭，绝不静默丢弃或接受。
 */
export function assertUniqueSearchResults(items) {
  if (!Array.isArray(items)) throw new P22Error('PROVIDER_RESPONSE_INVALID', '搜索响应不是数组。', 502);
  const seenUrl = new Set();
  const seenId = new Set();
  const seenHash = new Set();
  for (const item of items) {
    const url = String(item?.source_url || '');
    const id = item?.external_id == null ? '' : String(item.external_id);
    const hash = String(item?.content_sha256 || '');
    if (seenUrl.has(url) || (id && seenId.has(id)) || (hash && seenHash.has(hash))) {
      throw new P22Error('SEARCH_RESULT_DUPLICATE', '搜索结果包含重复来源身份（URL/外部 ID/正文哈希），已失败关闭。', 422, { field: 'items' });
    }
    if (url) seenUrl.add(url);
    if (id) seenId.add(id);
    if (hash) seenHash.add(hash);
  }
  return true;
}

/**
 * P32-B：搜索批次身份。确定性绑定精确关键词、数量、排序意图、采集运行、
 * 采集时间与全部结果的（URL|外部 ID|正文哈希）有序身份集合 —— 任何字段的
 * 缺失、篡改、乱序、错绑都会产生不同批次身份，导入端据此失败关闭。
 */
export async function searchBatchId({ keyword, count, sort, runId, collectedAt, items }, digest) {
  const identities = (Array.isArray(items) ? items : [])
    .map((item) => `${String(item?.source_url || '')}|${item?.external_id == null ? '' : String(item.external_id)}|${String(item?.content_sha256 || '')}`)
    .join(';');
  const value = `p32-search-batch\0${String(keyword || '')}\0${String(count ?? '')}\0${String(sort || '')}\0${String(runId || '')}\0${String(collectedAt || '')}\0${identities}`;
  const digestValue = await digest(value);
  return `p32-search-${String(digestValue).slice(0, 24)}`;
}

/** Bind a provider response to exactly one requested post identity. */
export function bindExactCollectedPost(items, requested) {
  if (!Array.isArray(items)) throw new P22Error('PROVIDER_RESPONSE_INVALID', '采集响应不是数组。', 502);
  const expected = identifyPublicPostUrl(requested?.canonical_url || requested?.url || '');
  const matches = items.filter((item) => {
    try {
      const actual = identifyPublicPostUrl(item?.source_url || '');
      return actual.platform === expected.platform && actual.external_id === expected.external_id
        && String(item?.external_id || actual.external_id) === expected.external_id;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new P22Error(matches.length ? 'AMBIGUOUS_POST_RESULT' : 'POST_NOT_FOUND', '采集结果无法唯一绑定到请求的帖子。', 422, { field: 'source_url' });
  }
  return [matches[0]];
}

export function buildQwenPrompt(items) {
  const sources = items.map((item, index) => ({ index: index + 1, id: item.id, url: item.source_url, text: item.content_text }));
  return [
    '你是只读内容研究助手。只分析给定公开来源，不补写事实。',
    '返回严格 JSON：{"analyses":[{"source_id":"...","summary":"...","signals":["..."],"risks":["..."]}]}。',
    '每条摘要不超过 300 字；signals/risks 各最多 5 项；不得生成营销成品、路由或发布指令。',
    'Each summary must be non-empty and at most 300 Unicode characters. signals and risks must be arrays with at most 5 non-empty items, each at most 240 Unicode characters.',
    JSON.stringify(sources),
  ].join('\n');
}

export function parseQwenAnalyses(payload, items) {
  const rawText = String(payload?.choices?.[0]?.message?.content || '').trim();
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { throw new P22Error('MODEL_RESPONSE_INVALID', '分析响应不是有效 JSON。', 502); }
  if (!Array.isArray(parsed.analyses) || parsed.analyses.length !== items.length) throw new P22Error('MODEL_RESPONSE_INVALID', '分析响应与来源数量不一致。', 502);
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set();
  return parsed.analyses.map((row) => {
    const sourceId = text(row?.source_id, 'source_id', 160);
    if (!byId.has(sourceId) || seen.has(sourceId)) throw new P22Error('MODEL_SOURCE_BINDING_INVALID', '分析来源绑定无效。', 502, { field: 'source_id' });
    seen.add(sourceId);
    const boundedList = (value, field) => {
      if (!Array.isArray(value) || value.length > 5) throw new P22Error('MODEL_RESPONSE_INVALID', `${field} 无效。`, 502, { field });
      return value.map((entry) => boundedModelText(entry, field, 240));
    };
    return {
      source_id: sourceId,
      source_url: byId.get(sourceId).source_url,
      content_sha256: byId.get(sourceId).content_sha256,
      summary: boundedModelText(row.summary, 'summary', 300),
      signals: boundedList(row.signals, 'signals'),
      risks: boundedList(row.risks, 'risks'),
      method: 'qwen_assisted_review',
    };
  });
}

/**
 * P29 多模态请求体：来源文本 + 每个已验证媒体 URL（精确顺序）。
 * 图片/GIF 使用 image_url 部件，视频使用 video_url 部件（OpenAI 兼容 DashScope 契约）。
 * 仅已验证内容哈希（kind === 'content'）的媒体才能进入 Qwen 多模态请求；
 * 存在任何未验证媒体（kind !== 'content' 或缺少哈希）一律 fail closed，
 * 绝不将未验证 URL 泄露到文本来源 JSON 或任何请求部件中。
 */
export function buildMultimodalQwenContent(items) {
  // 失败关闭：任何媒体资产缺少已验证内容哈希即整体拒绝，绝不构造请求。
  for (const item of items) {
    for (const asset of item.media_assets || []) {
      if (!asset.hash || asset.hash.kind !== 'content') {
        throw new P22Error('MEDIA_PROOF_INCOMPLETE', '媒体资产缺少已验证内容哈希，无法构造多模态请求，已失败关闭。', 422, { media_id: asset.id });
      }
      let mediaUrl;
      try {
        mediaUrl = new globalThis.URL(asset.media_url);
      } catch {
        throw new P22Error('MEDIA_URL_INVALID', '媒体 URL 无效，无法构造多模态请求。', 422, { media_id: asset.id });
      }
      if (mediaUrl.protocol !== 'https:' || !P22_MEDIA_CDN_ALLOWLIST.has(mediaUrl.hostname.toLowerCase())) {
        throw new P22Error('MEDIA_HOST_UNSUPPORTED', '媒体主机不在严格 CDN 白名单内，无法构造多模态请求。', 422, { media_id: asset.id });
      }
    }
  }
  const sources = items.map((item, index) => ({
    index: index + 1,
    id: item.id,
    url: item.source_url,
    text: item.content_text,
    media: (item.media_assets || []).map((asset) => ({ id: asset.id, url: asset.media_url, kind: asset.kind })),
  }));
  const text = [
    '你是只读多模态内容研究助手。只分析给定公开来源与所附媒体，不补写事实。',
    '返回严格 JSON：{"analyses":[{"source_id":"...","text_expression":"...","hook":"...","copy_pattern":"...","target_audience":"...","audience_need_emotion":"...","media_analysis":[{"media_id":"...","visual_content":"...","composition":"...","people":"...","scene":"...","emotion":"...","visual_selling_points":["..."],"style_pattern":"..."}],"virality_drivers":["..."],"reusable_methods":["..."],"rewrite_suggestions":["..."],"signals":["..."],"risks":["..."]}]}',
    'hook 是文本/标题钩子（≤500 字）；copy_pattern 是文案模式；target_audience 是目标受众；audience_need_emotion 是受众需求/情感。',
    'visual_selling_points 是每条媒体的视觉卖点（最多 3 项、每项 ≤240 字）；style_pattern 是风格模式（≤500 字）。rewrite_suggestions 是可复写的建议（最多 5 项、每项 ≤240 字）。',
    'media_analysis 必须与每个来源的媒体一一对应并保持相同顺序，每项精确绑定 media_id；无媒体的来源 media_analysis 必须为空数组。',
    'text_expression/hook/copy_pattern/target_audience/audience_need_emotion 各 ≤500 字；virality_drivers/reusable_methods/rewrite_suggestions/signals/risks 各最多 5 项、每项最多 240 字；逐媒体字段各不超过 500 字。',
    '不得生成营销成品、路由或发布指令。',
    'Each media_analysis entry must bind the exact media_id in the same order as the source; missing, duplicate, reordered, foreign or extra media ids are invalid.',
    JSON.stringify(sources),
  ].join('\n');
  const parts = [{ type: 'text', text }];
  for (const item of items) {
    for (const asset of item.media_assets || []) {
      // 纵深防御：所有媒体在此处已知为已验证内容哈希（上游已 fail closed），
      // 此处仅构造对应多模态部件；gif 仍使用 image_url 部件。
      parts.push(asset.kind === 'image' || asset.kind === 'gif'
        ? { type: 'image_url', image_url: { url: asset.media_url } }
        : { type: 'video_url', video_url: { url: asset.media_url } });
    }
  }
  return parts;
}

/**
 * P29 多模态响应解析（严格、来源绑定、逐媒体绑定）：
 * - analyses 与来源一一对应且唯一；
 * - 每条 media_analysis 必须按精确顺序绑定来源媒体的精确 id —— 缺失、重复、
 *   乱序、外来、多余 id 一律 fail closed；
 * - 全部文本有界；未知字段静默由 JSON 结构检查失败关闭。
 */
export function parseQwenMultimodalAnalyses(payload, items) {
  const rawText = String(payload?.choices?.[0]?.message?.content || '').trim();
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { throw new P22Error('MODEL_RESPONSE_INVALID', '分析响应不是有效 JSON。', 502); }
  if (!Array.isArray(parsed.analyses) || parsed.analyses.length !== items.length) throw new P22Error('MODEL_RESPONSE_INVALID', '分析响应与来源数量不一致。', 502);
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set();
  const boundedList = (value, field) => {
    if (!Array.isArray(value) || value.length > 5) throw new P22Error('MODEL_RESPONSE_INVALID', `${field} 无效。`, 502, { field });
    return value.map((entry) => boundedModelText(entry, field, 240));
  };
  const boundedVisual = (value, field) => boundedModelText(value, field, 500);
  return parsed.analyses.map((row) => {
    const sourceId = text(row?.source_id, 'source_id', 160);
    if (!byId.has(sourceId) || seen.has(sourceId)) throw new P22Error('MODEL_SOURCE_BINDING_INVALID', '分析来源绑定无效。', 502, { field: 'source_id' });
    seen.add(sourceId);
    const item = byId.get(sourceId);
    const mediaIds = (item.media_assets || []).map((asset) => asset.id);
    const mediaRows = row.media_analysis;
    if (!Array.isArray(mediaRows) || mediaRows.length !== mediaIds.length) {
      throw new P22Error('MODEL_MEDIA_BINDING_INVALID', '逐媒体分析与来源媒体数量不一致（含缺失/多余）。', 502, { field: 'media_analysis' });
    }
    const mediaAnalysis = mediaRows.map((entry, index) => {
      if (!object(entry) || entry.media_id !== mediaIds[index]) {
        throw new P22Error('MODEL_MEDIA_BINDING_INVALID', '逐媒体分析未按顺序绑定精确媒体 id（缺失/重复/乱序/外来均失败）。', 502, { field: 'media_analysis' });
      }
      const base = {
        media_id: entry.media_id,
        visual_content: boundedVisual(entry.visual_content, 'visual_content'),
        composition: boundedVisual(entry.composition, 'composition'),
        people: boundedVisual(entry.people, 'people'),
        scene: boundedVisual(entry.scene, 'scene'),
        emotion: boundedVisual(entry.emotion, 'emotion'),
      };
      // P32-A v2 扩展：视觉卖点与风格模式（Qwen 可选输出，缺省为空）
      if (entry.visual_selling_points !== undefined) {
        base.visual_selling_points = (Array.isArray(entry.visual_selling_points) ? entry.visual_selling_points : []).slice(0, 3).map((v) => boundedModelText(v, 'visual_selling_points', 240));
      }
      if (entry.style_pattern !== undefined) {
        base.style_pattern = boundedVisual(entry.style_pattern, 'style_pattern');
      }
      return base;
    });
    const v2Fields = {};
    // P32-A v2 扩展：钩子/文案模式/受众/情感/改写建议（Qwen 可选输出，缺省为空字符串或空数组）
    if (row.hook !== undefined) v2Fields.hook = boundedModelText(row.hook, 'hook', 500);
    if (row.copy_pattern !== undefined) v2Fields.copy_pattern = boundedModelText(row.copy_pattern, 'copy_pattern', 500);
    if (row.target_audience !== undefined) v2Fields.target_audience = boundedModelText(row.target_audience, 'target_audience', 500);
    if (row.audience_need_emotion !== undefined) v2Fields.audience_need_emotion = boundedModelText(row.audience_need_emotion, 'audience_need_emotion', 500);
    if (row.rewrite_suggestions !== undefined) v2Fields.rewrite_suggestions = boundedList(row.rewrite_suggestions, 'rewrite_suggestions');
    return {
      source_id: sourceId,
      source_url: item.source_url,
      content_sha256: item.content_sha256,
      text_expression: boundedModelText(row.text_expression, 'text_expression', 300),
      media_analysis: mediaAnalysis,
      virality_drivers: boundedList(row.virality_drivers, 'virality_drivers'),
      reusable_methods: boundedList(row.reusable_methods, 'reusable_methods'),
      signals: boundedList(row.signals, 'signals'),
      risks: boundedList(row.risks, 'risks'),
      method: 'qwen_multimodal_assisted_review',
      ...v2Fields,
    };
  });
}

export function publicError(error) {
  if (error instanceof P22Error) return { code: error.code, message: error.message, status: error.status, details: error.details };
  return { code: 'INTERNAL_ERROR', message: '智能研究服务暂时不可用，内部细节已隐藏。', status: 500, details: {} };
}

// ---------------------------------------------------------------------------
// Apify 提供方适配边界（fail-closed）
//
// 只使用 Apify API v2 的文档化端点，明确地取得运行身份与数据集身份：
//   POST /v2/acts/{actorId}/runs?maxTotalChargeUsd=...  启动运行；POST 请求体本身即 Actor 的
//       顶层输入 { maxItems, sort, searchTerms }，不包裹 input（包裹后 Actor 收不到顶层字段）
//   GET  /v2/actor-runs/{runId}?waitForFinish=60        在严格超时内等待终态
//   GET  /v2/actor-runs/{runId}/dataset/items?limit&clean  只取该运行的默认数据集
//   GET  /v2/actor-runs/{runId}（有界稳定轮询）           同一运行的稳定 usageTotalUsd
// 启动响应必须提供 data.id 与 data.defaultDatasetId，作为唯一的运行与数据集身份；等待与费用
// 阶段每次都重新校验，缺失/变化/外来一律失败关闭。费用在终态 SUCCEEDED 后按有界轮询次数读取，
// 每次读取都必须保持 status === 'SUCCEEDED' 才允许观测费用；状态缺失/过渡态（RUNNING/READY）/
// 未知/终态失败一律失败关闭。两次连续相等才作为最终费用证据；初步值允许上升（继续有界等待），
// 但下降/矛盾或始终不稳定都失败关闭。
// 不使用任何响应头（如 x-apify-actor-run-id）作为运行身份或费用证据来源。
// 所有失败都折叠为有界类别；诊断只含白名单字段，绝不包含令牌、请求体或上游原文。
// ---------------------------------------------------------------------------

const PROVIDER_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROVIDER_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;
const PROVIDER_TERMINAL_FAILURES = new Set(['FAILED', 'ABORTED', 'TIMED-OUT']);
const PROVIDER_RUN_STATUS_PATTERN = /^[A-Z0-9-]{1,32}$/;

const PROVIDER_MESSAGES = Object.freeze({
  APIFY_UPSTREAM_REJECTED: '公开来源服务拒绝请求。',
  APIFY_RUN_ID_INVALID: '无法验证采集运行身份。',
  APIFY_RUN_FAILED: '采集运行未成功完成。',
  APIFY_TIMEOUT: '采集超时。',
  APIFY_DATASET_INVALID: '采集结果数据无效。',
  APIFY_COST_UNVERIFIABLE: '无法验证采集费用。',
  APIFY_COST_ABOVE_RESERVATION: '采集费用超过预留预算。',
});

const PROVIDER_HTTP = Object.freeze({
  APIFY_UPSTREAM_REJECTED: 502,
  APIFY_RUN_ID_INVALID: 502,
  APIFY_RUN_FAILED: 502,
  APIFY_TIMEOUT: 504,
  APIFY_DATASET_INVALID: 502,
  APIFY_COST_UNVERIFIABLE: 502,
  APIFY_COST_ABOVE_RESERVATION: 502,
});

/** 只接受符合有界模式的提供方标识；其他值一律返回 null（不进入诊断）。 */
function boundedProviderId(value) {
  return typeof value === 'string' && PROVIDER_RUN_ID_PATTERN.test(value) ? value : null;
}

/** 只接受符合有界模式的提供方运行标识；其他值一律返回 null（不进入诊断）。 */
export function boundedProviderRunId(value) {
  return boundedProviderId(value);
}

/** 构造只含白名单有界字段的结构化诊断；绝不包含令牌、请求体或原始上游响应。 */
export function providerDiagnostic({ provider = 'apify', stage = null, status = null, runId = null, reason = null, runStatus = null } = {}) {
  const details = { provider: String(provider).slice(0, 40) };
  if (stage) details.stage = String(stage).slice(0, 24);
  if (Number.isInteger(status) && status >= 100 && status <= 599) details.status = status;
  const safeRunId = boundedProviderRunId(runId);
  if (safeRunId) details.run_id = safeRunId;
  if (runStatus && PROVIDER_RUN_STATUS_PATTERN.test(String(runStatus))) details.run_status = String(runStatus);
  if (reason) details.reason = String(reason).slice(0, 24);
  return details;
}

function providerError(code, stage, { status = null, runId = null, reason = null, runStatus = null } = {}) {
  return new P22Error(code, PROVIDER_MESSAGES[code], PROVIDER_HTTP[code], providerDiagnostic({ stage, status, runId, reason, runStatus }));
}

async function readJson(response, code, stage, { runId = null } = {}) {
  let payload;
  try { payload = await response.json(); } catch { throw providerError(code, stage, { runId, reason: 'unparseable' }); }
  return payload;
}

async function providerFetch(fetchImpl, url, init, stage, { runId = null } = {}) {
  let response;
  try { response = await fetchImpl(url, init); }
  catch (error) {
    if (error?.name === 'AbortError') throw providerError('APIFY_TIMEOUT', stage, { runId });
    throw providerError('APIFY_UPSTREAM_REJECTED', stage, { runId, reason: 'transport' });
  }
  if (!response.ok) throw providerError('APIFY_UPSTREAM_REJECTED', stage, { status: response.status, runId });
  return response;
}

function startRunIdentity(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) throw providerError('APIFY_RUN_ID_INVALID', 'start', { reason: 'duplicate' });
  const id = data?.id;
  if (id == null || id === '') throw providerError('APIFY_RUN_ID_INVALID', 'start', { reason: 'missing' });
  const runId = boundedProviderId(String(id));
  if (!runId) throw providerError('APIFY_RUN_ID_INVALID', 'start', { reason: 'malformed' });
  return { runId, datasetId: runDatasetId(data, 'start', runId) };
}

function runDatasetId(data, stage, runId) {
  const rawDatasetId = data?.defaultDatasetId;
  if (rawDatasetId == null || rawDatasetId === '') {
    throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'dataset_missing' });
  }
  const datasetId = boundedProviderId(String(rawDatasetId));
  if (!datasetId) throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'dataset_malformed' });
  return datasetId;
}

function verifyRunIdentity(payload, runId, datasetId, stage) {
  const data = payload?.data;
  if (Array.isArray(data)) throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'duplicate' });
  const seenId = data?.id;
  if (seenId == null || seenId === '') throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'missing' });
  if (String(seenId) !== runId) throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'foreign' });
  const seenDatasetId = data?.defaultDatasetId;
  if (seenDatasetId == null || seenDatasetId === '') {
    throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'dataset_missing' });
  }
  if (String(seenDatasetId) !== datasetId) {
    throw providerError('APIFY_RUN_ID_INVALID', stage, { runId, reason: 'dataset_foreign' });
  }
  return data;
}

/**
 * 执行文档化的 Apify 采集序列并返回 { runId, items, usageTotalUsd }。
 * POST 请求体即 Actor 的顶层输入；启动响应必须提供 data.id 与 data.defaultDatasetId，
 * 等待与费用阶段每次读取都重新校验这对身份，且费用阶段每次读取还必须保持
 * status === 'SUCCEEDED' 才允许观测费用。费用在终态 SUCCEEDED 后按有界轮询次数
 * 稳定读取：两次连续相等才作为最终费用证据，下降/矛盾、状态缺失/过渡态/未知/
 * 终态失败或始终不稳定则失败关闭。
 * 所有边界（maxItems、maxTotalChargeUsd、超时、轮询间隔、稳定次数）都受 P22_LIMITS 约束；
 * token 只用于 Authorization 头，绝不进入返回值、诊断或异常。
 * @param {object} options 采集序列选项。
 * @param {string} options.token Apify 令牌（只用于 Authorization 头）。
 * @param {string} options.actorId Apify Actor 标识（xquik/x-tweet-scraper）。
 * @param {string} [options.topic] 关键词搜索主题（与 sourceUrl 二选一）。
 * @param {string} [options.sourceUrl] 单帖读取 URL（与 topic 二选一）。
 * @param {number} [options.count] 请求的 Actor 输入条数。
 * @param {number} [options.maxItems] 请求的 Actor 输入上限（P32-B 搜索 20 / 采集 5）。
 * @param {number} [options.hardMax] 服务端硬上限（搜索 20 / 采集 5；两者分离，绝不放宽普通采集）。
 * @param {number} [options.maxTotalChargeUsd] 单次最大费用（USD，受 P22_LIMITS 约束）。
 * @param {function} [options.fetchImpl] fetch 实现（可注入供测试离线运行）。
 * @param {function} [options.sleepImpl] 等待实现（可注入供测试离线运行）。
 * @param {function} [options.nowImpl] 当前时间实现（可注入供测试离线运行）。
 * @param {number} [options.waitTimeoutMs] 等待完成超时（受 P22_LIMITS 约束）。
 * @param {number} [options.pollIntervalMs] 等待轮询间隔（受 P22_LIMITS 约束）。
 * @param {number} [options.costStabilizePolls] 费用稳定读取次数（受 P22_LIMITS 约束）。
 * @param {number} [options.costStabilizeIntervalMs] 费用稳定读取间隔（受 P22_LIMITS 约束）。
 * @param {AbortSignal} [options.signal] 中止信号（超时门禁）。
 * @returns {Promise<{runId: string, items: Array<object>, usageTotalUsd: number}>} 运行身份、原始结果行与稳定费用。
 */
export async function runApifyCollectionSequence({
  token,
  actorId,
  topic,
  sourceUrl,
  count,
  maxItems = P22_LIMITS.collect,
  /** P32-B：搜索允许最多 P22_LIMITS.search_max 条；其余调用保持 P22_LIMITS.collect。 */
  hardMax = P22_LIMITS.collect,
  maxTotalChargeUsd,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  nowImpl = Date.now,
  waitTimeoutMs = P22_LIMITS.apify_wait_ms,
  pollIntervalMs = P22_LIMITS.apify_poll_interval_ms,
  costStabilizePolls = P22_LIMITS.cost_stabilize_polls,
  costStabilizeIntervalMs = P22_LIMITS.cost_stabilize_interval_ms,
  signal,
}) {
  const boundedMaxItems = Math.max(1, Math.min(Math.max(1, Number(hardMax) || P22_LIMITS.collect), Number(maxItems) || P22_LIMITS.collect));
  const boundedCount = Math.max(1, Math.min(boundedMaxItems, Number(count) || 1));
  const boundedTopic = String(topic || '').trim().slice(0, 240);
  const boundedSource = sourceUrl ? identifyPublicPostUrl(sourceUrl) : null;
  const boundedSourceUrl = boundedSource?.canonical_url || '';
  const boundedSourceId = boundedSource?.external_id || '';
  const boundedCharge = Math.max(0, Math.min(Number(maxTotalChargeUsd) || P22_LIMITS.apify_reservation_cny / P22_CNY_PER_USD, P22_LIMITS.apify_reservation_cny / P22_CNY_PER_USD));
  const actorPath = String(actorId || '').trim().replace('/', '~');
  if (typeof token !== 'string' || !token) throw providerError('APIFY_UPSTREAM_REJECTED', 'start', { reason: 'not_configured' });
  if ((!boundedTopic && !boundedSourceUrl) || (boundedTopic && boundedSourceUrl) || !PROVIDER_ACTOR_PATTERN.test(actorPath)) {
    throw providerError('APIFY_RUN_ID_INVALID', 'start', { reason: 'malformed' });
  }

  const startUrl = new globalThis.URL(`https://api.apify.com/v2/acts/${encodeURIComponent(actorPath)}/runs`);
  startUrl.searchParams.set('maxTotalChargeUsd', String(boundedCharge));
  const topicBody = JSON.stringify({ maxItems: boundedCount, sort: 'Latest', searchTerms: [boundedTopic] });
  // Exact-post reads use the Actor's dedicated tweetIds contract. Passing the
  // canonical /i/web/status URL through startUrls is less deterministic across
  // Actor router versions and can yield a diagnostic row instead of the tweet.
  const urlBody = JSON.stringify({ maxItems: 1, tweetIds: [boundedSourceId] });
  const actorBody = boundedSourceUrl ? urlBody : topicBody;
  const startResponse = await providerFetch(fetchImpl, startUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: actorBody,
    signal,
  }, 'start');
  const { runId, datasetId } = startRunIdentity(await readJson(startResponse, 'APIFY_RUN_ID_INVALID', 'start'));

  const waitDeadline = nowImpl() + waitTimeoutMs;
  for (;;) {
    if (signal?.aborted) throw providerError('APIFY_TIMEOUT', 'wait', { runId });
    const remaining = waitDeadline - nowImpl();
    if (remaining <= 0) throw providerError('APIFY_TIMEOUT', 'wait', { runId });
    const waitUrl = new globalThis.URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`);
    waitUrl.searchParams.set('waitForFinish', String(Math.min(60, Math.max(1, Math.floor(remaining / 1000)))));
    const waitResponse = await providerFetch(fetchImpl, waitUrl, { headers: { Authorization: `Bearer ${token}` }, signal }, 'wait', { runId });
    const waitRun = verifyRunIdentity(await readJson(waitResponse, 'APIFY_RUN_ID_INVALID', 'wait', { runId }), runId, datasetId, 'wait');
    const runStatus = String(waitRun?.status || '');
    if (!runStatus) throw providerError('APIFY_RUN_ID_INVALID', 'wait', { runId, reason: 'malformed' });
    if (runStatus === 'SUCCEEDED') break;
    if (PROVIDER_TERMINAL_FAILURES.has(runStatus)) throw providerError('APIFY_RUN_FAILED', 'wait', { runId, runStatus });
    await sleepImpl(pollIntervalMs);
  }

  const datasetUrl = new globalThis.URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/dataset/items`);
  datasetUrl.searchParams.set('limit', String(boundedMaxItems));
  datasetUrl.searchParams.set('clean', 'true');
  const datasetResponse = await providerFetch(fetchImpl, datasetUrl, { headers: { Authorization: `Bearer ${token}` }, signal }, 'dataset', { runId });
  const datasetPayload = await readJson(datasetResponse, 'APIFY_DATASET_INVALID', 'dataset', { runId });
  const datasetEnvelope = datasetPayload && typeof datasetPayload === 'object' && !Array.isArray(datasetPayload) ? datasetPayload : null;
  if (datasetEnvelope) {
    if (datasetEnvelope.run_id != null && datasetEnvelope.run_id !== '' && String(datasetEnvelope.run_id) !== runId) {
      throw providerError('APIFY_DATASET_INVALID', 'dataset', { runId, reason: 'run_mismatch' });
    }
    for (const key of ['datasetId', 'dataset_id']) {
      const envelopeDatasetId = datasetEnvelope[key];
      if (envelopeDatasetId != null && envelopeDatasetId !== '' && String(envelopeDatasetId) !== datasetId) {
        throw providerError('APIFY_DATASET_INVALID', 'dataset', { runId, reason: 'dataset_mismatch' });
      }
    }
  }
  const items = datasetEnvelope ? datasetEnvelope.items : datasetPayload;
  if (!Array.isArray(items)) throw providerError('APIFY_DATASET_INVALID', 'dataset', { runId, reason: 'shape' });

  // 费用稳定读取：终态 SUCCEEDED 后，费用总额可能仍是初步值。按有界轮询次数读取同一运行；
  // 每次读取都必须同时保持同一运行 ID、同一数据集身份与 status === 'SUCCEEDED' 才允许观测
  // 费用（等待已成功并不意味着后续读取仍保持成功）。两次连续相等才作为最终费用证据；终态
  // 失败（FAILED/ABORTED/TIMED-OUT）失败关闭为 APIFY_RUN_FAILED；状态缺失、过渡态
  // （RUNNING/READY）、未知或矛盾状态同样失败关闭为 APIFY_COST_UNVERIFIABLE；
  // 下降/矛盾或始终不稳定一律失败关闭，不签发证明。
  const costUrl = new globalThis.URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`);
  let previousCost = null;
  let stableCost = null;
  for (let poll = 1; poll <= Math.max(1, costStabilizePolls); poll += 1) {
    if (signal?.aborted) throw providerError('APIFY_TIMEOUT', 'cost', { runId });
    const costResponse = await providerFetch(fetchImpl, costUrl, { headers: { Authorization: `Bearer ${token}` }, signal }, 'cost', { runId });
    const costRun = verifyRunIdentity(await readJson(costResponse, 'APIFY_COST_UNVERIFIABLE', 'cost', { runId }), runId, datasetId, 'cost');
    const runStatus = String(costRun?.status || '');
    if (runStatus === 'SUCCEEDED') {
      const rawUsage = costRun?.usageTotalUsd;
      const usageTotalUsd = typeof rawUsage === 'number' ? rawUsage : Number(rawUsage);
      if (rawUsage == null || rawUsage === '' || !Number.isFinite(usageTotalUsd) || usageTotalUsd < 0) {
        throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'unavailable' });
      }
      if (usageTotalUsd > boundedCharge) throw providerError('APIFY_COST_ABOVE_RESERVATION', 'cost', { runId });
      if (previousCost === null) {
        previousCost = usageTotalUsd;
      } else if (usageTotalUsd === previousCost) {
        stableCost = usageTotalUsd;
        break;
      } else if (usageTotalUsd < previousCost) {
        throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'decreased' });
      } else {
        previousCost = usageTotalUsd; // 仍在结算中，继续有界读取
      }
      if (poll < Math.max(1, costStabilizePolls)) await sleepImpl(costStabilizeIntervalMs);
    } else if (PROVIDER_TERMINAL_FAILURES.has(runStatus)) {
      throw providerError('APIFY_RUN_FAILED', 'cost', { runId, runStatus });
    } else if (!runStatus) {
      throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'status_missing' });
    } else if (runStatus === 'RUNNING' || runStatus === 'READY') {
      throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'status_transitional', runStatus });
    } else {
      throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'status_unknown', runStatus });
    }
  }
  if (stableCost === null) throw providerError('APIFY_COST_UNVERIFIABLE', 'cost', { runId, reason: 'unstable' });

  return { runId, items, usageTotalUsd: stableCost };
}
