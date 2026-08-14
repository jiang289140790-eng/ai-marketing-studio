// M3: Research → Knowledge → Brief → Handoff 在线闭环 —— 完整离线对抗测试。
//
// 全部无真实网络/模型/Supabase 调用；mock 响应仍练习生产控制流。覆盖：
// - 统一在线记录入口：X 单链接 / Reddit 单链接 / 主题搜索批量导入 → 精确
//   Evidence 身份与费用绑定（usage_total_usd + budget_reservation_id + run_id），
//   幂等重放不产生重复记录；
// - 版本化分析：Evidence 绑定当前有效 model_analysis；新分析形成显式新版本，
//   旧版可查看且不被覆盖；实际 provider 费用记录随分析绑定，绝不虚构；
// - 知识卡门禁：只从「当前、完整、准确绑定」的分析生成（CARD_ANALYSIS_STALE），
//   缺失/重复/错绑媒体失败关闭；旧版卡快照保留且不自动过时；
// - Brief：2–5 张当前卡组装 pending_review，逐项结论可反查
//   Knowledge → Analysis → Evidence；未选中卡绝不混入；
// - 审核与审计：approved / return_for_revision；退回必须重建新版再审核；旧决定
//   保留审计（review.comments）但绝不显示为 current；批准前 Handoff 拒绝；
//   旧 Handoff 不再 current；无别名；
// - 命令边界：完整命令链（evidence.create → analysis.create → card.create →
//   brief.assemble → brief.decide → handoff.create）+ 幂等重放 + 两标签页修订
//   冲突（ENTITY_REVISION_STALE / PROJECT_REVISION_STALE）+ 跨项目/跨账号隔离
//   + 在线卡过时门禁 + 决定修订失配 + 无交接包删除命令；
// - 刷新/重新登录恢复：本地 store 往返与在线命令边界重载
//   identity/fingerprint/version/费用 完全一致；
// - 费用：确定性本地分析恒无费用；未返回费用记录不虚构；有记录才绑定；
// - 错误脱敏：不输出 Bearer/JWT/service-role。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ANALYSIS_ID_PATTERN,
  BRIEF_ID_PATTERN,
  CARD_ID_PATTERN,
  EVIDENCE_ID_PATTERN,
  PACKAGE_ID_PATTERN,
  P32_MODEL_ANALYSIS_SCHEMA_VERSION,
  SHA256_PATTERN,
  clonePlain,
  deepFreeze,
  fingerprintOf,
  validateAnalysis,
  validateBrief,
  validateHandoffPackageRecord,
  validateKnowledgeCard,
} from '../src/services/p19-contracts.js';
import {
  addEvidence,
  assembleBrief,
  assembleSynthesisBrief,
  buildKnowledgeCard,
  buildKnowledgeCardsForSelection,
  computeStaleness,
  createProject,
  deriveHandoffPackage,
  getAllAnalysisVersionsForEvidence,
  getLatestAnalysisForEvidence,
  recordVersionedReanalysis,
  reviewBrief,
  runAnalysis,
  updateEvidence,
  validateSynthesisSelection,
  workbenchError,
} from '../src/services/p19-workspace-service.js';
import {
  COMMAND_ALLOWLIST,
  COMMAND_SCHEMA_VERSION,
  executeCommand,
} from '../supabase/functions/p19-workspace-command/command-core.mjs';
import { createP19Store } from '../src/services/p19-store.js';
import { createP20OnlineStore } from '../src/services/p20-online-store.js';
import { createP19CommandClient } from '../src/services/p19-server-write-adapter.js';
import { createP22ResearchAssistClient, importSearchSelection, recomputeSearchBatchId, toP19EvidenceInput } from '../src/services/p22-research-assist.js';

const hash = async (text) => createHash('sha256').update(String(text)).digest('hex');
const now = () => '2026-08-14T08:00:00.000Z';
const USER_A = '44444444-4444-4444-8444-444444444444';
const USER_B = '55555555-5555-5555-8555-555555555555';

// ---- 共享夹具 ----------------------------------------------------------------

/** 构造一条 P22 采集来源证据输入（X 或 Reddit；费用字段与来源证明齐备）。 */
async function collectedInputFor(index, { platform = 'x', externalId = `20870470117534679${index % 10}` } = {}) {
  const text = `M3 采集证据 ${index}：验证统一在线记录入口与费用绑定。`;
  const contentSha256 = await hash(text);
  const sourceUrl = platform === 'reddit'
    ? `https://www.reddit.com/r/test/comments/${externalId}/m3-post-${index}/`
    : `https://x.com/m3author/status/${externalId}`;
  const provider = platform === 'reddit' ? 'apify:endspec/reddit-instant-search-scraper' : 'apify:xquik/x-tweet-scraper';
  const collectionProof = `1999999999.${'c'.repeat(64)}`;
  return {
    // P22 采集来源项合同：id 与 collection_proof 必须在顶层——生产
    // toP19EvidenceInput 只从顶层读取来源 ID 与服务端来源证明（缺失即拒绝）；
    // provenance 中同一值继续保留供证据记录绑定。
    id: `m3-source-${index}`,
    source_url: sourceUrl,
    label: `M3 采集证据 ${index}（${platform}）`,
    // platform 必须是原始规范标识（'x' | 'reddit'）：生产 toP19EvidenceInput
    // 提供方/平台门禁只接受规范标识（UI 展示文案由适配层输出，绝不回灌输入）。
    platform,
    content_text: text,
    // 顶层 content_sha256 必须与 content_text 精确一致（toP19EvidenceInput 哈希门禁
    // 复算原文；同一真实哈希继续保留在 provenance 与 media metadata 中）。
    content_sha256: contentSha256,
    collection_proof: collectionProof,
    recorded_at: '2026-08-13T07:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider,
      source_platform: platform, source_id: `m3-source-${index}`,
      external_id: externalId, source_url: sourceUrl,
      run_id: 'apify-run-m3', collected_at: '2026-08-13T07:00:00.000Z',
      usage_total_usd: 0.0123, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: contentSha256, collection_proof: collectionProof,
      statement: 'M3 测试证据：服务端来源证明绑定正文、身份与采集运行。',
    },
    media_metadata: {
      filename: `m3-${index}.txt`, mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(text).byteLength,
      last_modified: '2026-08-13T07:00:00.000Z', sha256: contentSha256,
    },
    source_metadata: {
      author: { name: `M3 作者 ${index}`, handle: `m3author${index}`, user_id: `99999999999999999${index % 10}` },
      published_at: '2026-08-13T06:00:00.000Z',
      engagement: { likes: 1200 * index, retweets: 300 * index, replies: 80 * index, quotes: 20 * index, views: 50000 * index, bookmarks: 150 * index },
    },
    media_assets: [
      {
        id: `m-${'a'.repeat(16)}${String(index).padStart(8, '0')}`,
        tweet_id: externalId, external_id: externalId,
        canonical_tweet_url: sourceUrl,
        media_url: `https://pbs.twimg.com/media/m3-${index}.jpg`, order: 0, kind: 'image',
        mime_type: 'image/jpeg', dimensions: { width: 1200, height: 800 },
        byte_size: 200000, hash: { algorithm: 'sha256', kind: 'content', value: `${index}a`.repeat(32) },
      },
    ],
  };
}

/** 构造一次 v2 Qwen 模型结果（真实来源身份绑定 + 可选实际费用记录）。 */
function v2ModelResult(sourceId, mediaIds, { cost = null, videoAudio = '存在可用音轨：人声解说。' } = {}) {
  return {
    source_id: sourceId,
    model: 'qwen3.5-omni-flash',
    result: {
      text_expression: 'M3 文本表达：图片吸引注意、文案完成说服。',
      hook: 'M3 钩子：一张图说明一切',
      copy_pattern: '视觉前置 + 短文案',
      target_audience: '关注内容增长的创作者',
      audience_need_emotion: '高效获取确定方法',
      media_analysis: mediaIds.map((id, i) => ({
        media_id: id,
        visual_content: `画面 #${i + 1}：主体突出。`,
        composition: i === 0 ? '中心构图' : `三分法；${videoAudio}`,
        people: '单人', scene: '室内', emotion: '自信',
        visual_selling_points: ['主体突出', '信息明确'],
        style_pattern: '暖色调 + 浅景深',
      })),
      virality_drivers: ['视觉冲击力', '信息密度高'],
      reusable_methods: ['首屏先给结果', '短句强化记忆'],
      rewrite_suggestions: ['加强结尾行动引导'],
      signals: ['高互动率'],
      risks: ['避免夸大结论'],
    },
    executed_at: '2026-08-13T08:01:00.000Z',
    usage: { total_tokens: 1500 },
    cost,
    _request_identity: `m3:${sourceId}:v1`,
  };
}

/** 构造一条 P22/P32 搜索结果项（批量导入入口使用；默认 X 平台）。 */
async function searchItemFor(index, { platform = 'x' } = {}) {
  const input = await collectedInputFor(index, { platform });
  return {
    id: input.provenance.source_id,
    source_url: input.source_url,
    label: input.label,
    platform: input.provenance.source_platform,
    content_text: input.content_text,
    external_id: input.provenance.external_id,
    content_sha256: input.provenance.content_sha256,
    source_metadata: input.source_metadata,
    media_assets: input.media_assets,
    collection_proof: input.provenance.collection_proof,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: input.provenance.provider,
      run_id: input.provenance.run_id,
      collected_at: input.provenance.collected_at,
      usage_total_usd: input.provenance.usage_total_usd,
      budget_reservation_id: input.provenance.budget_reservation_id,
    },
  };
}

async function projectWithCollectedEvidence(count = 2) {
  const project = await createProject({
    topic: 'M3 在线闭环项目', objective: '验证统一入口与完整闭环',
    audience: '运营团队', channel: 'X', now,
  });
  let current = project;
  const evidence = [];
  for (let index = 1; index <= count; index += 1) {
    const input = await collectedInputFor(index);
    current = await addEvidence(current, input, { now, hasher: fingerprintOf });
    evidence.push(current.evidence.find((item) => item.source_url === input.source_url));
  }
  return { project: current, evidence };
}

async function analyzedProject(count = 2, { withCost = true } = {}) {
  const { project, evidence } = await projectWithCollectedEvidence(count);
  let current = project;
  for (const record of evidence) {
    const mediaIds = (record.media_assets || []).map((asset) => asset.id);
    current = await recordVersionedReanalysis(current, record.id, v2ModelResult(record.provenance.source_id, mediaIds, {
      cost: withCost
        ? { actual_usd: 0.0042, recorded_cny: 0.05, reservation_id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' }
        : null,
    }), { now, hasher: fingerprintOf });
  }
  return { project: current, evidence };
}

function assertBoundedNoSecrets(value) {
  assert.ok(!/Bearer\s+[A-Za-z0-9._~+/=-]+/i.test(value), `不得输出 Bearer 令牌：${value}`);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/.test(value), `不得输出 JWT：${value}`);
  for (const key of ['service[_-]?role', 'secret', 'token', 'password']) {
    const match = new RegExp(`(?:${key})\\s*[:=]\\s*([^\\s,;]+)`, 'i').exec(value);
    if (match) assert.equal(match[1], '[redacted]', `Secret 值必须被脱敏（${key}）：${value}`);
  }
}

// ---- 1. 统一在线记录入口（范围 1 + 10）---------------------------------------

test('M3 统一入口：X 单链接 / Reddit 单链接 / 主题搜索批量导入都成为精确 Evidence，费用绑定实际 provider/run/reservation', async () => {
  // 单链接入口（X 与 Reddit 共用同一 toP19EvidenceInput 合同）。
  const xInput = await collectedInputFor(1, { platform: 'x' });
  const redditInput = await collectedInputFor(2, { platform: 'reddit', externalId: 'abc123def456' });
  const xEvidenceInput = await toP19EvidenceInput(xInput);
  const redditEvidenceInput = await toP19EvidenceInput(redditInput);
  assert.equal(xEvidenceInput.platform, 'X · Apify');
  assert.equal(redditEvidenceInput.platform, 'Reddit · Apify');
  assert.equal(xEvidenceInput.provenance.provider, 'apify:xquik/x-tweet-scraper');
  assert.equal(redditEvidenceInput.provenance.provider, 'apify:endspec/reddit-instant-search-scraper');
  // 费用绑定：usage_total_usd / budget_reservation_id / run_id 原样进入 provenance。
  for (const record of [xEvidenceInput, redditEvidenceInput]) {
    assert.equal(record.provenance.usage_total_usd, 0.0123);
    assert.equal(record.provenance.budget_reservation_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(record.provenance.run_id, 'apify-run-m3');
    assert.match(record.provenance.collection_proof, /^\d{10}\.[0-9a-f]{64}$/i);
  }

  const project = await createProject({
    topic: '统一入口', objective: '批量导入', audience: 'a', channel: 'X', now,
  });
  // 主题搜索批量导入入口：2–5 条选择，原子写入，费用逐条绑定。
  const batch = {
    batch_id: '', project_id: project.id, platform: 'x', keyword: '统一入口', count: 2, sort_intent: 'latest',
    run_id: 'apify-run-m3', collected_at: '2026-08-13T07:00:00.000Z',
    items: [await searchItemFor(1, { platform: 'x' }), await searchItemFor(2, { platform: 'x' })],
  };
  batch.batch_id = await recomputeSearchBatchId(batch);
  const imported = await importSearchSelection({ project, batch, selectedIds: [batch.items[0].id, batch.items[1].id], nowMs: Date.parse('2026-08-14T08:00:00.000Z') });
  assert.equal(imported.imported, 2);
  for (const record of imported.project.evidence) {
    assert.equal(record.provenance.usage_total_usd, 0.0123);
    assert.equal(record.provenance.budget_reservation_id, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    assert.equal(record.provenance.run_id, 'apify-run-m3');
  }
  // 同一选择幂等重试：0 新增、0 重复记录。
  const retry = await importSearchSelection({ project: imported.project, batch, selectedIds: [batch.items[0].id, batch.items[1].id], nowMs: Date.parse('2026-08-14T08:00:00.000Z'), skipAlreadyImported: true });
  assert.equal(retry.imported, 0);
  assert.equal(retry.alreadyImported, 2);
  assert.equal(retry.project.evidence.length, 2, '幂等重试绝不产生重复 Evidence');
});

// ---- 2. 版本化分析：当前有效绑定 + 显式新版本 + 费用绑定（范围 2 + 10）--------

test('M3 版本化分析：Evidence 绑定当前有效 model_analysis；新分析形成显式新版本，旧版可查看且不被覆盖', async () => {
  const { project, evidence } = await analyzedProject(1, { withCost: true });
  const record = evidence[0];
  const mediaIds = record.media_assets.map((asset) => asset.id);
  const v1 = getLatestAnalysisForEvidence(project, record.id);
  assert.equal(v1.version, 1);
  assert.equal(v1.evidence_id, record.id);
  assert.equal(v1.evidence_fingerprint, record.fingerprint);
  assert.equal(v1.evidence_version, record.version);
  assert.equal(v1.model_analysis.schema_version, P32_MODEL_ANALYSIS_SCHEMA_VERSION);
  // 实际费用记录已随分析绑定（绝不虚构）。
  assert.equal(v1.model_analysis.usage.total_tokens, 1500);
  assert.equal(v1.model_analysis.usage.actual_usd, 0.0042);
  assert.equal(v1.model_analysis.usage.recorded_cny, 0.05);
  assert.equal(v1.model_analysis.usage.reservation_id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
  assert.equal(validateAnalysis(v1).valid, true, validateAnalysis(v1).issues.join('；'));

  // 新分析 → 显式新版本（追加不覆写）。
  const second = v2ModelResult(record.provenance.source_id, mediaIds, {
    cost: { actual_usd: 0.0051, recorded_cny: 0.05, reservation_id: 'cccccccc-dddd-4eee-8fff-000000000000' },
  });
  second._request_identity = 'm3:second-version';
  second.result.hook = 'M3 钩子 v2：更强的开头';
  const afterV2 = await recordVersionedReanalysis(project, record.id, second, { now, hasher: fingerprintOf });
  const versions = getAllAnalysisVersionsForEvidence(afterV2, record.id);
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map((row) => row.version), [2, 1]);
  // v1 不可变：id/指纹原样保留，未被覆写。
  assert.equal(versions[1].id, v1.id);
  assert.equal(versions[1].fingerprint, v1.fingerprint);
  assert.equal(versions[1].model_analysis.usage.reservation_id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', '旧版费用绑定不被新版覆盖');
  // 最新选择确定性。
  assert.equal(getLatestAnalysisForEvidence(afterV2, record.id).version, 2);
  assert.equal(getLatestAnalysisForEvidence(afterV2, record.id).model_analysis.usage.reservation_id, 'cccccccc-dddd-4eee-8fff-000000000000');
  // 相同请求身份不产生重复版本（幂等重放）。
  const dedup = await recordVersionedReanalysis(afterV2, record.id, second, { now, hasher: fingerprintOf });
  assert.equal(dedup.analyses.length, 2);
});

test('M3 费用不虚构：未返回费用记录的分析保持只有用量；确定性本地分析恒为无费用', async () => {
  const { project, evidence } = await analyzedProject(1, { withCost: false });
  const record = evidence[0];
  const analysis = getLatestAnalysisForEvidence(project, record.id);
  assert.deepEqual(analysis.model_analysis.usage, { total_tokens: 1500 }, '未返回费用记录时 usage 只有用量，绝不虚构费用字段');
  assert.equal(validateAnalysis(analysis).valid, true);

  // 确定性本地分析：model 恒 null、无 model_analysis、无任何费用字段。
  const { project: plainProject, evidence: plainEvidence } = await projectWithCollectedEvidence(1);
  const withDet = await runAnalysis(plainProject, plainEvidence[0].id, { now, hasher: fingerprintOf });
  const det = withDet.analyses[0];
  assert.equal(det.model_analysis, undefined);
  assert.equal(det.provenance.model, null);
  assert.equal(validateAnalysis(det).valid, true);
  assert.match(det.provenance.statement, /不调用任何模型|无费用/);
});

// ---- 3. 知识卡门禁：只从当前、完整、准确绑定的分析生成（范围 3）-------------

test('M3 知识卡门禁：过时分析（来源已变化）拒绝构建，项目不变；旧版卡快照保留且不自动过时', async () => {
  const { project, evidence } = await analyzedProject(1);
  const record = evidence[0];
  const latest = getLatestAnalysisForEvidence(project, record.id);
  const before = project.fingerprint;

  // 过时分析：证据编辑后分析绑定旧版证据 → 拒绝构建新卡。
  const edited = await updateEvidence(project, record.id, { label: '已编辑标签' }, { now, hasher: fingerprintOf });
  await assert.rejects(
    () => buildKnowledgeCard(edited, latest.id, { now, hasher: fingerprintOf }),
    (cause) => cause.code === 'CARD_ANALYSIS_STALE' && /重新分析/.test(cause.message),
  );
  assert.equal(project.fingerprint, before, '门禁失败时项目完全不变');
  // 过时传播确定性：该分析与其卡都标记 stale，但绝不删除。
  const staleness = await computeStaleness(edited, { hasher: fingerprintOf });
  assert.equal(staleness.analysis_stale_ids.includes(latest.id), true);

  // 旧版卡快照：v1 分析时构建的卡，在 v2 分析存在后仍有效（不自动过时）。
  const withCardV1 = await buildKnowledgeCard(project, latest.id, { now, hasher: fingerprintOf });
  const cardV1 = withCardV1.knowledge_cards[0];
  assert.equal(validateKnowledgeCard(cardV1).valid, true, '生成的卡必须通过 content_knowledge_card_v1 校验');
  const second = v2ModelResult(record.provenance.source_id, record.media_assets.map((asset) => asset.id));
  second._request_identity = 'm3:card-snapshot-v2';
  second.result.hook = 'M3 钩子 v2';
  const afterV2 = await recordVersionedReanalysis(withCardV1, record.id, second, { now, hasher: fingerprintOf });
  const staleAfterV2 = await computeStaleness(afterV2, { hasher: fingerprintOf });
  assert.equal(staleAfterV2.card_stale_ids.includes(cardV1.id), false, '新分析不使旧版卡自动过时（P32-A 快照语义）');
  // 旧版本恢复：旧分析（未过时）仍可确定性恢复其卡（同一卡幂等复用）。
  const restored = await buildKnowledgeCard(afterV2, latest.id, { now, hasher: fingerprintOf });
  const restoredCard = restored.knowledge_cards.find((card) => card.id === cardV1.id);
  assert.equal(restoredCard.fingerprint, cardV1.fingerprint, '旧版恢复必须返回同一不可变卡');
});

test('M3 知识卡门禁：缺失证据/错绑/缺哈希/重复与外来媒体一律失败关闭', async () => {
  const { project, evidence } = await analyzedProject(1);
  const record = evidence[0];
  const latest = getLatestAnalysisForEvidence(project, record.id);

  // 分析绑定证据缺失（被移除后）→ 拒绝。
  const pruned = clonePlain(project);
  pruned.evidence = pruned.evidence.filter((item) => item.id !== record.id);
  await assert.rejects(
    () => buildKnowledgeCard(pruned, latest.id, { now, hasher: fingerprintOf }),
    { code: 'EVIDENCE_NOT_FOUND' },
  );
  // 证据媒体被换序（与已保存分析绑定不一致）→ 拒绝。
  const reordered = clonePlain(project);
  reordered.evidence = [{
    ...reordered.evidence[0],
    media_assets: [reordered.evidence[0].media_assets[0], ...(reordered.evidence[0].media_assets || [])].slice(0, 2).reverse(),
  }];
  await assert.rejects(
    () => buildKnowledgeCard(reordered, latest.id, { now, hasher: fingerprintOf }),
    { code: 'CARD_MEDIA_BINDING_INVALID' },
  );
  // 媒体哈希降级为 URL 哈希（旧合同）→ 拒绝继承。
  const legacy = clonePlain(project);
  legacy.evidence = [{
    ...legacy.evidence[0],
    media_assets: legacy.evidence[0].media_assets.map((asset) => ({ ...asset, hash: { algorithm: 'sha256', kind: 'url', value: 'd'.repeat(64) } })),
  }];
  await assert.rejects(
    () => buildKnowledgeCard(legacy, latest.id, { now, hasher: fingerprintOf }),
    { code: 'CARD_MEDIA_HASH_MISSING' },
  );
  // 逐媒体分析重复/外来媒体（分析结果错绑）→ 保存时失败关闭（项目不变）。
  const mediaIds = record.media_assets.map((asset) => asset.id);
  const base = v2ModelResult(record.provenance.source_id, mediaIds);
  await assert.rejects(
    () => recordVersionedReanalysis(project, record.id, { ...base, result: { ...base.result, media_analysis: [base.result.media_analysis[0], base.result.media_analysis[0]] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  await assert.rejects(
    () => recordVersionedReanalysis(project, record.id, { ...base, result: { ...base.result, media_analysis: [{ ...base.result.media_analysis[0], media_id: 'm-cccccccccccccccccccccccc' }] } }, { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_MEDIA_BINDING_INVALID' },
  );
  assert.equal(project.analyses.length, 1, '失败关闭时项目完全不变');
});

// ---- 4. Brief：2–5 张当前卡组装，逐项结论可反查（范围 4）----------------------

test('M3 Brief：2–5 张当前卡组装 pending_review；未选中卡绝不混入；逐项结论反查 Knowledge→Analysis→Evidence', async () => {
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);
  const selected = [ids[0], ids[1]];

  // 先为未选中的帖子 3 也生成知识卡（必须被 Brief 隔离）。
  let prepared = await buildKnowledgeCardsForSelection(project, selected, { now, hasher: fingerprintOf }).then((result) => result.project);
  prepared = await buildKnowledgeCard(prepared, getLatestAnalysisForEvidence(prepared, ids[2]).id, { now, hasher: fingerprintOf });
  const unselectedCard = prepared.knowledge_cards.find((card) => card.analysis_id === getLatestAnalysisForEvidence(prepared, ids[2]).id);

  const afterBrief = await assembleSynthesisBrief(prepared, { selectedEvidenceIds: selected, now, hasher: fingerprintOf });
  const brief = afterBrief.brief;
  assert.equal(brief.status, 'pending_review');
  assert.equal(brief.review.decision, null);
  assert.ok(!brief.knowledge_citation_ids.includes(unselectedCard.id), '未选中的知识卡绝不混入 Brief');
  assert.equal(brief.knowledge_citation_ids.length, 2, 'Brief 只引用本次选择的 2 张卡');
  // 精确引用范围：本次选择（按项目卡顺序）的每张卡都必须精确绑定所选证据的最新分析。
  const selectedAnalyses = selected.map((evidenceId) => getLatestAnalysisForEvidence(afterBrief, evidenceId));
  const expectedCitations = afterBrief.knowledge_cards
    .filter((card) => selectedAnalyses.some((analysis) => analysis.id === card.analysis_id
      && card.analysis_fingerprint === analysis.fingerprint && card.analysis_version === analysis.version))
    .map((card) => card.id);
  assert.deepEqual(brief.knowledge_citation_ids, expectedCitations, 'Brief 引用必须精确等于本次选择的分析绑定卡');
  const verdict = validateBrief(brief);
  assert.equal(verdict.valid, true, verdict.issues.join('；'));
  // 逐项结论反查：每条引用卡 → 分析 → 证据（精确 fingerprint/version，绝不 alias）。
  const cardById = new Map(afterBrief.knowledge_cards.map((card) => [card.id, card]));
  const analysisById = new Map(afterBrief.analyses.map((analysis) => [analysis.id, analysis]));
  for (const cardId of brief.knowledge_citation_ids) {
    const card = cardById.get(cardId);
    assert.ok(card, `引用卡 ${cardId} 必须存在`);
    const analysis = analysisById.get(card.analysis_id);
    assert.ok(analysis, '引用卡必须绑定存在的分析');
    assert.equal(card.analysis_fingerprint, analysis.fingerprint, '卡与分析指纹必须精确一致');
    assert.equal(card.analysis_version, analysis.version);
    assert.equal(analysis.evidence_id, card.evidence_links[0]?.source_ref, '分析证据与卡来源引用必须一致');
    const record = afterBrief.evidence.find((item) => item.id === analysis.evidence_id);
    assert.ok(record, '分析必须绑定存在的证据');
    assert.equal(analysis.evidence_fingerprint, record.fingerprint, '分析与证据指纹必须精确一致');
    assert.equal(analysis.evidence_version, record.version);
  }
  // 多帖综合快照绑定 2..5 个互异 Evidence 身份。
  const synthesis = brief.p32_synthesis;
  assert.ok(synthesis);
  assert.deepEqual(synthesis.selected_evidence_ids, [ids[0], ids[1]]);
  assert.equal(synthesis.source_snapshot.length, 2);
});

test('M3 Brief 门禁：缺少/过时/错绑卡与跨项目选择整体失败关闭，项目不变', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);
  const before = project.fingerprint;

  // 缺少知识卡。
  await assert.rejects(
    () => assembleSynthesisBrief(project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf }),
    (cause) => cause.code === 'P32_SYNTHESIS_CARDS_MISSING',
  );
  // 过时卡（篡改卡的分析指纹快照）。
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const staleCards = clonePlain(withCards.project);
  staleCards.knowledge_cards[0].analysis_fingerprint = 'd'.repeat(64);
  await assert.rejects(
    () => assembleSynthesisBrief(staleCards, { selectedEvidenceIds: ids, now, hasher: fingerprintOf }),
    (cause) => cause.code === 'P32_SYNTHESIS_CARDS_STALE',
  );
  // 跨项目证据选择。
  const { project: other } = await projectWithCollectedEvidence(1);
  const crossVerdict = validateSynthesisSelection(project, [ids[0], other.evidence[0].id]);
  assert.equal(crossVerdict.valid, false, '跨项目选择必须失败关闭');
  // 少于 2 条 / 重复 / 别名选择。
  assert.equal(validateSynthesisSelection(project, [ids[0]]).valid, false);
  assert.equal(validateSynthesisSelection(project, [ids[0], ids[1], ids[0]]).valid, false);
  assert.equal(validateSynthesisSelection(project, [ids[0].slice(0, 10), ids[1]]).valid, false, '截断 id 不能代理身份');
  assert.equal(project.fingerprint, before, '失败关闭时项目完全不变');
});

// ---- 5. 审核与审计：退回 → 新版本 → 批准；旧决定/旧 Handoff 保留审计（范围 5）---

test('M3 审核：退回必须重建新版本再审核；旧决定保留审计但绝不 current；批准前 Handoff 拒绝', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const v1 = await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  assert.equal(v1.brief.version, 1);

  // 批准前 Handoff 拒绝。
  await assert.rejects(
    () => deriveHandoffPackage(v1, { now, hasher: fingerprintOf }),
    { code: 'HANDOFF_BRIEF_NOT_APPROVED' },
  );

  // 退回 v1（必须填写理由；审计条目随决定写入 comments）。
  const returned = await reviewBrief(v1, { decision: 'return_for_revision', rationale: '钩子需要更锋利', comment: '首屏信息密度不足', now });
  assert.equal(returned.brief.status, 'returned');
  assert.equal(returned.brief.review.decision.value, 'return_for_revision');
  assert.ok(returned.brief.review.comments.some((item) => item.includes('[第 1 版 已退回修改]')), '退回决定必须写入审计记录');
  assert.ok(returned.brief.review.comments.some((item) => item.includes('首屏信息密度不足')), '用户评论随决定保留');

  // 已决定 Brief 不能重复决定（退回后必须先重建新版本）。
  await assert.rejects(
    () => reviewBrief(returned, { decision: 'approved', rationale: '重复决定', now }),
    { code: 'BRIEF_REVIEW_STATE_INVALID' },
  );

  // 重建 → v2 pending，旧决定重置为 null（不 current），审计评论延续。
  const v2 = await assembleSynthesisBrief(returned, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  assert.equal(v2.brief.version, 2);
  assert.equal(v2.brief.status, 'pending_review');
  assert.equal(v2.brief.review.decision, null, '旧决定绝不显示为 current');
  assert.ok(v2.brief.review.comments.some((item) => item.includes('[第 1 版 已退回修改]')), '旧决定保留审计（随重建延续）');
  assert.equal(v2.handoff, null, '旧 Handoff 不 current');
  assert.deepEqual(v2.handoffs, []);

  // 批准 v2 → 可派生交接包（绑定第 2 版）。
  const approved = await reviewBrief(v2, { decision: 'approved', rationale: '已按意见重建并复核', now });
  assert.equal(approved.brief.status, 'approved');
  assert.ok(approved.brief.review.comments.some((item) => item.includes('[第 2 版 已批准]')), '批准决定写入审计记录');
  const withHandoff = await deriveHandoffPackage(approved, { now, hasher: fingerprintOf });
  const handoff = withHandoff.handoff;
  assert.match(handoff.id, PACKAGE_ID_PATTERN);
  assert.equal(handoff.brief_provenance.brief_id, approved.brief.id);
  assert.equal(handoff.brief_provenance.brief_version, 2, '交接包必须绑定当前批准版本');
  assert.equal(handoff.brief_provenance.brief_status, 'approved');
  assert.equal(handoff.human_decision.value, 'approved');
  assert.deepEqual(handoff.execution_flags, {
    generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false,
  });
  assert.equal(validateHandoffPackageRecord(handoff).valid, true);
  // 批准后再决定被拒绝（不得覆盖已批准决定）。
  await assert.rejects(
    () => reviewBrief(withHandoff, { decision: 'return_for_revision', rationale: '已批准不得重复决定', now }),
    { code: 'BRIEF_REVIEW_STATE_INVALID' },
  );
});

test('M3 审核：重建后旧 Handoff 不再 current，新批准派生新交接包（绝不复用旧决定）', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const v1 = await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  const approvedV1 = await reviewBrief(v1, { decision: 'approved', rationale: '第一版批准', now });
  const withHandoffV1 = await deriveHandoffPackage(approvedV1, { now, hasher: fingerprintOf });
  const handoffV1 = withHandoffV1.handoff;
  assert.equal(handoffV1.brief_provenance.brief_version, 1);

  // 上游变化 → 重建 v2（旧 Handoff 与旧决定全部作废，不再 current）。
  const v2 = await assembleSynthesisBrief(withHandoffV1, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  assert.equal(v2.handoff, null, '重建后旧 Handoff 不得继续显示为 current');
  assert.deepEqual(v2.handoffs, []);
  assert.equal(v2.brief.review.decision, null);
  // 旧决定保留审计（comments 含 v1 批准条目），但绝不能直接据其创建 Handoff。
  assert.ok(v2.brief.review.comments.some((item) => item.includes('[第 1 版 已批准]')));
  await assert.rejects(
    () => deriveHandoffPackage(v2, { now, hasher: fingerprintOf }),
    { code: 'HANDOFF_BRIEF_NOT_APPROVED' },
  );
  // 重新批准 v2 → 新交接包：新 id、绑定第 2 版、新决定快照。
  const approvedV2 = await reviewBrief(v2, { decision: 'approved', rationale: '第二版批准', now: () => '2026-08-14T08:05:00.000Z' });
  const withHandoffV2 = await deriveHandoffPackage(approvedV2, { now, hasher: fingerprintOf });
  const handoffV2 = withHandoffV2.handoff;
  assert.notEqual(handoffV2.id, handoffV1.id, '新交接包必须产生新 identity');
  assert.equal(handoffV2.brief_provenance.brief_version, 2);
  assert.notEqual(handoffV2.human_decision.decided_at, handoffV1.human_decision.decided_at, '决定快照不得复用');
  // 旧 Handoff 记录本身不可变（v1 指纹保持原样，审计数据不被覆写）。
  assert.match(handoffV1.fingerprint, SHA256_PATTERN);
  assert.equal(validateHandoffPackageRecord(handoffV1).valid, true, '旧交接包记录仍是合法审计数据');
});

test('M3 无别名：修改返回快照绝不污染项目或兄弟结果', async () => {
  const { project, evidence } = await analyzedProject(2);
  const ids = evidence.map((item) => item.id);
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const brief = (await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf })).brief;
  const before = JSON.stringify(project);

  // 修改返回值（卡指纹/决定/comments）不得污染项目来源。
  withCards.cards[0].analysis_fingerprint = 'f'.repeat(64);
  withCards.project.knowledge_cards[0].fingerprint = 'f'.repeat(64);
  brief.review.comments[0] = '外部篡改';
  assert.equal(JSON.stringify(project), before, '修改返回值不得污染项目来源');
  // 再次读取必须返回干净数据。
  const again = (await buildKnowledgeCardsForSelection(withCards.project, ids, { now, hasher: fingerprintOf })).project;
  assert.notEqual(again.knowledge_cards[0].analysis_fingerprint, 'f'.repeat(64));
});

// ---- 6. 命令边界：完整命令链 + 幂等 + 并发冲突 + 隔离 + 在线门禁（范围 7 + 9）----

function memoryDb() {
  const state = { commands: [], projects: new Map(), evidence: [], analyses: [], cards: [], briefs: [], handoffs: [] };
  function boundaryError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  function reserve(userId, meta) {
    const requestIdentity = JSON.stringify({
      command: meta.command, entity_type: meta.entity_type, entity_id: meta.entity_id,
      project_id: meta.project_id ?? meta.payload?.project_id ?? meta.payload?.id ?? null,
      request_summary: meta.request_summary || {},
      expected_base_version: meta.expected_base_version ?? null,
      expected_entity_fingerprint: meta.expected_entity_fingerprint ?? null,
    });
    const existing = state.commands.find((entry) => entry.user_id === userId && entry.idempotency_key === meta.idempotency_key);
    if (existing) {
      if (existing.request_identity !== requestIdentity) throw boundaryError('IDEMPOTENCY_CONFLICT');
      return { outcome: 'replayed', ledger: existing };
    }
    state.commands.push({
      user_id: userId, idempotency_key: meta.idempotency_key, command: meta.command,
      entity_type: meta.entity_type, entity_id: meta.entity_id, status: 'applied',
      request_summary: meta.request_summary || {}, request_identity: requestIdentity, diagnostics: {},
    });
    return null;
  }
  function rollbackReservation(userId, meta) {
    const index = state.commands.findIndex((entry) => entry.user_id === userId && entry.idempotency_key === meta.idempotency_key);
    if (index >= 0) state.commands.splice(index, 1);
  }
  async function writeEntity(userId, meta) {
    const reserved = reserve(userId, meta);
    if (reserved) return reserved;
    if (meta.declared_sha) {
      const actual = await fingerprintOf(meta.payload);
      if (actual !== meta.declared_sha) {
        rollbackReservation(userId, meta);
        throw boundaryError('PAYLOAD_HASH_MISMATCH');
      }
    }
    const projectId = meta.table === 'p19_research_projects_v1' ? meta.payload.id : meta.payload.project_id;
    const projectRow = projectId ? state.projects.get(`${userId}:${projectId}`) : null;
    const archiving = meta.table === 'p19_research_projects_v1' && meta.payload.status === 'archived';
    if (projectRow && projectRow.status === 'archived' && !archiving) {
      rollbackReservation(userId, meta);
      throw boundaryError('PROJECT_ARCHIVED');
    }
    if (meta.table === 'p19_research_projects_v1') {
      const key = `${userId}:${meta.payload.id}`;
      const current = state.projects.get(key);
      const expectedBase = meta.expected_base_version;
      const latestVersion = current ? Number(current.version) : null;
      const baseOk = expectedBase === null || expectedBase === undefined
        ? latestVersion === null || latestVersion === undefined
        : latestVersion === expectedBase;
      if (!baseOk) {
        rollbackReservation(userId, meta);
        throw boundaryError('PROJECT_REVISION_STALE');
      }
      state.projects.set(key, clonePlain(meta.payload));
    } else {
      const table = state[meta.table === 'p19_evidence_records_v1' ? 'evidence'
        : meta.table === 'p19_analyses_v1' ? 'analyses'
          : meta.table === 'p19_knowledge_cards_v1' ? 'cards'
            : meta.table === 'p19_briefs_v1' ? 'briefs'
              : meta.table === 'p19_handoff_packages_v1' ? 'handoffs' : null];
      if (!table) {
        rollbackReservation(userId, meta);
        throw boundaryError('UNKNOWN_TABLE');
      }
      const row = clonePlain(meta.payload);
      row.user_id = userId;
      const index = table.findIndex((item) => item.user_id === userId && item.project_id === String(row.project_id || '') && item.id === String(meta.entity_id));
      const current = index >= 0 ? table[index] : null;
      const expectedFingerprint = meta.expected_entity_fingerprint ?? null;
      const baselineOk = current
        ? expectedFingerprint !== null && current.fingerprint === expectedFingerprint
        : expectedFingerprint === null;
      if (!baselineOk) {
        rollbackReservation(userId, meta);
        throw boundaryError('ENTITY_REVISION_STALE');
      }
      if (index >= 0) table[index] = row;
      else table.push(row);
    }
    return { outcome: 'applied', entity: { type: meta.entity_type, id: meta.entity_id } };
  }
  async function removeEvidence(userId, meta) {
    const reserved = reserve(userId, meta);
    if (reserved) return reserved;
    const projectRow = state.projects.get(`${userId}:${meta.project_id}`);
    if (projectRow && projectRow.status === 'archived') {
      rollbackReservation(userId, meta);
      throw boundaryError('PROJECT_ARCHIVED');
    }
    const index = state.evidence.findIndex((item) => item.user_id === userId && item.project_id === meta.project_id && item.id === meta.evidence_id);
    if (index < 0) {
      rollbackReservation(userId, meta);
      throw boundaryError('EVIDENCE_NOT_FOUND');
    }
    if (!meta.expected_entity_fingerprint || state.evidence[index].fingerprint !== meta.expected_entity_fingerprint) {
      rollbackReservation(userId, meta);
      throw boundaryError('ENTITY_REVISION_STALE');
    }
    state.evidence.splice(index, 1);
    return { outcome: 'applied', entity: { type: 'evidence', id: meta.evidence_id } };
  }
  return {
    _state: state,
    async getProject(userId, projectId) {
      const project = state.projects.get(`${userId}:${projectId}`);
      return project ? clonePlain(project) : null;
    },
    async listProjectEntities(userId, projectId) {
      const pick = (rows) => rows.filter((row) => row.user_id === userId && row.project_id === projectId);
      // 镜像真实边界：user_id 是独立列，绝不混入 JSONB 载荷。存储行内部仍保留
      // 该列用于按用户过滤；返回给命令核心的行必须剥离它，否则 P22 幂等重放的
      // 指纹比对（存储行 vs 新建记录）会被 user_id 污染，同内容重放被误判冲突。
      const withoutUserColumn = (row) => {
        const copy = clonePlain(row);
        delete copy.user_id;
        return copy;
      };
      const briefs = pick(state.briefs).slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      const handoffs = pick(state.handoffs).slice().sort((a, b) => (Number(b.version) || 0) - (Number(a.version) || 0));
      return {
        evidence: pick(state.evidence).map(withoutUserColumn),
        analyses: pick(state.analyses).map(withoutUserColumn),
        cards: pick(state.cards).map(withoutUserColumn),
        brief: briefs.length > 0 ? withoutUserColumn(briefs[0]) : null,
        handoff: handoffs.length > 0 ? withoutUserColumn(handoffs[0]) : null,
      };
    },
    writeEntity,
    removeEvidence,
  };
}

function request(command, payload, idempotencyKey = 'key-1') {
  return { schema_version: COMMAND_SCHEMA_VERSION, command, idempotency_key: idempotencyKey, payload };
}

/** 从边界实体状态重建项目快照（镜像 applyProjectRead）。 */
async function snapshotFrom(db, userId, projectId) {
  const project = await db.getProject(userId, projectId);
  const entities = await db.listProjectEntities(userId, projectId);
  const rebuilt = {
    ...clonePlain(project),
    evidence: entities.evidence, analyses: entities.analyses,
    knowledge_cards: entities.cards, brief: entities.brief,
    handoff: entities.handoff, handoffs: entities.handoff ? [entities.handoff] : [],
    lineage: null, fingerprint: '',
  };
  rebuilt.fingerprint = await fingerprintOf(rebuilt);
  return rebuilt;
}

test('M3 命令边界：evidence.create → analysis.create → card.create → brief.assemble → brief.decide → handoff.create 完整链', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };

  const created = await executeCommand({
    ...request('project.create', { project: { topic: 'M3 链', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'm3-k1'),
    ...role,
  }, { db });
  assert.equal(created.ok, true);
  const projectId = created.entity.id;

  // evidence.create（P22 采集证据；费用绑定真实采集运行）。基线 fixture 一次
  // 构造并深冻结为不可变；首次创建与同键重放每次都从同一基线深克隆请求——
  // 生产命令规范化绝不触碰基线，重放请求身份逐字一致。P22 证据的身份是确定
  // 性的：record.id 由 {project_id, provider, source_url, external_id,
  // content_sha256} 派生，created_at 跟随 recorded_at（不含时钟值），因此
  // 同键、同内容重放必然命中同一 Evidence 身份（绝不依赖手工证据的时钟值）。
  const m3k2EvidenceText = 'M3 命令链证据正文。';
  const m3k2EvidenceSha = await hash(m3k2EvidenceText);
  const m3k2EvidenceBaseline = deepFreeze({
    source_url: 'https://example.com/m3/x', label: 'M3 证据', platform: 'x',
    content_text: m3k2EvidenceText, recorded_at: '2026-08-13T07:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: 'm3-command-chain-source',
      external_id: '20870470117534679', source_url: 'https://example.com/m3/x',
      run_id: 'apify-run-m3-command', collected_at: '2026-08-13T07:00:00.000Z',
      usage_total_usd: 0.0123, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      content_sha256: m3k2EvidenceSha,
      collection_proof: `1999999999.${'c'.repeat(64)}`,
      statement: 'M3 命令链测试证据：服务端来源证明绑定正文、身份与采集运行。',
    },
    media_metadata: {
      filename: 'm3-command-chain.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new globalThis.TextEncoder().encode(m3k2EvidenceText).byteLength,
      last_modified: '2026-08-13T07:00:00.000Z', sha256: m3k2EvidenceSha,
    },
  });
  const evidence = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: clonePlain(m3k2EvidenceBaseline) }, 'm3-k2'),
    ...role,
  }, { db, verifyP22Evidence: async () => true });
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.match(evidence.entity.id, EVIDENCE_ID_PATTERN);
  const evidenceId = evidence.entity.id;

  // analysis.create（客户端经服务派生后提交）。
  const snapshot = await snapshotFrom(db, USER_A, projectId);
  const analysisRecord = (await runAnalysis(snapshot, evidenceId, { now, hasher: fingerprintOf })).analyses[0];
  const analysis = await executeCommand({
    ...request('analysis.create', { project_id: projectId, analysis: analysisRecord }, 'm3-k3'),
    ...role,
  }, { db });
  assert.equal(analysis.ok, true, JSON.stringify(analysis));
  assert.match(analysis.entity.id, ANALYSIS_ID_PATTERN);
  const analysisId = analysis.entity.id;

  // card.create（服务派生后提交；边界校验分析→证据当前绑定）。
  const snapshotWithAnalysis = await snapshotFrom(db, USER_A, projectId);
  const cardRecord = (await buildKnowledgeCard(snapshotWithAnalysis, analysisId, { now, hasher: fingerprintOf })).knowledge_cards[0];
  const card = await executeCommand({
    ...request('card.create', { project_id: projectId, card: cardRecord }, 'm3-k4'),
    ...role,
  }, { db });
  assert.equal(card.ok, true, JSON.stringify(card));
  assert.match(card.entity.id, CARD_ID_PATTERN);

  // brief.assemble（服务派生后提交；P24 既有入口，引用全部卡）。
  const snapshotWithCard = await snapshotFrom(db, USER_A, projectId);
  const briefRecord = (await assembleBrief(snapshotWithCard, { now, hasher: fingerprintOf })).brief;
  const brief = await executeCommand({
    ...request('brief.assemble', { project_id: projectId, brief: briefRecord }, 'm3-k5'),
    ...role,
  }, { db });
  assert.equal(brief.ok, true, JSON.stringify(brief));
  assert.match(brief.entity.id, BRIEF_ID_PATTERN);
  const pendingBrief = (await db.listProjectEntities(USER_A, projectId)).brief;
  assert.equal(pendingBrief.status, 'pending_review');

  // brief.decide：修订失配被拒绝（两标签页旧快照）。
  const mismatch = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: pendingBrief.id, brief_version: 99, value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-13T08:02:00.000Z' },
    }, 'm3-k6'),
    ...role,
  }, { db });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'DECISION_REVISION_MISMATCH');

  // brief.decide 批准（两标签页冲突：旧 expected_fingerprint 在写入时被边界拒绝）。
  const decide = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: pendingBrief.id, brief_version: pendingBrief.version, value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-13T08:02:00.000Z' },
    }, 'm3-k7'),
    ...role,
  }, { db });
  assert.equal(decide.ok, true, JSON.stringify(decide));
  // 同一修订再次决定（旧快照，模拟第二个标签页）→ ENTITY_REVISION_STALE。
  const staleDecision = await executeCommand({
    ...request('brief.decide', {
      project_id: projectId,
      expected_fingerprint: pendingBrief.fingerprint,
      decision: { brief_id: pendingBrief.id, brief_version: pendingBrief.version, value: 'return_for_revision', source: 'local_manual', rationale: '旧快照不得覆盖', decided_by: 'racing-reviewer', decided_at: '2026-08-13T08:02:01.000Z' },
    }, 'm3-k7-stale'),
    ...role,
  }, { db });
  assert.equal(staleDecision.ok, false);
  assert.equal(staleDecision.code, 'ENTITY_REVISION_STALE', '两标签页并发决定必须失败关闭，绝不覆盖已批准决定');
  const decidedBrief = (await db.listProjectEntities(USER_A, projectId)).brief;
  assert.equal(decidedBrief.status, 'approved');
  assert.equal(decidedBrief.review.decision.value, 'approved');

  // handoff.create：从持久化链精确派生后提交（边界重派生比对 canonical JSON）。
  const beforeHandoff = await snapshotFrom(db, USER_A, projectId);
  const exactHandoff = (await deriveHandoffPackage(beforeHandoff, { now: () => '2026-08-13T08:03:00.000Z', hasher: fingerprintOf })).handoff;
  const handoff = await executeCommand({
    ...request('handoff.create', { project_id: projectId, handoff: exactHandoff }, 'm3-k8'),
    ...role,
  }, { db });
  assert.equal(handoff.ok, true, JSON.stringify(handoff));
  assert.match(handoff.entity.id, PACKAGE_ID_PATTERN);
  assert.deepEqual(exactHandoff.execution_flags, {
    generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false,
  });

  // 幂等重放（项目已进入 handoff-ready 之后）：从同一不可变基线深克隆的、与
  // 首次创建逐字一致的请求重放此前已成功的 evidence.create（m3-k2）——
  // 绝不写入新记录、绝不产生重复记录、返回同一 Evidence 身份；
  // 同一幂等键绑定不同请求内容仍整体失败关闭（IDEMPOTENCY_CONFLICT）。
  const replay = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: clonePlain(m3k2EvidenceBaseline) }, 'm3-k2'),
    ...role,
  }, { db, verifyP22Evidence: async () => true });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.applied, false, '同键同请求重放绝不重复写入');
  assert.equal(replay.replay_of.status, 'applied', '重放必须命中此前已成功的同一请求');
  assert.equal(replay.entity.id, evidenceId, '重放必须返回同一 Evidence 身份');
  // 同键、不同内容：正文与哈希同时变化（哈希门禁仍通过），确定性身份
  // （content_sha256 参与 id 派生）与请求身份双双改变 → 边界必须整体失败
  // 关闭（IDEMPOTENCY_CONFLICT），且绝不写入任何记录。
  const conflictText = 'M3 命令链冲突证据正文。';
  const conflictEvidence = clonePlain(m3k2EvidenceBaseline);
  conflictEvidence.content_text = conflictText;
  conflictEvidence.provenance.content_sha256 = await hash(conflictText);
  conflictEvidence.media_metadata.sha256 = conflictEvidence.provenance.content_sha256;
  conflictEvidence.media_metadata.byte_size = new globalThis.TextEncoder().encode(conflictText).byteLength;
  const conflict = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: conflictEvidence }, 'm3-k2'),
    ...role,
  }, { db, verifyP22Evidence: async () => true });
  assert.equal(conflict.ok, false, '同键不同请求必须失败关闭');
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  const entitiesAfter = await db.listProjectEntities(USER_A, projectId);
  assert.equal(entitiesAfter.evidence.length, 1, '幂等重放与冲突请求绝不产生重复或新增记录');

  // 无交接包删除命令：交接包数据只可派生与重建作废，绝无删除路径。
  assert.equal(Object.hasOwn(COMMAND_ALLOWLIST, 'handoff.remove'), false, '不允许任何交接包删除命令');
  assert.equal(Object.hasOwn(COMMAND_ALLOWLIST, 'handoff.update'), false);
});

test('M3 命令边界：在线知识卡过时门禁（CARD_ANALYSIS_STALE）与批准前 Handoff 拒绝', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: 'M3 门禁', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'm3-g1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;
  const evidence = await executeCommand({
    ...request('evidence.create', {
      project_id: projectId,
      evidence: {
        source_url: 'https://example.com/m3/g', label: 'G', platform: 'x',
        content_text: '门禁证据正文。', recorded_at: '2026-08-13T07:00:00.000Z',
        provenance: { manual: true, statement: '服务端登记：来源由人工提交。' },
      },
    }, 'm3-g2'),
    ...role,
  }, { db });
  const evidenceId = evidence.entity.id;
  const snapshot = await snapshotFrom(db, USER_A, projectId);
  const analysisRecord = (await runAnalysis(snapshot, evidenceId, { now, hasher: fingerprintOf })).analyses[0];
  const analysis = await executeCommand({
    ...request('analysis.create', { project_id: projectId, analysis: analysisRecord }, 'm3-g3'),
    ...role,
  }, { db });
  const analysisId = analysis.entity.id;

  // 证据编辑（来源内容变化）→ 已存分析过时 → card.create 必须被边界拒绝。
  const storedEvidence = (await db.listProjectEntities(USER_A, projectId)).evidence[0];
  const updated = await executeCommand({
    ...request('evidence.update', {
      project_id: projectId, evidence_id: evidenceId, expected_fingerprint: storedEvidence.fingerprint,
      patch: { label: '已编辑标签' },
    }, 'm3-g4'),
    ...role,
  }, { db });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  // 服务端同样拒绝在本地构建过时分析的知识卡（M3 门禁双层强制）。
  const snapshotStale = await snapshotFrom(db, USER_A, projectId);
  await assert.rejects(
    () => buildKnowledgeCard(snapshotStale, analysisId, { now, hasher: fingerprintOf }),
    { code: 'CARD_ANALYSIS_STALE' },
  );
  // 客户端即使绕过本地门禁直接提交 card.create（绑定旧分析快照），
  // 在线边界也必须按持久化分析 → 证据的当前绑定拒绝（CARD_ANALYSIS_STALE）。
  const card = await executeCommand({
    ...request('card.create', { project_id: projectId, card: {
      schema_version: 'content_knowledge_card_v1',
      id: 'kc-aaaaaaaaaaaaaaaaaaaaaaaa',
      project_id: projectId, analysis_id: analysisId,
      analysis_fingerprint: analysisRecord.fingerprint, analysis_version: 1,
      source_observations: {
        post_text: '门禁证据正文。',
        media: { duration_seconds: 0, resolution: 'local_metadata_only', audio_track_present: false,
          timeline: [
            { stage: 'start', time_range: 'na', visual_evidence: 's', audio_evidence: '无音轨' },
            { stage: 'middle', time_range: 'na', visual_evidence: 'm', audio_evidence: '无音轨' },
            { stage: 'end', time_range: 'na', visual_evidence: 'e', audio_evidence: '无音轨' },
          ],
          transcript_segments: [] },
        uncertainties: ['无画面'],
      },
      creative_analysis: {
        hook: '钩子', copy_device: '直述', semantic_layers: ['层'], visual_impact: '无视觉媒体',
        seductive_tone: '平稳', narrative_arc: '单句', audio_role: '无音轨',
        audience_response_mechanisms: ['机制'], replicable_features: ['特征'],
        risk_labels: { sexual_suggestiveness: 'none', platform_moderation: 'low', brand_suitability: 'broad', notes: [] },
      },
      evidence_links: [
        { claim: '一', evidence_type: 'post_text', source_ref: evidenceId, time_range: null, confidence: 0.9 },
        { claim: '二', evidence_type: 'metadata', source_ref: evidenceId, time_range: null, confidence: 0.8 },
        { claim: '三', evidence_type: 'metadata', source_ref: evidenceId, time_range: null, confidence: 0.7 },
      ],
      generation_guidance: { reusable_pattern: '模式', must_preserve: ['保留'], must_not_invent: ['不虚构'], prompt_ingredients: ['成分'], variation_space: ['变体'] },
      generation_readiness: { usable: true, score: 90, reasons: ['完成'], blockers: [] },
      trust_status: 'manual_local', validation_status: 'validated_deterministic',
      version: 1, created_at: '2026-08-13T08:00:00.000Z', updated_at: '2026-08-13T08:00:00.000Z',
    } }, 'm3-g5'),
    ...role,
  }, { db });
  assert.equal(card.ok, false, '过时分析的知识卡必须被在线边界拒绝');
  assert.equal(card.code, 'CARD_ANALYSIS_STALE');

  // 批准前 handoff.create 被拒绝（HANDOFF_BRIEF_NOT_APPROVED）。
  const handoff = await executeCommand({
    ...request('handoff.create', {
      project_id: projectId,
      handoff: {
        schema_version: 'ams_external_handoff_package_v1',
        id: 'handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa',
        version: 1, kind: 'external_generation_handoff_package', status: 'ready_for_external_import',
        payload_label: 'local_external_generation_handoff_package',
        is_external_task: false, submission_pending: true, local_only: true, repo_external: true,
        brief_provenance: { brief_id: 'brief-m3aaaaaaaaaaaaaaaaaaaa', brief_version: 1, brief_schema_version: 'ams_content_brief_v1', brief_status: 'approved' },
        human_decision: { value: 'approved', source: 'local_manual', rationale: '批准', decided_by: 'tester', decided_at: '2026-08-13T08:02:00.000Z' },
        topic: '门禁', objective: 'o',
        knowledge_citations: [], evidence_provenance: { local_only: true, store: 'p19_local_store_v1', created_from: 'approved_content_brief', knowledge_count: 0, statement: '本地' },
        structural_guidance: { reusable_patterns: [], must_preserve: [], variation_space: [] },
        constraints: { must_not_invent: ['不虚构'], evidence_boundary: '仅本地' },
        external_project_boundary: { destination: 'external_generation_project', statement: '边界' },
        import_only: { manual_import_required: true }, manual_feedback: null,
        execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
        source_trace: { origin: 'local_bridge', created_from: 'approved_content_brief' },
        project_id: projectId, fingerprint: '', created_at: '2026-08-13T08:02:00.000Z',
      },
    }, 'm3-g6'),
    ...role,
  }, { db });
  assert.equal(handoff.ok, false);
  assert.equal(handoff.code, 'HANDOFF_BRIEF_NOT_APPROVED');
});

test('M3 命令边界：跨项目/跨账号隔离（PROJECT_NOT_FOUND）与幂等键冲突有界失败', async () => {
  const db = memoryDb();
  const role = { user_id: USER_A, access_role: 'operator' };
  const created = await executeCommand({
    ...request('project.create', { project: { topic: 'M3 隔离', objective: 'o', audience: 'a', channel: 'c', constraints: [] } }, 'm3-i1'),
    ...role,
  }, { db });
  const projectId = created.entity.id;

  // 跨账号：USER_B 无法读取或写入 USER_A 的项目。
  const foreignRead = await executeCommand({
    ...request('project.read', { project_id: projectId }, 'm3-i2'),
    user_id: USER_B, access_role: 'viewer',
  }, { db });
  assert.equal(foreignRead.ok, false);
  assert.equal(foreignRead.code, 'PROJECT_NOT_FOUND');
  const foreignWrite = await executeCommand({
    ...request('project.update', { project_id: projectId, patch: { topic: '越权' } }, 'm3-i3'),
    user_id: USER_B, access_role: 'operator',
  }, { db });
  assert.equal(foreignWrite.ok, false);
  assert.equal(foreignWrite.code, 'PROJECT_NOT_FOUND');
  // USER_B 在自己的项目里看不到 USER_A 的任何实体。
  const foreignEntities = await db.listProjectEntities(USER_B, projectId);
  assert.equal(foreignEntities.evidence.length, 0);

  // 幂等键绑定另一请求身份 → IDEMPOTENCY_CONFLICT（绝不复用键写入不同内容）。
  const evidencePayload = {
    source_url: 'https://example.com/m3/i', label: 'I', platform: 'x',
    content_text: '隔离证据正文。', recorded_at: '2026-08-13T07:00:00.000Z',
    provenance: { manual: true, statement: '服务端登记：来源由人工提交。' },
  };
  const first = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: evidencePayload }, 'm3-i4'),
    ...role,
  }, { db });
  assert.equal(first.ok, true);
  const conflict = await executeCommand({
    ...request('evidence.create', { project_id: projectId, evidence: { ...evidencePayload, content_text: '不同内容' } }, 'm3-i4'),
    ...role,
  }, { db });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT');
  const entities = await db.listProjectEntities(USER_A, projectId);
  assert.equal(entities.evidence.length, 1, '冲突请求不得写入任何记录');
});

// ---- 7. 刷新/重新登录恢复（范围 9）---------------------------------------------

test('M3 刷新恢复：store 往返后完整链 identity/fingerprint/version/决定/费用 完全一致', async () => {
  const backing = new Map();
  const store = createP19Store({ storage: { getItem: (key) => backing.get(key) ?? null, setItem: (key, value) => backing.set(key, value) } });
  // 综合闭环：2–5 条互异 Evidence，Cards/Brief 必须覆盖完整选中集合
  // （生产综合选择门禁 2–5 条绝不放松）。
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);
  assert.equal(ids.length, 3);
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const withBrief = await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });
  const approved = await reviewBrief(withBrief, { decision: 'approved', rationale: '刷新恢复测试批准', now });
  const withHandoff = await deriveHandoffPackage(approved, { now, hasher: fingerprintOf });

  const saved = store.putProject(withHandoff);
  assert.equal(saved.ok, true, saved.message || 'store 保存必须成功');
  const restored = store.getProject(withHandoff.id);
  assert.equal(restored.ok, true);
  const reloaded = restored.project;
  assert.equal(reloaded.fingerprint, withHandoff.fingerprint);
  // 完整选中集合恢复：全部互异 Evidence、对应知识卡与 Brief 引用原样精确。
  assert.equal(reloaded.evidence.length, ids.length, '刷新恢复必须还原全部互异 Evidence');
  assert.equal(reloaded.knowledge_cards.length, ids.length, '刷新恢复必须还原完整选中集合的每张知识卡');
  assert.deepEqual(reloaded.brief.knowledge_citation_ids, reloaded.knowledge_cards.map((card) => card.id), 'Brief 引用必须覆盖完整选中集合的每张卡');
  assert.deepEqual(reloaded.brief.p32_synthesis.selected_evidence_ids, ids, '综合快照必须绑定完整互异 Evidence 集合');
  // 逐实体 identity/fingerprint/version 精确恢复。
  assert.equal(reloaded.evidence[0].id, evidence[0].id);
  assert.equal(reloaded.evidence[0].fingerprint, evidence[0].fingerprint);
  assert.equal(reloaded.analyses[0].id, withHandoff.analyses[0].id);
  assert.equal(reloaded.analyses[0].fingerprint, withHandoff.analyses[0].fingerprint);
  assert.equal(reloaded.analyses[0].version, withHandoff.analyses[0].version);
  assert.equal(reloaded.analyses[0].model_analysis.usage.reservation_id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', '费用绑定随刷新恢复');
  assert.equal(reloaded.knowledge_cards[0].id, withHandoff.knowledge_cards[0].id);
  assert.equal(reloaded.brief.version, withHandoff.brief.version);
  assert.equal(reloaded.brief.status, 'approved');
  assert.deepEqual(reloaded.brief.review.decision, withHandoff.brief.review.decision, '人工决定快照原样恢复');
  assert.equal(reloaded.handoff.id, withHandoff.handoff.id);
  assert.equal(reloaded.handoff.fingerprint, withHandoff.handoff.fingerprint);
  assert.equal(reloaded.handoff.brief_provenance.brief_version, withHandoff.handoff.brief_provenance.brief_version);
  // 无别名：修改恢复快照不污染存储。
  reloaded.brief.review.decision.rationale = '外部篡改';
  const reread = store.getProject(withHandoff.id).project;
  assert.equal(reread.brief.review.decision.rationale, '刷新恢复测试批准', '存储读取必须深克隆隔离');
});

test('M3 在线重新登录恢复：命令边界权威重载返回精确 identity/revision/fingerprint 与费用', async () => {
  // 综合闭环：2–5 条互异 Evidence，Cards/Brief 必须覆盖完整选中集合
  // （生产综合选择门禁 2–5 条绝不放松）。
  const { project, evidence } = await analyzedProject(3);
  const ids = evidence.map((item) => item.id);
  assert.equal(ids.length, 3);
  const withCards = await buildKnowledgeCardsForSelection(project, ids, { now, hasher: fingerprintOf });
  const withBrief = await assembleSynthesisBrief(withCards.project, { selectedEvidenceIds: ids, now, hasher: fingerprintOf });

  // 命令边界 mock：project.read 返回权威存储的项目快照（模拟重新登录后的重载）。
  let authoritative = clonePlain(withBrief);
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
  // 完整选中集合重载：全部互异 Evidence、对应知识卡与 Brief 引用原样精确。
  assert.equal(reloaded.evidence.length, ids.length, '在线重载必须还原全部互异 Evidence');
  assert.equal(reloaded.knowledge_cards.length, ids.length, '在线重载必须还原完整选中集合的每张知识卡');
  assert.deepEqual(reloaded.brief.knowledge_citation_ids, reloaded.knowledge_cards.map((card) => card.id), 'Brief 引用必须覆盖完整选中集合的每张卡');
  assert.deepEqual(reloaded.brief.p32_synthesis.selected_evidence_ids, ids, '综合快照必须绑定完整互异 Evidence 集合');
  assert.equal(reloaded.evidence[0].fingerprint, evidence[0].fingerprint);
  assert.equal(reloaded.analyses[0].version, withBrief.analyses[0].version);
  assert.equal(reloaded.analyses[0].model_analysis.usage.reservation_id, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', '在线重载恢复费用绑定');
  assert.equal(reloaded.knowledge_cards[0].analysis_id, withBrief.knowledge_cards[0].analysis_id);
  assert.equal(reloaded.knowledge_cards[0].analysis_version, withBrief.knowledge_cards[0].analysis_version);
  assert.equal(reloaded.brief.status, 'pending_review');
  assert.equal(reloaded.brief.review.decision, null);
  // 身份不匹配拒绝加载（跨项目错绑失败关闭）。
  const mismatched = {
    ...fakeCommandClient,
    invoke: async (command) => (command === 'project.read' ? { data: { project: { ...clonePlain(authoritative), id: 'prj-ffffffffffffffffffffffff' } } } : { data: { projects: [] } }),
  };
  const wrongStore = createP20OnlineStore({ commandClient: mismatched });
  await assert.rejects(() => wrongStore.getProject(project.id), { code: 'ONLINE_PROJECT_ID_MISMATCH' });
});

// ---- 8. 跨项目/跨账号数据绝不混入（范围 9）-------------------------------------

test('M3 隔离：同一来源内容的证据分属两个项目时，分析/卡/Brief 绝不跨项目混入', async () => {
  const inputA = await collectedInputFor(1);
  const projectA = await createProject({ topic: '项目 A', objective: 'A', audience: 'A', channel: 'X', now });
  const projectB = await createProject({ topic: '项目 B', objective: 'B', audience: 'B', channel: 'X', now });
  const afterA = await addEvidence(projectA, inputA, { now, hasher: fingerprintOf });
  const afterB = await addEvidence(projectB, inputA, { now, hasher: fingerprintOf });
  const evidenceA = afterA.evidence[0];
  const evidenceB = afterB.evidence[0];
  assert.notEqual(evidenceA.id, evidenceB.id, '同一来源在各自项目内产生各自证据身份');
  assert.equal(evidenceA.project_id, projectA.id);
  assert.equal(evidenceB.project_id, projectB.id);

  const mediaIdsA = evidenceA.media_assets.map((asset) => asset.id);
  const withAnalysisA = await recordVersionedReanalysis(afterA, evidenceA.id, v2ModelResult(evidenceA.provenance.source_id, mediaIdsA), { now, hasher: fingerprintOf });
  assert.equal(withAnalysisA.analyses[0].project_id, projectA.id);
  // B 项目绝不能出现 A 的分析；把 A 的来源身份绑定到 B 项目的证据（外来来源身份）
  // 必须失败关闭（同一来源内容在各自项目内各有身份，绝不跨项目复用模型结果）。
  assert.equal(afterB.analyses.length, 0);
  await assert.rejects(
    () => recordVersionedReanalysis(afterB, evidenceB.id, v2ModelResult('m3-foreign-source-999', mediaIdsA), { now, hasher: fingerprintOf }),
    { code: 'ANALYSIS_SOURCE_BINDING_INVALID' },
  );
  assert.equal(afterB.analyses.length, 0, '跨项目来源身份绑定失败关闭，B 项目零分析');
});

// ---- 9. 错误脱敏（范围 9）-------------------------------------------------------

test('M3 脱敏：P22 客户端与命令适配器错误输出不包含令牌/JWT/service-role', async () => {
  const leakedMessage = '上游返回异常：Authorization: Bearer abc.def.ghi12345, service_role=sk_live_secret_value, token=abc, 详情见日志。';
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
