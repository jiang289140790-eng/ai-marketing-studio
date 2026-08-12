// P32-B 热门主题搜索、指标排序与批量导入：完整离线测试。
// 全部测试无真实网络/模型/Supabase 调用；mock 响应与精确请求体仍练习生产控制流。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  P22_LIMITS, assertUniqueSearchResults, isUrlLikeKeyword, normalizeCollectedItems,
  normalizeSourceMetadata, parseP22Request, runApifyCollectionSequence, searchBatchId,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';
import {
  P32_SEARCH_COUNT_DEFAULT, P32_SEARCH_COUNT_MAX, computeEngagementMetrics,
  createP22ResearchAssistClient, findConflictingEvidence, importSearchSelection,
  rankSearchResults, recomputeSearchBatchId, validateSearchBatch, validateSearchResultItem,
} from '../src/services/p22-research-assist.js';
import { createProject } from '../src/services/p19-workspace-service.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const now = () => '2026-08-12T12:00:00.000Z';
const FAR_FUTURE_PROOF = `9999999999.${'a'.repeat(64)}`;
const RESERVATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';

// ---- 共享夹具 ----

/** 构造一条带有效来源证明的搜索结果（媒体为空数组）。 */
async function searchItem(index, overrides = {}) {
  const contentText = `P32-B 搜索结果 ${index}：热门主题搜索批量导入测试正文。`;
  const contentSha256 = await hash(contentText);
  return {
    id: `p22-${contentSha256.slice(0, 24)}`,
    source_url: `https://x.com/author${index}/status/190000000000000000${index}`,
    label: `热门帖子 ${index}`,
    platform: 'x',
    content_text: contentText,
    external_id: `190000000000000000${index}`,
    content_sha256: contentSha256,
    source_metadata: {
      author: { name: `作者${index}`, handle: `author${index}`, user_id: `user${index}` },
      published_at: `2026-08-0${index}T08:00:00.000Z`,
      engagement: {
        likes: 100 * index, retweets: 20 * index, replies: 5 * index,
        quotes: 2 * index, views: 1000 * index, bookmarks: 10 * index,
      },
    },
    media_assets: [],
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: 'apify:xquik/x-tweet-scraper',
      run_id: 'apify-run-search-1',
      collected_at: '2026-08-12T00:00:00.000Z',
      usage_total_usd: 0.01,
      budget_reservation_id: RESERVATION_ID,
    },
    collection_proof: FAR_FUTURE_PROOF,
    ...overrides,
  };
}

/** 与测试共享的批次元数据（必须与服务端 searchBatchId 的绑定字段一致）。 */
const BATCH_COLLECTED_AT = '2026-08-12T00:00:00.000Z';

/**
 * 构造一个批次，batch_id 使用真实服务端 searchBatchId 算法签名（绑定关键词/数量/
 * 排序意图/采集运行/采集时间/有序结果身份）。这样导入端的批次身份重算校验
 * 在正常路径上必须通过；任何「重算校验」测试都直接篡改内容而不重新签名。
 */
async function searchBatchFixture(items) {
  const list = Array.isArray(items) ? items : [];
  const runId = list[0]?.provenance?.run_id || '';
  const batchId = await searchBatchId({
    keyword: 'AI 营销', count: list.length, sort: 'latest', runId, collectedAt: BATCH_COLLECTED_AT, items: list,
  }, hash);
  return {
    batch_id: batchId,
    project_id: 'prj-pending', // 调用方覆盖为真实项目 id
    keyword: 'AI 营销',
    count: list.length,
    sort_intent: 'latest',
    collected_at: BATCH_COLLECTED_AT,
    cost: { recorded_cny: 2, actual_cny: 0.08 },
    items: list,
  };
}

/** 项目 ID 由档案内容 + 时间戳确定：要构造真实不同的项目必须传入不同的档案字段。 */
async function emptyProject(overrides = {}) {
  return createProject({
    topic: 'P32-B 测试项目', objective: '验证热门主题搜索批量导入',
    audience: '测试团队', channel: '内部测试', now,
    ...overrides,
  });
}

/** 运行 importSearchSelection 并返回结果；失败时断言项目指纹完全不变。 */
async function importSelection(project, batch, selectedIds, nowMs = Date.parse('2026-08-12T12:00:00.000Z')) {
  const before = project.fingerprint;
  let result;
  try {
    result = await importSearchSelection({ project, batch, selectedIds, nowMs });
  } catch (error) {
    assert.equal(project.fingerprint, before, '导入失败时当前项目必须完全不变');
    throw error;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Edge 搜索合同：关键词/数量边界、URL 误输入、Actor 输入固定
// ---------------------------------------------------------------------------

test('P32-B parseP22Request accepts bounded search and normalizes keyword', () => {
  const parsed = parseP22Request({ action: 'search', keyword: '  AI   营销  出海  ', count: 15 });
  assert.deepEqual(parsed, { action: 'search', keyword: 'AI 营销 出海', count: 15, sort: 'latest' });
  // 缺省数量 = 10、缺省排序意图 = latest
  assert.deepEqual(parseP22Request({ action: 'search', keyword: '广告' }).count, P32_SEARCH_COUNT_DEFAULT);
  assert.equal(parseP22Request({ action: 'search', keyword: '广告' }).sort, 'latest');
  // 未知字段失败关闭
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告', actorInput: { maxItems: 99 } }),
    (error) => error.code === 'UNKNOWN_FIELD');
});

test('P32-B search rejects URL keywords, oversized keywords and out-of-range counts', () => {
  assert.throws(() => parseP22Request({ action: 'search', keyword: 'https://x.com/user/status/123' }),
    (error) => error.code === 'KEYWORD_IS_URL' && error.status === 400);
  assert.throws(() => parseP22Request({ action: 'search', keyword: 'www.x.com/status/1' }),
    (error) => error.code === 'KEYWORD_IS_URL');
  assert.throws(() => parseP22Request({ action: 'search', keyword: 'example.com/path' }),
    (error) => error.code === 'KEYWORD_IS_URL');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '   ' }),
    (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告'.repeat(61) }),
    (error) => error.code === 'INVALID_REQUEST');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告', count: 0 }),
    (error) => error.code === 'COUNT_OUT_OF_RANGE');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告', count: P32_SEARCH_COUNT_MAX + 1 }),
    (error) => error.code === 'COUNT_OUT_OF_RANGE');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告', count: 2.5 }),
    (error) => error.code === 'COUNT_OUT_OF_RANGE');
  assert.throws(() => parseP22Request({ action: 'search', keyword: '广告', sort: 'top' }),
    (error) => error.code === 'SORT_INTENT_UNSUPPORTED');
});

test('P32-B isUrlLikeKeyword covers protocol, social hosts and domain/path shapes', () => {
  for (const value of [
    'https://x.com/status/1', 'http://t.co/abc', 'ftp://example.com/',
    'www.twitter.com/user/status/1', 'x.com/status/1',
    'instagram.com/p/abc', 'youtu.be/abc',
    'example.com/path', 'a.b.io/x',
  ]) {
    assert.equal(isUrlLikeKeyword(value), true, `${value} 应识别为链接形态`);
  }
  for (const value of ['AI 营销', 'AI', '2026 出海趋势', 'x 平台 2026', '搜索 主题 词', 'a.b']) {
    assert.equal(isUrlLikeKeyword(value), false, `${value} 不应识别为链接形态`);
  }
});

test('P32-B search keeps keyword length bounded after normalization', () => {
  const keyword = '广告'.repeat(60); // 120 字符恰好 = 上限
  assert.equal(parseP22Request({ action: 'search', keyword }).keyword, keyword);
});

test('P32-B search Actor input is server-constructed: exact keyword, platform, count and latest intent only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, method: init?.method || 'GET', body: init?.body || null });
    if (text.includes('/acts/')) {
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-s1', defaultDatasetId: 'ds-s1' } }) };
    }
    if (text.includes('/dataset/items')) {
      return { ok: true, status: 200, json: async () => [
        { id: '111', url: 'https://x.com/a/status/111', text: '第一条搜索内容' },
        { id: '222', url: 'https://x.com/b/status/222', text: '第二条搜索内容' },
      ] };
    }
    if (text.includes('/actor-runs/')) {
      return { ok: true, status: 200, json: async () => ({ data: { id: 'run-s1', defaultDatasetId: 'ds-s1', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    }
    throw new Error(`unexpected URL: ${text}`);
  };
  const result = await runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 'AI 营销',
    count: 20, maxItems: P22_LIMITS.search_max, hardMax: P22_LIMITS.search_max,
    maxTotalChargeUsd: P22_LIMITS.apify_reservation_cny / 7.5,
    fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  assert.equal(result.items.length, 2);
  const start = calls.find((call) => call.method === 'POST');
  assert.deepEqual(JSON.parse(start.body), { maxItems: 20, sort: 'Latest', searchTerms: ['AI 营销'] });
  assert.equal(Object.hasOwn(JSON.parse(start.body), 'input'), false, '请求体必须是 Actor 顶层输入，不得包裹 input');
  const datasetCall = calls.find((call) => call.url.includes('/dataset/items'));
  assert.match(datasetCall.url, /limit=20&clean=true/);
  assert.equal(calls.some((call) => call.body && call.body.includes('actorInput')), false, '客户端任意 Actor 输入绝不进入请求');
});

test('P32-B oversized search counts stay bounded by hardMax 20', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const text = String(url);
    calls.push({ url: text, body: init?.body || null });
    if (text.includes('/acts/')) return { ok: true, status: 200, json: async () => ({ data: { id: 'run-s2', defaultDatasetId: 'ds-s2' } }) };
    if (text.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [] };
    if (text.includes('/actor-runs/')) return { ok: true, status: 200, json: async () => ({ data: { id: 'run-s2', defaultDatasetId: 'ds-s2', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
    throw new Error(`unexpected URL: ${text}`);
  };
  await runApifyCollectionSequence({
    token: 'apify-test-token', actorId: 'xquik/x-tweet-scraper', topic: 't', count: 9999,
    maxItems: 9999, hardMax: P22_LIMITS.search_max, maxTotalChargeUsd: 0.1,
    fetchImpl, sleepImpl: async () => {}, nowImpl: () => 0,
  });
  const start = calls.find((call) => call.body);
  assert.equal(JSON.parse(start.body).maxItems, P22_LIMITS.search_max);
  const dataset = calls.find((call) => call.url.includes('/dataset/items'));
  assert.match(dataset.url, /limit=20&clean=true/);
});

test('P32-B normalizeCollectedItems keeps up to 20 rows for search and defaults to 5 for collect', async () => {
  const rawRows = Array.from({ length: 25 }, (_, i) => ({
    id: String(1900000000000000000 + i), url: `https://x.com/u/status/${1900000000000000000 + i}`,
    text: `搜索正文 ${i}`,
  }));
  const context = {
    provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-s3', collected_at: '2026-08-12T00:00:00.000Z',
    usage_total_usd: 0.01, budget_reservation_id: RESERVATION_ID,
  };
  const searchRows = await normalizeCollectedItems(rawRows, context, hash, { maxItems: P22_LIMITS.search_max });
  assert.equal(searchRows.length, 20, '搜索最多保留 20 条');
  const collectRows = await normalizeCollectedItems(rawRows, context, hash);
  assert.equal(collectRows.length, P22_LIMITS.collect, '普通采集仍为 5 条');
});

test('P32-B search results must be unique: duplicate URL/ID/hash fail closed', async () => {
  const a = await searchItem(1);
  const b = await searchItem(2);
  assert.equal(assertUniqueSearchResults([a, b]), true);
  // 重复 source URL
  assert.throws(() => assertUniqueSearchResults([a, { ...b, source_url: a.source_url }]),
    (error) => error.code === 'SEARCH_RESULT_DUPLICATE' && error.status === 422);
  // 重复 external ID
  assert.throws(() => assertUniqueSearchResults([a, { ...b, external_id: a.external_id }]),
    (error) => error.code === 'SEARCH_RESULT_DUPLICATE');
  // 重复正文哈希
  assert.throws(() => assertUniqueSearchResults([a, { ...b, content_sha256: a.content_sha256 }]),
    (error) => error.code === 'SEARCH_RESULT_DUPLICATE');
  assert.throws(() => assertUniqueSearchResults({ items: [] }),
    (error) => error.code === 'PROVIDER_RESPONSE_INVALID');
});

test('P32-B search batch id is deterministic and binds keyword, count, intent, run, time and ordered identities', async () => {
  const items = [await searchItem(1), await searchItem(2)];
  const base = { keyword: 'AI 营销', count: 2, sort: 'latest', runId: 'run-s4', collectedAt: '2026-08-12T00:00:00.000Z', items };
  const id1 = await searchBatchId(base, hash);
  const id2 = await searchBatchId(base, hash);
  assert.equal(id1, id2, '相同输入必须产生相同批次身份');
  assert.match(id1, /^p32-search-[0-9a-f]{24}$/);
  // 任一字段变化 → 不同批次身份（关键词 / 数量 / 排序意图 / 运行 / 时间 / 结果身份）
  assert.notEqual(await searchBatchId({ ...base, keyword: '广告' }, hash), id1);
  assert.notEqual(await searchBatchId({ ...base, count: 3 }, hash), id1);
  assert.notEqual(await searchBatchId({ ...base, sort: 'top' }, hash), id1);
  assert.notEqual(await searchBatchId({ ...base, runId: 'run-other' }, hash), id1);
  assert.notEqual(await searchBatchId({ ...base, collectedAt: '2026-08-13T00:00:00.000Z' }, hash), id1);
  assert.notEqual(await searchBatchId({ ...base, items: [items[1], items[0]] }, hash), id1, '结果乱序必须改变批次身份');
  const tampered = await searchItem(1);
  tampered.content_sha256 = 'b'.repeat(64);
  assert.notEqual(await searchBatchId({ ...base, items: [tampered, items[1]] }, hash), id1, '结果身份篡改必须改变批次身份');
});

test('P32-B malformed engagement metrics fail closed and never enter search results', () => {
  // 负数 / 非整数 / 超上界 / 非数字类型 → SOURCE_METADATA_INVALID
  for (const likes of [-1, 1.5, '100', 1e12 + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeSourceMetadata({ likeCount: likes, viewCount: 10 }),
      (error) => error.code === 'SOURCE_METADATA_INVALID');
  }
  // 缺失字段 → null（绝不伪造为 0）
  const snapshot = normalizeSourceMetadata({ likeCount: 5 });
  assert.equal(snapshot.engagement.likes, 5);
  assert.equal(snapshot.engagement.views, null);
  assert.equal(snapshot.engagement.retweets, null);
});

// ---------------------------------------------------------------------------
// 2. 五种确定性排序
// ---------------------------------------------------------------------------

test('P32-B computeEngagementMetrics sums only provided non-negative integers and never fabricates zero', async () => {
  const full = await searchItem(1);
  const metrics = computeEngagementMetrics(full);
  assert.equal(metrics.views, 1000);
  assert.equal(metrics.likes, 100);
  assert.equal(metrics.retweets, 20);
  // total = likes+retweets+replies+quotes+bookmarks = 100+20+5+2+10
  assert.equal(metrics.total_engagement, 137);
  assert.equal(metrics.engagement_rate, 137 / 1000);

  // 全部缺失 → total 与 rate 为 null
  const none = { ...full, source_metadata: { author: null, published_at: null, engagement: null } };
  const noneMetrics = computeEngagementMetrics(none);
  assert.equal(noneMetrics.views, null);
  assert.equal(noneMetrics.total_engagement, null);
  assert.equal(noneMetrics.engagement_rate, null);

  // views=0 或缺失 → rate 不可用（即使总互动存在）
  const zeroViews = { ...full, source_metadata: { ...full.source_metadata, engagement: { ...full.source_metadata.engagement, views: 0 } } };
  assert.equal(computeEngagementMetrics(zeroViews).engagement_rate, null);
  const noViews = { ...full, source_metadata: { ...full.source_metadata, engagement: { likes: 10 } } };
  assert.equal(computeEngagementMetrics(noViews).engagement_rate, null);
});

test('P32-B engagement arithmetic handles extreme bounded integers', () => {
  const extreme = {
    source_metadata: {
      engagement: { likes: 1e12, retweets: 1e12, replies: 1e12, quotes: 1e12, bookmarks: 1e12, views: 1e12 },
    },
  };
  const metrics = computeEngagementMetrics(extreme);
  assert.equal(metrics.total_engagement, 5e12);
  assert.equal(metrics.engagement_rate, 5);
  // 部分缺失不参与累加
  const partial = { source_metadata: { engagement: { likes: 10, retweets: null, replies: undefined } } };
  assert.equal(computeEngagementMetrics(partial).total_engagement, 10);
});

test('P32-B five sorts are deterministic, descending, missing-last with stable tie-break', async () => {
  const a = await searchItem(1); // views 1000, likes 100, retweets 20, total 137
  const b = await searchItem(2); // views 2000, likes 200, retweets 40, total 274
  const c = await searchItem(3); // views 3000, likes 300, retweets 60, total 411
  const missing = { ...a, id: 'p22-missing', source_url: 'https://x.com/m/status/9', external_id: '9',
    source_metadata: { author: null, published_at: null, engagement: null } };
  const shuffled = [c, missing, a, b];
  // 严格断言完整原始 external_id（绝不缩短、substring 或代理断言）。
  const FULL_ID = { 1: '1900000000000000001', 2: '1900000000000000002', 3: '1900000000000000003', 9: '9' };

  assert.deepEqual(rankSearchResults(shuffled, 'views').map((item) => item.external_id), [FULL_ID[3], FULL_ID[2], FULL_ID[1], FULL_ID[9]]);
  assert.deepEqual(rankSearchResults(shuffled, 'likes').map((item) => item.external_id), [FULL_ID[3], FULL_ID[2], FULL_ID[1], FULL_ID[9]]);
  assert.deepEqual(rankSearchResults(shuffled, 'retweets').map((item) => item.external_id), [FULL_ID[3], FULL_ID[2], FULL_ID[1], FULL_ID[9]]);
  assert.deepEqual(rankSearchResults(shuffled, 'total_engagement').map((item) => item.external_id), [FULL_ID[3], FULL_ID[2], FULL_ID[1], FULL_ID[9]]);

  // engagement_rate：b 与 c 都是 0.137；按发布时间较新在前（published_at 由 index 生成，越新 index 越大越晚）
  // published_at: a=08-01, b=08-02, c=08-03 → 较新在前 → c 在 b 前；缺失的 last。
  const rateOrder = rankSearchResults(shuffled, 'engagement_rate').map((item) => item.external_id);
  assert.equal(rateOrder[0], FULL_ID[3]);
  assert.equal(rateOrder[1], FULL_ID[2]);
  assert.equal(rateOrder[rateOrder.length - 1], FULL_ID[9]);
  assert.deepEqual(rateOrder, [FULL_ID[3], FULL_ID[2], FULL_ID[1], FULL_ID[9]]);

  // 确定性：相同输入两次排序结果完全一致，且不修改输入数组
  const snapshot = JSON.stringify(shuffled);
  const first = rankSearchResults(shuffled, 'views');
  const second = rankSearchResults(shuffled, 'views');
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(JSON.stringify(shuffled), snapshot, '排序不得修改输入数组');
});

test('P32-B tie-break falls back to published_at then full source identity', async () => {
  const a = await searchItem(1);
  const b = await searchItem(2);
  // 相同 views、相同 published_at → 完整来源身份字典序
  const sameViewsA = { ...a, id: 'p22-tie-a', source_url: 'https://x.com/zzz/status/1', source_metadata: { ...a.source_metadata, published_at: '2026-08-01T00:00:00.000Z', engagement: { views: 500, likes: 1 } } };
  const sameViewsB = { ...b, id: 'p22-tie-b', source_url: 'https://x.com/aaa/status/2', source_metadata: { ...b.source_metadata, published_at: '2026-08-01T00:00:00.000Z', engagement: { views: 500, likes: 1 } } };
  const order = rankSearchResults([sameViewsA, sameViewsB], 'views').map((item) => item.id);
  assert.deepEqual(order, ['p22-tie-b', 'p22-tie-a'], '同指标同时间按完整来源身份稳定排序');

  // 相同 views、不同 published_at → 较新在前
  const older = { ...a, id: 'p22-tie-older', source_url: 'https://x.com/old/status/1', source_metadata: { ...a.source_metadata, published_at: '2026-08-01T00:00:00.000Z', engagement: { views: 500 } } };
  const newer = { ...b, id: 'p22-tie-newer', source_url: 'https://x.com/new/status/2', source_metadata: { ...b.source_metadata, published_at: '2026-08-05T00:00:00.000Z', engagement: { views: 500 } } };
  assert.deepEqual(rankSearchResults([older, newer], 'views').map((item) => item.id), ['p22-tie-newer', 'p22-tie-older']);

  // 未知排序键失败关闭
  assert.throws(() => rankSearchResults([a, b], 'favorites'), (error) => error.code === 'P32_SORT_UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// 3. 批量导入：选择边界、重复、已导入、原子性、项目切换、篡改/过期
// ---------------------------------------------------------------------------

test('P32-B batch import saves 1–5 selected results into the current project', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2), await searchItem(3)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;

  const before = project.fingerprint;
  const result = await importSelection(project, batch, [items[0].id, items[2].id]);
  assert.equal(result.imported, 2);
  assert.equal(result.project.evidence.length, 2);
  assert.notEqual(result.project.fingerprint, before);
  assert.equal(result.project.version, project.version + 1, '批量导入只递增一次版本');
  for (const record of result.project.evidence) {
    assert.equal(record.provenance?.manual, false);
    assert.equal(record.platform, 'X · Apify');
  }
  // 已导入来源现在被识别为冲突
  const conflicting = findConflictingEvidence(result.project, items[0]);
  assert.ok(conflicting, '导入后同一来源应被识别为已存在');
  assert.equal(conflicting.id, result.project.evidence[0].id);
});

test('P32-B batch import rejects out-of-range selection and duplicate ids without touching the project', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2), await searchItem(3), await searchItem(4), await searchItem(5), await searchItem(6)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;
  const before = project.fingerprint;

  await assert.rejects(() => importSelection(project, batch, []), (error) => error.code === 'P32_SELECTION_OUT_OF_RANGE');
  await assert.rejects(() => importSelection(project, batch, items.map((item) => item.id)), (error) => error.code === 'P32_SELECTION_OUT_OF_RANGE');
  await assert.rejects(() => importSelection(project, batch, [items[0].id, items[0].id]), (error) => error.code === 'P32_SELECTION_DUPLICATE');
  assert.equal(project.fingerprint, before, '全部拒绝路径都必须保持项目完全不变');
});

test('P32-B batch import is atomic: any invalid item leaves the project completely unchanged', async () => {
  const project = await emptyProject();
  const good1 = await searchItem(1);
  const good2 = await searchItem(2);
  const bad = await searchItem(3);
  bad.content_text = '正文被篡改，哈希不再匹配';
  const batch = await searchBatchFixture([good1, good2, bad]);
  batch.project_id = project.id;

  await assert.rejects(
    () => importSelection(project, batch, [good1.id, bad.id]),
    (error) => error.code === 'P32_HASH_MISMATCH',
  );
  assert.equal(project.evidence.length, 0, '任一条无效时整批失败，任何证据都不写入');

  // 批次内重复来源（同一 URL/外部 ID/正文哈希）
  const dup = await searchItem(4);
  const dupClone = { ...dup, id: 'p22-dupe-clone', label: '克隆结果' };
  const dupBatch = await searchBatchFixture([dup, dupClone]);
  dupBatch.project_id = project.id;
  await assert.rejects(
    () => importSelection(project, dupBatch, [dup.id, dupClone.id]),
    (error) => error.code === 'P32_DUPLICATE_SOURCE',
  );
  assert.equal(project.evidence.length, 0);
});

test('P32-B batch import rejects already-imported sources and expired/invalid proofs', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;

  const first = await importSelection(project, batch, [items[0].id]);
  assert.equal(first.imported, 1);

  // 已导入 → 禁止重复导入
  await assert.rejects(
    () => importSelection(first.project, batch, [items[0].id]),
    (error) => error.code === 'P32_ALREADY_IMPORTED',
  );

  // 过期证明 → 整批拒绝
  const expired = await searchItem(3);
  expired.collection_proof = `1000000000.${'b'.repeat(64)}`;
  const expiredBatch = await searchBatchFixture([expired]);
  expiredBatch.project_id = project.id;
  await assert.rejects(
    () => importSelection(first.project, expiredBatch, [expired.id]),
    (error) => error.code === 'P32_PROOF_EXPIRED',
  );

  // 证明格式无效 → 整批拒绝
  const malformed = await searchItem(4);
  malformed.collection_proof = 'not-a-proof';
  const malformedBatch = await searchBatchFixture([malformed]);
  malformedBatch.project_id = project.id;
  await assert.rejects(
    () => importSelection(first.project, malformedBatch, [malformed.id]),
    (error) => error.code === 'P32_PROOF_INVALID',
  );
});

test('P32-B batch import fails closed on project switch, stale batch and out-of-order results', async () => {
  const projectA = await emptyProject();
  // 真实不同的项目身份：相同输入 + 固定 now 会生成相同 ID（切换从未发生）。
  // 必须使用不同档案字段产生不同 ID，并严格证明旧批次对新项目失败关闭。
  const projectB = await emptyProject({ topic: 'P32-B 测试项目 B', objective: '验证切换后旧批次被拒绝' });
  assert.notEqual(projectA.id, projectB.id, '两个项目必须是真实不同身份，切换才真实发生');
  const items = [await searchItem(1), await searchItem(2)];
  const batch = await searchBatchFixture(items);
  batch.project_id = projectA.id;

  // 项目切换后：批次属于 A，但当前项目是 B
  await assert.rejects(
    () => importSelection(projectB, batch, [items[0].id]),
    (error) => error.code === 'P32_BATCH_PROJECT_MISMATCH',
  );
  // 错绑方向同样失败关闭（批次声称属于 B，当前项目是 A），项目指纹不变
  batch.project_id = projectB.id;
  await assert.rejects(
    () => importSelection(projectA, batch, [items[0].id]),
    (error) => error.code === 'P32_BATCH_PROJECT_MISMATCH',
  );
  batch.project_id = projectA.id;

  // 批次身份被替换/损坏（非 p32-search-<24hex> 形态）
  const staleBatch = await searchBatchFixture(items);
  staleBatch.project_id = projectA.id;
  staleBatch.batch_id = 'stale-batch-identity';
  await assert.rejects(
    () => importSelection(projectA, staleBatch, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
  );

  // ---- 批次身份与内容绑定（重算校验，绝不只验证正则形状）----
  // 结果乱序但 batch_id 未重新签名 → 重算身份不同 → 整批失败关闭
  const reordered = await searchBatchFixture(items);
  reordered.project_id = projectA.id;
  reordered.items = [items[1], items[0]]; // 顺序被篡改，batch_id 仍绑定原顺序
  await assert.rejects(
    () => importSelection(projectA, reordered, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
    '结果乱序而批次身份未重新签名必须失败关闭',
  );

  // 正文哈希被篡改但 batch_id 未重新签名 → 重算身份不同 → 整批失败关闭
  const tamperedHash = await searchBatchFixture(items);
  tamperedHash.project_id = projectA.id;
  tamperedHash.items = [await searchItem(1, { content_sha256: 'd'.repeat(64) }), items[1]];
  await assert.rejects(
    () => importSelection(projectA, tamperedHash, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
    '正文哈希被篡改而批次身份未重新签名必须失败关闭',
  );

  // 批次元数据（关键词）被错改但 batch_id 未重新签名 → 整批失败关闭
  const tamperedMeta = await searchBatchFixture(items);
  tamperedMeta.project_id = projectA.id;
  tamperedMeta.keyword = '被篡改的关键词';
  await assert.rejects(
    () => importSelection(projectA, tamperedMeta, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
    '批次元数据被错改而批次身份未重新签名必须失败关闭',
  );

  // 批次内采集运行不一致 → 身份无法确定 → 整批失败关闭
  const mixedRun = await searchBatchFixture(items);
  mixedRun.project_id = projectA.id;
  mixedRun.items = [items[0], { ...items[1], provenance: { ...items[1].provenance, run_id: 'apify-run-foreign' } }];
  await assert.rejects(
    () => importSelection(projectA, mixedRun, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
    '批次内采集运行不一致必须失败关闭',
  );

  // 选择不在当前批次中（乱序/过期响应）
  const outsider = await searchItem(3);
  await assert.rejects(
    () => importSelection(projectA, batch, [outsider.id]),
    (error) => error.code === 'P32_ITEM_NOT_IN_BATCH',
  );

  // 缺少批次对象
  await assert.rejects(
    () => importSelection(projectA, null, [items[0].id]),
    (error) => error.code === 'P32_BATCH_INVALID',
  );
});

test('P32-B client batch id recomputation mirrors the server searchBatchId canonical form', async () => {
  const items = [await searchItem(1), await searchItem(2), await searchItem(3)];
  const batch = await searchBatchFixture(items);
  // 服务端签名（真实算法）与客户端重算必须完全一致；与批次携带的身份也一致
  const server = await searchBatchId({
    keyword: batch.keyword, count: batch.count, sort: batch.sort_intent,
    runId: items[0].provenance.run_id, collectedAt: batch.collected_at, items,
  }, hash);
  const client = await recomputeSearchBatchId(batch);
  assert.equal(client, server, '客户端重算必须与服务端 searchBatchId 完全一致');
  assert.equal(client, batch.batch_id, '批次携带的身份必须与重算一致');

  // 任一绑定字段变化 → 重算身份不同（对应导入端 P32_BATCH_INVALID）
  assert.notEqual(await recomputeSearchBatchId({ ...batch, keyword: '广告' }), batch.batch_id);
  assert.notEqual(await recomputeSearchBatchId({ ...batch, count: 99 }), batch.batch_id);
  assert.notEqual(await recomputeSearchBatchId({ ...batch, sort_intent: 'top' }), batch.batch_id);
  assert.notEqual(await recomputeSearchBatchId({ ...batch, collected_at: '2026-08-13T00:00:00.000Z' }), batch.batch_id);
  assert.notEqual(await recomputeSearchBatchId({ ...batch, items: [items[2], items[1], items[0]] }), batch.batch_id, '结果乱序必须改变重算身份');
  // 无法确定唯一运行 → null（失败关闭）
  assert.equal(await recomputeSearchBatchId({ ...batch, items: [] }), null, '空批次身份无法确定必须返回 null');
  assert.equal(await recomputeSearchBatchId({ ...batch, items: [items[0], { ...items[1], provenance: { ...items[1].provenance, run_id: 'other-run' } }] }), null, '运行不一致必须返回 null');
  assert.equal(await recomputeSearchBatchId(null), null);
});

test('P32-B online retry is idempotent: same selection re-imports only missing identities', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2), await searchItem(3)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;
  const nowMs = Date.parse('2026-08-12T12:00:00.000Z');

  // 第一次部分成功（模拟在线逐条写入到第 2 条后失败，权威项目只含前 2 条）
  const partial = await importSelection(project, batch, [items[0].id, items[1].id]);
  assert.equal(partial.imported, 2);

  // 严格模式：同一选择重试（含已导入身份）→ 整批失败关闭
  await assert.rejects(
    () => importSelection(partial.project, batch, [items[0].id, items[1].id, items[2].id]),
    (error) => error.code === 'P32_ALREADY_IMPORTED',
  );

  // 幂等重试模式：同一选择只写入缺失身份，已导入身份跳过，不产生重复 Evidence
  const retried = await importSearchSelection({
    project: partial.project, batch, selectedIds: [items[0].id, items[1].id, items[2].id], nowMs, skipAlreadyImported: true,
  });
  assert.equal(retried.imported, 1, '只写入尚未导入的身份');
  assert.equal(retried.alreadyImported, 2, '已导入身份被跳过并计数');
  assert.equal(retried.project.evidence.length, 3, '最终完整导入且无重复');
  assert.equal(retried.project.version, partial.project.version + 1, '重试只递增一次版本');
  const ids = new Set(retried.project.evidence.map((record) => record.id));
  assert.equal(ids.size, 3, '证据身份绝不重复');

  // 全部已导入时再次重试 → imported=0，不写任何记录，版本不变
  const done = await importSearchSelection({
    project: retried.project, batch, selectedIds: [items[0].id, items[1].id, items[2].id], nowMs, skipAlreadyImported: true,
  });
  assert.equal(done.imported, 0);
  assert.equal(done.alreadyImported, 3);
  assert.equal(done.project, retried.project, '无新写入时返回同一项目快照（版本不变）');
  assert.equal(done.project.evidence.length, 3);
});

test('P32-B validateSearchResultItem rejects tampered hash, invalid URL and malformed shapes', async () => {
  const item = await searchItem(1);
  await validateSearchResultItem(item, { nowMs: Date.parse('2026-08-12T00:00:00.000Z') });

  const tampered = { ...item, content_text: '被篡改的正文' };
  await assert.rejects(() => validateSearchResultItem(tampered), (error) => error.code === 'P32_HASH_MISMATCH');

  const badUrl = { ...item, source_url: 'https://not-x.com/status/1' };
  await assert.rejects(() => validateSearchResultItem(badUrl), (error) => error.code === 'P32_ITEM_INVALID');

  const badSnapshot = { ...item, source_metadata: { author: { name: 'x'.repeat(200) }, published_at: null, engagement: null } };
  await assert.rejects(() => validateSearchResultItem(badSnapshot), (error) => error.code === 'P32_ITEM_INVALID');

  const badMedia = { ...item, media_assets: [{ id: 'not-an-id', media_url: 'ftp://x', order: 9, kind: 'bad' }] };
  await assert.rejects(() => validateSearchResultItem(badMedia), (error) => error.code === 'P32_ITEM_INVALID');
});

test('P32-B search, rank and selection operations never modify project state or evidence fingerprints', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2), await searchItem(3)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;
  const before = JSON.stringify({ fingerprint: project.fingerprint, evidence: project.evidence, version: project.version });

  rankSearchResults(items, 'views');
  rankSearchResults(items, 'engagement_rate');
  computeEngagementMetrics(items[0]);
  await validateSearchBatch({ project, batch, selectedIds: [items[0].id], nowMs: Date.parse('2026-08-12T00:00:00.000Z') });
  findConflictingEvidence(project, items[0]);

  assert.equal(JSON.stringify({ fingerprint: project.fingerprint, evidence: project.evidence, version: project.version }), before,
    '搜索/排序/选择/验证不得修改项目或证据');
});

// ---------------------------------------------------------------------------
// 4. addEvidenceBatch 工作区原子层
// ---------------------------------------------------------------------------

test('P32-B addEvidenceBatch applies all-or-nothing with a single version bump', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;
  const selection = await importSearchSelection({ project, batch, selectedIds: [items[0].id, items[1].id], nowMs: Date.parse('2026-08-12T00:00:00.000Z') });
  assert.equal(selection.imported, 2);
  assert.equal(selection.project.version, 2, '两批各一次版本递增（1 → 2）');
  assert.equal(selection.project.evidence.length, 2);
});

test('P32-B addEvidenceBatch fails closed on size, duplicate identity and existing conflict', async () => {
  const project = await emptyProject();
  const items = [await searchItem(1), await searchItem(2), await searchItem(3), await searchItem(4), await searchItem(5), await searchItem(6)];
  const batch = await searchBatchFixture(items);
  batch.project_id = project.id;

  await assert.rejects(() => importSelection(project, batch, items.map((item) => item.id)),
    (error) => error.code === 'P32_SELECTION_OUT_OF_RANGE');

  // 同一证据身份（同正文同来源）出现两次 → 工作区层整批失败
  const dupA = await searchItem(7);
  const dupB = { ...dupA, id: 'p22-same-content-alias' };
  const dupBatch = await searchBatchFixture([dupA, dupB]);
  dupBatch.project_id = project.id;
  await assert.rejects(
    () => importSelection(project, dupBatch, [dupA.id, dupB.id]),
    (error) => error.code === 'P32_DUPLICATE_SOURCE',
  );
  assert.equal(project.evidence.length, 0);
});

test('P32-B createP22ResearchAssistClient exposes the versioned search action', () => {
  let captured = null;
  const fakeClient = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }) },
    functions: {
      invoke: async (name, { body }) => {
        captured = body;
        return { data: { ok: true, schema_version: 'p22_research_assist_v1', action: 'search', items: [] }, error: null };
      },
    },
  };
  const client = createP22ResearchAssistClient({ client: fakeClient });
  return client.search('AI 营销', 15).then((response) => {
    assert.deepEqual(captured, { action: 'search', keyword: 'AI 营销', count: 15, sort: 'latest' });
    assert.equal(response.ok, true);
  });
});
