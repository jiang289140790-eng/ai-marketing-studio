// P38 旧视频证据恢复验收（纯单元，无浏览器、无网络、无真实 Apify/Qwen）：
//
// - assessMediaAnalyzability：唯一、失败关闭的媒体可分析性判定。每个媒体资产
//   必须有非空且有界的 id、准确 order、image/video/gif 类型、匹配类型的 MIME、
//   允许的 X/Twitter CDN（t.co 与任意非白名单拒绝）、sha256/content 内容哈希、
//   正整数 byte_size；任一不满足 = needs_rehydration，禁止直接调用 Qwen。
// - bindRehydratedItemToEvidence：重新采集结果与当前 Evidence 的精确一对一
//   身份绑定（source_url/平台/external_id/source_id/正文逐字一致）。
// - rehydrateEvidenceMediaAndAnalyze：原位恢复链 —— 一次 collect_url →
//   唯一身份绑定 → 一次 evidence.update（不创建新证据；版本 +1、指纹变化）→
//   权威在线读取确认 → 之后才 analyze_persisted；所有失败模式零 Qwen 调用。
// - 所有错误有界、脱敏：不输出 token/Secret/媒体签名参数/上游原始响应，
//   错误文案绝不包含 URL 或哈希值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  P38_MEDIA_CDN_ALLOWLIST,
  assessMediaAnalyzability,
  bindRehydratedItemToEvidence,
  rehydrateEvidenceMediaAndAnalyze,
} from '../src/services/p22-research-assist.js';
import { clonePlain, fingerprintOf } from '../src/services/p19-contracts.js';
import { addEvidence, createProject, updateEvidence } from '../src/services/p19-workspace-service.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const CONTENT_TEXT = 'P38 legacy video post body';
const SOURCE_URL = 'https://x.com/p38author/status/1900000000000000001';
const EXTERNAL_ID = '1900000000000000001';
const SOURCE_ID = 'p38-source-1';
const COLLECTED_AT = '2026-08-12T00:00:00.000Z';
const RESERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PROOF = `1999999999.${'a'.repeat(64)}`;

function legacyAsset(overrides = {}) {
  return {
    id: 'm-111111111111111111111111',
    tweet_id: EXTERNAL_ID,
    external_id: EXTERNAL_ID,
    canonical_tweet_url: SOURCE_URL,
    media_url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280.mp4',
    order: 0,
    kind: 'video',
    mime_type: 'video/mp4',
    dimensions: { width: 720, height: 1280 },
    byte_size: null,
    hash: { algorithm: 'sha256', kind: 'url', value: 'a'.repeat(64) },
    ...overrides,
  };
}

/** 通过严格媒体校验的资产（content 哈希、正整数 byte_size、白名单 CDN）。 */
function verifiedAsset(overrides = {}) {
  return {
    ...legacyAsset({
      id: 'm-222222222222222222222222',
      media_url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280.mp4?exp=999&sig=abc',
      byte_size: 4096,
      hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) },
    }),
    ...overrides,
  };
}

async function legacyEvidenceInput(overrides = {}) {
  const contentSha = await hash(CONTENT_TEXT);
  const provenance = {
    schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
    method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x',
    source_id: SOURCE_ID, external_id: EXTERNAL_ID,
    source_url: SOURCE_URL,
    run_id: 'apify-run-p38-legacy', collected_at: COLLECTED_AT, usage_total_usd: 0.01,
    budget_reservation_id: RESERVATION_ID, content_sha256: contentSha,
    collection_proof: PROOF, statement: 'Server-bound P22 source evidence.',
  };
  return {
    source_url: SOURCE_URL, label: 'P38 legacy video source', platform: 'X · Apify',
    content_text: CONTENT_TEXT, recorded_at: COLLECTED_AT, provenance,
    media_metadata: {
      filename: 'p38-source.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(CONTENT_TEXT).byteLength,
      last_modified: COLLECTED_AT, sha256: contentSha,
    },
    source_metadata: {
      author: { name: 'P38 Author', handle: 'p38author', user_id: 'u-p38-author' },
      published_at: '2026-08-11T09:30:00.000Z',
      engagement: { likes: 100, views: 5000 },
    },
    media_assets: [legacyAsset()],
    ...overrides,
  };
}

async function projectWithLegacyEvidence(overrides = {}) {
  const project = await createProject({ topic: 'P38 旧视频恢复', objective: '验证原位恢复链', audience: '验收团队', channel: 'X' });
  const input = await legacyEvidenceInput(overrides);
  const after = await addEvidence(project, input);
  const evidence = after.evidence.find((row) => row.id !== undefined);
  return { project: after, evidence };
}

/** 重新采集返回的已验证来源项（与 legacyEvidenceInput 同一身份，媒体已验证）。 */
async function reCollectedItem({ media = [verifiedAsset()], contentText = CONTENT_TEXT, sourceUrl = SOURCE_URL, platform = 'x', externalId = EXTERNAL_ID, sourceId = SOURCE_ID } = {}) {
  return {
    id: sourceId,
    source_url: sourceUrl,
    label: 'P38 legacy video source',
    platform,
    content_text: contentText,
    external_id: externalId,
    content_sha256: await hash(contentText),
    source_metadata: {
      author: { name: 'P38 Author', handle: 'p38author', user_id: 'u-p38-author' },
      published_at: '2026-08-11T09:30:00.000Z',
      engagement: { likes: 120, views: 6000 },
    },
    media_assets: media,
    collection_proof: `1999999998.${'b'.repeat(64)}`,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: 'apify:xquik/x-tweet-scraper',
      run_id: 'apify-run-p38-rehydrated',
      collected_at: '2026-08-13T00:00:00.000Z',
      usage_total_usd: 0.02,
      budget_reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    },
  };
}

/** 页面 buildOnlineCommand 的 evidence.update 分支镜像（仅 P38 所需子集）。 */
function buildEvidenceUpdateSpec(before, after) {
  for (const item of after.evidence || []) {
    const prior = (before.evidence || []).find((row) => row.id === item.id);
    if (prior && prior.fingerprint !== item.fingerprint) {
      const patch = {};
      for (const field of ['source_url', 'label', 'platform', 'content_text', 'recorded_at', 'provenance', 'media_metadata', 'source_metadata', 'media_assets']) {
        if (JSON.stringify(prior[field]) !== JSON.stringify(item[field])) patch[field] = item[field];
      }
      return {
        command: 'evidence.update',
        payload: { project_id: before.id, evidence_id: item.id, expected_fingerprint: prior.fingerprint, patch },
      };
    }
  }
  throw new Error('no evidence.update diff');
}

/** 服务端 applyEvidenceUpdate 的权威镜像：应用 patch、版本 +1、重算指纹。 */
async function fakeServerApply(project, spec) {
  const next = clonePlain(project);
  const record = next.evidence.find((row) => row.id === spec.payload.evidence_id);
  if (!record) throw new Error('evidence not found');
  const patch = spec.payload.patch || {};
  if (patch.source_url !== undefined) record.source_url = String(patch.source_url).trim().slice(0, 1000);
  if (patch.label !== undefined) record.label = String(patch.label).trim().slice(0, 200);
  if (patch.platform !== undefined) record.platform = String(patch.platform).trim().slice(0, 80);
  if (patch.content_text !== undefined) record.content_text = String(patch.content_text).slice(0, 5000);
  if (patch.recorded_at !== undefined) record.recorded_at = String(patch.recorded_at).slice(0, 80);
  if (patch.provenance !== undefined) record.provenance = clonePlain(patch.provenance);
  if (patch.media_metadata !== undefined) record.media_metadata = patch.media_metadata === null ? null : clonePlain(patch.media_metadata);
  if (patch.source_metadata !== undefined) {
    if (patch.source_metadata === null) delete record.source_metadata;
    else record.source_metadata = clonePlain(patch.source_metadata);
  }
  if (patch.media_assets !== undefined) {
    if (patch.media_assets === null) delete record.media_assets;
    else record.media_assets = clonePlain(patch.media_assets);
  }
  record.version = (record.version || 1) + 1;
  record.updated_at = '2026-08-13T00:00:00.000Z';
  const without = { ...record, fingerprint: '' };
  record.fingerprint = await fingerprintOf(without);
  return next;
}

/** 有界/脱敏校验：错误文案不得包含 URL、token、64 位哈希或上游原文。 */
function assertBoundedError(error, code) {
  assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
  assert.ok(error.message.length <= 300, `error message must be bounded: ${error.message}`);
  assert.ok(!/https?:\/\//.test(error.message), `error must not echo URLs: ${error.message}`);
  assert.ok(!/[0-9a-f]{64}/.test(error.message), `error must not echo hashes: ${error.message}`);
  assert.ok(!/Bearer\s+\S+/i.test(error.message), `error must not echo tokens: ${error.message}`);
}

// ---- 严格媒体可分析性判定 ------------------------------------------------------

test('P38 gate: fully verified media is analyzable with zero issues', () => {
  const verdict = assessMediaAnalyzability({ media_assets: [verifiedAsset(), verifiedAsset({ id: 'm-333333333333333333333333', order: 1, byte_size: 2048, hash: { algorithm: 'sha256', kind: 'content', value: 'c'.repeat(64) } })] });
  assert.equal(verdict.analyzable, true);
  assert.equal(verdict.status, 'analyzable');
  assert.deepEqual(verdict.issues, []);
  assert.equal(verdict.reason, '媒体已通过严格安全验证。');
});

test('P38 gate: text-only evidence is directly analyzable (text path, no rehydration)', () => {
  const verdict = assessMediaAnalyzability({ media_assets: [] });
  assert.equal(verdict.analyzable, true);
  assert.equal(verdict.status, 'text_only');
});

test('P38 gate: every legacy binding failure mode means needs_rehydration', () => {
  const cases = [
    ['旧 URL 哈希', legacyAsset()],
    ['t.co 短链', legacyAsset({ media_url: 'https://t.co/UTBGnHanx3', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 1024 })],
    ['非白名单 CDN', legacyAsset({ media_url: 'https://cdn.example.com/video.mp4', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 1024 })],
    ['类型/MIME 不匹配', legacyAsset({ mime_type: 'text/plain; charset=utf-8', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 1024 })],
    ['缺失内容字节', legacyAsset({ hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) } })],
    ['类型无效', legacyAsset({ kind: 'audio', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 1024 })],
    ['无效媒体 id', legacyAsset({ id: 'not-a-media-id', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 1024 })],
    ['乱序', [legacyAsset({ id: 'm-444444444444444444444444' }), legacyAsset({ id: 'm-555555555555555555555555', order: 0 })]],
  ];
  for (const [label, media] of cases) {
    const verdict = assessMediaAnalyzability({ media_assets: Array.isArray(media) ? media : [media] });
    assert.equal(verdict.analyzable, false, `${label} must need rehydration`);
    assert.equal(verdict.status, 'needs_rehydration', label);
    assert.ok(verdict.issues.length > 0, label);
    // 判定文案固定、有界、脱敏：绝不回显媒体 URL 或哈希值。
    for (const issue of verdict.issues) {
      assert.ok(!/https?:\/\//.test(issue), `${label} issue must not echo URL: ${issue}`);
      assert.ok(!/[0-9a-f]{64}/.test(issue), `${label} issue must not echo hash: ${issue}`);
    }
  }
});

test('P38 gate: CDN whitelist is exactly the strict X/Twitter CDN set', () => {
  assert.deepEqual(P38_MEDIA_CDN_ALLOWLIST, ['pbs.twimg.com', 'video.twimg.com', 'abs.twimg.com']);
});

// ---- 精确一对一身份绑定 --------------------------------------------------------

test('P38 binding: exact 1:1 identity match returns the evidence.update patch', async () => {
  const { evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  const { patch } = bindRehydratedItemToEvidence(evidence, item);
  assert.deepEqual(patch.media_assets, item.media_assets);
  assert.deepEqual(patch.source_metadata, item.source_metadata);
  assert.equal(Object.keys(patch).sort().join(','), 'media_assets,provenance,recorded_at,source_metadata');
});

test('P38 binding: any identity mismatch fails closed with a bounded P38 error', async () => {
  const { evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  const cases = [
    ['source_url 错绑', { ...item, source_url: 'https://x.com/other/status/999' }, 'P38_REHYDRATION_SOURCE_URL_MISMATCH'],
    ['平台错绑', { ...item, platform: 'reddit' }, 'P38_REHYDRATION_PLATFORM_MISMATCH'],
    ['external_id 错绑', { ...item, external_id: '9999999999999999999' }, 'P38_REHYDRATION_EXTERNAL_ID_MISMATCH'],
    ['source_id 错绑', { ...item, id: 'p38-source-foreign' }, 'P38_REHYDRATION_SOURCE_ID_MISMATCH'],
    ['正文哈希错绑', { ...item, content_text: `${CONTENT_TEXT}tampered`, content_sha256: await hash(`${CONTENT_TEXT}tampered`) }, 'P38_REHYDRATION_CONTENT_MISMATCH'],
    ['正文逐字不一致', { ...item, content_text: `${CONTENT_TEXT} ` }, 'P38_REHYDRATION_CONTENT_MISMATCH'],
    ['无结果对象', null, 'P38_REHYDRATION_IDENTITY_MISMATCH'],
  ];
  for (const [label, wrongItem, code] of cases) {
    assert.throws(() => bindRehydratedItemToEvidence(evidence, wrongItem), (error) => {
      assertBoundedError(error, code);
      return true;
    }, label);
  }
});

test('P38 binding: unverified media in the re-collected result is rejected (zero Qwen)', async () => {
  const { evidence } = await projectWithLegacyEvidence();
  const bad = [
    ['无媒体', []],
    ['旧 URL 哈希', [legacyAsset()]],
    ['非白名单 CDN', [legacyAsset({ media_url: 'https://evil.example.com/x.mp4', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 100 })]],
    ['类型/MIME 不匹配', [legacyAsset({ mime_type: 'text/plain', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 100 })]],
  ];
  for (const [label, media] of bad) {
    const item = await reCollectedItem({ media });
    assert.throws(() => bindRehydratedItemToEvidence(evidence, item), (error) => {
      assertBoundedError(error, 'P38_REHYDRATED_MEDIA_INVALID');
      return true;
    }, label);
  }
});

// ---- 原位恢复链 ----------------------------------------------------------------

test('P38 chain: legacy video evidence rehydrates in place and only then calls Qwen (preview)', async () => {
  const { project, evidence } = await projectWithLegacyEvidence();
  const calls = [];
  const reCollected = await reCollectedItem();
  const modelResult = {
    source_id: SOURCE_ID, source_url: SOURCE_URL, content_sha256: evidence.provenance.content_sha256,
    text_expression: '旧视频画面分析', model: 'qwen3.5-omni-flash',
    media_analysis: reCollected.media_assets.map((asset) => ({
      media_id: asset.id, visual_content: '画面内容', composition: '构图', people: '人物', scene: '场景', emotion: '情绪',
    })),
    virality_drivers: ['真实场景'], reusable_methods: ['先展示画面'], signals: [], risks: [],
  };
  const client = {
    async collectUrl(url) {
      calls.push(['collect_url', url]);
      return { items: [reCollected] };
    },
    async analyzePersisted(projectId, evidenceId) {
      calls.push(['analyze_persisted', projectId, evidenceId]);
      return { analyses: [modelResult], usage: { total_tokens: 300 } };
    },
  };
  const result = await rehydrateEvidenceMediaAndAnalyze({
    project,
    evidenceId: evidence.id,
    client,
    updateEvidenceFn: updateEvidence,
    buildCommandFn: buildEvidenceUpdateSpec,
    executeCommandFn: async (command, payload, options) => {
      calls.push(['execute', command, payload.evidence_id]);
      return fakeServerApply(project, { command, payload, options });
    },
  });

  // 顺序严格：collect_url → 一次 evidence.update → 权威重载 → analyze_persisted。
  assert.deepEqual(calls.map((entry) => entry[0]), ['collect_url', 'execute', 'analyze_persisted']);
  assert.equal(calls[0][1], evidence.source_url, 'collect_url 必须使用当前 Evidence 的规范 source_url');
  assert.equal(calls[1][1], 'evidence.update', '必须恰好一次 evidence.update');
  assert.equal(calls[1][2], evidence.id, 'evidence.update 必须绑定同一 evidence_id');
  assert.equal(calls[2][2], evidence.id);

  // 原 Evidence 数量不变、id 不变、版本 +1、指纹变化；媒体绑定更新为内容哈希。
  assert.equal(result.project.evidence.length, 1, '不得产生重复 Evidence');
  assert.equal(result.evidence.id, evidence.id);
  assert.equal(result.evidence.version, evidence.version + 1);
  assert.notEqual(result.evidence.fingerprint, evidence.fingerprint);
  assert.equal(result.evidence.media_assets[0].hash.kind, 'content');
  assert.equal(result.evidence.media_assets[0].byte_size, 4096);
  assert.equal(assessMediaAnalyzability(result.evidence).analyzable, true, '权威证据必须通过严格媒体校验');
  assert.equal(result.modelResult.source_id, SOURCE_ID);
  assert.equal(result.usage.total_tokens, 300);
});

test('P38 chain: verified media evidence is never re-collected (zero client calls)', async () => {
  const project = await createProject({ topic: 'P38 已验证', objective: '直接分析', audience: '团队', channel: 'X' });
  const verifiedInput = await legacyEvidenceInput({ media_assets: [verifiedAsset()] });
  const after = await addEvidence(project, verifiedInput);
  const evidence = after.evidence[0];
  let collectCalled = 0;
  let analyzeCalled = 0;
  const client = {
    async collectUrl() { collectCalled += 1; return { items: [] }; },
    async analyzePersisted() { analyzeCalled += 1; return { analyses: [] }; },
  };
  await assert.rejects(() => rehydrateEvidenceMediaAndAnalyze({
    project: after, evidenceId: evidence.id, client,
    updateEvidenceFn: updateEvidence, buildCommandFn: buildEvidenceUpdateSpec,
    executeCommandFn: async () => { throw new Error('must not execute'); },
  }), (error) => {
    assertBoundedError(error, 'P38_MEDIA_ALREADY_VERIFIED');
    return true;
  });
  assert.equal(collectCalled, 0, '已验证证据必须零重新采集');
  assert.equal(analyzeCalled, 0, '已验证证据必须零 Qwen 调用');
});

test('P38 chain: every failed rehydration mode is fail-closed with zero Qwen calls', async () => {
  const failures = [
    ['缺失采集结果', { items: [] }],
    ['重复结果', { items: [await reCollectedItem(), await reCollectedItem({ sourceId: 'p38-source-2' })] }],
    ['external_id 错绑', { items: [await reCollectedItem({ externalId: '9999999999999999999' })] }],
    ['source URL 错绑', { items: [await reCollectedItem({ sourceUrl: 'https://x.com/other/status/999' })] }],
    ['平台错绑', { items: [await reCollectedItem({ platform: 'reddit' })] }],
    ['正文不一致', { items: [await reCollectedItem({ contentText: `${CONTENT_TEXT}tampered` })] }],
    ['结果无媒体', { items: [await reCollectedItem({ media: [] })] }],
    ['结果旧 URL 哈希', { items: [await reCollectedItem({ media: [legacyAsset()] })] }],
    ['结果非白名单 CDN', { items: [await reCollectedItem({ media: [legacyAsset({ media_url: 'https://evil.example.com/x.mp4', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 100 })] })] }],
    ['结果类型/MIME 不符', { items: [await reCollectedItem({ media: [legacyAsset({ mime_type: 'text/plain', hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) }, byte_size: 100 })] })] }],
  ];
  for (const [label, response] of failures) {
    const { project, evidence } = await projectWithLegacyEvidence();
    let collectCount = 0;
    let analyzeCalled = 0;
    const client = {
      async collectUrl() { collectCount += 1; return response; },
      async analyzePersisted() { analyzeCalled += 1; return { analyses: [] }; },
    };
    await assert.rejects(() => rehydrateEvidenceMediaAndAnalyze({
      project, evidenceId: evidence.id, client,
      updateEvidenceFn: updateEvidence, buildCommandFn: buildEvidenceUpdateSpec,
      executeCommandFn: async () => { throw new Error('must not execute when binding fails'); },
    }), (error) => {
      assert.ok(String(error.code).startsWith('P38_'), `${label}: unexpected code ${error.code}`);
      assertBoundedError(error, error.code);
      return true;
    }, label);
    assert.equal(collectCount, 1, `${label}: collect_url exactly once`);
    assert.equal(analyzeCalled, 0, `${label}: zero Qwen calls`);
  }
});

test('P38 chain: authoritative verification failures stop before Qwen', async () => {
  const { project, evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  const baseClient = {
    async collectUrl() { return { items: [item] }; },
    async analyzePersisted() { throw new Error('Qwen must not be called'); },
  };
  const mutated = (mutate) => async (command, payload, options) => {
    const applied = await fakeServerApply(project, { command, payload, options });
    mutate(applied);
    return applied;
  };
  const cases = [
    ['权威证据缺失', mutated((next) => { next.evidence = []; }), 'P38_REHYDRATION_MISSING'],
    ['版本未递增', mutated((next) => { next.evidence[0].version = evidence.version; }), 'P38_REHYDRATION_VERSION_INVALID'],
    ['指纹未变化', mutated((next) => { next.evidence[0].fingerprint = evidence.fingerprint; }), 'P38_REHYDRATION_FINGERPRINT_UNCHANGED'],
    ['媒体仍未验证', mutated((next) => { next.evidence[0].media_assets = [legacyAsset()]; }), 'P38_REHYDRATION_INCOMPLETE'],
  ];
  for (const [label, executeCommandFn, code] of cases) {
    await assert.rejects(() => rehydrateEvidenceMediaAndAnalyze({
      project, evidenceId: evidence.id, client: baseClient,
      updateEvidenceFn: updateEvidence, buildCommandFn: buildEvidenceUpdateSpec, executeCommandFn,
    }), (error) => {
      assertBoundedError(error, code);
      return true;
    }, label);
  }
});

test('P38 chain: non-evidence.update command binding fails closed before any write', async () => {
  const { project, evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  const client = {
    async collectUrl() { return { items: [item] }; },
    async analyzePersisted() { throw new Error('Qwen must not be called'); },
  };
  await assert.rejects(() => rehydrateEvidenceMediaAndAnalyze({
    project, evidenceId: evidence.id, client,
    updateEvidenceFn: updateEvidence,
    buildCommandFn: () => ({ command: 'evidence.create', payload: { evidence_id: evidence.id } }),
    executeCommandFn: async () => { throw new Error('must not execute'); },
  }), (error) => {
    assertBoundedError(error, 'P38_UPDATE_BINDING_INVALID');
    return true;
  });
});

test('P38 chain: missing analysis identity binding stops with a bounded error', async () => {
  const { project, evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  const client = {
    async collectUrl() { return { items: [item] }; },
    async analyzePersisted() { return { analyses: [{ source_id: 'p38-source-foreign' }] }; },
  };
  await assert.rejects(() => rehydrateEvidenceMediaAndAnalyze({
    project, evidenceId: evidence.id, client,
    updateEvidenceFn: updateEvidence, buildCommandFn: buildEvidenceUpdateSpec,
    executeCommandFn: (command, payload, options) => fakeServerApply(project, { command, payload, options }),
  }), (error) => {
    assertBoundedError(error, 'P38_ANALYSIS_IDENTITY_MISSING');
    return true;
  });
});

test('P38 chain: evidence.update payload atomically carries the exact media and refreshed provenance binding', async () => {
  const { project, evidence } = await projectWithLegacyEvidence();
  const item = await reCollectedItem();
  let captured = null;
  const client = {
    async collectUrl() { return { items: [item] }; },
    async analyzePersisted() { return { analyses: [{ source_id: SOURCE_ID }], usage: { total_tokens: 1 } }; },
  };
  await rehydrateEvidenceMediaAndAnalyze({
    project, evidenceId: evidence.id, client,
    updateEvidenceFn: updateEvidence, buildCommandFn: buildEvidenceUpdateSpec,
    executeCommandFn: async (command, payload) => {
      captured = { command, payload };
      return fakeServerApply(project, { command, payload });
    },
  });
  assert.equal(captured.command, 'evidence.update');
  assert.equal(captured.payload.evidence_id, evidence.id);
  assert.equal(captured.payload.expected_fingerprint, evidence.fingerprint);
  assert.deepEqual(Object.keys(captured.payload.patch).sort(), ['media_assets', 'provenance', 'recorded_at', 'source_metadata']);
  assert.equal(captured.payload.patch.media_assets[0].hash.kind, 'content');
  // 正文与文本包元数据不得被改写（身份逐字一致，来源证明继续有效）。
  assert.ok(!('content_text' in captured.payload.patch));
  assert.ok(!('media_metadata' in captured.payload.patch));
});
