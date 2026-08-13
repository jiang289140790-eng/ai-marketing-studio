// M2: staging 唯一数据源与真实多模态分析闭环 —— 完整离线对抗测试。
//
// 覆盖（全部无真实网络/模型/Supabase 调用；mock 响应仍练习生产控制流）：
// - 图片+视频证据 → 版本化 Qwen 分析 → 显式保存 → 知识卡完整继承：
//   evidence/analysis identity、模型、逐媒体内容 SHA-256、逐媒体发现、
//   声音可用信息（可用时）、来源 URL、版本；缺失/错绑失败关闭；
// - 多媒体顺序/重复/缺失/错绑对抗；旧版本保留与最新版本选择确定性；
// - 刷新恢复（本地 store 与在线命令边界两条权威重载路径）identity/fingerprint 一致；
// - 项目切换隔离；local/demo 绝不混入 staging 分析；
// - 保存冲突（PROJECT_REVISION_STALE）有界失败；错误消息脱敏
//   （不输出 Bearer/JWT/URL/哈希）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ANALYSIS_ID_PATTERN, P32_MODEL_ANALYSIS_SCHEMA_VERSION,
  P32_V2_MEDIA_ANALYSIS_KEYS, SHA256_PATTERN,
  clonePlain, fingerprintOf, validateAnalysis, validateKnowledgeCard,
} from '../src/services/p19-contracts.js';
import {
  addEvidence, buildKnowledgeCard, computeStaleness, createProject,
  getAllAnalysisVersionsForEvidence, getLatestAnalysisForEvidence,
  recordVersionedReanalysis, workbenchError,
} from '../src/services/p19-workspace-service.js';
import { createP19Store } from '../src/services/p19-store.js';
import { createP20OnlineStore } from '../src/services/p20-online-store.js';
import { createP19CommandClient } from '../src/services/p19-server-write-adapter.js';
import { createP22ResearchAssistClient, toP19EvidenceInput } from '../src/services/p22-research-assist.js';
import {
  buildMultimodalQwenContent, parseQwenMultimodalAnalyses,
} from '../supabase/functions/p22-research-assist/assist-core.mjs';

const hash = async (text) => createHash('sha256').update(String(text)).digest('hex');
const now = () => '2026-08-13T08:00:00.000Z';

const SOURCE_ID = 'm2-source-video-0001';
const EXTERNAL_ID = '2087047011753467912';
const SOURCE_URL = `https://x.com/example/status/${EXTERNAL_ID}`;

// ---- 共享夹具：一张图片 + 一条视频（均带已验证内容 SHA-256）----

async function mediaEvidenceInput() {
  const body = 'M2 视频证据正文：这是一条含图片与视频的真实 X 帖子，用于验证完整多模态分析闭环。';
  const contentSha256 = await hash(body);
  const mediaAssets = [
    {
      id: 'm-aaaaaaaaaaaaaaaaaaaaaaaa',
      tweet_id: EXTERNAL_ID, external_id: EXTERNAL_ID,
      canonical_tweet_url: SOURCE_URL,
      media_url: 'https://pbs.twimg.com/media/photo-m2-1.jpg', order: 0, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
      byte_size: 200000, hash: { algorithm: 'sha256', kind: 'content', value: 'a'.repeat(64) },
    },
    {
      id: 'm-bbbbbbbbbbbbbbbbbbbbbbbb',
      tweet_id: EXTERNAL_ID, external_id: EXTERNAL_ID,
      canonical_tweet_url: SOURCE_URL,
      media_url: 'https://video.twimg.com/ext_tw_video/m2/video.mp4', order: 1, kind: 'video',
      mime_type: 'video/mp4', dimensions: { width: 1280, height: 720 },
      byte_size: 5000000, hash: { algorithm: 'sha256', kind: 'content', value: 'b'.repeat(64) },
    },
  ];
  return {
    source_url: SOURCE_URL,
    label: 'M2 图片+视频证据',
    platform: 'X · Apify',
    content_text: body,
    content_sha256: contentSha256,
    recorded_at: '2026-08-13T07:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: SOURCE_ID, external_id: EXTERNAL_ID,
      source_url: SOURCE_URL, run_id: 'apify-run-m2', collected_at: '2026-08-13T07:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: contentSha256, collection_proof: `1999999999.${'c'.repeat(64)}`,
      statement: 'M2 测试证据：服务端来源证明绑定正文、身份与采集运行。',
    },
    media_metadata: {
      filename: 'm2-post.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(body).byteLength,
      last_modified: '2026-08-13T07:00:00.000Z', sha256: contentSha256,
    },
    source_metadata: {
      author: { name: 'M2 作者', handle: 'm2author', user_id: '999999999999999999' },
      published_at: '2026-08-13T06:00:00.000Z',
      engagement: { likes: 1200, retweets: 300, replies: 80, quotes: 20, views: 40000, bookmarks: 150 },
    },
    media_assets: mediaAssets,
  };
}

async function projectWithMediaEvidence() {
  const project = await createProject({
    topic: 'M2 视频分析闭环', objective: '验证 staging 唯一数据源与知识卡完整继承',
    audience: '运营团队', channel: 'X', now,
  });
  const after = await addEvidence(project, await mediaEvidenceInput(), { now, hasher: fingerprintOf });
  return { project: after, evidence: after.evidence[0] };
}

/** 构造一次 v2 模型分析结果：视频 composition 携带声音可用信息（M2 提示词契约）。 */
function v2ModelResult(mediaIds, { videoAudio = '存在可用音轨：人声解说介绍产品亮点，配乐为轻快电子乐。' } = {}) {
  return {
    source_id: SOURCE_ID,
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: '这条帖子用图片吸引注意、用视频完成产品演示，叙事完整。',
      hook: '三十秒看完产品亮点',
      copy_pattern: '图片钩子 + 视频演示 + 行动引导',
      target_audience: '关注科技产品的年轻用户',
      audience_need_emotion: '快速理解产品价值的好奇心',
      media_analysis: [
        {
          media_id: mediaIds[0],
          visual_content: '画面 1：产品特写居中，叙事为新品亮相前的静态展示。',
          composition: '构图 1：中心对称，主体居中。',
          people: '人物：无人物，纯产品展示。',
          scene: '场景：明亮棚拍环境。',
          emotion: '情绪：期待与专业。',
          visual_selling_points: ['高辨识度产品剪影', '干净背景'],
          style_pattern: '暖色调 + 居中构图',
        },
        {
          media_id: mediaIds[1],
          visual_content: '画面 2：演示者手持产品操作，叙事为逐步展示使用过程。',
          composition: `构图 2：三分法引导视线；${videoAudio}`,
          people: '人物：一名演示者。',
          scene: '场景：室内办公环境。',
          emotion: '情绪：自信与亲和。',
          visual_selling_points: ['操作过程可见', '真实使用环境'],
          style_pattern: '纪实风格 + 自然光',
        },
      ],
      virality_drivers: ['真实演示', '信息密度高'],
      reusable_methods: ['先用图片抓注意力', '再用视频完成说服'],
      rewrite_suggestions: ['加强结尾行动引导', '加入数据对比'],
      signals: ['高完播率', '产品提问集中'],
      risks: ['视频节奏偏慢', '口播语速可能过快'],
    },
    executed_at: '2026-08-13T08:01:00.000Z',
    usage: { total_tokens: 1500 },
    _request_identity: 'm2-reanalysis:video-1',
  };
}

function assertBoundedNoSecrets(value) {
  assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]+/i.test(value), `不得输出 Bearer 令牌：${value}`);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/.test(value), `不得输出 JWT：${value}`);
  // service_role/token/password 等键即使出现，其值必须是 [redacted] 占位
  for (const key of ['service[_-]?role', 'secret', 'token', 'password']) {
    const match = new RegExp(`(?:${key})\\s*[:=]\\s*([^\\s,;]+)`, 'i').exec(value);
    if (match) assert.equal(match[1], '[redacted]', `Secret 值必须被脱敏（${key}）：${value}`);
  }
}

// ---- 1. 完整闭环：图片+视频证据 → 版本化 Qwen 分析 → 知识卡完整继承 ----

test('M2 闭环：图片+视频证据经版本化分析保存后，知识卡完整继承身份/模型/媒体哈希/逐媒体发现/声音/来源 URL/版本', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);

  // 显式保存：版本化分析记录（不可变，追加不覆写）
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(afterAnalysis, evidence.id);
  assert.ok(analysis, '分析必须存在');
  assert.equal(analysis.evidence_id, evidence.id);
  assert.equal(analysis.evidence_fingerprint, evidence.fingerprint);
  assert.equal(analysis.evidence_version, evidence.version);
  assert.equal(analysis.model_analysis.schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION);
  assert.equal(analysis.model_analysis.model, 'qwen3.5-omni-flash');
  assert.equal(analysis.model_analysis.media_ids.length, 2);
  assert.deepEqual(analysis.model_analysis.media_ids, mediaIds);
  assert.equal(validateAnalysis(analysis).valid, true, validateAnalysis(analysis).issues.join('；'));
  // 精确 revision/fingerprint 可返回（页面保存后以权威快照为准）
  assert.match(analysis.id, ANALYSIS_ID_PATTERN);
  assert.match(analysis.fingerprint, SHA256_PATTERN);

  // 知识卡继承
  const withCard = await buildKnowledgeCard(afterAnalysis, analysis.id, { now, hasher: fingerprintOf });
  const card = withCard.knowledge_cards[0];
  const verdict = validateKnowledgeCard(card);
  assert.equal(verdict.valid, true, verdict.issues.join('；'));

  // 身份：分析 identity + 版本 + 指纹
  assert.equal(card.analysis_id, analysis.id);
  assert.equal(card.analysis_fingerprint, analysis.fingerprint);
  assert.equal(card.analysis_version, analysis.version);
  assert.equal(card.analysis_provenance.source_analysis_id, analysis.id);
  assert.equal(card.analysis_provenance.model, 'qwen3.5-omni-flash');
  assert.deepEqual(card.analysis_provenance.media_ids, mediaIds);

  // 媒体哈希逐条继承（内容 SHA-256，非 URL 哈希）
  for (const asset of evidence.media_assets) {
    const claim = card.evidence_links.find((link) => link.claim.includes(asset.id) && link.claim.includes('内容 SHA-256'));
    assert.ok(claim, `知识卡必须携带媒体 ${asset.id} 的内容哈希链接`);
    assert.ok(claim.claim.includes(asset.hash.value), `哈希值必须逐字继承（${asset.id}）`);
    assert.equal(claim.source_ref, evidence.id);
  }

  // 来源 URL 继承
  assert.ok(card.evidence_links.some((link) => link.claim.includes(SOURCE_URL)), '知识卡必须携带来源 URL 链接');

  // 逐媒体发现继承（画面/构图/人物/场景/情绪 + 叙事）
  const json = JSON.stringify(card);
  assert.match(json, /画面 1：产品特写居中，叙事为新品亮相前的静态展示/);
  assert.match(json, /画面 2：演示者手持产品操作，叙事为逐步展示使用过程/);

  // 声音可用信息（可用时）：视频媒体含音轨 + 模型声音描述
  assert.equal(card.source_observations.media.audio_track_present, true);
  const videoSegment = card.source_observations.media.timeline.find((segment) => segment.stage === 'media_2');
  assert.ok(videoSegment.audio_evidence.includes('模型声音描述'), `视频段必须继承模型声音描述：${videoSegment.audio_evidence}`);
  assert.ok(videoSegment.audio_evidence.includes('人声解说'), '声音描述必须包含模型输出内容');
  const imageSegment = card.source_observations.media.timeline.find((segment) => segment.stage === 'media_1');
  assert.match(imageSegment.audio_evidence, /无音轨：静态图片媒体/);
  assert.ok(card.creative_analysis.audio_role.includes('人声解说'), 'audio_role 必须继承模型声音描述');
  assert.ok(card.creative_analysis.narrative_arc.length > 0, '叙事弧必须非空');

  // 已验收禁止措辞不得进入卡内
  assert.doesNotMatch(json, /看起来像|应该是|大概有/);
});

test('M2 闭环：模型未提供声音描述时，卡片如实说明并记入不确定项（绝不虚构音轨内容）', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const result = v2ModelResult(mediaIds, { videoAudio: '构图 2：三分法引导视线。' });
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, result, { now, hasher: fingerprintOf });
  const withCard = await buildKnowledgeCard(afterAnalysis, getLatestAnalysisForEvidence(afterAnalysis, evidence.id).id, { now, hasher: fingerprintOf });
  const card = withCard.knowledge_cards[0];
  assert.equal(validateKnowledgeCard(card).valid, true);
  assert.equal(card.source_observations.media.audio_track_present, true);
  const videoSegment = card.source_observations.media.timeline.find((segment) => segment.stage === 'media_2');
  assert.match(videoSegment.audio_evidence, /该视频媒体含音轨，但模型未提供声音内容描述/);
  assert.match(card.creative_analysis.audio_role, /该视频媒体含音轨，但模型未提供声音内容描述/);
  assert.ok(card.source_observations.uncertainties.some((item) => item.includes('声音可用性仅依据媒体类型判定')));
});

// ---- 2. 提示词契约与解析：叙事/声音可用信息进入既有有界字段，逐媒体精确绑定 ----

test('M2 提示词契约：逐媒体叙事与视频声音可用信息被明确要求，解析仍严格按媒体 id 绑定', () => {
  const content = buildMultimodalQwenContent([
    {
      id: SOURCE_ID, source_url: SOURCE_URL, content_text: '正文', platform: 'x',
      media_assets: [
        { id: 'm-aaaaaaaaaaaaaaaaaaaaaaaa', media_url: 'https://video.twimg.com/v.mp4', kind: 'video', hash: { kind: 'content', value: 'b'.repeat(64) } },
      ],
    },
  ]);
  const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.match(text, /叙事（发生了什么、前后语境）/);
  assert.match(text, /声音可用信息：是否存在可用音轨/);
  // 严格 JSON 结构保持不变：逐媒体字段集仍是已验收子集（无新增契约键）
  assert.doesNotMatch(text, /"audio"/);
  assert.ok(content.some((part) => part.type === 'video_url'), '视频媒体必须构造 video_url 多模态部件');
});

test('M2 解析：composition 携带声音可用信息仍严格按顺序绑定全部媒体 id', async () => {
  const item = {
    id: SOURCE_ID, source_url: SOURCE_URL, label: 'M2', platform: 'x',
    content_text: '正文', external_id: EXTERNAL_ID, content_sha256: await hash('正文'),
    media_assets: [
      { id: 'm-aaaaaaaaaaaaaaaaaaaaaaaa', media_url: 'https://pbs.twimg.com/media/a.jpg', kind: 'image', hash: { kind: 'content', value: 'a'.repeat(64) } },
      { id: 'm-bbbbbbbbbbbbbbbbbbbbbbbb', media_url: 'https://video.twimg.com/v.mp4', kind: 'video', hash: { kind: 'content', value: 'b'.repeat(64) } },
    ],
  };
  const payload = {
    choices: [{ message: { content: JSON.stringify({
      analyses: [{
        source_id: SOURCE_ID,
        text_expression: '表达',
        media_analysis: [
          { media_id: 'm-aaaaaaaaaaaaaaaaaaaaaaaa', visual_content: 'v1', composition: '构图 1', people: 'p1', scene: 's1', emotion: 'e1' },
          { media_id: 'm-bbbbbbbbbbbbbbbbbbbbbbbb', visual_content: 'v2', composition: '存在可用音轨：人声解说。', people: 'p2', scene: 's2', emotion: 'e2' },
        ],
        virality_drivers: ['d'], reusable_methods: ['m'], signals: ['s'], risks: ['r'],
      }],
    }) } }],
  };
  const parsed = parseQwenMultimodalAnalyses(payload, [item])[0];
  assert.deepEqual(parsed.media_analysis.map((row) => row.media_id), item.media_assets.map((asset) => asset.id));
  assert.match(parsed.media_analysis[1].composition, /人声解说/);
  // 逐媒体键仍是已验收子集（可选 v2 字段仅在模型提供时出现）
  const parsedKeys = Object.keys(parsed.media_analysis[0]);
  assert.ok(parsedKeys.every((key) => P32_V2_MEDIA_ANALYSIS_KEYS.includes(key)), '解析键必须全部属于已验收 v2 子集');
  for (const key of ['media_id', 'visual_content', 'composition', 'people', 'scene', 'emotion']) {
    assert.ok(parsedKeys.includes(key), `基础逐媒体键 ${key} 必须存在`);
  }
});

// ---- 3. 多媒体对抗：顺序/重复/缺失/错绑一律失败关闭 ----

test('M2 对抗：乱序/缺失/重复/外来媒体绑定在保存时失败关闭，项目不变', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const [imageId, videoId] = evidence.media_assets.map((asset) => asset.id);
  const base = v2ModelResult([imageId, videoId]);

  // 乱序
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...base, result: { ...base.result, media_analysis: [base.result.media_analysis[1], base.result.media_analysis[0]] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  // 缺失一条
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...base, result: { ...base.result, media_analysis: [base.result.media_analysis[0]] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  // 重复
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...base, result: { ...base.result, media_analysis: [base.result.media_analysis[0], base.result.media_analysis[0]] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  // 外来媒体 id
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...base, result: { ...base.result, media_analysis: [{ ...base.result.media_analysis[1], media_id: 'm-cccccccccccccccccccccccc' }] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  // 来源身份错绑
  await assert.rejects(
    () => recordVersionedReanalysis(project, evidence.id, { ...base, source_id: 'm2-other-source' }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_SOURCE_BINDING_INVALID' },
  );
  // 全部失败后项目完全不变（零分析、零版本）
  assert.equal(project.analyses.length, 0);
  assert.equal(project.evidence[0].version, evidence.version);
});

test('M2 对抗：伪造/腐蚀状态下知识卡构建失败关闭（错绑媒体、缺失内容哈希）', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(afterAnalysis, evidence.id);

  // 腐蚀 1：证据媒体顺序被篡改（与已保存分析绑定不一致）→ 卡片拒绝构建
  const reordered = clonePlain(afterAnalysis);
  reordered.evidence = [{
    ...reordered.evidence[0],
    media_assets: [reordered.evidence[0].media_assets[1], reordered.evidence[0].media_assets[0]],
  }];
  await assert.rejects(
    () => buildKnowledgeCard(reordered, analysis.id, { now, hasher: fingerprintOf }),
    { code: 'CARD_MEDIA_BINDING_INVALID' },
  );
  // 腐蚀 2：媒体哈希被降级为旧 URL 哈希（旧合同）→ 卡片拒绝继承
  const legacy = clonePlain(afterAnalysis);
  legacy.evidence = [{
    ...legacy.evidence[0],
    media_assets: legacy.evidence[0].media_assets.map((asset) => ({ ...asset, hash: { algorithm: 'sha256', kind: 'url', value: 'd'.repeat(64) } })),
  }];
  await assert.rejects(
    () => buildKnowledgeCard(legacy, analysis.id, { now, hasher: fingerprintOf }),
    { code: 'CARD_MEDIA_HASH_MISSING' },
  );
});

// ---- 4. 旧版本保留与最新版本确定性 ----

test('M2 版本：同一证据多次显式保存产生不可变版本链，旧版本保留且最新选择确定', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const first = v2ModelResult(mediaIds, { videoAudio: '存在可用音轨：第一版人声。' });
  first._request_identity = 'm2-version:1';
  const afterV1 = await recordVersionedReanalysis(project, evidence.id, first, { now, hasher: fingerprintOf });
  const v1 = getLatestAnalysisForEvidence(afterV1, evidence.id);
  assert.equal(v1.version, 1);

  const second = v2ModelResult(mediaIds, { videoAudio: '存在可用音轨：第二版配乐加强。' });
  second._request_identity = 'm2-version:2';
  const afterV2 = await recordVersionedReanalysis(afterV1, evidence.id, second, { now, hasher: fingerprintOf });
  const versions = getAllAnalysisVersionsForEvidence(afterV2, evidence.id);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((row) => row.version), [2, 1]);
  // v1 不可变：id/指纹原样保留，未被覆写
  const reloadedV1 = versions[1];
  assert.equal(reloadedV1.id, v1.id);
  assert.equal(reloadedV1.fingerprint, v1.fingerprint);
  assert.equal(reloadedV1.model_analysis.result.media_analysis[1].composition.includes('第一版人声'), true);
  // 最新选择确定性
  assert.equal(getLatestAnalysisForEvidence(afterV2, evidence.id).version, 2);
  // 相同请求身份不产生重复版本
  const dedup = await recordVersionedReanalysis(afterV2, evidence.id, second, { now, hasher: fingerprintOf });
  assert.equal(dedup.analyses.length, 2);
  // 证据本身不可变
  assert.equal(dedup.evidence[0].version, evidence.version);
  assert.equal(dedup.evidence[0].fingerprint, evidence.fingerprint);
});

// ---- 5. 刷新恢复：本地 store 与在线命令边界两条权威重载路径 ----

test('M2 刷新恢复：store 往返后 Evidence/媒体/分析版本/知识卡 identity 与 fingerprint 完全一致', async () => {
  const backing = new Map();
  const store = createP19Store({ storage: { getItem: (key) => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) } });
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(afterAnalysis, evidence.id);
  const withCard = await buildKnowledgeCard(afterAnalysis, analysis.id, { now, hasher: fingerprintOf });
  const saved = store.putProject(withCard);
  assert.equal(saved.ok, true, saved.message || 'store 保存必须成功');

  const restored = store.getProject(project.id);
  assert.equal(restored.ok, true);
  const reloaded = restored.project;
  assert.equal(reloaded.fingerprint, withCard.fingerprint);
  const reloadedEvidence = reloaded.evidence.find((row) => row.id === evidence.id);
  assert.equal(reloadedEvidence.fingerprint, evidence.fingerprint);
  assert.equal(reloadedEvidence.version, evidence.version);
  assert.deepEqual(reloadedEvidence.media_assets.map((asset) => [asset.id, asset.hash.value]), evidence.media_assets.map((asset) => [asset.id, asset.hash.value]));
  const reloadedAnalysis = reloaded.analyses.find((row) => row.id === analysis.id);
  assert.equal(reloadedAnalysis.fingerprint, analysis.fingerprint);
  assert.equal(reloadedAnalysis.version, analysis.version);
  assert.deepEqual(reloadedAnalysis.model_analysis.media_ids, mediaIds);
  const reloadedCard = reloaded.knowledge_cards.find((row) => row.id === withCard.knowledge_cards[0].id);
  assert.equal(reloadedCard.fingerprint, withCard.knowledge_cards[0].fingerprint);
  // 旧版本同样恢复
  assert.equal(getAllAnalysisVersionsForEvidence(reloaded, evidence.id).length, 1);
  assert.equal(getLatestAnalysisForEvidence(reloaded, evidence.id).id, analysis.id);
});

test('M2 在线刷新恢复：命令边界权威重载返回精确 identity/revision/fingerprint', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(afterAnalysis, evidence.id);
  const withCard = await buildKnowledgeCard(afterAnalysis, analysis.id, { now, hasher: fingerprintOf });

  // 命令边界 mock：project.read 返回权威存储的项目快照
  let authoritative = clonePlain(withCard);
  authoritative.fingerprint = '';
  authoritative.fingerprint = await fingerprintOf(authoritative);
  const fakeCommandClient = {
    async invoke(command, payload) {
      if (command === 'project.list') return { data: { projects: [{ id: project.id, topic: project.topic, status: project.status }] } };
      if (command === 'project.read' && payload?.project_id === project.id) return { data: { project: clonePlain(authoritative) } };
      throw workbenchError('UNKNOWN_COMMAND', '测试边界拒绝未知命令。');
    },
  };
  const store = createP20OnlineStore({ commandClient: fakeCommandClient });
  const list = await store.listProjects();
  assert.equal(list.length, 1);
  const reloaded = await store.getProject(project.id);
  assert.equal(reloaded.fingerprint, authoritative.fingerprint);
  assert.equal(reloaded.evidence[0].fingerprint, evidence.fingerprint);
  assert.deepEqual(reloaded.evidence[0].media_assets.map((asset) => asset.hash.value), evidence.media_assets.map((asset) => asset.hash.value));
  const reloadedAnalysis = reloaded.analyses.find((row) => row.id === analysis.id);
  assert.equal(reloadedAnalysis.fingerprint, analysis.fingerprint);
  assert.equal(reloadedAnalysis.version, analysis.version);
  assert.equal(reloaded.knowledge_cards[0].analysis_id, analysis.id);
  assert.equal(reloaded.knowledge_cards[0].analysis_version, analysis.version);
});

// ---- 6. 项目切换隔离 + local/demo 隔离 ----

test('M2 隔离：同一来源内容的证据分属两个项目时，分析/知识卡绝不跨项目混入', async () => {
  const input = await mediaEvidenceInput();
  const projectA = await createProject({ topic: '项目 A', objective: 'A', audience: 'A', channel: 'X', now });
  const projectB = await createProject({ topic: '项目 B', objective: 'B', audience: 'B', channel: 'X', now });
  const afterA = await addEvidence(projectA, input, { now, hasher: fingerprintOf });
  const afterB = await addEvidence(projectB, input, { now, hasher: fingerprintOf });
  const evidenceA = afterA.evidence[0];
  const evidenceB = afterB.evidence[0];
  // 同一来源在各自项目内产生各自的证据身份
  assert.notEqual(evidenceA.id, evidenceB.id);
  assert.equal(evidenceA.project_id, projectA.id);
  assert.equal(evidenceB.project_id, projectB.id);

  const mediaIdsA = evidenceA.media_assets.map((asset) => asset.id);
  const resultA = v2ModelResult(mediaIdsA);
  resultA._request_identity = 'm2-isolation:a';
  const withAnalysisA = await recordVersionedReanalysis(afterA, evidenceA.id, resultA, { now, hasher: fingerprintOf });
  // B 项目绝不能出现 A 的分析
  assert.equal(afterB.analyses.length, 0);
  assert.equal(withAnalysisA.analyses[0].project_id, projectA.id);

  // A 的来源身份绑定到 B 项目的证据（不同来源身份）→ 失败关闭
  const otherInput = await mediaEvidenceInput();
  otherInput.provenance = { ...otherInput.provenance, source_id: 'm2-source-video-0002', external_id: '2087047011753467999', source_url: 'https://x.com/example/status/2087047011753467999' };
  otherInput.source_url = otherInput.provenance.source_url;
  otherInput.media_assets = otherInput.media_assets.map((asset) => ({ ...asset, tweet_id: '2087047011753467999', external_id: '2087047011753467999', canonical_tweet_url: otherInput.source_url }));
  const afterB2 = await addEvidence(afterB, otherInput, { now, hasher: fingerprintOf });
  const evidenceB2 = afterB2.evidence.find((row) => row.id !== evidenceB.id);
  assert.ok(evidenceB2, 'B 项目第二证据必须存在');
  await assert.rejects(
    () => recordVersionedReanalysis(afterB2, evidenceB2.id, { ...resultA, result: { ...resultA.result, media_analysis: resultA.result.media_analysis.map((row, index) => ({ ...row, media_id: evidenceB2.media_assets[index].id })) } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_SOURCE_BINDING_INVALID' },
  );
  // 且 B 项目仍然没有任何分析（隔离未破坏）
  assert.equal(afterB2.analyses.length, 0);
});

test('M2 隔离：local/demo 手工证据没有来源身份，永远无法登记为模型分析（绝不冒充 staging 来源）', async () => {
  const project = await createProject({ topic: '本地草稿', objective: '隔离', audience: '测试', channel: 'X', now });
  const after = await addEvidence(project, {
    source_url: 'https://example.com/manual-post', label: '手工录入演示',
    platform: 'manual', content_text: '本地演示正文，不属于任何 staging 采集来源。',
    recorded_at: '2026-08-13T07:30:00.000Z',
    provenance: { manual: true, statement: '人工录入，未经过平台采集或验证。' },
    media_metadata: null,
  }, { now, hasher: fingerprintOf });
  const evidence = after.evidence[0];
  assert.equal(evidence.provenance.manual, true);

  // 无媒体资产：多模态重新分析首先失败关闭（本地/demo 无法进入模型分析路径）；
  // 即便有媒体，手工证据也没有 P22 来源身份，来源绑定同样失败关闭。
  const mediaIds = (evidence.media_assets || []).map((asset) => asset.id);
  await assert.rejects(
    () => recordVersionedReanalysis(after, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf }),
    (cause) => ['REANALYSIS_MEDIA_MISSING', 'ANALYSIS_SOURCE_BINDING_INVALID'].includes(cause.code),
  );
  // P22 采集路径同样拒绝手工证据（无 P22 provenance）
  await assert.rejects(async () => toP19EvidenceInput({ ...(await mediaEvidenceInput()), provenance: { manual: true, statement: 'demo' } }), { code: 'P22_EVIDENCE_INVALID' });
});

// ---- 7. 保存冲突：并发修订有界失败 ----

test('M2 保存冲突：在线命令边界返回 PROJECT_REVISION_STALE 时有界失败，绝不谎报成功', async () => {
  const fakeCommandClient = {
    async invoke() {
      const error = new Error('项目最新修订已变化（并发写入），拒绝从旧修订分支。');
      error.code = 'PROJECT_REVISION_STALE';
      throw error;
    },
  };
  const store = createP20OnlineStore({ commandClient: fakeCommandClient });
  await assert.rejects(
    () => store.execute('evidence.create', { project_id: 'prj-0123456789abcdef01234567', evidence: {} }, {}),
    (cause) => {
      assert.equal(cause.code, 'PROJECT_REVISION_STALE');
      assert.match(cause.message, /并发写入/);
      return true;
    },
  );
});

// ---- 8. 错误消息脱敏：不输出 Bearer/JWT/service-role ----

test('M2 脱敏：P22 客户端与命令适配器错误输出不包含令牌/JWT/service-role', async () => {
  const leakedMessage = '上游返回异常：Authorization: Bearer abc.def.ghi12345, service_role=sk_live_secret_value, 详情见日志。';
  // P22 客户端
  const p22Client = createP22ResearchAssistClient({
    client: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } }, error: null }) },
      functions: { invoke: async () => ({ error: { context: { json: async () => ({ code: 'QWEN_REQUEST_FAILED', message: leakedMessage, details: { provider: 'qwen' } }) } } }) },
    },
  });
  await assert.rejects(() => p22Client.analyze([{}]), (cause) => {
    assertBoundedNoSecrets(cause.message);
    return true;
  });
  // P19 命令适配器（JWT 形状也必须脱敏）
  const p19Client = createP19CommandClient({
    client: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'tok', user: { id: 'u1' } } }, error: null }) },
      functions: { invoke: async () => ({ error: { context: { json: async () => ({ code: 'ONLINE_FAILED', message: leakedMessage }) } } }) },
    },
  });
  await assert.rejects(() => p19Client.invoke('project.read', { project_id: 'prj-0123456789abcdef01234567' }), (cause) => {
    assertBoundedNoSecrets(cause.message);
    return true;
  });
});

// ---- 9. 过时传播与卡片绑定仍然一致（回归护栏）----

test('M2 回归：分析过时判定与知识卡快照绑定在继承字段加入后仍精确', async () => {
  const { project, evidence } = await projectWithMediaEvidence();
  const mediaIds = evidence.media_assets.map((asset) => asset.id);
  const afterAnalysis = await recordVersionedReanalysis(project, evidence.id, v2ModelResult(mediaIds), { now, hasher: fingerprintOf });
  const analysis = getLatestAnalysisForEvidence(afterAnalysis, evidence.id);
  const withCard = await buildKnowledgeCard(afterAnalysis, analysis.id, { now, hasher: fingerprintOf });
  const staleness = await computeStaleness(withCard, { hasher: fingerprintOf });
  assert.equal(staleness.analysis_stale_ids.length, 0);
  assert.equal(staleness.card_stale_ids.length, 0);
  // 证据内容变化 → 分析与卡片全部过时
  const edited = await addEvidence(withCard, await mediaEvidenceInput(), { now, hasher: fingerprintOf });
  void edited;
  const afterEdit = clonePlain(withCard);
  afterEdit.evidence[0] = { ...afterEdit.evidence[0], content_text: '变更后的正文内容。', media_metadata: { ...afterEdit.evidence[0].media_metadata, sha256: 'e'.repeat(64) }, provenance: { ...afterEdit.evidence[0].provenance, content_sha256: 'e'.repeat(64) }, version: afterEdit.evidence[0].version + 1, updated_at: now() };
  const stale = await computeStaleness(afterEdit, { hasher: fingerprintOf });
  assert.equal(stale.analysis_stale_ids.includes(analysis.id), true);
  assert.equal(stale.card_stale_ids.includes(withCard.knowledge_cards[0].id), true);
});
