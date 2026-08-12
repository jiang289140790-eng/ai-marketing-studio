export const P22_SCHEMA_VERSION = 'p22_research_assist_v1';
export const P22_COLLECTION_PROOF_VERSION = 'p22_collection_proof_v2';
export const P22_LIMITS = Object.freeze({
  collect: 5,
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
});
export const P22_EXECUTION_FLAGS = Object.freeze({ generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false });
/** 人民币兑美元汇率，仅用于把有界的 Apify 预留金额换算成 API 的有界成本上限。 */
export const P22_CNY_PER_USD = 7.5;

const ACTION_FIELDS = Object.freeze({
  status: new Set(['action']),
  collect: new Set(['action', 'topic', 'count']),
  collect_url: new Set(['action', 'url']),
  analyze: new Set(['action', 'items']),
});
const ITEM_FIELDS = new Set(['id', 'source_url', 'label', 'platform', 'content_text', 'external_id', 'content_sha256', 'provenance', 'collection_proof']);
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
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > P22_LIMITS.analyze) {
    throw new P22Error('ITEM_COUNT_OUT_OF_RANGE', '分析项目必须为 1–2 条。', 400, { field: 'items' });
  }
  const ids = new Set();
  const items = input.items.map((rawItem, index) => {
    const item = object(rawItem);
    if (!item) throw new P22Error('INVALID_ITEM', '分析项目必须是对象。', 400, { field: `items[${index}]` });
    exactFields(item, ITEM_FIELDS, `items[${index}]`);
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

function proofPayload(userId, item, expiresAt) {
  // Sign a fixed-position, lossless source identity instead of a JSON object whose
  // display-only fields can be normalized by the P19 boundary. The content body is
  // still bound because verification recomputes content_sha256 before checking HMAC.
  return JSON.stringify([
    P22_COLLECTION_PROOF_VERSION,
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
  ]);
}

async function sha256Hex(value) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new globalThis.TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, payload) {
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
    new globalThis.TextEncoder().encode(`p22-collection-proof-v2\0${payload}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function issueCollectionProof(secret, userId, item, { nowMs = Date.now() } = {}) {
  const expiresAt = Math.floor((nowMs + P22_LIMITS.proof_ttl_ms) / 1000);
  const signature = await hmacHex(secret, proofPayload(userId, item, expiresAt));
  return `${expiresAt}.${signature}`;
}

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
  const expected = await hmacHex(secret, proofPayload(userId, item, expiresAt));
  if (!constantTimeHexEqual(expected, match[2].toLowerCase())) {
    throw new P22Error('SOURCE_PROOF_INVALID', '来源证明与内容不匹配。', 400, { field: 'collection_proof' });
  }
  return true;
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

export async function normalizeCollectedItems(rawItems, context, digest) {
  if (!Array.isArray(rawItems)) throw new P22Error('PROVIDER_RESPONSE_INVALID', '采集响应不是数组。', 502);
  const output = [];
  const seen = new Set();
  for (const raw of rawItems.slice(0, P22_LIMITS.collect)) {
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
    output.push({
      id: `p22-${contentSha256.slice(0, 24)}`,
      source_url: sourceUrl,
      label: String(first(raw.title, contentText.slice(0, 120), 'X 公开内容')).trim().slice(0, 200),
      platform: 'x',
      content_text: contentText,
      external_id: externalId || sourceUrl.match(/\/status\/(\d+)/)?.[1] || null,
      content_sha256: contentSha256,
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
 */
export async function runApifyCollectionSequence({
  token,
  actorId,
  topic,
  sourceUrl,
  count,
  maxItems = P22_LIMITS.collect,
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
  const boundedMaxItems = Math.max(1, Math.min(P22_LIMITS.collect, Number(maxItems) || P22_LIMITS.collect));
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
