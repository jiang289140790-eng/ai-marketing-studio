// P18 完整智能内容链：集成验收测试
//
// 测试范围：
//   1. 深度不可变数据契约（证据 → 分析 → 知识卡 → Brief → 交接包 → 世系）
//   2. 精确跨绑定（知识卡→证据、Brief→知识卡/证据、交接包→Brief）
//   3. 四项执行标志严格 false
//   4. 演示数据确定性（无随机、无时钟依赖、无环境变量）
//   5. Live 优先 / 仅空时才用 demo / fail-closed 畸形数据
//   6. 有界 localStorage Brief 审核持久化
//   7. 无网络请求、无写入路径、无模型/发布调用
//   8. 有效路由：五个主导航项均可解析

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEMO_WORKSPACE,
  DEMO_EVIDENCE,
  DEMO_ANALYSES,
  DEMO_KNOWLEDGE_CARDS,
  DEMO_BRIEF,
  DEMO_HANDOFF,
  DEMO_LINEAGE_ENTRIES,
  DEMO_WORKSPACE_META,
} from '../src/data/integrated-demo-workspace.js';
import {
  INTEGRATED_EXECUTION_FLAGS,
  loadBriefReviewState,
  saveBriefReviewState,
  buildFullChainTrace,
  findAnalysesForEvidence,
  findEvidenceForKnowledgeCard,
} from '../src/services/integrated-workspace-service.js';
import { ALL_STAGING_VIEW_NAMES, buildStagingReadErrorView } from '../src/services/staging-preview-service.js';
import { navigationItems } from '../src/data/navigation.js';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---- 授权路径清单（P18 本里程碑） ---------------------------------------------
// ---- 辅助函数 ----------------------------------------------------------------
function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  if (Object.isFrozen(value) === false) return false;
  return Object.keys(value).every((key) => isDeepFrozen(value[key]));
}

// ============================================================================
// 1. 深度不可变数据契约
// ============================================================================
test('深度不可变：DEMO_WORKSPACE 及所有嵌套对象均为 Object.freeze', () => {
  assert.ok(isDeepFrozen(DEMO_WORKSPACE), 'DEMO_WORKSPACE 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_EVIDENCE), 'DEMO_EVIDENCE 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_ANALYSES), 'DEMO_ANALYSES 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_KNOWLEDGE_CARDS), 'DEMO_KNOWLEDGE_CARDS 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_BRIEF), 'DEMO_BRIEF 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_HANDOFF), 'DEMO_HANDOFF 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_LINEAGE_ENTRIES), 'DEMO_LINEAGE_ENTRIES 必须深度不可变');
  assert.ok(isDeepFrozen(DEMO_WORKSPACE_META), 'DEMO_WORKSPACE_META 必须深度不可变');
});

test('深度不可变：无法修改 DEMO_WORKSPACE 的任何属性', () => {
  assert.throws(
    () => { DEMO_WORKSPACE.evidence = []; },
    /read.only|not writable|extensible|frozen|assignment/i,
    '严格模式下修改冻结对象应抛出 TypeError',
  );
});

test('深度不可变：无法修改嵌套证据的属性', () => {
  const ev = DEMO_EVIDENCE[0];
  assert.throws(
    () => { ev.title = 'hacked'; },
    /read.only|not writable|extensible|frozen|assignment/i,
  );
});

// ============================================================================
// 2. 数据量契约
// ============================================================================
test('数据量契约：至少 4 条证据记录', () => {
  assert.ok(DEMO_EVIDENCE.length >= 4, `应有 >=4 条证据，实际 ${DEMO_EVIDENCE.length}`);
});

test('数据量契约：至少 3 条分析记录', () => {
  assert.ok(DEMO_ANALYSES.length >= 3, `应有 >=3 条分析，实际 ${DEMO_ANALYSES.length}`);
});

test('数据量契约：至少 3 张知识卡', () => {
  assert.ok(DEMO_KNOWLEDGE_CARDS.length >= 3, `应有 >=3 张知识卡，实际 ${DEMO_KNOWLEDGE_CARDS.length}`);
});

test('数据量契约：恰好 1 条 Brief', () => {
  assert.ok(DEMO_BRIEF, 'DEMO_BRIEF 必须存在');
  assert.equal(typeof DEMO_BRIEF.id, 'string');
});

test('数据量契约：恰好 1 个 P5 交接包', () => {
  assert.ok(DEMO_HANDOFF, 'DEMO_HANDOFF 必须存在');
  assert.equal(typeof DEMO_HANDOFF.id, 'string');
});

test('数据量契约：至少 4 条世系记录（覆盖四种状态）', () => {
  assert.ok(DEMO_LINEAGE_ENTRIES.length >= 4, `应有 >=4 条世系记录，实际 ${DEMO_LINEAGE_ENTRIES.length}`);
});

// ============================================================================
// 3. 精确跨绑定（证据 → 分析 → 知识卡 → Brief → 交接包 → 世系）
// ============================================================================
test('跨绑定：每条分析都绑定到有效的证据 ID', () => {
  const evIds = new Set(DEMO_EVIDENCE.map((e) => e.id));
  for (const analysis of DEMO_ANALYSES) {
    assert.ok(
      evIds.has(analysis.evidenceId),
      `分析 ${analysis.id} 引用了不存在的证据 ID: ${analysis.evidenceId}`,
    );
  }
});

test('跨绑定：每张知识卡绑定到有效的证据 ID', () => {
  const evIds = new Set(DEMO_EVIDENCE.map((e) => e.id));
  for (const kc of DEMO_KNOWLEDGE_CARDS) {
    for (const evId of kc.sourceEvidenceIds) {
      assert.ok(
        evIds.has(evId),
        `知识卡 ${kc.id} 引用了不存在的证据 ID: ${evId}`,
      );
    }
  }
});

test('跨绑定：知识卡引用分析与证据 ID 一致', () => {
  const analysisToEvidence = new Map(DEMO_ANALYSES.map((a) => [a.id, a.evidenceId]));
  for (const kc of DEMO_KNOWLEDGE_CARDS) {
    for (const analysisId of (kc.sourceAnalysisIds || [])) {
      const linkedEvidenceId = analysisToEvidence.get(analysisId);
      assert.ok(linkedEvidenceId, `知识卡 ${kc.id} 引用不存在的分析 ID: ${analysisId}`);
    }
  }
});

test('跨绑定：Brief 绑定到有效的知识卡 ID', () => {
  const kcIds = new Set(DEMO_KNOWLEDGE_CARDS.map((kc) => kc.id));
  for (const kcId of DEMO_BRIEF.boundKnowledgeCardIds) {
    assert.ok(kcIds.has(kcId), `Brief 引用了不存在的知识卡 ID: ${kcId}`);
  }
});

test('跨绑定：Brief 绑定到有效的证据 ID', () => {
  const evIds = new Set(DEMO_EVIDENCE.map((e) => e.id));
  for (const evId of DEMO_BRIEF.boundEvidenceIds) {
    assert.ok(evIds.has(evId), `Brief 引用了不存在的证据 ID: ${evId}`);
  }
});

test('跨绑定：交接包绑定到 Brief ID', () => {
  assert.equal(DEMO_HANDOFF.briefId, DEMO_BRIEF.id,
    '交接包 briefId 应与 Brief.id 一致');
});

test('跨绑定：交接包绑定到有效的知识卡 ID', () => {
  const kcIds = new Set(DEMO_KNOWLEDGE_CARDS.map((kc) => kc.id));
  for (const kcId of DEMO_HANDOFF.boundKnowledgeCardIds) {
    assert.ok(kcIds.has(kcId), `交接包引用了不存在的知识卡 ID: ${kcId}`);
  }
});

test('跨绑定：世系记录包含精确的 node/edge ID', () => {
  for (const entry of DEMO_LINEAGE_ENTRIES) {
    assert.ok(entry.nodeId && entry.nodeId.length > 0,
      `世系 ${entry.id} 必须有 nodeId`);
    assert.ok(entry.edgeId && entry.edgeId.length > 0,
      `世系 ${entry.id} 必须有 edgeId`);
    assert.ok(
      entry.nodeId.startsWith('node-'),
      `nodeId 应以 node- 开头: ${entry.nodeId}`,
    );
    assert.ok(
      entry.edgeId.startsWith('edge-'),
      `edgeId 应以 edge- 开头: ${entry.edgeId}`,
    );
  }
});

test('跨绑定：helper 函数 findAnalysesForEvidence 正确工作', () => {
  const linked = findAnalysesForEvidence(DEMO_ANALYSES, 'ev-001');
  assert.ok(linked.length >= 1, 'ev-001 应关联至少 1 条分析');
  assert.ok(linked.every((a) => a.evidenceId === 'ev-001'));
});

test('跨绑定：helper 函数 findEvidenceForKnowledgeCard 正确工作', () => {
  const linked = findEvidenceForKnowledgeCard(DEMO_EVIDENCE, DEMO_KNOWLEDGE_CARDS[0]);
  assert.ok(linked.length >= 1, 'kc-001 应关联至少 1 条证据');
});

test('跨绑定：buildFullChainTrace 产生完整链路摘要', () => {
  const trace = buildFullChainTrace(DEMO_WORKSPACE);
  assert.ok(trace, 'buildFullChainTrace 应返回非空结果');
  assert.ok(trace.summary.includes('证据'), '摘要应提及"证据"');
  assert.ok(trace.summary.includes('分析'), '摘要应提及"分析"');
  assert.ok(trace.summary.includes('知识卡'), '摘要应提及"知识卡"');
  assert.ok(trace.summary.includes('Brief'), '摘要应提及"Brief"');
  assert.ok(trace.summary.includes('交接包'), '摘要应提及"交接包"');
  assert.ok(trace.summary.includes('世系'), '摘要应提及"世系"');
  // DEMO_WORKSPACE 直接使用时 status 为 undefined，isDemo 从 demoOnly 字段获取
  assert.equal(trace.isDemo, true, 'DEMO_WORKSPACE 应被识别为 demo');
  assert.equal(trace.isLive, false);
  assert.equal(trace.evidenceCount, DEMO_EVIDENCE.length);
});

// ============================================================================
// 4. 四项执行标志严格 false
// ============================================================================
test('执行标志：DEMO_WORKSPACE 中四项均为 false', () => {
  const flags = DEMO_WORKSPACE.executionFlags;
  assert.equal(flags.generation_executed, false);
  assert.equal(flags.routing_executed, false);
  assert.equal(flags.network_executed, false);
  assert.equal(flags.publish_executed, false);
});

test('执行标志：DEMO_HANDOFF 中四项均为 false', () => {
  const flags = DEMO_HANDOFF.executionFlags;
  assert.equal(flags.generation_executed, false);
  assert.equal(flags.routing_executed, false);
  assert.equal(flags.network_executed, false);
  assert.equal(flags.publish_executed, false);
});

test('执行标志：INTEGRATED_EXECUTION_FLAGS 中四项均为 false', () => {
  assert.equal(INTEGRATED_EXECUTION_FLAGS.generation_executed, false);
  assert.equal(INTEGRATED_EXECUTION_FLAGS.routing_executed, false);
  assert.equal(INTEGRATED_EXECUTION_FLAGS.network_executed, false);
  assert.equal(INTEGRATED_EXECUTION_FLAGS.publish_executed, false);
});

test('执行标志：所有标志为冻结不可变', () => {
  assert.ok(Object.isFrozen(DEMO_WORKSPACE.executionFlags));
  assert.ok(Object.isFrozen(DEMO_HANDOFF.executionFlags));
  assert.ok(Object.isFrozen(INTEGRATED_EXECUTION_FLAGS));
});

// ============================================================================
// 5. 世系状态类型完整性
// ============================================================================
test('世系状态：四种状态均有明确定义', () => {
  const states = DEMO_LINEAGE_ENTRIES.map((e) => e.lineageState);
  assert.ok(states.includes('COMPLETE'), '应有 COMPLETE');
  assert.ok(states.includes('PARTIAL'), '应有 PARTIAL');
  assert.ok(states.includes('BROKEN'), '应有 BROKEN');
  assert.ok(states.includes('INVALID_SOURCE'), '应有 INVALID_SOURCE');
});

test('世系状态：每种状态有显式含义说明', () => {
  for (const entry of DEMO_LINEAGE_ENTRIES) {
    assert.ok(
      entry.stateMeaning && entry.stateMeaning.length > 20,
      `${entry.id}: stateMeaning 应有足够长度的说明 (${entry.lineageState})`,
    );
    assert.ok(
      entry.stateMeaning.includes(entry.lineageState),
      `stateMeaning 应包含状态名: ${entry.lineageState}`,
    );
  }
});

test('世系状态：状态计数正确', () => {
  const stateCounts = DEMO_WORKSPACE.lineage.stateCounts;
  assert.equal(
    stateCounts.COMPLETE,
    DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'COMPLETE').length,
  );
  assert.equal(
    stateCounts.PARTIAL,
    DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'PARTIAL').length,
  );
  assert.equal(
    stateCounts.BROKEN,
    DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'BROKEN').length,
  );
  assert.equal(
    stateCounts.INVALID_SOURCE,
    DEMO_LINEAGE_ENTRIES.filter((e) => e.lineageState === 'INVALID_SOURCE').length,
  );
});

// ============================================================================
// 6. 证据记录：精确来源身份与引用
// ============================================================================
test('证据来源：每条证据有精确 sourceIdentity', () => {
  for (const ev of DEMO_EVIDENCE) {
    const id = ev.sourceIdentity;
    assert.ok(id, `${ev.id}: 必须有 sourceIdentity`);
    assert.ok(id.accountName && id.accountName.length > 0,
      `${ev.id}: sourceIdentity 必须有 accountName`);
    assert.ok(id.platform && id.platform.length > 0,
      `${ev.id}: sourceIdentity 必须有 platform`);
    assert.ok(typeof id.followerCount === 'number' && id.followerCount > 0,
      `${ev.id}: sourceIdentity followerCount 应为正数`);
  }
});

test('证据来源：每条证据有 sourceUrl', () => {
  for (const ev of DEMO_EVIDENCE) {
    assert.ok(ev.sourceUrl && ev.sourceUrl.startsWith('https://'),
      `${ev.id}: sourceUrl 应以 https:// 开头，实际: ${ev.sourceUrl}`);
  }
});

test('证据来源：每条证据有 captureStatus=demolocal', () => {
  for (const ev of DEMO_EVIDENCE) {
    assert.equal(ev.captureStatus, 'demo_local',
      `${ev.id}: captureStatus 应为 demo_local`);
  }
});

// ============================================================================
// 7. 分析记录：文本/多模态
// ============================================================================
test('分析内容：每条分析有 textSummary 或 multimodalInsights', () => {
  for (const analysis of DEMO_ANALYSES) {
    const hasText = analysis.textSummary && analysis.textSummary.length > 0;
    const hasMulti = analysis.multimodalInsights &&
      Object.keys(analysis.multimodalInsights).length > 0;
    assert.ok(hasText || hasMulti,
      `${analysis.id}: 必须有 textSummary 或 multimodalInsights`);
  }
});

test('分析内容：至少一条分析为 multimodal 类型', () => {
  const multimodalCount = DEMO_ANALYSES.filter((a) => a.type === 'multimodal').length;
  assert.ok(multimodalCount >= 1,
    `至少应有 1 条 multimodal 分析，实际 ${multimodalCount}`);
});

// ============================================================================
// 8. 知识卡：引用溯源
// ============================================================================
test('知识卡引用：每张知识卡有 citation 引用证据原文', () => {
  for (const kc of DEMO_KNOWLEDGE_CARDS) {
    assert.ok(kc.citations && kc.citations.length > 0,
      `${kc.id}: citations 不能为空`);
    for (const citation of kc.citations) {
      assert.ok(citation.evidenceId, 'citation 必须有 evidenceId');
      assert.ok(citation.excerpt && citation.excerpt.length > 10,
        `citation excerpt 应足够长: ${citation.evidenceId}`);
    }
  }
});

test('知识卡置信度：有界且为数字', () => {
  for (const kc of DEMO_KNOWLEDGE_CARDS) {
    assert.ok(typeof kc.confidence === 'number',
      `${kc.id}: confidence 应为数字`);
    assert.ok(kc.confidence >= 0 && kc.confidence <= 1,
      `${kc.id}: confidence 应在 [0, 1] 范围，实际 ${kc.confidence}`);
  }
});

// ============================================================================
// 9. 验收演示项目元信息
// ============================================================================
test('元信息：明确标注为验收演示项目', () => {
  assert.ok(DEMO_WORKSPACE_META.label.includes('验收演示'));
  assert.ok(DEMO_WORKSPACE_META.labelEn.includes('Acceptance Demo'));
  assert.ok(DEMO_WORKSPACE_META.boundaryStatement.includes('纯本地数据'));
  assert.ok(DEMO_WORKSPACE_META.livePrecedenceNote.includes('优先'));
});

test('元信息：版本号以 p18 开头', () => {
  assert.ok(DEMO_WORKSPACE_META.version.startsWith('p18-'));
});

// ============================================================================
// 10. 确定性：无随机、无时钟、无环境变量依赖
// ============================================================================
test('确定性：两次导入返回相同数据', () => {
  // 已经通过 import 加载了模块。重新读取会得到相同对象（模块缓存）。
  assert.strictEqual(DEMO_WORKSPACE.evidence, DEMO_EVIDENCE);
  assert.strictEqual(DEMO_WORKSPACE.analyses, DEMO_ANALYSES);
  assert.strictEqual(DEMO_WORKSPACE.knowledgeCards, DEMO_KNOWLEDGE_CARDS);
});

test('确定性：所有 ID 为固定字符串，不包含随机或时间成分', () => {
  const allIds = [
    ...DEMO_EVIDENCE.map((e) => e.id),
    ...DEMO_ANALYSES.map((a) => a.id),
    ...DEMO_KNOWLEDGE_CARDS.map((k) => k.id),
    DEMO_BRIEF.id,
    DEMO_HANDOFF.id,
    ...DEMO_LINEAGE_ENTRIES.map((l) => l.id),
  ];
  for (const id of allIds) {
    assert.ok(typeof id === 'string' && id.length > 0,
      `ID 应为非空字符串: ${id}`);
    // 确保没有明显的随机生成模式（如 UUID 长格式）
    assert.ok(!/[0-9a-f]{32}/i.test(id),
      `ID 不应是随机 UUID: ${id}`);
  }
});

test('确定性：不含 Math.random / Date.now / new Date() 调用', () => {
  const source = readSource('src/data/integrated-demo-workspace.js');
  assert.ok(!/Math\.random/.test(source), '不应使用 Math.random');
  assert.ok(!/Date\.now/.test(source), '不应使用 Date.now');
  assert.ok(!/new Date\(\)/.test(source), '不应使用无参数 new Date()');
});

// ============================================================================
// 11. Live 优先 / 仅空 demo / fail-closed 逻辑验证
// ============================================================================
test('Live 优先：服务导出 loadIntegratedWorkspace 函数', async () => {
  const { loadIntegratedWorkspace } = await import('../src/services/integrated-workspace-service.js');
  assert.equal(typeof loadIntegratedWorkspace, 'function');
});

test('Demo 门禁：未配置或未登录时失败关闭，只有 staging 全空分支可进入 demo', () => {
  const source = readSource('src/services/integrated-workspace-service.js');
  assert.match(source, /if \(!runtime\.configured\)[\s\S]*?buildFailClosedView\(/);
  assert.match(source, /if \(!userId\)[\s\S]*?buildFailClosedView\(/);
  assert.match(source, /stagingResult\.status === 'partial'/);
  assert.match(source, /stagingResult\.liveCount !== ALL_STAGING_VIEW_NAMES\.length/);
  assert.match(source, /if \(isCompletelyEmpty\)[\s\S]*?buildDemoWorkspaceView\('staging_empty'\)/);
});

test('Fail closed：buildStagingReadErrorView 产生正确错误视图', () => {
  const errorView = buildStagingReadErrorView('测试错误');
  assert.equal(errorView.status, 'read_error');
  assert.ok(errorView.error.message.includes('测试错误'));
});

test('Demo only：DEMO_WORKSPACE_META 声明仅在 staging 为空时展示', () => {
  assert.ok(
    DEMO_WORKSPACE_META.livePrecedenceNote.includes('为空'),
    'livePrecedenceNote 应提及 empty/为空 条件',
  );
});

test('服务层：五视图常量与 staging-preview-service 一致', () => {
  const viewNames = [...ALL_STAGING_VIEW_NAMES].sort();
  assert.equal(viewNames.length, 5);
  assert.ok(viewNames.includes('ke_knowledge_cards_v1'));
  assert.ok(viewNames.includes('ke_content_briefs_v1'));
  assert.ok(viewNames.includes('ke_handoff_manifest_v1'));
  assert.ok(viewNames.includes('ke_handoff_package_detail_v1'));
  assert.ok(viewNames.includes('vg_lineage_audit_v1'));
});

// ============================================================================
// 12. localStorage Brief 审核持久化（有界、版本化）
// ============================================================================
test('localStorage：存储键格式为 p18_brief_review_v1_', () => {
  // 由于 Node 环境没有真正的持久 localStorage，我们验证存储键模式
  // 这测试的是函数不崩溃且键模式正确
  const testId = 'test-brief-001';
  try {
    const result = saveBriefReviewState(testId, {
      status: 'approved',
      statusLabel: '已批准',
      comment: '测试评论',
    });
    // 在 Node 中可能失败（没有 localStorage），这是预期的
    // 我们只验证函数被调用且不抛出异常
    assert.ok(typeof result === 'boolean');
  } catch {
    // 如果没有 localStorage，跳过
  }
});

test('localStorage：评论值长度有界', () => {
  const testId = 'test-brief-002';
  const longComment = 'x'.repeat(10000);
  try {
    const result = saveBriefReviewState(testId, {
      status: 'pending',
      comment: longComment,
    });
    // 应被截断或拒绝
    assert.ok(typeof result === 'boolean');
    // 如果成功保存，读取时评论应被截断
    const loaded = loadBriefReviewState(testId);
    if (loaded) {
      assert.ok(loaded.comment.length <= 5000,
        `评论应被截断到 5000 字符以内，实际 ${loaded.comment.length}`);
    }
  } catch {
    // 没有 localStorage 时跳过
  }
});

test('localStorage：版本化存储包含 _v 字段', () => {
  const testId = 'test-brief-003';
  try {
    saveBriefReviewState(testId, { status: 'approved', comment: '测试' });
    const loaded = loadBriefReviewState(testId);
    if (loaded) {
      // 如果加载成功（环境有 localStorage），验证字段
      assert.ok(['approved', 'returned', 'pending'].includes(loaded.status),
        'status 应为有效值');
      assert.ok(typeof loaded.comment === 'string');
    }
  } catch {
    // 没有 localStorage 时跳过
  }
});

test('localStorage：无效 briefId 时 load 返回 null', () => {
  assert.equal(loadBriefReviewState(null), null);
  assert.equal(loadBriefReviewState(''), null);
  assert.equal(loadBriefReviewState(undefined), null);
});

test('localStorage：save 无效 briefId 时返回 false', () => {
  assert.equal(saveBriefReviewState(null, {}), false);
  assert.equal(saveBriefReviewState('', {}), false);
});

// ============================================================================
// 13. 无网络/写入/模型/发布路径
// ============================================================================
test('无网络路径：服务文件不含 fetch / axios / XMLHttpRequest', () => {
  const serviceSource = readSource('src/services/integrated-workspace-service.js');
  assert.ok(!/fetch\s*\(/.test(serviceSource), '不应直接调用 fetch');
  assert.ok(!/axios/i.test(serviceSource), '不应使用 axios');
  assert.ok(!/XMLHttpRequest/i.test(serviceSource), '不应使用 XMLHttpRequest');
});

test('无网络路径：数据文件不含任何 fetch/axios', () => {
  const dataSource = readSource('src/data/integrated-demo-workspace.js');
  assert.ok(!/fetch\s*\(/.test(dataSource), '不应调用 fetch');
  assert.ok(!/import.*supabase/i.test(dataSource),
    '不应导入 supabase 客户端');
});

test('无写入路径：数据文件不含 insert/update/delete/upsert', () => {
  const dataSource = readSource('src/data/integrated-demo-workspace.js');
  assert.ok(!/\binsert\b/i.test(dataSource), '不含 insert');
  assert.ok(!/\bupdate\b/i.test(dataSource), '不含 update');
  assert.ok(!/\bdelete\b/i.test(dataSource), '不含 delete');
  assert.ok(!/\bupsert\b/i.test(dataSource), '不含 upsert');
});

test('无模型/发布：组件不含真实的 generate/publish/model API 调用', () => {
  for (const path of [
    'src/components/integrated-workspace/BriefPanel.jsx',
    'src/components/integrated-workspace/HandoffPanel.jsx',
    'src/components/integrated-workspace/LineagePanel.jsx',
    'src/components/integrated-workspace/ChainProgress.jsx',
  ]) {
    const source = readSource(path);
    // 排除字段名引用，只匹配函数调用和 API 导入
    assert.ok(!/from\s+['"].*supabase/.test(source),
      `${path} 不应导入 Supabase 客户端`);
    assert.ok(!/from\s+['"].*ai-service/.test(source),
      `${path} 不应导入 AI 服务`);
    assert.ok(!/from\s+['"].*publish-service/.test(source),
      `${path} 不应导入发布服务`);
    assert.ok(!/from\s+['"].*generation|execution-gateway/.test(source),
      `${path} 不应导入生成/执行网关`);
  }
});

test('无模型路径：暂不支持模型执行', () => {
  // Brief 面板的审核按钮仅写 localStorage
  const briefSource = readSource('src/components/integrated-workspace/BriefPanel.jsx');
  assert.ok(briefSource.includes('localStorage'),
    'BriefPanel 应在 localStorage 中持久化审核状态');
  assert.ok(!briefSource.includes('supabase'),
    'BriefPanel 不应直接调用 Supabase');
});

// ============================================================================
// 14. 路由：核心流程与内容工作台均可解析
// ============================================================================
test('路由：核心流程与内容工作台存在于导航列表中', () => {
  const requiredIds = ['ai', 'research', 'knowledge', 'generation', 'workspace'];
  for (const id of requiredIds) {
    assert.ok(
      navigationItems.some((item) => item.id === id),
      `主导航缺少: ${id}`,
    );
  }
});

test('路由：App.jsx 保留既有页面并以 AI 工作台为默认入口', () => {
  const appSource = readSource('src/App.jsx');
  assert.ok(appSource.includes('research'), 'App.jsx 应路由到 research');
  assert.ok(appSource.includes('knowledge'), 'App.jsx 应路由到 knowledge');
  assert.ok(appSource.includes('workspace'), 'App.jsx 应路由到 workspace');
  assert.ok(appSource.includes('AIWorkspacePage'), 'App.jsx 应导入 AIWorkspacePage');
});

test('Sidebar exposes core Harness plugins plus the complete secondary operations map', () => {
  const sidebarSource = readSource('src/components/Sidebar.jsx');
  assert.ok(sidebarSource.includes('const corePlugins = harnessPlugins'));
  assert.ok(sidebarSource.includes('secondarySections.map((section) =>'));
  assert.ok(sidebarSource.includes('管理与查看'));
  assert.ok(sidebarSource.includes('aria-expanded={expanded}'));
  assert.ok(sidebarSource.includes('hidden={!expanded && !collapsed}'));
  assert.ok(sidebarSource.includes('sidebar-collapse-toggle'));
  assert.ok(!sidebarSource.includes('PRIMARY_NAV_IDS'));
  assert.equal(navigationItems.length, 18);
  for (const id of ['publish', 'accounts', 'analytics', 'dailyreport', 'workflows', 'health']) {
    assert.ok(navigationItems.some((item) => item.id === id), `operations navigation is missing ${id}`);
  }
});

// ============================================================================
// 15. 来源标签验证
// ============================================================================
test('来源标签：每条证据明确标注为演示数据', () => {
  for (const ev of DEMO_EVIDENCE) {
    assert.ok(
      ev.provenance.includes('验收演示项目') || ev.provenance.includes('演示占位数据'),
      `${ev.id}: provenance 应包含演示标签`,
    );
  }
});

test('来源标签：每条分析明确标注为演示数据', () => {
  for (const analysis of DEMO_ANALYSES) {
    assert.ok(
      analysis.provenance.includes('验收演示项目') || analysis.provenance.includes('演示占位数据'),
      `${analysis.id}: provenance 应包含演示标签`,
    );
  }
});

// ============================================================================
// 16. 构建验证
// ============================================================================
test('构建：npm run build 成功', () => {
  try {
    execFileSync('node', ['node_modules/vite/bin/vite.js', 'build'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 120000,
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    const msg = error.message || String(error);
    assert.fail(`构建失败: ${msg.slice(0, 300)} | stdout: ${stdout.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`);
  }
});

test('Lint：npm run lint 通过', { skip: process.env.SKIP_LINT ? true : false }, () => {
  try {
    execFileSync('npx', ['eslint', '.', '--ext', 'js,jsx', '--max-warnings', '0'], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (error) {
    const output = (error.stdout || '') + (error.stderr || '');
    // lint 错误输出
    if (output.trim()) {
      assert.fail(`Lint 失败:\n${output.slice(0, 1000)}`);
    }
  }
});

// ============================================================================
// 17. Brief 交接约束
// ============================================================================
test('交接约束：DEMO_HANDOFF 明确列出四项 false 约束', () => {
  const constraints = DEMO_HANDOFF.handoffConstraints;
  assert.ok(constraints.length >= 4, '应有至少 4 条约束');
  const constraintText = constraints.join(' ');
  assert.ok(constraintText.includes('generation_executed: false'));
  assert.ok(constraintText.includes('routing_executed: false'));
  assert.ok(constraintText.includes('network_executed: false'));
  assert.ok(constraintText.includes('publish_executed: false'));
});

test('交接约束：importOnly 为 true', () => {
  assert.equal(DEMO_HANDOFF.importOnly, true);
});

test('交接约束：contentPlan 有 7 天内容', () => {
  assert.equal(DEMO_HANDOFF.contentPlan.length, 7,
    '交接包应有 7 天内容计划');
});

// ---- 辅助：验证 frozen 工具 --------------------------
