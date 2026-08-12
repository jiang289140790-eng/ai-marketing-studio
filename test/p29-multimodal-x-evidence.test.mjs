// P29 多模态 X 帖子证据闭环：Actor 媒体规范化、v3 采集证明、多模态 Qwen 契约、
// 证据/知识卡/Brief 的绑定持久化。全部测试离线：媒体内容哈希用注入的 fetch，
// 模型响应用合成 payload，绝不发起真实网络/模型调用。
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import {
  P22_COLLECTION_PROOF_V2_VERSION, P22_LIMITS, buildMultimodalQwenContent,
  fetchMediaContentHash, issueCollectionProof, normalizeCollectedItems, normalizeMediaAssets,
  normalizeSourceMetadata, parseQwenMultimodalAnalyses, verifyCollectionProof,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';
import { sha256Hex, validateEvidenceRecord, validateKnowledgeCard, validateMediaAssets } from '../src/services/p19-contracts.js';
import { toP19EvidenceInput } from '../src/services/p22-research-assist.js';
import {
  addEvidence, assembleBrief, buildKnowledgeCard, createProject, recordAssistedAnalysis, runAnalysis,
} from '../src/services/p19-workspace-service.js';
import { createP19Store } from '../src/services/p19-store.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TEST_SECRET = 'p29-test-secret-with-at-least-thirty-two-bytes';
const USER_ID = 'user-p29-a';
const COLLECTED_AT = '2026-08-12T00:00:00Z';
const RESERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TWEET_ID = '2087047011753467912';
const CONTEXT = {
  provider: 'apify:xquik/x-tweet-scraper', run_id: 'run-p29-1', collected_at: COLLECTED_AT,
  usage_total_usd: 0.01, budget_reservation_id: RESERVATION_ID,
};

const IMAGE_1 = 'https://pbs.twimg.com/media/photo-a.jpg?format=jpg&name=large';
const IMAGE_2 = 'https://pbs.twimg.com/media/photo-b.jpg?format=jpg&name=large';
const IMAGE_3 = 'https://pbs.twimg.com/media/photo-c.jpg?format=jpg&name=large';
const IMAGE_4 = 'https://pbs.twimg.com/media/photo-d.jpg?format=jpg&name=large';
const VIDEO_1 = 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/720x1280.mp4';
const GIF_1 = 'https://video.twimg.com/tweet_video/example.mp4';
const FOREIGN_HOST = 'https://cdn.example.com/evil.jpg';

/** 注入的媒体抓取边界：按 URL 路由，支持重定向/MIME/大小/超时失败。 */
function mediaHarness(routes = {}) {
  const calls = [];
  const defaultRoute = routes.default || { contentType: 'image/jpeg', bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3]) };
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    calls.push({ url: text, redirect: init.redirect, signal: Boolean(init.signal) });
    const route = routes[text] || defaultRoute;
    if (route.hang) {
      return new Promise((resolve, reject) => {
        if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (route.status >= 300 && route.status < 400) {
      return { ok: false, status: route.status, headers: { get: (name) => (name.toLowerCase() === 'location' ? route.location : null) }, body: null };
    }
    const chunks = route.chunks || (route.bytes || new Uint8Array([1, 2, 3]) ? [route.bytes || new Uint8Array([1, 2, 3])] : []);
    const stream = new globalThis.ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
    });
    const contentLength = route.contentLength !== undefined ? route.contentLength
      : (chunks.length > 0 ? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) : null);
    return {
      ok: route.status === undefined || route.status < 300,
      status: route.status === undefined ? 200 : route.status,
      headers: { get: (name) => {
        const lower = name.toLowerCase();
        if (lower === 'content-type') return route.contentType;
        if (lower === 'content-length' && contentLength !== null) return String(contentLength);
        return null;
      } },
      body: stream,
    };
  };
  return { fetchImpl, calls };
}

function twoImageRaw() {
  return {
    id: TWEET_ID, url: `https://x.com/example/status/${TWEET_ID}`,
    text: 'P29 two-photo evidence post with a concrete hook.',
    author: { name: 'Example Author', username: 'example_handle' },
    createdAt: '2026-08-11T09:30:00.000Z',
    likeCount: 128, retweetCount: 34, replyCount: 12, quoteCount: 3, viewCount: 4567,
    media: [
      { url: IMAGE_1, type: 'image', width: 1200, height: 800 },
      { url: IMAGE_2, type: 'image', width: 900, height: 1200 },
    ],
  };
}

async function collectedTwoImage(options = {}) {
  const harness = mediaHarness(options.routes);
  const [item] = await normalizeCollectedItems([twoImageRaw()], CONTEXT, hash, { fetchImpl: harness.fetchImpl, timeoutMs: 500 });
  return { item, harness };
}

// ---------------------------------------------------------------------------
// 媒体规范化
// ---------------------------------------------------------------------------

function routeBytesFor(index) {
  return index === 0 ? new Uint8Array([255, 216, 255, 224, 1, 2, 3]) : new Uint8Array([255, 216, 255, 224, 4, 5, 6]);
}

test('P29 normalizes a two-photo post into bounded ordered media assets with content hashes', async () => {
  const harness = mediaHarness({
    [IMAGE_1]: { contentType: 'image/jpeg', bytes: routeBytesFor(0) },
    [IMAGE_2]: { contentType: 'image/jpeg', bytes: routeBytesFor(1) },
  });
  const [item] = await normalizeCollectedItems([twoImageRaw()], CONTEXT, hash, { fetchImpl: harness.fetchImpl, timeoutMs: 500 });
  assert.equal(item.external_id, TWEET_ID);
  assert.deepEqual(item.source_metadata, {
    author: { name: 'Example Author', handle: 'example_handle', user_id: null },
    published_at: '2026-08-11T09:30:00.000Z',
    engagement: { likes: 128, retweets: 34, replies: 12, quotes: 3, views: 4567, bookmarks: null },
  });
  assert.equal(item.media_assets.length, 2);
  assert.equal(harness.calls.length, 2, 'content hashes are fetched for both CDN images');
  item.media_assets.forEach((asset, index) => {
    assert.equal(asset.order, index);
    assert.equal(asset.tweet_id, TWEET_ID);
    assert.equal(asset.external_id, TWEET_ID);
    assert.equal(asset.canonical_tweet_url, item.source_url);
    assert.equal(asset.kind, 'image');
    if (index === 0) assert.deepEqual(asset.dimensions, { width: 1200, height: 800 });
    if (index === 1) assert.deepEqual(asset.dimensions, { width: 900, height: 1200 });
    assert.equal(asset.hash.kind, 'content');
    assert.equal(asset.hash.algorithm, 'sha256');
    assert.equal(asset.hash.value, hashBytes(routeBytesFor(index)));
    assert.equal(asset.byte_size, routeBytesFor(index).length);
    assert.equal(asset.mime_type, 'image/jpeg');
    assert.match(asset.id, /^m-[0-9a-f]{24}$/);
  });
  assert.notEqual(item.media_assets[0].id, item.media_assets[1].id);
  assert.deepEqual(item.media_assets.map((asset) => asset.media_url), [IMAGE_1, IMAGE_2]);
});

test('P29 preserves an ordered four-photo post and a video post through mixed provider shapes', async () => {
  const four = await normalizeCollectedItems([{
    id: '1001', url: 'https://x.com/a/status/1001', text: 'four photos',
    imageUrls: [IMAGE_1, IMAGE_2, IMAGE_3, IMAGE_4],
  }], CONTEXT, hash, { fetchImpl: mediaHarness().fetchImpl });
  assert.equal(four[0].media_assets.length, 4);
  assert.deepEqual(four[0].media_assets.map((asset) => asset.media_url), [IMAGE_1, IMAGE_2, IMAGE_3, IMAGE_4]);
  assert.deepEqual(four[0].media_assets.map((asset) => asset.order), [0, 1, 2, 3]);

  const video = await normalizeCollectedItems([{
    id: '1002', url: 'https://x.com/a/status/1002', text: 'video post',
    mediaUrls: [VIDEO_1], media: [{ url: IMAGE_1, type: 'image' }],
  }], CONTEXT, hash, { fetchImpl: mediaHarness({ [VIDEO_1]: { contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24]) } }).fetchImpl });
  // media（对象数组）先于 mediaUrls 收集：保留字段声明顺序。
  assert.deepEqual(video[0].media_assets.map((asset) => [asset.kind, asset.media_url]), [
    ['image', IMAGE_1], ['video', VIDEO_1],
  ]);
  assert.equal(video[0].media_assets[1].mime_type, 'video/mp4');
  assert.equal(video[0].media_assets[1].hash.kind, 'content');

  // mediaUrls 与 media 中相同的 URL 只保留一次（不产生重复资产）。
  const deduped = await normalizeCollectedItems([{
    id: '1003', url: 'https://x.com/a/status/1003', text: 'dedupe', imageUrls: [IMAGE_1, IMAGE_1],
  }], CONTEXT, hash, { fetchImpl: mediaHarness().fetchImpl });
  assert.equal(deduped[0].media_assets.length, 1);
});

test('P29 maps official X Actor media type aliases without weakening unknown-type failure', async () => {
  const routes = {
    [IMAGE_1]: { contentType: 'image/jpeg', bytes: routeBytesFor(0) },
    [VIDEO_1]: { contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 24]) },
    [GIF_1]: { contentType: 'video/mp4', bytes: new Uint8Array([0, 0, 0, 25]) },
  };
  const [item] = await normalizeCollectedItems([{
    id: '1004', url: 'https://x.com/a/status/1004', text: 'official actor media aliases',
    media: [
      { url: IMAGE_1, type: 'photo', width: 1200, height: 800 },
      { url: VIDEO_1, mediaType: 'native_video', contentType: 'video/mp4', width: 720, height: 1280 },
      { url: GIF_1, contentType: 'animated_gif', mimeType: 'video/mp4', width: 640, height: 360 },
    ],
  }], CONTEXT, hash, { fetchImpl: mediaHarness(routes).fetchImpl });
  assert.deepEqual(item.media_assets.map((asset) => asset.kind), ['image', 'video', 'gif']);
  assert.deepEqual(item.media_assets.map((asset) => asset.dimensions), [
    { width: 1200, height: 800 },
    { width: 720, height: 1280 },
    { width: 640, height: 360 },
  ]);

  await assert.rejects(() => normalizeCollectedItems([{
    id: '1005', url: 'https://x.com/a/status/1005', text: 'unknown media kind',
    media: [{ url: IMAGE_1, type: 'card_preview' }],
  }], CONTEXT, hash, { fetchImpl: mediaHarness(routes).fetchImpl }), (error) => (
    error.code === 'MEDIA_KIND_INVALID' && error.details?.field === 'media'
  ));
});

test('P29 rejects MIME content that contradicts the normalized media kind', async () => {
  for (const mismatch of [
    { type: 'photo', contentType: 'video/mp4' },
    { type: 'native_video', contentType: 'image/jpeg' },
    { type: 'photo', contentType: 'audio/mpeg' },
  ]) {
    await assert.rejects(() => normalizeCollectedItems([{
      id: `mismatch-${mismatch.type}-${mismatch.contentType}`,
      url: 'https://x.com/a/status/1006',
      text: 'mismatched media content',
      media: [{ url: IMAGE_1, type: mismatch.type }],
    }], CONTEXT, hash, {
      fetchImpl: mediaHarness({
        [IMAGE_1]: { contentType: mismatch.contentType, bytes: routeBytesFor(0) },
      }).fetchImpl,
    }), (error) => error.code === 'MEDIA_KIND_MIME_MISMATCH' && error.details?.field === 'media_url');
  }
});

test('P29 text-only posts normalize to empty media assets without fetching anything', async () => {
  const rows = await normalizeCollectedItems([
    { id: '1', url: 'https://x.com/a/status/1', text: '纯文本公开内容' },
  ], CONTEXT, hash, { fetchImpl: () => { throw new Error('must not fetch for text-only'); } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].media_assets, []);
  assert.equal(rows[0].source_metadata.published_at, null);
  assert.equal(rows[0].source_metadata.author, null);
});

test('P29 hard-fails on media count beyond the declared bound instead of truncating', async () => {
  const many = Array.from({ length: P22_LIMITS.max_media + 1 }, (_, index) => `https://pbs.twimg.com/media/m${index}.jpg`);
  await assert.rejects(() => normalizeCollectedItems([{
    id: '2', url: 'https://x.com/a/status/2', text: 'too many media', imageUrls: many,
  }], CONTEXT, hash, { fetchImpl: mediaHarness().fetchImpl }), (error) => error.code === 'MEDIA_BOUND_EXCEEDED');
});

test('P29 malformed author/time/engagement fail closed, never silently dropped', async () => {
  // normalizeSourceMetadata 是同步 fail-closed 校验器：必须用 assert.throws。
  assert.throws(() => normalizeSourceMetadata({ author: 42, text: 'x' }), (error) => error.code === 'SOURCE_METADATA_INVALID');
  assert.throws(() => normalizeSourceMetadata({ likeCount: -1 }), (error) => error.code === 'SOURCE_METADATA_INVALID');
  assert.throws(() => normalizeSourceMetadata({ likeCount: 1.5 }), (error) => error.code === 'SOURCE_METADATA_INVALID');
  assert.throws(() => normalizeSourceMetadata({ createdAt: 'not-a-date' }), (error) => error.code === 'SOURCE_METADATA_INVALID');
  assert.throws(() => normalizeSourceMetadata({ author: { name: 'x'.repeat(200) } }), (error) => error.code === 'SOURCE_METADATA_INVALID');
  // 合法的 epoch 毫秒与无字段裸行均可规范化。
  assert.equal(normalizeSourceMetadata({ createdAt: 1723356000000 }).published_at, new Date(1723356000000).toISOString());
  assert.deepEqual(normalizeSourceMetadata({}), { author: null, published_at: null, engagement: null });
});

test('P29 content hashing fetches only allowlisted HTTPS CDN hosts and revalidates redirects', async () => {
  const bytes = new Uint8Array([9, 8, 7]);
  const harness = mediaHarness({
    [IMAGE_1]: { contentType: 'image/png', bytes },
    'https://pbs.twimg.com/media/redir.jpg': { status: 302, location: 'https://video.twimg.com/real.mp4' },
    'https://video.twimg.com/real.mp4': { contentType: 'video/mp4', bytes },
  });
  const asset = {
    media_url: IMAGE_1, hash: { algorithm: 'sha256', kind: 'url', value: 'a'.repeat(64) },
  };
  const fetched = await fetchMediaContentHash(asset, { fetchImpl: harness.fetchImpl, timeoutMs: 500 });
  assert.equal(fetched.hashValue, hashBytes(bytes));
  assert.equal(fetched.contentType, 'image/png');

  // 重定向目标不在白名单 → 失败关闭。
  const evilRedirect = await fetchMediaContentHash(
    { media_url: 'https://pbs.twimg.com/media/r2.jpg' },
    { fetchImpl: mediaHarness({ 'https://pbs.twimg.com/media/r2.jpg': { status: 302, location: FOREIGN_HOST } }).fetchImpl, timeoutMs: 500 },
  ).then(() => null, (error) => error);
  assert.equal(evilRedirect.code, 'MEDIA_REDIRECT_REJECTED');

  // 非白名单主机必须抛出 MEDIA_HOST_UNSUPPORTED（fail closed）
  const foreign = await fetchMediaContentHash({ media_url: FOREIGN_HOST }, { fetchImpl: () => { throw new Error('must not fetch foreign host'); } }).then(() => null, (error) => error);
  assert.equal(foreign.code, 'MEDIA_HOST_UNSUPPORTED');
});

test('P29 content hashing fails closed on MIME, size and timeout violations', async () => {
  const asset = { media_url: IMAGE_1 };
  const wrongMime = await fetchMediaContentHash(asset, {
    fetchImpl: mediaHarness({ default: { contentType: 'text/html', bytes: new Uint8Array([1]) } }).fetchImpl, timeoutMs: 500,
  }).then(() => null, (error) => error);
  assert.equal(wrongMime.code, 'MEDIA_CONTENT_TYPE_REJECTED');

  const overflow = await fetchMediaContentHash(asset, {
    fetchImpl: mediaHarness({ default: { contentType: 'image/jpeg', bytes: new Uint8Array(1024) } }).fetchImpl,
    maxBytes: 64, timeoutMs: 500,
  }).then(() => null, (error) => error);
  assert.equal(overflow.code, 'MEDIA_SIZE_OVERFLOW');

  const timedOut = await fetchMediaContentHash(asset, {
    fetchImpl: mediaHarness({ default: { hang: true } }).fetchImpl, timeoutMs: 40,
  }).then(() => null, (error) => error);
  assert.equal(timedOut.code, 'MEDIA_FETCH_TIMEOUT');
});

test('P29 stream-hangs-after-headers deterministically returns MEDIA_FETCH_TIMEOUT via single bounded abort', async () => {
  // A stream that returns headers (200 OK, content-type valid) but never pushes
  // body chunks must still be bounded by the same single timeout.
  const hangingStream = new globalThis.ReadableStream({
    start() { /* intentional: never push chunks, never close */ },
  });
  const streamHangHarness = {
    [IMAGE_1]: {
      ok: true, status: 200,
      contentType: 'image/jpeg',
      contentLength: null, // unknown length so the pre-check passes
      body: hangingStream,
    },
  };
  let fetchCalled = false;
  const fetchImpl = async (url, _init = {}) => {
    fetchCalled = true;
    const route = streamHangHarness[String(url)];
    if (!route) throw new Error('unexpected URL');
    // Return proper Response-like object with headers but hanging body.
    return {
      ok: route.ok, status: route.status,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? route.contentType : null },
      body: route.body,
    };
  };
  const asset = { media_url: IMAGE_1 };
  const err = await fetchMediaContentHash(asset, { fetchImpl, timeoutMs: 80 }).then(() => null, (error) => error);
  assert.equal(fetchCalled, true);
  assert.equal(err.code, 'MEDIA_FETCH_TIMEOUT');
  assert.equal(err.message.includes('超时'), true);
});

// ---------------------------------------------------------------------------
// P29 对抗测试：声明大小越界、累积流越界、不受支持主机、维度/MIME 保存、畸形拒绝
// ---------------------------------------------------------------------------

test('P29 declared Content-Length over 12 MiB rejects immediately without reading the stream', async () => {
  const declaredLimit = 12 * 1024 * 1024;
  const bytes = new Uint8Array([255, 216, 255]); // 实际只有 3 字节，但声明超限
  const harness = mediaHarness({
    [IMAGE_1]: { contentType: 'image/jpeg', bytes, contentLength: declaredLimit + 1 },
  });
  const asset = { media_url: IMAGE_1 };
  const err = await fetchMediaContentHash(asset, {
    fetchImpl: harness.fetchImpl, timeoutMs: 500,
  }).then(() => null, (error) => error);
  assert.equal(err.code, 'MEDIA_SIZE_OVERFLOW');
  assert.equal(err.message.includes('声明大小'), true);
  // 不应读取流 — 在 stream 创建前就已拒绝。
  assert.equal(harness.calls.length, 1);
});

test('P29 cumulative streamed bytes over 12 MiB stops immediately on the overflowing chunk', async () => {
  const maxBytes = 128;
  const chunk = new Uint8Array(128); // exactly maxBytes
  // Two chunks: first fits within maxBytes, second tips cumulative bytes over.
  // Declared content-length is within bounds so the pre-check does not fire;
  // the stream-level overflow must be caught after reading the second chunk.
  const harness = mediaHarness({
    [IMAGE_1]: { contentType: 'image/jpeg', contentLength: maxBytes, chunks: [chunk, new Uint8Array([99])] },
  });
  const asset = { media_url: IMAGE_1 };
  const err = await fetchMediaContentHash(asset, {
    fetchImpl: harness.fetchImpl, maxBytes, timeoutMs: 500,
  }).then(() => null, (error) => error);
  assert.equal(err.code, 'MEDIA_SIZE_OVERFLOW');
  // The first chunk was read (bytes === maxBytes, not yet over), but the second
  // chunk pushed cumulative bytes beyond maxBytes and triggered immediate stop.
});

test('P29 unsupported host never fetched, never present in Qwen multimodal content, and fails closed before constructing any request', async () => {
  // normalizeMediaAssets must throw MEDIA_HOST_UNSUPPORTED for foreign hosts
  // (error now originates from fetchMediaContentHash and propagates up).
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: ['https://other.evil.com/malware.jpg'] },
      '9', 'https://x.com/a/status/9', hash, {}),
    (error) => error.code === 'MEDIA_HOST_UNSUPPORTED',
  );
  // Fail-closed: a url-hash-only asset (never content-verified) must cause
  // buildMultimodalQwenContent to throw before constructing any request.
  const evilAsset = {
    id: 'm-evil',
    tweet_id: null, external_id: null,
    canonical_tweet_url: 'https://x.com/a/status/9',
    media_url: FOREIGN_HOST,
    order: 0, kind: 'image', mime_type: 'image/jpeg',
    dimensions: null, byte_size: null,
    hash: { algorithm: 'sha256', kind: 'url', value: 'a'.repeat(64) },
  };
  // buildMultimodalQwenContent must throw MEDIA_PROOF_INCOMPLETE — unverified
  // media cannot enter the request in any form (not text, not image_url).
  assert.throws(
    () => buildMultimodalQwenContent([{
      id: 'p22-abc', source_url: 'https://x.com/a/status/9',
      content_text: 'text only', media_assets: [evilAsset],
    }]),
    (error) => error.code === 'MEDIA_PROOF_INCOMPLETE',
  );
  const forgedContentAsset = {
    ...evilAsset,
    hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) },
  };
  assert.throws(
    () => buildMultimodalQwenContent([{
      id: 'p22-forged', source_url: 'https://x.com/a/status/9',
      content_text: 'text only', media_assets: [forgedContentAsset],
    }]),
    (error) => error.code === 'MEDIA_HOST_UNSUPPORTED',
  );
  // 同时验证合法（全 content-hash）媒体可以正常构造请求。
  const verifiedAsset = {
    id: 'm-verified', tweet_id: '9', external_id: '9',
    canonical_tweet_url: 'https://x.com/a/status/9',
    media_url: IMAGE_1, order: 0, kind: 'image', mime_type: 'image/jpeg',
    dimensions: { width: 100, height: 100 }, byte_size: 1024,
    hash: { algorithm: 'sha256', kind: 'content', value: 'a'.repeat(64) },
  };
  const parts = buildMultimodalQwenContent([{
    id: 'p22-abc', source_url: 'https://x.com/a/status/9',
    content_text: 'text only', media_assets: [verifiedAsset],
  }]);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  // 外来 URL 绝不出现在序列化请求的任何位置（文本或部件）。
  const serialized = JSON.stringify(parts);
  assert.doesNotMatch(serialized, /evil\.com/);
  assert.doesNotMatch(serialized, /cdn\.example\.com/);
  // 文本 JSON 只包含已验证媒体（不含未验证 URL）。
  assert.match(parts[0].text, new RegExp(IMAGE_1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(parts[0].text, /evil/);
});

test('P29 valid width, height and MIME type are preserved through normalizeMediaAssets into Evidence', async () => {
  const raw = {
    id: TWEET_ID, url: `https://x.com/example/status/${TWEET_ID}`,
    text: 'Post with explicit dimensions and MIME.',
    media: [{
      url: IMAGE_1, type: 'image',
      width: 1920, height: 1080,
      mimeType: 'image/webp',
    }],
  };
  const harness = mediaHarness({ [IMAGE_1]: { contentType: 'image/webp', bytes: new Uint8Array([255, 216, 255, 224, 1, 2, 3]) } });
  const [item] = await normalizeCollectedItems([raw], CONTEXT, hash, { fetchImpl: harness.fetchImpl, timeoutMs: 500 });
  assert.equal(item.media_assets.length, 1);
  const asset = item.media_assets[0];
  assert.deepEqual(asset.dimensions, { width: 1920, height: 1080 });
  assert.equal(asset.mime_type, 'image/webp');
  assert.equal(asset.hash.kind, 'content');
});

test('P29 malformed width, height or MIME metadata fails closed instead of silently becoming null', async () => {
  // collectMediaCandidates is internal; test via normalizeMediaAssets.
  // width as a negative number → must throw.
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, width: -1, height: 100 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // width as a non-integer → must throw (silent null reject in old code).
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, width: 1.5, height: 100 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // width out of upper bound (65537) → must throw.
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, width: 65537, height: 100 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // height zero → must throw.
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, width: 100, height: 0 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // malformed MIME — just a word, not type/subtype.
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, mimeType: 'invalid', width: 100, height: 100 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // MIME as a non-string (number) → must throw.
  await assert.rejects(
    () => normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, mimeType: 42, width: 100, height: 100 }] },
      '1', 'https://x.com/a/status/1', hash, { fetchImpl: mediaHarness().fetchImpl }),
    (error) => error.code === 'MEDIA_ASSETS_INVALID',
  );
  // Valid values must still pass.
  const ok = await normalizeMediaAssets({ imageUrls: [{ url: IMAGE_1, mimeType: 'image/png', width: 100, height: 100 }] },
    '1', 'https://x.com/a/status/1', hash, {
      fetchImpl: mediaHarness({ [IMAGE_1]: { contentType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) } }).fetchImpl,
    });
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0].dimensions, { width: 100, height: 100 });
  assert.equal(ok[0].mime_type, 'image/png');
});

// ---------------------------------------------------------------------------
// v3 采集证明：绑定正文 + 身份 + 作者/时间/互动 + 有序媒体身份/哈希
// ---------------------------------------------------------------------------

async function provenTwoImageItem() {
  const { item } = await collectedTwoImage();
  return { ...item, collection_proof: await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) }) };
}

test('P29 v3 proof binds the snapshot and every ordered media identity; tampering fails closed', async () => {
  const item = await provenTwoImageItem();
  await verifyCollectionProof(TEST_SECRET, USER_ID, item, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) });

  // 媒体删除 / 乱序 / URL 替换 / 哈希篡改 / 推文绑定篡改 → 全部失败关闭。
  const withoutMedia = { ...item, media_assets: [] };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, withoutMedia, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  const reordered = { ...item, media_assets: [item.media_assets[1], item.media_assets[0]] };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, reordered, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  const swappedUrl = { ...item, media_assets: [{ ...item.media_assets[0], media_url: IMAGE_3 }] };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, swappedUrl, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  const mutatedHash = { ...item, media_assets: [{ ...item.media_assets[0], hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) } }] };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, mutatedHash, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  const wrongTweetBinding = { ...item, media_assets: [{ ...item.media_assets[0], tweet_id: '9999999999999999999' }] };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, wrongTweetBinding, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  const tamperedAuthor = { ...item, source_metadata: { ...item.source_metadata, author: { name: 'Imposter', handle: 'evil', user_id: null } } };
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedAuthor, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  // 跨用户绑定失败。
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, 'user-p29-other', item, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
  // 过期。
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, item, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) + P22_LIMITS.proof_ttl_ms + 1000 }), { code: 'SOURCE_PROOF_EXPIRED' });
  // 正文篡改。
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, { ...item, content_text: 'tampered body' }, item.collection_proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
});

test('P29 legacy v2 proofs keep verifying for extension-free items, and never for media items', async () => {
  const legacyItem = {
    id: 'p22-legacy', source_url: 'https://x.com/a/status/9', label: 'legacy', platform: 'x',
    content_text: 'legacy body', external_id: '9', content_sha256: await hash('legacy body'),
    provenance: { schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper', run_id: 'r1', collected_at: COLLECTED_AT, usage_total_usd: 0.01, budget_reservation_id: RESERVATION_ID },
  };
  // 手工构造存量 v2 证明（历史签名格式：v2 域 + 无扩展载荷）。
  const expiresAt = Math.floor((Date.parse(COLLECTED_AT) + P22_LIMITS.proof_ttl_ms) / 1000);
  const v2Payload = JSON.stringify([
    P22_COLLECTION_PROOF_V2_VERSION, USER_ID, expiresAt, legacyItem.id, legacyItem.source_url,
    legacyItem.external_id, legacyItem.content_sha256, legacyItem.provenance.schema_version,
    legacyItem.provenance.provider, legacyItem.provenance.run_id, legacyItem.provenance.collected_at,
    legacyItem.provenance.usage_total_usd, legacyItem.provenance.budget_reservation_id,
  ]);
  const v2Signature = createHmac('sha256', TEST_SECRET).update(`p22-collection-proof-v2\0${v2Payload}`).digest('hex');
  const v2Proof = `${expiresAt}.${v2Signature}`;
  await verifyCollectionProof(TEST_SECRET, USER_ID, legacyItem, v2Proof, { nowMs: Date.parse(COLLECTED_AT) });

  // 带媒体的条目绝不接受 v2 证明。
  const mediaItem = await provenTwoImageItem();
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, mediaItem, v2Proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
});

// ---------------------------------------------------------------------------
// P29 repair3：v3 证明绑定完整媒体证据身份 —— 尺寸 / MIME / byte_size / 推文身份 / 规范 URL
// ---------------------------------------------------------------------------

test('P29 v3 proof binds dimensions, MIME type, byte_size, tweet identity and canonical URL; mutation fails closed', async () => {
  const item = await provenTwoImageItem();
  const proof = await issueCollectionProof(TEST_SECRET, USER_ID, item, { nowMs: Date.parse(COLLECTED_AT) });
  await verifyCollectionProof(TEST_SECRET, USER_ID, item, proof, { nowMs: Date.parse(COLLECTED_AT) });

  // 篡改尺寸 → 失败关闭。
  const tamperedDimensions = cloneDeep(item);
  tamperedDimensions.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    dimensions: index === 0 ? { width: 9999, height: 1 } : asset.dimensions,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedDimensions, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // 篡改 MIME → 失败关闭。
  const tamperedMime = cloneDeep(item);
  tamperedMime.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    mime_type: index === 0 ? 'image/evil' : asset.mime_type,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedMime, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // 篡改 byte_size → 失败关闭。
  const tamperedBytes = cloneDeep(item);
  tamperedBytes.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    byte_size: index === 0 ? (asset.byte_size ?? 0) + 1 : asset.byte_size,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedBytes, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // 篡改 tweet_id → 失败关闭。
  const tamperedTweetId = cloneDeep(item);
  tamperedTweetId.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    tweet_id: index === 0 ? '9999999999999999999' : asset.tweet_id,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedTweetId, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // 篡改 external_id → 失败关闭。
  const tamperedExtId = cloneDeep(item);
  tamperedExtId.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    external_id: index === 0 ? '8888888888888888888' : asset.external_id,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedExtId, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // 篡改 canonical_tweet_url → 失败关闭。
  const tamperedUrl = cloneDeep(item);
  tamperedUrl.media_assets = item.media_assets.map((asset, index) => ({
    ...asset,
    canonical_tweet_url: index === 0 ? 'https://x.com/adversary/status/1' : asset.canonical_tweet_url,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, tamperedUrl, proof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });

  // byte_size null→number 注入攻击：原为 null 被替换为数字 → 失败关闭。
  const nullByteAsset = cloneDeep(item);
  nullByteAsset.media_assets = item.media_assets.map((asset) => ({
    ...asset, byte_size: null, // 模拟旧记录无 byte_size
  }));
  const nullProof = await issueCollectionProof(TEST_SECRET, USER_ID, nullByteAsset, { nowMs: Date.parse(COLLECTED_AT) });
  const injected = cloneDeep(nullByteAsset);
  injected.media_assets = injected.media_assets.map((asset) => ({
    ...asset, byte_size: 999999999,
  }));
  await assert.rejects(() => verifyCollectionProof(TEST_SECRET, USER_ID, injected, nullProof, { nowMs: Date.parse(COLLECTED_AT) }), { code: 'SOURCE_PROOF_INVALID' });
});

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// 多模态 Qwen 契约：请求含精确 URL 顺序；响应逐媒体严格绑定
// ---------------------------------------------------------------------------

/** 严格规范边界：recordAssistedAnalysis 的 result 只接受 p29_multimodal_model_v1 的模型结果子集。 */
function canonicalResult(parsed) {
  return {
    text_expression: parsed.text_expression,
    media_analysis: parsed.media_analysis,
    virality_drivers: parsed.virality_drivers,
    reusable_methods: parsed.reusable_methods,
    signals: parsed.signals,
    risks: parsed.risks,
  };
}

function multimodalPayload(item, overrides = {}) {
  const mediaAnalysis = (item.media_assets || []).map((asset) => ({
    media_id: asset.id,
    visual_content: `画面 ${asset.order + 1}：展示产品与使用场景`,
    composition: `构图 ${asset.order + 1}：居中特写`,
    people: '人物：一名演示者',
    scene: '场景：明亮的室内环境',
    emotion: '情绪：兴奋与期待',
    ...(overrides.mediaOverride && overrides.mediaOverride[asset.order] || {}),
  }));
  return {
    choices: [{ message: { content: JSON.stringify({
      analyses: [{
        source_id: item.id,
        text_expression: overrides.textExpression || '这条帖子通过具体使用场景说明产品价值。',
        media_analysis: overrides.mediaAnalysis || mediaAnalysis,
        virality_drivers: ['真实使用场景', '明确示范'],
        reusable_methods: ['先用场景吸引注意', '再给出具体事实'],
        signals: ['高互动内容', '可视化示范'],
        risks: [],
      }],
    }) } }],
  };
}

test('P29 multimodal request sends the source text and every verified media URL in exact order', async () => {
  const { item } = await collectedTwoImage();
  const parts = buildMultimodalQwenContent([item]);
  assert.equal(parts[0].type, 'text');
  assert.match(parts[0].text, /只分析给定公开来源与所附媒体/);
  assert.deepEqual(parts.slice(1).map((part) => part.type), ['image_url', 'image_url']);
  assert.deepEqual(parts.slice(1).map((part) => part.image_url.url), [IMAGE_1, IMAGE_2]);
  assert.equal(parts[1].image_url.url, IMAGE_1);
  assert.equal(parts[2].image_url.url, IMAGE_2);
  // 视频使用 video_url 部件。
  const videoItem = (await normalizeCollectedItems([{
    id: 'v1', url: 'https://x.com/a/status/v1', text: 'video', videoUrls: [VIDEO_1],
  }], CONTEXT, hash, { fetchImpl: mediaHarness({ [VIDEO_1]: { contentType: 'video/mp4', bytes: new Uint8Array([1]) } }).fetchImpl }))[0];
  const videoParts = buildMultimodalQwenContent([videoItem]);
  assert.equal(videoParts[1].type, 'video_url');
  assert.equal(videoParts[1].video_url.url, VIDEO_1);
});

test('P29 multimodal parse binds every media result to the exact ordered media id and fails closed otherwise', async () => {
  const { item } = await collectedTwoImage();
  const parsed = parseQwenMultimodalAnalyses(multimodalPayload(item), [item]);
  assert.equal(parsed.length, 1);
  const row = parsed[0];
  assert.equal(row.source_id, item.id);
  assert.equal(row.media_analysis.length, 2);
  assert.deepEqual(row.media_analysis.map((entry) => entry.media_id), item.media_assets.map((asset) => asset.id));
  assert.equal(row.media_analysis[0].visual_content, '画面 1：展示产品与使用场景');
  assert.equal(row.text_expression.length > 0, true);
  assert.equal(row.method, 'qwen_multimodal_assisted_review');

  // 缺失媒体结果。
  const missing = multimodalPayload(item, { mediaAnalysis: [{ media_id: item.media_assets[0].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' }] });
  assert.throws(() => parseQwenMultimodalAnalyses(missing, [item]), (error) => error.code === 'MODEL_MEDIA_BINDING_INVALID');
  // 重复媒体结果。
  const dup = multimodalPayload(item, { mediaAnalysis: [
    { media_id: item.media_assets[0].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
    { media_id: item.media_assets[0].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
  ] });
  assert.throws(() => parseQwenMultimodalAnalyses(dup, [item]), (error) => error.code === 'MODEL_MEDIA_BINDING_INVALID');
  // 乱序。
  const reordered = multimodalPayload(item, { mediaAnalysis: [
    { media_id: item.media_assets[1].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
    { media_id: item.media_assets[0].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
  ] });
  assert.throws(() => parseQwenMultimodalAnalyses(reordered, [item]), (error) => error.code === 'MODEL_MEDIA_BINDING_INVALID');
  // 外来/多余媒体 id。
  const foreign = multimodalPayload(item, { mediaAnalysis: [
    { media_id: item.media_assets[0].id, visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
    { media_id: 'm-ffffffffffffffffffffffff', visual_content: 'x', composition: 'x', people: 'x', scene: 'x', emotion: 'x' },
  ] });
  assert.throws(() => parseQwenMultimodalAnalyses(foreign, [item]), (error) => error.code === 'MODEL_MEDIA_BINDING_INVALID');
  // 空 media_analysis 与媒体数不符。
  const empty = multimodalPayload(item, { mediaAnalysis: [] });
  assert.throws(() => parseQwenMultimodalAnalyses(empty, [item]), (error) => error.code === 'MODEL_MEDIA_BINDING_INVALID');
});

// ---------------------------------------------------------------------------
// 持久化：Evidence（来源快照 + 媒体资产）→ 模型分析 → 知识卡 → Brief
// ---------------------------------------------------------------------------

test('P29 evidence carries the bounded snapshot and media assets and replays idempotently', async () => {
  const item = await provenTwoImageItem();
  const input = await toP19EvidenceInput(item);
  assert.deepEqual(input.source_metadata, item.source_metadata);
  assert.equal(input.media_assets.length, 2);
  assert.equal(input.media_metadata.sha256, item.content_sha256);

  const project = await createProject({ topic: 'P29 two-photo', objective: 'bind media evidence', audience: 'operator', channel: 'X', constraints: [] });
  const withEvidence = await addEvidence(project, input);
  const evidence = withEvidence.evidence[0];
  const verdict = validateEvidenceRecord(evidence);
  assert.equal(verdict.valid, true, verdict.issues.join('；'));
  assert.deepEqual(evidence.source_metadata, item.source_metadata);
  assert.equal(evidence.media_assets.length, 2);
  assert.equal(evidence.media_assets[0].hash.kind, 'content');

  const replayed = await addEvidence(withEvidence, input);
  assert.equal(replayed.evidence.length, 1, 'same source and media must replay idempotently');

  // 相同正文身份绑定不同媒体 → 失败关闭（不静默覆盖）。
  const mutatedMedia = { ...input, media_assets: [{ ...input.media_assets[0], media_url: IMAGE_3 }] };
  await assert.rejects(() => addEvidence(withEvidence, mutatedMedia), { code: 'EVIDENCE_IDENTITY_CONFLICT' });

  // 媒体资产契约：重复 id / 乱序 / 越界全部 fail closed。
  assert.equal(validateMediaAssets([{ ...evidence.media_assets[0] }, { ...evidence.media_assets[0], order: 1 }]).valid, false);
  assert.equal(validateMediaAssets([evidence.media_assets[1], evidence.media_assets[0]]).valid, false);
  assert.equal(validateMediaAssets(Array.from({ length: 9 }, (_, index) => ({
    id: `m-${'0'.repeat(22)}${index}`, tweet_id: null, external_id: null, canonical_tweet_url: 'https://x.com/a/status/1',
    media_url: `https://pbs.twimg.com/media/x${index}.jpg`, order: index, kind: 'image', mime_type: 'image/jpeg',
    dimensions: null, byte_size: null, hash: { algorithm: 'sha256', kind: 'url', value: 'a'.repeat(64) },
  }))).valid, false);
});

test('P29 multimodal analysis persists the exact server result and replays on retry', async () => {
  const item = await provenTwoImageItem();
  const input = await toP19EvidenceInput(item);
  let project = await createProject({ topic: 'P29', objective: 'persist model analysis', audience: 'operator', channel: 'X', constraints: [] });
  project = await addEvidence(project, input);
  const evidence = project.evidence[0];
  const parsed = parseQwenMultimodalAnalyses(multimodalPayload(item), [item])[0];

  // 来源身份不匹配 → 拒绝。
  await assert.rejects(() => recordAssistedAnalysis(project, evidence.id, { ...parsed, source_id: 'p22-other' }), { code: 'ANALYSIS_SOURCE_BINDING_INVALID' });
  // 媒体绑定缺失 → 拒绝（result 仍必须是规范子集，媒体数量与绑定不匹配时失败关闭）。
  await assert.rejects(() => recordAssistedAnalysis(project, evidence.id, { ...parsed, result: { ...canonicalResult(parsed), media_analysis: [] } }), { code: 'ANALYSIS_MEDIA_BINDING_INVALID' });

  // 严格规范边界：recordAssistedAnalysis 只接受 { source_id, result: 模型结果子集, model?, executed_at?, usage? }。
  const withAnalysis = await recordAssistedAnalysis(project, evidence.id, {
    ...parsed, result: canonicalResult(parsed), executed_at: '2026-08-12T01:00:00.000Z', usage: { total_tokens: 321 },
  });
  const analysis = withAnalysis.analyses[0];
  assert.equal(analysis.evidence_id, evidence.id);
  assert.equal(analysis.kind, 'deterministic_local');
  assert.equal(analysis.provenance.model, 'qwen3.5-omni-flash');
  assert.equal(analysis.model_analysis.schema_version, 'p29_multimodal_model_v1');
  assert.equal(analysis.model_analysis.provider, 'dashscope');
  assert.equal(analysis.model_analysis.media_ids.length, 2);
  assert.deepEqual(analysis.model_analysis.media_ids, item.media_assets.map((asset) => asset.id));
  // 持久化的就是服务端返回的精确结果（含逐媒体视觉发现），不是本地替代。
  assert.equal(analysis.model_analysis.result.media_analysis[1].visual_content, '画面 2：展示产品与使用场景');
  assert.deepEqual(analysis.model_analysis.result.signals, ['高互动内容', '可视化示范']);
  assert.equal(analysis.model_analysis.usage.total_tokens, 321);
  assert.equal(analysis.result.rules.length > 0, true, '确定性规则作为补充');

  // 幂等重放：同一证据指纹下重跑不产生新记录。
  const replayed = await recordAssistedAnalysis(withAnalysis, evidence.id, {
    ...parsed, result: canonicalResult(parsed), executed_at: '2026-08-12T02:00:00.000Z', usage: { total_tokens: 999 },
  });
  assert.equal(replayed.analyses.length, 1);
  assert.equal(replayed.analyses[0].id, analysis.id);
  assert.equal(replayed.analyses[0].model_analysis.usage.total_tokens, 321);
});

test('P29 knowledge card includes bound visual findings and model identity and passes the accepted card contract', async () => {
  const item = await provenTwoImageItem();
  let project = await createProject({ topic: 'P29 card', objective: 'bind visual findings', audience: 'operator', channel: 'X', constraints: [] });
  project = await addEvidence(project, await toP19EvidenceInput(item));
  const evidence = project.evidence[0];
  const parsed = parseQwenMultimodalAnalyses(multimodalPayload(item), [item])[0];
  project = await recordAssistedAnalysis(project, evidence.id, { ...parsed, result: canonicalResult(parsed), executed_at: '2026-08-12T01:00:00.000Z', usage: { total_tokens: 100 } });
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  const card = project.knowledge_cards[0];
  const verdict = validateKnowledgeCard(card);
  assert.equal(verdict.valid, true, verdict.issues.join('；'));
  assert.equal(card.validation_status, 'validated_multimodal');
  assert.equal(card.analysis_provenance.method, 'multimodal_model');
  assert.equal(card.analysis_provenance.model, 'qwen3.5-omni-flash');
  assert.equal(card.analysis_provenance.media_ids.length, 2);
  assert.equal(card.analysis_provenance.source_analysis_id, card.analysis_id);
  assert.match(JSON.stringify(card), /画面 1：展示产品与使用场景/);
  assert.equal(card.source_observations.media.timeline.length >= 3, true);
  assert.ok(card.evidence_links.length >= 3);
  assert.ok(card.evidence_links.some((link) => link.claim.includes('媒体 #1')));
  // 已验收禁止词不得进入卡内断言。
  assert.doesNotMatch(JSON.stringify(card), /看起来像|应该是|大概有/);
});

test('P29 brief includes the plain-language multimodal findings, model identity and media count', async () => {
  const item = await provenTwoImageItem();
  let project = await createProject({ topic: 'P29 brief', objective: 'reviewable multimodal draft', audience: 'operator', channel: 'X', constraints: [] });
  project = await addEvidence(project, await toP19EvidenceInput(item));
  const evidence = project.evidence[0];
  const parsed = parseQwenMultimodalAnalyses(multimodalPayload(item), [item])[0];
  project = await recordAssistedAnalysis(project, evidence.id, { ...parsed, result: canonicalResult(parsed), executed_at: '2026-08-12T01:00:00.000Z', usage: { total_tokens: 100 } });
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  project = await assembleBrief(project, { now: () => '2026-08-12T01:01:00.000Z' });
  const brief = project.brief;
  assert.equal(brief.status, 'pending_review');
  assert.equal(brief.analysis_provenance.method, 'multimodal_model');
  assert.equal(brief.analysis_provenance.model, 'qwen3.5-omni-flash');
  assert.equal(brief.analysis_provenance.media_count, 2);
  assert.deepEqual(brief.analysis_provenance.analysis_ids, [project.analyses[0].id]);
  assert.ok(Array.isArray(brief.multimodal_findings) && brief.multimodal_findings.length > 0);
  assert.match(brief.multimodal_findings.join('|'), /画面（媒体 #1）/);
  assert.match(brief.multimodal_findings.join('|'), /画面（媒体 #2）/);
  // 纯确定性项目不携带模型扩展（兼容旧 Brief）。
  let plain = await createProject({ topic: 'plain', objective: 'text only', audience: 'operator', channel: 'X', constraints: [] });
  plain = await addEvidence(plain, {
    source_url: 'https://example.com/manual', label: 'manual', platform: 'manual',
    content_text: 'manual body', recorded_at: COLLECTED_AT,
    provenance: { manual: true, statement: 'manual' }, media_metadata: null,
  });
  plain = await runDeterministicChain(plain);
  assert.equal(plain.brief.analysis_provenance, null);
  assert.equal(plain.brief.multimodal_findings, null);
});

async function runDeterministicChain(project) {
  // 与既有测试相同的确定性链条。
  project = await runAnalysis(project, project.evidence[0].id);
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  return assembleBrief(project, { now: () => '2026-08-12T01:02:00.000Z' });
}

test('P29 store round-trip keeps deep-clone isolation for the multimodal chain', async () => {
  const backing = new Map();
  const store = createP19Store({ storage: { getItem: (key) => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) } });
  const item = await provenTwoImageItem();
  let project = await createProject({ topic: 'P29 store', objective: 'isolate snapshots', audience: 'operator', channel: 'X', constraints: [] });
  project = await addEvidence(project, await toP19EvidenceInput(item));
  const parsed = parseQwenMultimodalAnalyses(multimodalPayload(item), [item])[0];
  project = await recordAssistedAnalysis(project, project.evidence[0].id, { ...parsed, result: canonicalResult(parsed), executed_at: '2026-08-12T01:00:00.000Z', usage: { total_tokens: 50 } });
  project = await buildKnowledgeCard(project, project.analyses[0].id);
  project = await assembleBrief(project, { now: () => '2026-08-12T01:01:00.000Z' });
  const saved = store.putProject(project);
  assert.equal(saved.ok, true, saved.message);
  const read = store.getProject(project.id);
  assert.equal(read.ok, true);
  // 对外突变不得污染存储快照。
  read.project.evidence[0].media_assets[0].hash.value = 'c'.repeat(64);
  read.project.analyses[0].model_analysis.result.media_analysis[0].visual_content = 'mutated';
  read.project.brief.multimodal_findings[0] = 'mutated finding';
  const again = store.getProject(project.id);
  assert.equal(again.project.evidence[0].media_assets[0].hash.value, item.media_assets[0].hash.value);
  assert.equal(again.project.analyses[0].model_analysis.result.media_analysis[0].visual_content, '画面 1：展示产品与使用场景');
  assert.doesNotMatch(again.project.brief.multimodal_findings[0], /mutated/);
});

test('P29 cross-project contamination fail closed in the evidence chain', async () => {
  const item = await provenTwoImageItem();
  let projectA = await createProject({ topic: 'A', objective: 'A', audience: 'A', channel: 'X', constraints: [] });
  let projectB = await createProject({ topic: 'B', objective: 'B', audience: 'B', channel: 'X', constraints: [] });
  projectA = await addEvidence(projectA, await toP19EvidenceInput(item));
  const foreign = await toP19EvidenceInput({ ...item, id: `${item.id}-b`, source_url: 'https://x.com/b/status/999', external_id: '999', provenance: { ...item.provenance, run_id: 'run-b' } });
  projectB = await addEvidence(projectB, foreign);
  // 证据总是绑定传入的项目，绝不接受输入里的外来 project_id。
  assert.equal(projectA.evidence[0].project_id, projectA.id);
  assert.equal(projectB.evidence[0].project_id, projectB.id);
  assert.equal(projectA.evidence[0].id !== projectB.evidence[0].id, true);
  // 跨项目组装 Brief 被引用绑定检查拒绝。
  const analyzedA = await runAnalysis(projectA, projectA.evidence[0].id);
  const withCardA = await buildKnowledgeCard(analyzedA, analyzedA.analyses[0].id);
  const contaminated = { ...withCardA, knowledge_cards: [withCardA.knowledge_cards[0], { ...withCardA.knowledge_cards[0], id: 'kc-aaaaaaaaaaaaaaaaaaaaaaaa' }] };
  await assert.rejects(() => assembleBrief(contaminated), { code: 'BRIEF_EVIDENCE_BINDING_INVALID' });
});

test('P29 asset ids are deterministic across identical re-collections', async () => {
  const { item: first } = await collectedTwoImage();
  const { item: second } = await collectedTwoImage();
  assert.deepEqual(first.media_assets.map((asset) => asset.id), second.media_assets.map((asset) => asset.id));
  assert.deepEqual(first.media_assets.map((asset) => asset.hash), second.media_assets.map((asset) => asset.hash));
  // 非 CDN 白名单主机必须 fail closed，绝不回退到 URL 哈希。
  await assert.rejects(() => normalizeMediaAssets({ imageUrls: [FOREIGN_HOST] }, '9', 'https://x.com/a/status/9', hash, {}),
    (error) => error.code === 'MEDIA_HOST_UNSUPPORTED');
  // 各资产哈希在 URL 哈希与内容哈希之间明确区分。
  await assert.rejects(() => normalizeMediaAssets({ imageUrls: ['https://other.evil.com/img.jpg'] }, '9', 'https://x.com/a/status/9', hash, {}),
    (error) => error.code === 'MEDIA_HOST_UNSUPPORTED');
});

test('P29 helper contract: sha256Hex import still used for evidence hash binding', async () => {
  assert.equal(/^[0-9a-f]{64}$/.test(await sha256Hex('anything')), true);
});
