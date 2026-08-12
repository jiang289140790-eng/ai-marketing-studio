import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  normalizeRedditSearchItems,
  parseP22Request,
  redditSearchBatchId,
  runApifyCollectionSequence,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';
import {
  createP22ResearchAssistClient,
  importSearchSelection,
  rankRedditSearchResults,
  recomputeSearchBatchId,
} from '../src/services/p22-research-assist.js';
import { createProject, recordVersionedTextReanalysis } from '../src/services/p19-workspace-service.js';

const digest = async (value) => createHash('sha256').update(String(value)).digest('hex');
const query = Object.freeze({ search: 'AI marketing', subreddit: 'marketing', sortType: 'top', timeFilter: 'month', limit: 2 });
const context = Object.freeze({
  provider: 'apify:endspec/reddit-instant-search-scraper',
  run_id: 'reddit-run-1',
  collected_at: '2026-08-13T02:00:00.000Z',
  usage_total_usd: 0.01,
  budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
});
const proof = `9999999999.${'a'.repeat(64)}`;

function raw(index, overrides = {}) {
  return {
    id: `reddit-${index}`,
    title: `Reddit 标题 ${index}`,
    text: `正文 ${index}`,
    author: `author_${index}`,
    subreddit: 'marketing',
    score: 100 * index,
    num_comments: 10 * index,
    created_utc: 1786500000 + index,
    url: `https://example.com/outbound-${index}`,
    permalink: `/r/marketing/comments/reddit${index}/topic_${index}/`,
    _query: query,
    ...overrides,
  };
}

test('P32-D request parser constructs a bounded Reddit search contract', () => {
  assert.deepEqual(parseP22Request({
    action: 'search_reddit', keyword: '  AI   marketing ', count: 2, sort: 'top', subreddit: 'r/marketing', time_filter: 'month',
  }), { action: 'search_reddit', keyword: 'AI marketing', count: 2, sort: 'top', subreddit: 'marketing', time_filter: 'month' });
  assert.throws(() => parseP22Request({ action: 'search_reddit', keyword: 'https://reddit.com/r/x', count: 2 }), (error) => error.code === 'KEYWORD_IS_URL');
  assert.throws(() => parseP22Request({ action: 'search_reddit', keyword: 'AI', sort: 'viral' }), (error) => error.code === 'SORT_INTENT_UNSUPPORTED');
  assert.throws(() => parseP22Request({ action: 'search_reddit', keyword: 'AI', subreddit: '../admin' }), (error) => error.code === 'SUBREDDIT_INVALID');
});

test('P32-D normalization binds permalink, exact query and real Reddit metrics', async () => {
  const rows = await normalizeRedditSearchItems([raw(1), raw(2)], context, digest, query);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source_url, 'https://www.reddit.com/r/marketing/comments/reddit1/topic_1');
  assert.notEqual(rows[0].source_url, raw(1).url, 'outbound link must never replace canonical Reddit thread permalink');
  assert.equal(rows[0].source_metadata.community, 'marketing');
  assert.deepEqual(rows[0].source_metadata.engagement, { reddit_score: 100, reddit_comments: 10, reddit_upvote_ratio: null });
  assert.equal(rows[0].platform, 'reddit');
  assert.equal(rows[0].media_assets.length, 0);
  const downvoted = await normalizeRedditSearchItems([raw(3, { score: -7, num_comments: 2, _query: { ...query, limit: 1 } })], context, digest, { ...query, limit: 1 });
  assert.equal(downvoted[0].source_metadata.engagement.reddit_score, -7, 'Reddit net score may be negative and must not be rewritten to zero');
  const ratio = await normalizeRedditSearchItems([raw(4, { upvote_ratio: 0.75, _query: { ...query, limit: 1 } })], context, digest, { ...query, limit: 1 });
  assert.equal(ratio[0].source_metadata.engagement.reddit_upvote_ratio, 0.75, 'an explicitly returned ratio must remain available');
  await assert.rejects(() => normalizeRedditSearchItems([raw(5, { upvote_ratio: 1.5, _query: { ...query, limit: 1 } })], context, digest, { ...query, limit: 1 }), (error) => error.code === 'SOURCE_METADATA_INVALID');
});

test('P32-D provider diagnostics and query mismatch fail closed', async () => {
  await assert.rejects(() => normalizeRedditSearchItems([{ status: 'error', message: 'none' }], context, digest, query), (error) => error.code === 'REDDIT_NO_RESULTS');
  await assert.rejects(() => normalizeRedditSearchItems([raw(1, { _query: { ...query, search: 'foreign' } })], context, digest, query), (error) => error.code === 'REDDIT_QUERY_MISMATCH');
  await assert.rejects(() => normalizeRedditSearchItems([raw(1, { permalink: 'https://evil.example/post' })], context, digest, query), (error) => error.code === 'UNSUPPORTED_SOURCE');
});

test('P32-D fixed Actor input is sent exactly and arbitrary fields are rejected', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    calls.push({ value, body: init.body });
    if (value.includes('/acts/')) return { ok: true, status: 200, json: async () => ({ data: { id: 'rr1', defaultDatasetId: 'rds1' } }) };
    if (value.includes('/dataset/items')) return { ok: true, status: 200, json: async () => [raw(1), raw(2)] };
    return { ok: true, status: 200, json: async () => ({ data: { id: 'rr1', defaultDatasetId: 'rds1', status: 'SUCCEEDED', usageTotalUsd: 0.01 } }) };
  };
  await runApifyCollectionSequence({ token: 'test-token', actorId: 'endspec/reddit-instant-search-scraper', actorInput: query, count: 2, maxItems: 20, hardMax: 20, maxTotalChargeUsd: 0.2, fetchImpl, sleepImpl: async () => {}, costStabilizeIntervalMs: 0 });
  assert.deepEqual(JSON.parse(calls.find((call) => call.value.includes('/acts/')).body), query);
  await assert.rejects(() => runApifyCollectionSequence({ token: 'test-token', actorId: 'endspec/reddit-instant-search-scraper', actorInput: { ...query, startUrls: ['https://evil.example'] }, count: 2, maxItems: 20, hardMax: 20, maxTotalChargeUsd: 0.2, fetchImpl }), (error) => error.code === 'APIFY_RUN_ID_INVALID');
});

test('P32-D client exposes Reddit search and preserves exact request fields', async () => {
  const bodies = [];
  const client = createP22ResearchAssistClient({ client: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }) },
    functions: { invoke: async (_name, request) => { bodies.push(request.body); return { data: { ok: true, schema_version: 'p22_research_assist_v1', items: [] }, error: null }; } },
  } });
  await client.searchReddit('AI marketing', { count: 5, sort: 'comments', subreddit: 'marketing', timeFilter: 'week' });
  assert.deepEqual(bodies[0], { action: 'search_reddit', keyword: 'AI marketing', count: 5, sort: 'comments', subreddit: 'marketing', time_filter: 'week' });
});

test('P32-D batch identity, ranking and import remain bound to the current project', async () => {
  const items = (await normalizeRedditSearchItems([raw(1), raw(2)], context, digest, query)).map((item) => ({ ...item, collection_proof: proof }));
  const project = await createProject({ topic: 'Reddit 对比', objective: '比较主题帖子', audience: '营销团队', channel: 'Reddit', now: () => '2026-08-13T03:00:00.000Z' });
  const batchId = await redditSearchBatchId({ keyword: query.search, subreddit: query.subreddit, count: 2, sort: query.sortType, timeFilter: query.timeFilter, runId: context.run_id, collectedAt: context.collected_at, items }, digest);
  const batch = { batch_id: batchId, project_id: project.id, platform: 'reddit', keyword: query.search, subreddit: query.subreddit, count: 2, sort_intent: query.sortType, time_filter: query.timeFilter, collected_at: context.collected_at, items };
  assert.equal(await recomputeSearchBatchId(batch), batchId);
  assert.deepEqual(rankRedditSearchResults(items, 'reddit_comments').map((item) => item.external_id), ['reddit-2', 'reddit-1']);
  assert.deepEqual(rankRedditSearchResults(items, 'reddit_total_engagement').map((item) => item.external_id), ['reddit-2', 'reddit-1']);
  assert.deepEqual(rankRedditSearchResults(items, 'reddit_interaction_rate').map((item) => item.external_id), ['reddit-2', 'reddit-1'], 'missing ratios remain unavailable and use stable newer-first tie-breaks');
  const imported = await importSearchSelection({ project, batch, selectedIds: items.map((item) => item.id), nowMs: Date.parse('2026-08-13T03:00:00.000Z') });
  assert.equal(imported.project.evidence.length, 2);
  assert.equal(imported.project.evidence[0].provenance.source_platform, 'reddit');
  assert.equal(imported.project.evidence[0].source_metadata.community, 'marketing');
});

test('P32-D text-only Reddit evidence supports append-only Qwen versions', async () => {
  const items = (await normalizeRedditSearchItems([raw(1, { _query: { ...query, limit: 1 } })], context, digest, { ...query, limit: 1 })).map((item) => ({ ...item, collection_proof: proof }));
  const project = await createProject({ topic: '文本重分析', objective: '验证 Reddit 文本分析', audience: '团队', channel: 'Reddit', now: () => '2026-08-13T03:00:00.000Z' });
  const batchId = await redditSearchBatchId({ keyword: query.search, subreddit: query.subreddit, count: 1, sort: query.sortType, timeFilter: query.timeFilter, runId: context.run_id, collectedAt: context.collected_at, items }, digest);
  const imported = await importSearchSelection({ project, batch: { batch_id: batchId, project_id: project.id, platform: 'reddit', keyword: query.search, subreddit: query.subreddit, count: 1, sort_intent: query.sortType, time_filter: query.timeFilter, collected_at: context.collected_at, items }, selectedIds: [items[0].id], nowMs: Date.parse('2026-08-13T03:00:00.000Z') });
  const evidence = imported.project.evidence[0];
  const analyzed = await recordVersionedTextReanalysis(imported.project, evidence.id, {
    source_id: evidence.provenance.source_id,
    model: 'qwen-plus',
    result: { text_expression: '表达', hook: '钩子', copy_pattern: '公式', target_audience: '受众', audience_need_emotion: '需求', media_analysis: [], virality_drivers: ['传播'], reusable_methods: ['复用'], rewrite_suggestions: ['改写'], signals: ['信号'], risks: ['风险'] },
    executed_at: '2026-08-13T03:01:00.000Z', usage: { total_tokens: 100 }, _request_identity: 'reddit-text-v1',
  }, { now: () => '2026-08-13T03:01:00.000Z' });
  assert.equal(analyzed.analyses[0].model_analysis.method, 'text_model');
  assert.equal(analyzed.evidence[0].fingerprint, evidence.fingerprint, 'analysis must never overwrite evidence');
});
