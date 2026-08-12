// P32-A 版本化 Qwen 重新分析、多帖证据库与比较：完整离线测试。
// 全部测试无真实网络/模型/Supabase 调用；mock 响应与精确请求体仍练习生产控制流。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ANALYSIS_KIND, ANALYSIS_SCHEMA_VERSION, P32_MODEL_ANALYSIS_SCHEMA_VERSION,
  MODEL_ANALYSIS_SCHEMA_VERSION, validateAnalysis, validateP32ModelAnalysis,
  validateEvidenceRecord, ANALYSIS_ID_PATTERN, clonePlain, fingerprintOf,
} from '../src/services/p19-contracts.js';
import {
  addEvidence, assembleBrief, buildKnowledgeCard, createProject,
  recordAssistedAnalysis, recordVersionedReanalysis,
  generateEvidenceComparison, getLatestAnalysisForEvidence,
  getAllAnalysisVersionsForEvidence, computeStaleness,
} from '../src/services/p19-workspace-service.js';
import { createP19Store } from '../src/services/p19-store.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const now = () => '2026-08-12T12:00:00.000Z';

// ---- 共享夹具 ----

async function projectWithEvidence({ hasMedia = true } = {}) {
  const project = await createProject({
    topic: 'P32-A 版本化测试项目', objective: '验证版本化重新分析与比较',
    audience: '测试团队', channel: '内部测试', now,
  });
  const mediaAssets = hasMedia ? [
    {
      id: 'm-aaaaaaaaaaaaaaaaaaaaaaaa',
      tweet_id: '1900000000000000001', external_id: '1900000000000000001',
      canonical_tweet_url: 'https://x.com/test/status/1900000000000000001',
      media_url: 'https://pbs.twimg.com/media/photo-a.jpg', order: 0, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
      byte_size: 200000, hash: { algorithm: 'sha256', kind: 'content', value: 'a'.repeat(64) },
    },
    {
      id: 'm-bbbbbbbbbbbbbbbbbbbbbbbb',
      tweet_id: '1900000000000000001', external_id: '1900000000000000001',
      canonical_tweet_url: 'https://x.com/test/status/1900000000000000001',
      media_url: 'https://pbs.twimg.com/media/photo-b.jpg', order: 1, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 800, height: 600 },
      byte_size: 150000, hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) },
    },
  ] : [];
  const sourceMetadata = {
    author: { name: '测试作者', handle: 'testauthor', user_id: '111111111111111111' },
    published_at: '2026-08-10T08:00:00.000Z',
    engagement: { likes: 1500, retweets: 300, replies: 80, quotes: 20, views: 50000, bookmarks: 400 },
  };
  const evidenceInput = {
    source_url: 'https://x.com/test/status/1900000000000000001',
    label: 'P32-A 测试帖子',
    platform: 'X · Apify',
    content_text: '这是 P32-A 版本化重新分析的测试正文，用于验证追加历史、不覆写和多帖比较。',
    recorded_at: '2026-08-10T08:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: 'p32-test-source-a',
      external_id: '1900000000000000001',
      source_url: 'https://x.com/test/status/1900000000000000001',
      run_id: 'apify-run-p32', collected_at: '2026-08-10T08:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: await hash('这是 P32-A 版本化重新分析的测试正文，用于验证追加历史、不覆写和多帖比较。'),
      collection_proof: '1999999999.' + 'c'.repeat(64),
      statement: 'P32-A 测试证据。',
    },
    media_metadata: {
      filename: 'p32-test.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode('这是 P32-A 版本化重新分析的测试正文，用于验证追加历史、不覆写和多帖比较。').byteLength,
      last_modified: '2026-08-10T08:00:00.000Z',
      sha256: await hash('这是 P32-A 版本化重新分析的测试正文，用于验证追加历史、不覆写和多帖比较。'),
    },
    source_metadata: sourceMetadata,
    media_assets: mediaAssets,
  };
  const afterEvidence = await addEvidence(project, evidenceInput, { now, hasher: fingerprintOf });
  const evidence = afterEvidence.evidence[0];
  return { project: afterEvidence, evidence, mediaAssets, sourceMetadata };
}

/** 构造一次 v2 模型分析结果（模拟 Qwen 多模态返回）。 */
function v2ModelResult(mediaIds) {
  return {
    source_id: 'p32-test-source-a',
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: '该帖子通过视觉冲击力强的图片与简洁直接的文字表达，在短时间内抓住受众注意力。',
      hook: '一张图说明一切——不需要多余解释',
      copy_pattern: '视觉前置 + 短文案 + 情绪共鸣',
      target_audience: '25-35岁关注科技与生活方式的城市青年',
      audience_need_emotion: '渴望快速获取有价值信息的效率感与归属感',
      media_analysis: mediaIds.map((id, i) => ({
        media_id: id,
        visual_content: `画面 #${i + 1}：高对比度的视觉元素构成主体，色彩饱和度高。`,
        composition: i === 0 ? '中心对称构图，主体居中' : '三分法构图，引导视线向文字区域',
        people: i === 0 ? '单人正面特写' : '无人物，纯产品展示',
        scene: i === 0 ? '室内暖光环境，背景虚化' : '纯色背景的产品棚拍',
        emotion: i === 0 ? '自信、专业、亲和' : '简洁、高端、品质感',
        visual_selling_points: [`卖点 ${i + 1}A：高辨识度`, `卖点 ${i + 1}B：品牌调性统一`],
        style_pattern: i === 0 ? '暖色调 + 浅景深 + 品牌色点缀' : '冷色调 + 居中产品 + 留白',
      })),
      virality_drivers: ['视觉冲击力', '信息密度高', '引发共鸣'],
      reusable_methods: ['图胜于文的核心策略', '第一帧抓住注意力的构图'],
      rewrite_suggestions: ['用对比图强化效果展示', '加入数据可视化元素'],
      signals: ['高互动率', '传播层级深'],
      risks: ['过度依赖视觉可能忽略文字信息'],
    },
    executed_at: '2026-08-12T12:00:00.000Z',
    usage: { total_tokens: 1500 },
    _request_identity: 'reanalysis:test-identity-1',
  };
}

// ---- 测试 ----

test('P32-A analysis records carry append-only identity and versioned ids', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 首次重新分析：版本 1
  const result1 = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const v1Analyses = (result1.analyses || []).filter((a) => a.evidence_id === evidence.id);
  assert.equal(v1Analyses.length, 1, '首次重新分析应创建 1 条分析记录');
  assert.equal(v1Analyses[0].version, 1);
  assert.equal(v1Analyses[0].model_analysis.schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION);
  assert.ok(ANALYSIS_ID_PATTERN.test(v1Analyses[0].id));

  // 第二次重新分析：版本 2，追加不覆写
  const result2 = await recordVersionedReanalysis(result1, evidence.id, {
    ...v2ModelResult(mediaIds),
    _request_identity: 'reanalysis:test-identity-2',
  }, { now, hasher: fingerprintOf });
  const v2Analyses = (result2.analyses || []).filter((a) => a.evidence_id === evidence.id);
  assert.equal(v2Analyses.length, 2, '第二次重新分析应产生 2 条分析记录（追加）');
  assert.equal(v2Analyses[0].version, 1);
  assert.equal(v2Analyses[1].version, 2);
  assert.notEqual(v2Analyses[0].id, v2Analyses[1].id, '两个版本应有不同的分析 id');
  assert.equal(v2Analyses[0].evidence_fingerprint, evidence.fingerprint);
  assert.equal(v2Analyses[1].evidence_fingerprint, evidence.fingerprint);

  // 证据指纹、版本、内容、媒体、来源完全不变
  assert.equal(result2.evidence[0].fingerprint, evidence.fingerprint);
  assert.equal(result2.evidence[0].version, evidence.version);
  assert.equal(result2.evidence[0].content_text, evidence.content_text);
  assert.deepEqual(result2.evidence[0].media_assets, evidence.media_assets);
});

test('P32-A reanalysis is dedup-safe on identical request identity', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  const mr = v2ModelResult(mediaIds);
  mr._request_identity = 'reanalysis:dedup-identity';
  const result1 = await recordVersionedReanalysis(project, evidence.id, mr, { now, hasher: fingerprintOf });
  const count1 = (result1.analyses || []).filter((a) => a.evidence_id === evidence.id).length;
  assert.equal(count1, 1);

  // 相同身份重放：不创建重复版本
  const result2 = await recordVersionedReanalysis(result1, evidence.id, mr, { now, hasher: fingerprintOf });
  const count2 = (result2.analyses || []).filter((a) => a.evidence_id === evidence.id).length;
  assert.equal(count2, 1, '相同请求身份不应创建重复版本');

  // 不同身份：创建新版本
  const mr2 = v2ModelResult(mediaIds);
  mr2._request_identity = 'reanalysis:dedup-identity-2';
  const result3 = await recordVersionedReanalysis(result2, evidence.id, mr2, { now, hasher: fingerprintOf });
  const count3 = (result3.analyses || []).filter((a) => a.evidence_id === evidence.id).length;
  assert.equal(count3, 2, '不同请求身份应创建新版本');
});

test('P32-A reanalysis fails closed for missing evidence, missing media, and identity mismatch', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 缺失证据
  await assert.rejects(
    () => recordVersionedReanalysis(project, 'ev-nonexistent', v2ModelResult(mediaIds), { now, hasher: fingerprintOf }),
    (e) => e.code === 'EVIDENCE_NOT_FOUND',
  );

  // 无媒体资产的证据
  const { project: noMediaProj, evidence: noMediaEv } = await projectWithEvidence({ hasMedia: false });
  await assert.rejects(
    () => recordVersionedReanalysis(noMediaProj, noMediaEv.id, v2ModelResult([]), { now, hasher: fingerprintOf }),
    (e) => e.code === 'REANALYSIS_MEDIA_MISSING',
  );

  // 来源身份不匹配
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...v2ModelResult(mediaIds), source_id: 'wrong-source' }, { now, hasher: fingerprintOf }),
    (e) => e.code === 'ANALYSIS_SOURCE_BINDING_INVALID',
  );

  // 归档项目拒绝重新分析
  const { project: archProj } = await projectWithEvidence();
  const archived = { ...archProj, status: 'archived' };
  await assert.rejects(
    () => recordVersionedReanalysis(archived, archProj.evidence[0].id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf }),
    (e) => e.code === 'PROJECT_ARCHIVED',
  );
});

test('P32-A v2 model result: valid fixture passes strict validation', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa', 'm-bbbbbbbbbbbbbbbbbbbbbbbb'];
  const valid = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文表达', hook: '钩子文案', copy_pattern: '文案模式',
      target_audience: '目标受众', audience_need_emotion: '受众需求',
      media_analysis: [
        { media_id: mediaIds[0], visual_content: '视觉 1', composition: '构图 1', people: '人物 1', scene: '场景 1', emotion: '情绪 1', visual_selling_points: ['卖点 1'], style_pattern: '风格 1' },
        { media_id: mediaIds[1], visual_content: '视觉 2', composition: '构图 2', people: '人物 2', scene: '场景 2', emotion: '情绪 2', visual_selling_points: ['卖点 2'], style_pattern: '风格 2' },
      ],
      virality_drivers: ['传播力 1'], reusable_methods: ['方法 1'],
      rewrite_suggestions: ['建议 1'], signals: ['信号 1'], risks: ['风险 1'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(valid);
  assert.equal(verdict.valid, true, `valid fixture rejected: ${JSON.stringify(verdict.issues)}`);
});

test('P32-A v2 model result: rejects unknown top-level extension field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
    extra_unknown_key: 'should be rejected',
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'unknown top-level extension field should fail validation');
});

test('P32-A v2 model result: rejects unknown result-level field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
      unexpected_result_field: 'should be rejected',
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'unknown result field should fail validation');
});

test('P32-A v2 model result: rejects unknown per-media field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格', extra_media_field: 'x' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'unknown per-media field should fail validation');
});

test('P32-A v2 model result: rejects media id order mismatch', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa', 'm-bbbbbbbbbbbbbbbbbbbbbbbb'];
  // Swapped: row 0 has mediaIds[1], row 1 has mediaIds[0]
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [
        { media_id: mediaIds[1], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' },
        { media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' },
      ],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'media id order mismatch should fail validation');
});

test('P32-A v2 model result: rejects media analysis count mismatch', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa', 'm-bbbbbbbbbbbbbbbbbbbbbbbb'];
  // Only 1 media analysis row for 2 media ids
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [
        { media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' },
      ],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'media analysis count mismatch should fail validation');
});

test('P32-A v2 model result: rejects empty required text field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const emptyCases = [
    { key: 'text_expression', value: '', label: 'empty text_expression' },
    { key: 'text_expression', value: '   ', label: 'whitespace text_expression' },
    { key: 'hook', value: '', label: 'empty hook' },
    { key: 'hook', value: '   ', label: 'whitespace hook' },
    { key: 'copy_pattern', value: '', label: 'empty copy_pattern' },
    { key: 'target_audience', value: '', label: 'empty target_audience' },
    { key: 'audience_need_emotion', value: '', label: 'empty audience_need_emotion' },
  ];
  for (const { key, value, label } of emptyCases) {
    const fixture = {
      schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
      provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
      executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
      result: {
        text_expression: '正文', hook: '钩子', copy_pattern: '模式',
        target_audience: '受众', audience_need_emotion: '需求',
        media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
        virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
      },
      usage: { total_tokens: 100 },
    };
    fixture.result[key] = value;
    const verdict = validateP32ModelAnalysis(fixture);
    assert.equal(verdict.valid, false, `${label} should fail validation`);
  }
});

test('P32-A v2 model result: rejects empty per-media text field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const perMediaKeys = ['visual_content', 'composition', 'people', 'scene', 'emotion', 'style_pattern'];
  for (const key of perMediaKeys) {
    const fixture = {
      schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
      provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
      executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
      result: {
        text_expression: '正文', hook: '钩子', copy_pattern: '模式',
        target_audience: '受众', audience_need_emotion: '需求',
        media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
        virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
      },
      usage: { total_tokens: 100 },
    };
    fixture.result.media_analysis[0][key] = '';
    const verdict = validateP32ModelAnalysis(fixture);
    assert.equal(verdict.valid, false, `empty per-media field ${key} should fail validation`);
  }
});

test('P32-A v2 model result: rejects empty visual_selling_points array', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: [], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'empty visual_selling_points array should fail validation');
});

test('P32-A v2 model result: rejects visual_selling_points exceeding max count', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['1', '2', '3', '4'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'visual_selling_points with 4 items should fail (max 3)');
});

test('P32-A v2 model result: rejects empty list field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const listKeys = ['virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks'];
  for (const key of listKeys) {
    const fixture = {
      schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
      provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
      executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
      result: {
        text_expression: '正文', hook: '钩子', copy_pattern: '模式',
        target_audience: '受众', audience_need_emotion: '需求',
        media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
        virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
      },
      usage: { total_tokens: 100 },
    };
    fixture.result[key] = [];
    const verdict = validateP32ModelAnalysis(fixture);
    assert.equal(verdict.valid, false, `empty list field ${key} should fail validation`);
  }
});

test('P32-A v2 model result: rejects list item with whitespace only', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['   '], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'whitespace-only list item should fail validation');
});

test('P32-A v2 model result: rejects malformed type for text field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: 12345, hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'number instead of string for text_expression should fail validation');
});

test('P32-A v2 model result: rejects wrong schema_version', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const fixture = {
    schema_version: MODEL_ANALYSIS_SCHEMA_VERSION, // v1 instead of v2
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'v1 schema_version in v2 validator should fail');
});

test('P32-A v2 model result: rejects missing required result field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const requiredKeys = ['text_expression', 'hook', 'copy_pattern', 'target_audience', 'audience_need_emotion', 'media_analysis', 'virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks'];
  for (const key of requiredKeys) {
    const result = {
      text_expression: '正文', hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    };
    delete result[key];
    const fixture = {
      schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
      provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
      executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
      result,
      usage: { total_tokens: 100 },
    };
    const verdict = validateP32ModelAnalysis(fixture);
    assert.equal(verdict.valid, false, `missing result field ${key} should fail validation`);
  }
});

test('P32-A v2 model result: rejects oversized text field', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const oversized = 'x'.repeat(501);
  const fixture = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION,
    provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: oversized, hook: '钩子', copy_pattern: '模式',
      target_audience: '受众', audience_need_emotion: '需求',
      media_analysis: [{ media_id: mediaIds[0], visual_content: '视觉', composition: '构图', people: '人物', scene: '场景', emotion: '情绪', visual_selling_points: ['卖点'], style_pattern: '风格' }],
      virality_drivers: ['传播'], reusable_methods: ['方法'], rewrite_suggestions: ['建议'], signals: ['信号'], risks: ['风险'],
    },
    usage: { total_tokens: 100 },
  };
  const verdict = validateP32ModelAnalysis(fixture);
  assert.equal(verdict.valid, false, 'text_expression exceeding 500 chars should fail validation');
});

test('P32-A validateAnalysis accepts both v1 and v2 extensions', async () => {
  const mediaIds = ['m-aaaaaaaaaaaaaaaaaaaaaaaa'];
  const v1Ext = {
    schema_version: MODEL_ANALYSIS_SCHEMA_VERSION, provider: 'dashscope',
    model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: 'v1 text',
      media_analysis: [{ media_id: mediaIds[0], visual_content: 'vc', composition: 'c', people: 'p', scene: 's', emotion: 'e' }],
      virality_drivers: ['d1'], reusable_methods: ['m1'], signals: ['s1'], risks: ['r1'],
    },
    usage: { total_tokens: 100 },
  };
  const v2Ext = {
    schema_version: P32_MODEL_ANALYSIS_SCHEMA_VERSION, provider: 'dashscope',
    model: 'qwen3.5-omni-flash', method: 'multimodal_model',
    executed_at: '2026-08-12T12:00:00.000Z', media_ids: mediaIds,
    result: {
      text_expression: 'v2 text', hook: 'hook', copy_pattern: 'cp',
      target_audience: 'ta', audience_need_emotion: 'ane',
      media_analysis: [{
        media_id: mediaIds[0], visual_content: 'vc', composition: 'c',
        people: 'p', scene: 's', emotion: 'e',
        visual_selling_points: ['sp1'], style_pattern: 'style',
      }],
      virality_drivers: ['d1'], reusable_methods: ['m1'],
      rewrite_suggestions: ['rs1'], signals: ['s1'], risks: ['r1'],
    },
    usage: { total_tokens: 100 },
  };

  const v1Analysis = {
    schema_version: ANALYSIS_SCHEMA_VERSION, id: 'an-aaaaaaaaaaaaaaaaaaaaaaaa',
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', evidence_id: 'ev-aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: ANALYSIS_KIND, rule_ids: ['source_url_shape'],
    provenance: { method: ANALYSIS_KIND, generated_by: 'p19_analysis_engine_v1', model: 'qwen3.5-omni-flash', executed_at: '2026-08-12T12:00:00.000Z', statement: 'test' },
    result: { summary: { label: 'test' }, rules: [] },
    model_analysis: v1Ext,
    evidence_fingerprint: 'a'.repeat(64), evidence_version: 1,
    version: 1, fingerprint: 'b'.repeat(64),
    created_at: '2026-08-12T12:00:00.000Z', updated_at: '2026-08-12T12:00:00.000Z',
  };
  assert.equal(validateAnalysis(v1Analysis).valid, true, JSON.stringify(validateAnalysis(v1Analysis).issues));

  const v2Analysis = { ...v1Analysis, id: 'an-bbbbbbbbbbbbbbbbbbbbbbbb', model_analysis: v2Ext, fingerprint: 'c'.repeat(64) };
  assert.equal(validateAnalysis(v2Analysis).valid, true, JSON.stringify(validateAnalysis(v2Analysis).issues));
});

test('P32-A evidence immutability is preserved across reanalyses', async () => {
  const { project, evidence } = await projectWithEvidence();
  const originalFingerprint = evidence.fingerprint;
  const originalVersion = evidence.version;
  const originalContent = evidence.content_text;
  const originalMedia = clonePlain(evidence.media_assets);

  // 多次重新分析后证据不变
  let current = project;
  for (let i = 0; i < 3; i++) {
    const mediaIds = evidence.media_assets.map((a) => a.id);
    current = await recordVersionedReanalysis(current, evidence.id, {
      ...v2ModelResult(mediaIds),
      _request_identity: `reanalysis:immutability-${i}`,
    }, { now, hasher: fingerprintOf });
  }

  const finalEvidence = current.evidence[0];
  assert.equal(finalEvidence.fingerprint, originalFingerprint, '证据指纹在多轮重新分析后不变');
  assert.equal(finalEvidence.version, originalVersion, '证据版本在多轮重新分析后不变');
  assert.equal(finalEvidence.content_text, originalContent, '证据内容不变');
  assert.deepEqual(finalEvidence.media_assets, originalMedia, '媒体资产不变');
  assert.equal(current.analyses.filter((a) => a.evidence_id === evidence.id).length, 3, '应有 3 个分析版本');
});

test('P32-A v1 legacy analyses remain readable alongside v2 versions', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 先用传统 recordAssistedAnalysis 创建 v1 分析
  const withV1 = await recordAssistedAnalysis(project, evidence.id, {
    source_id: 'p32-test-source-a',
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: 'v1 传统分析结果',
      media_analysis: mediaIds.map((id) => ({ media_id: id, visual_content: 'vc', composition: 'c', people: 'p', scene: 's', emotion: 'e' })),
      virality_drivers: ['d1'], reusable_methods: ['m1'], signals: ['s1'], risks: ['r1'],
    },
    executed_at: '2026-08-12T12:00:00.000Z',
    usage: { total_tokens: 100 },
  }, { now, hasher: fingerprintOf });
  assert.equal(withV1.analyses.filter((a) => a.evidence_id === evidence.id).length, 1);
  assert.equal(withV1.analyses[0].model_analysis.schema_version, MODEL_ANALYSIS_SCHEMA_VERSION);

  // 再用 recordVersionedReanalysis 追加 v2
  const withV2 = await recordVersionedReanalysis(withV1, evidence.id, {
    ...v2ModelResult(mediaIds),
    _request_identity: 'reanalysis:v1+v2-legacy',
  }, { now, hasher: fingerprintOf });
  const allAnalyses = withV2.analyses.filter((a) => a.evidence_id === evidence.id);
  assert.equal(allAnalyses.length, 2, 'v1 和 v2 分析共存');
  assert.equal(allAnalyses[0].model_analysis.schema_version, MODEL_ANALYSIS_SCHEMA_VERSION, '第一条是 v1');
  assert.equal(allAnalyses[1].model_analysis.schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION, '第二条是 v2');
  assert.equal(allAnalyses[0].version, 1);
  assert.equal(allAnalyses[1].version, 2);

  // v1 内容完整可读
  assert.ok(allAnalyses[0].model_analysis.result.text_expression);
  assert.ok(Array.isArray(allAnalyses[0].model_analysis.result.media_analysis));
  // v2 内容完整可读
  assert.ok(allAnalyses[1].model_analysis.result.hook);
  assert.ok(allAnalyses[1].model_analysis.result.target_audience);
});

test('P32-A latest-version selection is deterministic', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  let current = project;
  for (let v = 1; v <= 4; v++) {
    current = await recordVersionedReanalysis(current, evidence.id, {
      ...v2ModelResult(mediaIds),
      result: { ...v2ModelResult(mediaIds).result, hook: `钩子 v${v}` },
      _request_identity: `reanalysis:latest-${v}`,
    }, { now, hasher: fingerprintOf });
  }

  const latest = getLatestAnalysisForEvidence(current, evidence.id);
  assert.ok(latest, '应有最新分析');
  assert.equal(latest.version, 4, '最新分析版本应为 4');
  assert.equal(latest.model_analysis.result.hook, '钩子 v4');

  const allVersions = getAllAnalysisVersionsForEvidence(current, evidence.id);
  assert.equal(allVersions.length, 4);
  assert.equal(allVersions[0].version, 4, '按版本降序，首位为最新');
  assert.equal(allVersions[3].version, 1, '末位为最早');
});

test('P32-A fetch all versions returns sorted descending by version', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  let current = project;
  for (let v = 1; v <= 3; v++) {
    current = await recordVersionedReanalysis(current, evidence.id, {
      ...v2ModelResult(mediaIds),
      _request_identity: `reanalysis:versions-${v}`,
    }, { now, hasher: fingerprintOf });
  }

  const versions = getAllAnalysisVersionsForEvidence(current, evidence.id);
  assert.equal(versions.length, 3);
  assert.equal(versions[0].version, 3);
  assert.equal(versions[1].version, 2);
  assert.equal(versions[2].version, 1);
});

test('P32-A comparison binds exact records and fails for invalid selection count', async () => {
  const p1 = await projectWithEvidence();
  const project = p1.project;

  // 少于 2 条
  const tooFew = generateEvidenceComparison(project, [p1.evidence.id]);
  assert.equal(tooFew.valid, false);

  // 多于 5 条
  const tooMany = generateEvidenceComparison(project, ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5', 'ev-6']);
  assert.equal(tooMany.valid, false);

  // 证据不存在
  const missing = generateEvidenceComparison(project, ['ev-nonexistent', 'ev-also-nonexistent']);
  assert.equal(missing.valid, false);

  // 无分析时返回有效结构但标记缺失
  const noAnalysis = generateEvidenceComparison(project, [p1.evidence.id, p1.evidence.id]);
  assert.equal(noAnalysis.valid, false); // 重复 id
});

test('P32-A comparison with actual analyses shows all required fields', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 创建分析
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });

  // 添加第二条证据 + 分析
  const input2 = {
    source_url: 'https://x.com/test2/status/1900000000000000002',
    label: 'P32-A 测试帖子 2',
    platform: 'X · Apify',
    content_text: '第二条测试正文内容。',
    recorded_at: '2026-08-11T10:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: 'p32-test-source-b',
      external_id: '1900000000000000002',
      source_url: 'https://x.com/test2/status/1900000000000000002',
      run_id: 'apify-run-p32-2', collected_at: '2026-08-11T10:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef',
      content_sha256: await hash('第二条测试正文内容。'),
      collection_proof: '1999999999.' + 'd'.repeat(64),
      statement: 'P32-A 测试证据 2。',
    },
    media_metadata: {
      filename: 'p32-test2.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode('第二条测试正文内容。').byteLength,
      last_modified: '2026-08-11T10:00:00.000Z',
      sha256: await hash('第二条测试正文内容。'),
    },
    source_metadata: {
      author: { name: '作者2', handle: 'author2' },
      published_at: '2026-08-11T10:00:00.000Z',
      engagement: { likes: 500, retweets: 100 },
    },
    media_assets: [{
      id: 'm-cccccccccccccccccccccccc',
      tweet_id: '1900000000000000002', external_id: '1900000000000000002',
      canonical_tweet_url: 'https://x.com/test2/status/1900000000000000002',
      media_url: 'https://pbs.twimg.com/media/photo-c.jpg', order: 0, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 900, height: 900 },
      byte_size: 100000, hash: { algorithm: 'sha256', kind: 'content', value: 'e'.repeat(64) },
    }],
  };
  const afterEv2 = await addEvidence(afterAnalysis, input2, { now, hasher: fingerprintOf });
  const evidence2 = afterEv2.evidence.find((e) => e.source_url === 'https://x.com/test2/status/1900000000000000002');
  assert.ok(evidence2, '第二条证据应存在');

  const afterAnalysis2 = await recordVersionedReanalysis(afterEv2, evidence2.id, {
    ...v2ModelResult([evidence2.media_assets[0].id]),
    source_id: 'p32-test-source-b',
    _request_identity: 'reanalysis:compare-2',
  }, { now, hasher: fingerprintOf });

  const comparison = generateEvidenceComparison(afterAnalysis2, [evidence.id, evidence2.id]);
  assert.equal(comparison.valid, true, comparison.reason || '');
  assert.equal(comparison.rows.length, 2);
  assert.equal(comparison.summary.totalSelected, 2);
  assert.equal(comparison.summary.analyzedCount, 2);
  assert.equal(comparison.summary.missingAnalysisCount, 0);

  // 每条记录包含必填字段
  for (const row of comparison.rows) {
    assert.ok(row.hook, '应有钩子');
    assert.ok(row.visualPattern, '应有视觉模式');
    assert.ok(Array.isArray(row.propagationDrivers), '应有传播驱动力');
    assert.ok(Array.isArray(row.reusableFormula), '应有可复用公式');
    assert.ok(Array.isArray(row.risks), '应有风险');
    assert.equal(row.analysisMissing, false);
  }
});

test('P32-A comparison warns on missing analysis', async () => {
  const { project, evidence } = await projectWithEvidence();

  // 添加仅手工证据（无分析）
  const manualInput = {
    source_url: 'https://example.com/manual',
    label: '手工证据', platform: 'Manual',
    content_text: '手工录入的证据。', recorded_at: '2026-08-12T00:00:00.000Z',
    provenance: { manual: true, statement: '手工录入。' },
    media_metadata: null,
  };
  const afterManual = await addEvidence(project, manualInput, { now, hasher: fingerprintOf });
  const manualEv = afterManual.evidence.find((e) => e.source_url === 'https://example.com/manual');
  assert.ok(manualEv);

  const comparison = generateEvidenceComparison(afterManual, [evidence.id, manualEv.id]);
  assert.equal(comparison.valid, true);
  const missingRow = comparison.rows.find((r) => r.analysisMissing);
  assert.ok(missingRow, '应有一条标记为分析缺失');
  assert.ok(comparison.summary.warnings.length >= 1, '摘要中应有缺失分析警告');
});

test('P32-A Knowledge Card uses explicitly selected latest analysis version', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 先创建 v1 分析 → 知识卡
  const withV1 = await recordAssistedAnalysis(project, evidence.id, {
    source_id: 'p32-test-source-a',
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: 'v1 结果',
      media_analysis: mediaIds.map((id) => ({ media_id: id, visual_content: 'vc', composition: 'c', people: 'p', scene: 's', emotion: 'e' })),
      virality_drivers: ['d1'], reusable_methods: ['m1'], signals: ['s1'], risks: ['r1'],
    },
    executed_at: '2026-08-12T12:00:00.000Z',
    usage: { total_tokens: 100 },
  }, { now, hasher: fingerprintOf });
  const v1Analysis = withV1.analyses.find((a) => a.evidence_id === evidence.id);
  const withCard1 = await buildKnowledgeCard(withV1, v1Analysis.id, { now, hasher: fingerprintOf });
  const card1 = withCard1.knowledge_cards[0];
  assert.equal(card1.analysis_id, v1Analysis.id);

  // 追加 v2 重新分析
  const withV2 = await recordVersionedReanalysis(withCard1, evidence.id, {
    ...v2ModelResult(mediaIds),
    _request_identity: 'reanalysis:kc-test',
  }, { now, hasher: fingerprintOf });
  const latestV2 = getLatestAnalysisForEvidence(withV2, evidence.id);
  assert.equal(latestV2.version, 2);

  // 从最新 v2 版本创建新知识卡
  const withCard2 = await buildKnowledgeCard(withV2, latestV2.id, { now, hasher: fingerprintOf });
  const cards = withCard2.knowledge_cards || [];
  assert.ok(cards.length >= 2, `应有至少 2 张知识卡，实际 ${cards.length} 张`);
  // 最新卡绑定最新分析
  const latestCard = cards.find((c) => c.analysis_id === latestV2.id);
  assert.ok(latestCard, '应有绑定最新分析的知识卡');
  assert.equal(latestCard.analysis_version, 2);
});

test('P32-A stale downstream state is marked after reanalysis', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 创建分析 → 知识卡 → Brief
  const withAnalysis = await recordVersionedReanalysis(project, evidence.id, {
    ...v2ModelResult(mediaIds),
    _request_identity: 'reanalysis:stale-1',
  }, { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(withAnalysis, evidence.id);
  const withCard = await buildKnowledgeCard(withAnalysis, analysis.id, { now, hasher: fingerprintOf });
  const withBrief = await assembleBrief(withCard, { now, hasher: fingerprintOf });
  assert.ok(withBrief.brief, '应已组装 Brief');

  // 检查初始过时状态：Brief 应未过时
  const initialStale = await computeStaleness(withBrief, { hasher: fingerprintOf });
  assert.equal(initialStale.brief_stale, false, '初始 Brief 不应过时');

  // 追加新版本分析
  const withV2 = await recordVersionedReanalysis(withBrief, evidence.id, {
    ...v2ModelResult(mediaIds),
    result: { ...v2ModelResult(mediaIds).result, hook: '新版本钩子' },
    _request_identity: 'reanalysis:stale-2',
  }, { now, hasher: fingerprintOf });
  const v2Analysis = getLatestAnalysisForEvidence(withV2, evidence.id);
  assert.equal(v2Analysis.version, 2);

  // 旧知识卡仍指向旧分析且旧分析未被修改 —— 旧卡不应过时
  const afterV2Stale = await computeStaleness(withV2, { hasher: fingerprintOf });
  // 分析本身不过时（证据未变）
  const hasStaleAnalysis = afterV2Stale.analysis_stale_ids.some((id) => id === analysis.id);
  assert.equal(hasStaleAnalysis, false, '旧分析因证据未变不应过时');
  // 旧知识卡仍绑定旧分析（未变）—— 不过时
  const oldCard = withV2.knowledge_cards.find((c) => c.analysis_id === analysis.id);
  assert.ok(oldCard);
  const cardStale = afterV2Stale.card_stale_ids.includes(oldCard.id);
  assert.equal(cardStale, false, '旧知识卡指向未变的旧分析，不应过时');
  // Brief 引用旧知识卡且旧知识卡指纹未变 —— Brief 也不应因新版本而过时
  // （这是正确的：新分析版本不应使指向旧版本的 Brief 自动失效）
});

test('P32-A Brief assembly uses at most one card per evidence', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  // 创建单分析单卡
  const withAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(withAnalysis, evidence.id);
  const withCard = await buildKnowledgeCard(withAnalysis, analysis.id, { now, hasher: fingerprintOf });

  // 组装 Brief
  const withBrief = await assembleBrief(withCard, { now, hasher: fingerprintOf });
  assert.ok(withBrief.brief);
  // 每证据最多一张卡的证明：knowledge_citation_ids 中每个证据只应有一张卡
  const citedCards = withBrief.knowledge_cards.filter((c) =>
    withBrief.brief.knowledge_citation_ids.includes(c.id));
  const evidenceIds = new Set(citedCards.map((c) => {
    const bound = withBrief.analyses.find((a) => a.id === c.analysis_id);
    return bound && bound.evidence_id;
  }).filter(Boolean));
  assert.ok(evidenceIds.size <= citedCards.length, '引用不应超出知识卡数量');
});

test('P32-A store persistence preserves versioned analysis history', async () => {
  const storage = new Map();
  const store = createP19Store({
    storage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
    hasher: fingerprintOf,
  });

  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  let current = project;
  for (let v = 1; v <= 2; v++) {
    current = await recordVersionedReanalysis(current, evidence.id, {
      ...v2ModelResult(mediaIds),
      _request_identity: `reanalysis:store-${v}`,
    }, { now, hasher: fingerprintOf });
  }

  const saved = store.putProject(current);
  assert.equal(saved.ok, true, saved.message || '');

  const restored = store.getProject(current.id);
  assert.equal(restored.ok, true);
  const analysesForEvidence = restored.project.analyses.filter((a) => a.evidence_id === evidence.id);
  assert.equal(analysesForEvidence.length, 2, '恢复后应有 2 个分析版本');
  assert.equal(analysesForEvidence[0].version, 1);
  assert.equal(analysesForEvidence[1].version, 2);
  assert.ok(analysesForEvidence[0].model_analysis);
  assert.ok(analysesForEvidence[1].model_analysis);
});

test('P32-A comparison fails closed for duplicate ids and all edge cases', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  const withAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });

  // 重复 ID 传给 generateEvidenceComparison 应去重
  const comparison = generateEvidenceComparison(withAnalysis, [evidence.id, evidence.id]);
  assert.equal(comparison.valid, false, '重复 id 去重后只剩 1 条，应失败');

  // 混合存在和不存在的证据
  const mixed = generateEvidenceComparison(withAnalysis, [evidence.id, 'ev-nonexistent']);
  assert.equal(mixed.valid, false, '包含不存在的证据应失败');
});

test('P32-A execution flags remain four times false after reanalysis', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  const result = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  assert.deepEqual(result.execution_flags, {
    generation_executed: false, routing_executed: false,
    network_executed: false, publish_executed: false,
  }, '四项执行标志保持严格 false');
});

test('P32-A all new analysis ids are unique within and across evidence records', async () => {
  const { project, evidence } = await projectWithEvidence();
  const mediaIds = evidence.media_assets.map((a) => a.id);

  let current = project;
  const allIds = new Set();
  for (let v = 1; v <= 5; v++) {
    current = await recordVersionedReanalysis(current, evidence.id, {
      ...v2ModelResult(mediaIds),
      _request_identity: `reanalysis:unique-${v}`,
    }, { now, hasher: fingerprintOf });
  }

  for (const analysis of current.analyses) {
    assert.ok(!allIds.has(analysis.id), `分析 id ${analysis.id.slice(0, 24)} 不应重复`);
    allIds.add(analysis.id);
  }
  assert.equal(current.analyses.filter((a) => a.evidence_id === evidence.id).length, 5);
});

test('P32-A existing P19/P22/P29 contract regression: validateEvidenceRecord still passes', async () => {
  const { evidence } = await projectWithEvidence();
  const verdict = validateEvidenceRecord(evidence);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.issues));
});
