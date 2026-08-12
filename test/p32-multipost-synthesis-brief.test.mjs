// P32-C 多帖综合洞察 → 精确知识卡 → 待人工审核 Brief：完整离线单元/对抗测试。
// 全部测试无真实网络/模型/Supabase 调用；综合洞察只由已保存分析确定性派生。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  ANALYSIS_ID_PATTERN, P32_MODEL_ANALYSIS_SCHEMA_VERSION, clonePlain, fingerprintOf,
  validateBrief, validateKnowledgeCard,
} from '../src/services/p19-contracts.js';
import {
  addEvidence, assembleBrief, assembleSynthesisBrief, buildKnowledgeCard,
  buildKnowledgeCardsForSelection, computeStaleness, computeSynthesisPartialState,
  createProject, deriveHandoffPackage, generateSynthesisInsight,
  getLatestAnalysisForEvidence, recordAssistedAnalysis, recordVersionedReanalysis,
  reviewBrief, updateEvidence, validateSynthesisSelection,
  P32_SYNTHESIS_MAX, P32_SYNTHESIS_MIN, P32_SYNTHESIS_SCHEMA_VERSION,
} from '../src/services/p19-workspace-service.js';
import { createP19Store } from '../src/services/p19-store.js';

const hash = async (text) => createHash('sha256').update(text).digest('hex');
const now = () => '2026-08-12T12:00:00.000Z';

// ---- 共享夹具 ----

function mediaAssetsFor(index) {
  return [
    {
      id: `m-${'a'.repeat(16)}${String(index).padStart(8, '0')}`,
      tweet_id: `190000000000000000${index}`, external_id: `190000000000000000${index}`,
      canonical_tweet_url: `https://x.com/test${index}/status/190000000000000000${index}`,
      media_url: `https://pbs.twimg.com/media/photo-${index}-a.jpg`, order: 0, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
      byte_size: 200000, hash: { algorithm: 'sha256', kind: 'content', value: `${index}a`.repeat(32) },
    },
    {
      id: `m-${'b'.repeat(16)}${String(index).padStart(8, '0')}`,
      tweet_id: `190000000000000000${index}`, external_id: `190000000000000000${index}`,
      canonical_tweet_url: `https://x.com/test${index}/status/190000000000000000${index}`,
      media_url: `https://pbs.twimg.com/media/photo-${index}-b.jpg`, order: 1, kind: 'image',
      mime_type: 'image/jpeg', dimensions: { width: 800, height: 600 },
      byte_size: 150000, hash: { algorithm: 'sha256', kind: 'content', value: `${index}b`.repeat(32) },
    },
  ];
}

/** 构造一条 P22 采集来源证据输入（身份由 index 决定，绝不与其他证据冲突）。 */
async function evidenceInputFor(index, { engagement, contentText } = {}) {
  const text = contentText || `P32-C 综合测试正文 ${index}：验证多帖综合洞察、精确知识卡与待审核 Brief。`;
  const contentSha256 = await hash(text);
  const fullEngagement = { likes: 1500 * index, retweets: 300 * index, replies: 80 * index, quotes: 20 * index, views: 50000 * index, bookmarks: 400 * index };
  return {
    source_url: `https://x.com/test${index}/status/190000000000000000${index}`,
    label: `P32-C 测试帖子 ${index}`,
    platform: 'X · Apify',
    content_text: text,
    recorded_at: '2026-08-10T08:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: `p32c-test-source-${index}`,
      external_id: `190000000000000000${index}`,
      source_url: `https://x.com/test${index}/status/190000000000000000${index}`,
      run_id: 'apify-run-p32c', collected_at: '2026-08-10T08:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: contentSha256,
      collection_proof: '1999999999.' + 'c'.repeat(64),
      statement: 'P32-C 测试证据。',
    },
    media_metadata: {
      filename: `p32c-${index}.txt`, mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(text).byteLength,
      last_modified: '2026-08-10T08:00:00.000Z',
      sha256: contentSha256,
    },
    source_metadata: {
      author: { name: `测试作者${index}`, handle: `testauthor${index}`, user_id: `11111111111111111${index}` },
      published_at: `2026-08-0${index}T08:00:00.000Z`,
      engagement: engagement === undefined ? fullEngagement : engagement,
    },
    media_assets: mediaAssetsFor(index),
  };
}

async function projectWithEvidence(count = 3, { engagementFor } = {}) {
  const project = await createProject({
    topic: 'P32-C 综合测试项目', objective: '验证多帖综合洞察与待审核 Brief',
    audience: '测试团队', channel: '内部测试', now,
  });
  let current = project;
  const evidence = [];
  for (let index = 1; index <= count; index += 1) {
    const engagement = typeof engagementFor === 'function' ? engagementFor(index) : undefined;
    const input = await evidenceInputFor(index, { engagement });
    current = await addEvidence(current, input, { now, hasher: fingerprintOf });
    evidence.push(current.evidence.find((item) => item.source_url === input.source_url));
  }
  return { project: current, evidence };
}

/** 构造一次 v2 Qwen 模型结果（模拟多模态返回）。 */
function v2ModelResult(sourceId, mediaIds, { hook, copyPattern, drivers, risks, styles } = {}) {
  return {
    source_id: sourceId,
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: '强有力的视觉表达与简洁文案形成传播合力。',
      hook: hook || '一张图说明一切——不需要多余解释',
      copy_pattern: copyPattern || '视觉前置 + 短文案 + 情绪共鸣',
      target_audience: '25-35岁关注科技与生活方式的城市青年',
      audience_need_emotion: '渴望快速获取有价值信息的效率感与归属感',
      media_analysis: mediaIds.map((id, i) => ({
        media_id: id,
        visual_content: `画面 #${i + 1}：高对比度的视觉元素构成主体。`,
        composition: '中心对称构图', people: '单人特写', scene: '室内暖光', emotion: '专业自信',
        visual_selling_points: ['高辨识度', '调性统一'],
        style_pattern: styles ? styles[i] : '暖色调 + 浅景深',
      })),
      virality_drivers: drivers || ['视觉冲击力', '信息密度高', '引发共鸣'],
      reusable_methods: ['图胜于文的核心策略', '第一帧抓住注意力的构图'],
      rewrite_suggestions: ['用对比图强化效果展示'],
      signals: ['高互动率', '传播层级深'],
      risks: risks || ['过度依赖视觉可能忽略文字信息'],
    },
    executed_at: '2026-08-12T12:00:00.000Z',
    usage: { total_tokens: 1500 },
    _request_identity: `p32c:${sourceId}:v2`,
  };
}

/** 构造 v1 模型结果（P29 旧路径，无 hook/copy_pattern 等 v2 字段）。 */
function v1ModelResult(sourceId, mediaIds) {
  return {
    source_id: sourceId,
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: 'v1 文本表达：简洁直接、结构清晰。',
      media_analysis: mediaIds.map((id, i) => ({
        media_id: id,
        visual_content: `v1 画面 #${i + 1}：主体突出。`,
        composition: '构图', people: '人物', scene: '场景', emotion: '情绪',
      })),
      virality_drivers: ['v1 传播驱动'],
      reusable_methods: ['v1 可复用方法'],
      signals: ['v1 信号'],
      risks: ['v1 风险'],
    },
    executed_at: '2026-08-12T12:00:00.000Z',
    usage: { total_tokens: 900 },
  };
}

/** 为每条证据追加最新 Qwen v2 分析（默认全部成功）。 */
async function analyzedProject(count = 3, { engagementFor } = {}) {
  const { project, evidence } = await projectWithEvidence(count, { engagementFor });
  let current = project;
  for (const record of evidence) {
    const mediaIds = (record.media_assets || []).map((asset) => asset.id);
    current = await recordVersionedReanalysis(current, record.id, v2ModelResult(record.provenance.source_id, mediaIds), { now, hasher: fingerprintOf });
  }
  return { project: current, evidence };
}

// ---------------------------------------------------------------------------
// A. 精确选择与失败关闭
// ---------------------------------------------------------------------------

test('P32-C selection: 2/5 boundaries, duplicates, aliases and empty inputs fail closed', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);

  // 少于 2 条
  let verdict = validateSynthesisSelection(project, [ids[0]]);
  assert.equal(verdict.valid, false, '1 条选择必须失败关闭');
  assert.ok(verdict.reason.includes('2–5'), '应说明 2–5 边界');

  // 超过 5 条（需要 6 条证据）
  const many = await projectWithEvidence(6);
  let current = many.project;
  for (const record of many.evidence) {
    const mediaIds = (record.media_assets || []).map((asset) => asset.id);
    current = await recordVersionedReanalysis(current, record.id, v2ModelResult(record.provenance.source_id, mediaIds), { now, hasher: fingerprintOf });
  }
  verdict = validateSynthesisSelection(current, many.evidence.map((item) => item.id));
  assert.equal(verdict.valid, false, '6 条选择必须失败关闭');
  assert.equal(many.evidence.length, 6);
  assert.ok(P32_SYNTHESIS_MIN === 2 && P32_SYNTHESIS_MAX === 5, '边界常量精确为 2 与 5');

  // 重复 identity
  verdict = validateSynthesisSelection(project, [ids[0], ids[1], ids[0]]);
  assert.equal(verdict.valid, false, '重复 evidence_id 必须失败关闭');
  assert.ok(verdict.reason.includes('重复'), '应说明重复身份');

  // 空 / 非数组
  assert.equal(validateSynthesisSelection(project, []).valid, false);
  assert.equal(validateSynthesisSelection(project, null).valid, false);
  assert.equal(validateSynthesisSelection(project, undefined).valid, false);

  // 别名 / 截断 / 标题 / 位置代理一律拒绝（绝不 substring 匹配）
  verdict = validateSynthesisSelection(project, [ids[0].slice(0, 10), ids[1]]);
  assert.equal(verdict.valid, false, '截断 id 必须失败关闭');
  verdict = validateSynthesisSelection(project, [evidence[0].label, ids[1]]);
  assert.equal(verdict.valid, false, '标题不能代理身份');
  verdict = validateSynthesisSelection(project, [0, 1]);
  assert.equal(verdict.valid, false, '数组位置不能代理身份');

  // 有效选择：2 条
  verdict = validateSynthesisSelection(project, [ids[0], ids[1]]);
  assert.equal(verdict.valid, true, `2 条有效选择应通过：${JSON.stringify(verdict.issues)}`);
  assert.equal(verdict.bindings.length, 2);
});

test('P32-C selection: missing / stale / cross-project / misbound / deterministic-only fail closed, project unchanged', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);
  const before = project.fingerprint;

  // 缺失分析
  let verdict = validateSynthesisSelection(project, [ids[0], ids[1]]);
  assert.equal(verdict.valid, true);
  const { project: noAnalysis, evidence: noAnalysisEvidence } = await projectWithEvidence(2);
  verdict = validateSynthesisSelection(noAnalysis, noAnalysisEvidence.map((item) => item.id));
  assert.equal(verdict.valid, false, '缺少分析必须失败关闭');
  assert.ok(verdict.issues.some((issue) => issue.includes('用 Qwen 重新分析')), '缺失分析提示必须包含可操作指引');

  // 过时分析（证据编辑后指纹变化）
  const staleProject = await updateEvidence(project, ids[0], { label: '已编辑标签' }, { now, hasher: fingerprintOf });
  verdict = validateSynthesisSelection(staleProject, [ids[0], ids[1]]);
  assert.equal(verdict.valid, false, '过时分析必须失败关闭');
  assert.ok(verdict.issues.some((issue) => issue.includes('已过时') && issue.includes('用 Qwen 重新分析')), '过时提示必须可操作');
  assert.equal(project.fingerprint, before, '校验失败时项目必须完全不变');

  // 跨项目：分析 project_id 被篡改
  const tampered = clonePlain(project);
  const latestA = getLatestAnalysisForEvidence(tampered, ids[0]);
  latestA.project_id = 'prj-cccccccccccccccccccccccc';
  verdict = validateSynthesisSelection(tampered, [ids[0], ids[1]]);
  assert.equal(verdict.valid, false, '跨项目分析必须失败关闭');

  // 错绑：分析 evidence_id 指向其他证据
  const misbound = clonePlain(project);
  const latestB = getLatestAnalysisForEvidence(misbound, ids[1]);
  latestB.evidence_id = ids[2];
  verdict = validateSynthesisSelection(misbound, [ids[1], ids[2]]);
  assert.equal(verdict.valid, false, '错绑分析必须失败关闭');

  // 只有确定性本地分析（无 model_analysis）：不能冒充 Qwen 分析进入综合
  const { project: deterministicOnly } = await projectWithEvidence(2);
  verdict = validateSynthesisSelection(deterministicOnly, deterministicOnly.evidence.map((item) => item.id));
  assert.equal(verdict.valid, false, '确定性本地分析不能进入综合');
  assert.ok(verdict.issues.some((issue) => issue.includes('Qwen 多模态分析')), '应明确要求 Qwen 多模态分析');

  // 归档项目
  const archived = { ...project, status: 'archived' };
  verdict = validateSynthesisSelection(archived, [ids[0], ids[1]]);
  assert.equal(verdict.valid, false, '归档项目必须失败关闭');
  assert.throws(
    () => generateSynthesisInsight(archived, [ids[0], ids[1]], { now }),
    (error) => error.code === 'PROJECT_ARCHIVED' || error.code === 'P32_SYNTHESIS_INVALID_SELECTION',
  );
  await assert.rejects(
    () => buildKnowledgeCardsForSelection(archived, [ids[0], ids[1]], { now, hasher: fingerprintOf }),
    (error) => error.code === 'PROJECT_ARCHIVED',
  );
  await assert.rejects(
    () => assembleSynthesisBrief(archived, { selectedEvidenceIds: [ids[0], ids[1]], now, hasher: fingerprintOf }),
    (error) => error.code === 'PROJECT_ARCHIVED',
  );
});

// ---------------------------------------------------------------------------
// B. 多帖综合洞察（无新模型调用）
// ---------------------------------------------------------------------------

test('P32-C synthesis: deterministic derivation, stable identity/fingerprint, canonical ordering', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);

  const synthesisA = generateSynthesisInsight(project, [ids[1], ids[0]], { now });
  const synthesisB = generateSynthesisInsight(project, [ids[0], ids[1]], { now: () => '2026-08-12T13:00:00.000Z' });

  // 选择顺序无关：bindings 按项目 evidence 顺序规范化。
  assert.deepEqual(synthesisA.selected_evidence_ids, [ids[0], ids[1]], '选择顺序必须规范化为项目 evidence 顺序');
  // identity/fingerprint 稳定且与生成时间无关。
  assert.equal(synthesisA.id, synthesisB.id, '同一选择与分析必须得到稳定 identity');
  assert.equal(synthesisA.fingerprint, synthesisB.fingerprint, 'fingerprint 必须稳定');
  assert.ok(/^syn-[0-9a-f]{24}$/.test(synthesisA.id), '综合 identity 必须是有界稳定格式');
  assert.equal(synthesisA.schema_version, P32_SYNTHESIS_SCHEMA_VERSION);

  // 有序不可变来源快照：完整绑定 Evidence/Analysis id + version + fingerprint。
  assert.equal(synthesisA.source_snapshot.length, 2);
  const snap = synthesisA.source_snapshot[0];
  assert.equal(snap.evidence_id, ids[0]);
  assert.equal(snap.evidence_fingerprint, evidence[0].fingerprint);
  assert.ok(ANALYSIS_ID_PATTERN.test(snap.analysis_id), '快照必须绑定完整分析 id');
  assert.equal(snap.analysis_version, 1);
  assert.equal(snap.model_schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION);

  // 六项洞察全部存在且非空。
  for (const key of ['common_topics', 'high_performance_structures', 'visual_styles', 'audience_sentiment', 'reusable_formula', 'risks_do_not_copy']) {
    assert.ok(Array.isArray(synthesisA.sections[key]) && synthesisA.sections[key].length > 0, `sections.${key} 必须存在且非空`);
  }

  // 高表现结构必须来自真实指标最高的证据（帖子 3 的互动是帖子 1 的 3 倍）。
  assert.ok(
    synthesisA.sections.high_performance_structures.some((item) => item.includes('测试帖子 2')),
    `高表现判断应只在本次选中的帖子 1/2 中绑定真实互动最高的帖子 2：${JSON.stringify(synthesisA.sections.high_performance_structures)}`,
  );
  // 派生结果必须与项目和兄弟结果无别名：修改返回值不能污染来源或下一次读取。
  const projectBeforeMutation = clonePlain(project);
  synthesisA.source_snapshot[0].analysis_version = 999;
  synthesisA.sections.common_topics[0] = '外部篡改';
  assert.deepEqual(project, projectBeforeMutation, '修改综合返回值不得污染项目来源');
  assert.equal(synthesisB.source_snapshot[0].analysis_version, 1, '兄弟综合结果不得共享嵌套引用');
  assert.notEqual(synthesisB.sections.common_topics[0], '外部篡改');
  // 内容变化 → identity 变化（快照绑定 fingerprint）。
  const edited = await updateEvidence(project, ids[0], { label: '改了标题' }, { now, hasher: fingerprintOf });
  const editedTarget = edited.evidence.find((item) => item.id === ids[0]);
  const synthesisC = await (async () => {
    let current = edited;
    const mediaIds = (editedTarget.media_assets || []).map((asset) => asset.id);
    current = await recordVersionedReanalysis(current, ids[0], { ...v2ModelResult(editedTarget.provenance.source_id, mediaIds), _request_identity: 'p32c:after-edit' }, { now, hasher: fingerprintOf });
    return generateSynthesisInsight(current, [ids[0], ids[1]], { now });
  })();
  assert.notEqual(synthesisC.id, synthesisA.id, '上游内容/分析变化必须改变综合 identity');
});

test('P32-C synthesis: real engagement metrics only; missing shown unavailable, never fabricated as 0', async () => {
  const { project, evidence } = await analyzedProject(3, {
    engagementFor: (index) => (index === 1
      ? { views: null, likes: 120, retweets: null, replies: null, quotes: null, bookmarks: null }
      : index === 2
        ? { views: 10000, likes: 800, retweets: 90, replies: 30, quotes: null, bookmarks: null }
        : null),
  });
  const ids = evidence.map((item) => item.id);
  const synthesis = generateSynthesisInsight(project, ids, { now });
  const basis = synthesis.engagement_basis;
  assert.equal(basis.length, 3);
  // 帖子 1：只有 likes → 总互动 = 120，其余缺失保持 null。
  const b1 = basis.find((row) => row.evidence_id === ids[0]);
  assert.equal(b1.likes, 120);
  assert.equal(b1.retweets, null, '缺失 retweets 必须为 null，绝不伪造为 0');
  assert.equal(b1.views, null, '缺失 views 必须为 null，绝不伪造为 0');
  assert.equal(b1.total_engagement, 120);
  assert.equal(b1.engagement_rate, null, 'views 不可用时互动率必须不可用');
  // 帖子 2：部分字段缺失 → 总互动只加存在的字段，互动率可用。
  const b2 = basis.find((row) => row.evidence_id === ids[1]);
  assert.equal(b2.quotes, null);
  assert.equal(b2.total_engagement, 800 + 90 + 30);
  assert.equal(b2.engagement_rate, 920 / 10000);
  // 帖子 3：完全没有互动 → 总互动不可用，排在最后，绝不伪造。
  const b3 = basis.find((row) => row.evidence_id === ids[2]);
  assert.equal(b3.total_engagement, null);
  const serialized = JSON.stringify(basis);
  assert.ok(!serialized.includes('"views":0'), '缺失 views 绝不伪造为 0');
  assert.ok(!serialized.includes('"retweets":0'), '缺失 retweets 绝不伪造为 0');
  // 真实指标最高的帖子 2 应成为高表现依据。
  assert.ok(synthesis.sections.high_performance_structures.some((item) => item.includes('测试帖子 2')), '高表现应绑定真实总互动最高的帖子 2');
});

test('P32-C synthesis: latest version binding and v1 (P29) analysis compatibility', async () => {
  // 全部记录必须真实属于同一项目；不能把另一个项目的记录拼接进来伪造同项目选择。
  const { project, evidence } = await projectWithEvidence(2);
  const [record, secondRecord] = evidence;
  const mediaIds = (record.media_assets || []).map((asset) => asset.id);
  const sourceId = record.provenance.source_id;

  // 先登记 v1（P29 旧路径），再追加 v2（P32-A）。
  let current = await recordAssistedAnalysis(project, record.id, v1ModelResult(sourceId, mediaIds), { now, hasher: fingerprintOf });
  current = await recordVersionedReanalysis(current, record.id, v2ModelResult(sourceId, mediaIds), { now, hasher: fingerprintOf });
  const secondMediaIds = (secondRecord.media_assets || []).map((asset) => asset.id);
  const combined = await recordVersionedReanalysis(current, secondRecord.id, v2ModelResult(secondRecord.provenance.source_id, secondMediaIds), { now, hasher: fingerprintOf });

  const synthesis = generateSynthesisInsight(combined, [record.id, secondRecord.id], { now });
  // 最新版本绑定：帖子 1 的快照必须绑定 v2（版本 2），而不是旧 v1。
  const snap1 = synthesis.source_snapshot.find((item) => item.evidence_id === record.id);
  assert.equal(snap1.analysis_version, 2, '综合必须绑定最新分析版本');
  assert.equal(snap1.model_schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION, '最新版本必须是 v2 扩展');

  // 纯 v1 分析（无 v2）也可以进入综合（仍然是 Qwen 分析），且不虚构 v2 字段。
  const { project: v1Only, evidence: v1OnlyEvidence } = await projectWithEvidence(2);
  const [v1Record, v1SecondRecord] = v1OnlyEvidence;
  const v1MediaIds = (v1Record.media_assets || []).map((asset) => asset.id);
  let v1Combined = await recordAssistedAnalysis(v1Only, v1Record.id, v1ModelResult(v1Record.provenance.source_id, v1MediaIds), { now, hasher: fingerprintOf });
  const v1SecondMediaIds = (v1SecondRecord.media_assets || []).map((asset) => asset.id);
  v1Combined = await recordAssistedAnalysis(v1Combined, v1SecondRecord.id, v1ModelResult(v1SecondRecord.provenance.source_id, v1SecondMediaIds), { now, hasher: fingerprintOf });
  const v1Synthesis = generateSynthesisInsight(v1Combined, [v1Record.id, v1SecondRecord.id], { now });
  assert.equal(v1Synthesis.source_snapshot[0].model_schema_version, 'p29_multimodal_model_v1');
  assert.ok(v1Synthesis.sections.visual_styles.some((item) => item.includes('v1 画面')), 'v1 画面内容应进入视觉风格聚合');

  // 全部字符串与数组有界。
  const walk = (value) => {
    if (typeof value === 'string') assert.ok(value.length <= 5000, '字符串必须有界');
    else if (Array.isArray(value)) { assert.ok(value.length <= 100, '数组必须有界'); value.forEach(walk); }
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(v1Synthesis);
  walk(synthesis);
  for (const key of Object.keys(synthesis.sections)) assert.ok(synthesis.sections[key].length <= 5, `sections.${key} 最多 5 条`);
});

// ---------------------------------------------------------------------------
// C. 知识卡与 Brief
// ---------------------------------------------------------------------------

test('P32-C cards: idempotent create/reuse, no duplicates, exact analysis-version binding', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);

  const first = await buildKnowledgeCardsForSelection(project, [ids[0], ids[1]], { now, hasher: fingerprintOf });
  assert.equal(first.createdCount, 2, '首次生成应新建 2 张卡');
  assert.equal(first.reusedCount, 0);
  assert.equal(first.cards.length, 2);
  for (const card of first.cards) {
    assert.equal(validateKnowledgeCard(card).valid, true, `知识卡必须通过契约校验：${JSON.stringify(validateKnowledgeCard(card).issues)}`);
  }
  const cardIds = first.cards.map((card) => card.id);
  assert.equal(new Set(cardIds).size, 2, '卡片身份互异');
  // 精确绑定最新分析版本。
  for (let index = 0; index < 2; index += 1) {
    const latest = getLatestAnalysisForEvidence(first.project, ids[index]);
    const card = first.cards[index];
    assert.equal(card.analysis_id, latest.id, '卡必须绑定最新分析 id');
    assert.equal(card.analysis_version, latest.version);
    assert.equal(card.analysis_fingerprint, latest.fingerprint);
  }

  // 同一分析重试：全部复用、零新建、项目指纹不变、绝不产生重复卡。
  const second = await buildKnowledgeCardsForSelection(first.project, [ids[0], ids[1]], { now, hasher: fingerprintOf });
  assert.equal(second.createdCount, 0, '重试不得新建重复卡');
  assert.equal(second.reusedCount, 2, '重试必须复用现有卡');
  assert.equal(second.project.fingerprint, first.project.fingerprint, '幂等重试项目指纹不变');
  assert.deepEqual(second.cards.map((card) => card.id), cardIds, '重试卡 id 完全一致');
  assert.equal(second.project.knowledge_cards.length, 2, '绝不产生重复知识卡');

  // 缺失分析时整体失败关闭且项目不变。
  const { project: partial, evidence: partialEvidence } = await analyzedProject(3);
  const { project: noAnalysis, evidence: noAnalysisEvidence } = await projectWithEvidence(2);
  const combined = clonePlain(partial);
  combined.evidence = [...partial.evidence, ...noAnalysis.evidence];
  const noAnalysisId = noAnalysisEvidence[0].id;
  await assert.rejects(
    () => buildKnowledgeCardsForSelection(combined, [partialEvidence[0].id, noAnalysisId], { now, hasher: fingerprintOf }),
    (error) => error.code === 'P32_SYNTHESIS_INVALID_SELECTION',
  );
});

test('P32-C brief: exact selected-card scope, unselected cards never mixed in, synthesis summary embedded', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);

  // 为未选中的帖子 3 也生成知识卡（必须被 Brief 隔离）。
  let prepared = await buildKnowledgeCardsForSelection(project, [ids[0], ids[1]], { now, hasher: fingerprintOf }).then((result) => result.project);
  prepared = await buildKnowledgeCard(prepared, getLatestAnalysisForEvidence(prepared, ids[2]).id, { now, hasher: fingerprintOf });
  const unselectedCard = prepared.knowledge_cards.find((card) => card.analysis_id === getLatestAnalysisForEvidence(prepared, ids[2]).id);

  const afterBrief = await assembleSynthesisBrief(prepared, { selectedEvidenceIds: [ids[0], ids[1]], now, hasher: fingerprintOf });
  const brief = afterBrief.brief;
  assert.equal(brief.status, 'pending_review', '新 Brief 必须为待审核状态');
  assert.equal(brief.review.decision, null, '任何旧人工决定必须重置');
  assert.equal(afterBrief.handoff, null, '绝不自动创建交接包');
  assert.deepEqual(afterBrief.handoffs, [], '交接包列表必须清空');
  // 精确选中范围：只引用本次选择的卡，未选中的卡绝不混入。
  assert.equal(brief.knowledge_citation_ids.length, 2, 'Brief 只引用本次选择的 2 张卡');
  assert.ok(!brief.knowledge_citation_ids.includes(unselectedCard.id), '未选中的知识卡绝不混入 Brief');
  const selectedCards = prepared.knowledge_cards.filter((card) => brief.knowledge_citation_ids.includes(card.id));
  const analysisById = new Map(prepared.analyses.map((analysis) => [analysis.id, analysis]));
  for (const card of selectedCards) {
    assert.ok([ids[0], ids[1]].includes(analysisById.get(card.analysis_id)?.evidence_id), '引用卡必须来自本次选择');
  }
  // 综合洞察摘要与准确 citation IDs 进入 Brief。
  const embedded = brief.p32_synthesis;
  assert.ok(embedded, 'Brief 必须包含综合洞察');
  assert.equal(embedded.schema_version, P32_SYNTHESIS_SCHEMA_VERSION);
  assert.deepEqual(embedded.selected_evidence_ids, [ids[0], ids[1]]);
  assert.equal(embedded.source_snapshot.length, 2);
  for (const key of ['common_topics', 'high_performance_structures', 'visual_styles', 'audience_sentiment', 'reusable_formula', 'risks_do_not_copy']) {
    assert.ok(Array.isArray(embedded.summary[key]) && embedded.summary[key].length > 0, `summary.${key} 必须存在`);
  }
  // Brief 仍通过既有合同校验（P24/P25/P29/P32-A 兼容）。
  const briefVerdict = validateBrief(brief);
  assert.equal(briefVerdict.valid, true, `Brief 必须通过既有合同校验：${JSON.stringify(briefVerdict.issues)}`);
  // 项目执行标志恒 false。
  assert.deepEqual(afterBrief.execution_flags, {
    generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false,
  });

  // 真实本地持久化边界必须接受、恢复并严格校验综合快照；不能只在内存通过。
  const backing = new Map();
  const store = createP19Store({ storage: { getItem: (key) => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) } });
  const saved = store.putProject(afterBrief);
  assert.equal(saved.ok, true, saved.message);
  const restored = store.getProject(afterBrief.id);
  assert.equal(restored.ok, true);
  assert.deepEqual(restored.project.brief.p32_synthesis, brief.p32_synthesis, '刷新读取必须完整恢复综合快照');

  const malformed = clonePlain(afterBrief);
  malformed.brief.p32_synthesis.source_snapshot[0].analysis_id = 'an-invalid';
  malformed.brief.fingerprint = await fingerprintOf(malformed.brief);
  malformed.fingerprint = await fingerprintOf({ ...malformed, fingerprint: '' });
  const rejected = store.putProject(malformed);
  assert.equal(rejected.ok, false, '畸形综合来源绑定必须失败关闭');
  assert.equal(rejected.code, 'PROJECT_INVALID');

  const malformedMetrics = clonePlain(afterBrief);
  malformedMetrics.brief.p32_synthesis.engagement_basis[0].likes = -1;
  malformedMetrics.brief.fingerprint = await fingerprintOf(malformedMetrics.brief);
  malformedMetrics.fingerprint = await fingerprintOf({ ...malformedMetrics, fingerprint: '' });
  assert.equal(store.putProject(malformedMetrics).ok, false, '负数互动指标不得进入持久化综合快照');

  const tamperedSnapshot = clonePlain(afterBrief);
  tamperedSnapshot.brief.p32_synthesis.summary.common_topics[0] = '篡改但未重签综合指纹';
  tamperedSnapshot.brief.fingerprint = await fingerprintOf(tamperedSnapshot.brief);
  tamperedSnapshot.fingerprint = await fingerprintOf({ ...tamperedSnapshot, fingerprint: '' });
  assert.equal(store.putProject(tamperedSnapshot).ok, false, '综合 fingerprint 不匹配必须失败关闭');

  const misboundSnapshot = clonePlain(afterBrief);
  const foreignAnalysis = getLatestAnalysisForEvidence(prepared, ids[1]);
  misboundSnapshot.brief.p32_synthesis.source_snapshot[0].analysis_id = foreignAnalysis.id;
  misboundSnapshot.brief.p32_synthesis.source_snapshot[0].analysis_fingerprint = foreignAnalysis.fingerprint;
  misboundSnapshot.brief.p32_synthesis.source_snapshot[0].analysis_version = foreignAnalysis.version;
  const identityInput = {
    project_id: misboundSnapshot.id,
    selected_evidence_ids: misboundSnapshot.brief.p32_synthesis.selected_evidence_ids,
    source_snapshot: misboundSnapshot.brief.p32_synthesis.source_snapshot,
  };
  misboundSnapshot.brief.p32_synthesis.synthesis_id = `syn-${(await fingerprintOf(identityInput)).slice(0, 24)}`;
  misboundSnapshot.brief.p32_synthesis.fingerprint = await fingerprintOf({
    schema_version: misboundSnapshot.brief.p32_synthesis.schema_version,
    id: misboundSnapshot.brief.p32_synthesis.synthesis_id,
    project_id: misboundSnapshot.id,
    selected_evidence_ids: misboundSnapshot.brief.p32_synthesis.selected_evidence_ids,
    source_snapshot: misboundSnapshot.brief.p32_synthesis.source_snapshot,
    sections: misboundSnapshot.brief.p32_synthesis.summary,
    engagement_basis: misboundSnapshot.brief.p32_synthesis.engagement_basis,
  });
  misboundSnapshot.brief.fingerprint = await fingerprintOf(misboundSnapshot.brief);
  misboundSnapshot.fingerprint = await fingerprintOf({ ...misboundSnapshot, fingerprint: '' });
  assert.equal(store.putProject(misboundSnapshot).ok, false, '格式正确且重签指纹的错绑分析快照仍必须失败关闭');
});

test('P32-C brief: resets old human decision, never auto-approves, handoff only after explicit review', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);

  // 第一次综合 → Brief v1 pending。
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  let current = await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  assert.equal(current.brief.version, 1);
  assert.equal(current.brief.status, 'pending_review');
  assert.equal(current.brief.review.decision, null);

  // 人工批准 → 可派生交接包（既有 P24/P25/P29 合同仍工作）。
  const approved = await reviewBrief(current, { decision: 'approved', rationale: '测试批准', now });
  assert.equal(approved.brief.status, 'approved');
  const withHandoff = await deriveHandoffPackage(approved, { now, hasher: fingerprintOf });
  assert.ok(withHandoff.handoff, '批准后可派生交接包');
  assert.equal(withHandoff.handoff.knowledge_citations.length, 2);

  // 同一选择再次综合 → Brief v2 pending，旧批准决定重置、交接包作废。
  const withCardsAgain = await buildKnowledgeCardsForSelection(withHandoff, ids, { now, hasher: fingerprintOf });
  const again = await assembleSynthesisBrief(withCardsAgain.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  assert.equal(again.brief.version, 2, 'Brief 版本递增');
  assert.equal(again.brief.status, 'pending_review', '重新综合必须回到待审核');
  assert.equal(again.brief.review.decision, null, '旧人工决定必须重置');
  assert.equal(again.handoff, null, '旧交接包必须作废');
  assert.deepEqual(again.handoffs, []);
  // 未过时（引用卡与证据绑定完整）。
  const staleness = await computeStaleness(again, { hasher: fingerprintOf });
  assert.equal(staleness.brief_stale, false, '综合 Brief 未过时');
  assert.equal(staleness.card_stale_ids.length, 0);
});

test('P32-C brief: fail closed when cards missing or stale; original assembleBrief scope unchanged', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);

  // 卡缺失：整体失败关闭，项目不变。
  const before = project.fingerprint;
  await assert.rejects(
    () => assembleSynthesisBrief(project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf }),
    (error) => error.code === 'P32_SYNTHESIS_CARDS_MISSING',
  );
  assert.equal(project.fingerprint, before, '失败关闭时项目必须不变');

  // 卡过时（篡改卡的分析指纹快照）：失败关闭。
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const staleCards = clonePlain(withCards.project);
  staleCards.knowledge_cards[0].analysis_fingerprint = 'd'.repeat(64);
  await assert.rejects(
    () => assembleSynthesisBrief(staleCards, { selectedEvidenceIds: ids, now, hasher: fingerprintOf }),
    (error) => error.code === 'P32_SYNTHESIS_CARDS_STALE',
  );

  // 既有 assembleBrief 合同不变：仍引用项目全部卡，且不带 p32_synthesis。
  const allCards = await buildKnowledgeCard(withCards.project, getLatestAnalysisForEvidence(withCards.project, ids[0]).id, { now, hasher: fingerprintOf });
  const legacy = await assembleBrief(allCards, { now, hasher: fingerprintOf });
  assert.equal(legacy.brief.knowledge_citation_ids.length, 2, '既有 assembleBrief 仍引用全部卡');
  assert.equal(legacy.brief.p32_synthesis, undefined, '既有 assembleBrief 不带综合字段');
  const legacyVerdict = validateBrief(legacy.brief);
  assert.equal(legacyVerdict.valid, true);
});

// ---------------------------------------------------------------------------
// D. 在线部分失败对账与幂等续传（纯函数层）
// ---------------------------------------------------------------------------

test('P32-C online partial: authoritative reconciliation and idempotent continuation', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);
  const selected = [ids[0], ids[1]];

  // 权威状态：只有帖子 1 的卡已确认（模拟多命令中途失败）。
  const partialAuthoritative = await buildKnowledgeCard(project, getLatestAnalysisForEvidence(project, ids[0]).id, { now, hasher: fingerprintOf });
  const partial = computeSynthesisPartialState(partialAuthoritative, selected);
  assert.equal(partial.cards_confirmed, 1, '已确认 1 张卡');
  assert.equal(partial.cards_pending, 1, '剩余 1 张卡待续传');
  assert.deepEqual(partial.pending_evidence_ids, [ids[1]], '待续传身份精确');
  assert.equal(partial.brief_assembled, false, 'Brief 尚未组装');

  // 幂等续传：只补建缺失的卡（复用 1 / 新建 1），再组装 Brief → 完整完成。
  const continued = await buildKnowledgeCardsForSelection(partialAuthoritative, selected, { now, hasher: fingerprintOf });
  assert.equal(continued.reusedCount, 1, '已确认的卡必须复用');
  assert.equal(continued.createdCount, 1, '只新建缺失的卡');
  const completed = await assembleSynthesisBrief(continued.project, { selectedEvidenceIds: selected, now, hasher: fingerprintOf });
  const finalState = computeSynthesisPartialState(completed, selected);
  assert.equal(finalState.cards_confirmed, 2);
  assert.equal(finalState.cards_pending, 0);
  assert.equal(finalState.brief_assembled, true, '续传后 Brief 已组装');
  assert.equal(completed.brief.status, 'pending_review');
  assert.equal(completed.brief.review.decision, null);

  // 另一组选帖的旧 Brief 不能掩盖当前选择的部分/未完成状态。
  const allCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const oldSelectionBrief = await assembleSynthesisBrief(allCards.project, { selectedEvidenceIds: [ids[0], ids[1]], now, hasher: fingerprintOf });
  const differentSelection = computeSynthesisPartialState(oldSelectionBrief, [ids[1], ids[2]]);
  assert.equal(differentSelection.cards_confirmed, 2, '当前选择的卡可全部存在');
  assert.equal(differentSelection.cards_pending, 0);
  assert.equal(differentSelection.brief_assembled, false, '其他选择的旧 Brief 绝不能冒充当前选择已组装');

  // 权威对账绝不谎报：卡缺失时仍如实报告待续传（上面的 partial 状态即
  // 真实一张卡已确认、一张待续传；不得用单条选择绕过 2–5 门禁伪造 Brief）。
  assert.equal(partial.cards_pending, 1, '卡缺失必须如实报告');
});
