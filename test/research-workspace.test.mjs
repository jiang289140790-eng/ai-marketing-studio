import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHarnessOwnedPath } from './helpers/harness-integration-owned-paths.mjs';
import {
  RESEARCH_DEMO_ANALYSES,
  RESEARCH_DEMO_BRIEF,
  RESEARCH_DEMO_EVIDENCE,
  RESEARCH_DEMO_KNOWLEDGE,
  RESEARCH_DEMO_META,
  RESEARCH_DEMO_TOPIC,
  RESEARCH_DEMO_VERSION,
} from '../src/data/research-workspace-demo.js';
import { navigationItems, navigationSections } from '../src/data/navigation.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const OWNED_PATHS = new Set([
  'src/App.jsx',
  'src/data/navigation.js',
  'src/utils/app-route.js',
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/data/research-workspace-demo.js',
  'src/services/research-workspace-service.js',
  'src/contexts/auth-context.js',
  'test/research-workspace.test.mjs',
  'test/research-live-data.test.mjs',
  // 本里程碑要求修改导航结构，导航契约测试必须同步（见结果文件说明）。
  'test/navigation-contract.test.mjs',
  // 上一里程碑的所有权守卫测试需把本里程碑授权路径并入其守卫清单。
  'test/online-integrated-preview.test.mjs',
  // 上一里程碑遗留的未提交改动（本任务开始前已存在，本任务未触碰）。
  'src/pages/ContentWorkspacePage.jsx',
  'src/pages/Dashboard.jsx',
  'src/pages/KnowledgeVaultPage.jsx',
  'src/styles.css',
  // P17-C staging integrated preview 新增授权路径。
  'src/services/staging-preview-service.js',
  'src/components/Header.jsx',
  'src/components/Sidebar.jsx',
  'src/pages/CommandCenter.jsx',
  'test/p17c-staging-preview.test.mjs',
  // P19 运营研究工作台新增授权路径（本里程碑）。
  'src/services/p19-contracts.js',
  'src/services/p19-store.js',
  'src/services/p19-lineage.js',
  'src/services/p19-workspace-service.js',
  'src/services/p19-server-write-adapter.js',
  'src/components/integrated-workspace/P19WorkbenchPanels.jsx',
  // P36 渐进式交互重设计新增授权路径（本里程碑）：四目的地容器 + 采集面板改造。
  'src/components/integrated-workspace/P22ResearchAssistPanel.jsx',
  'src/components/integrated-workspace/P36ResearchDestinations.jsx',
  'test/p21-guided-research.test.mjs',
  'test/p32-hot-topic-search.browser.test.mjs',
  'test/p32-reddit-topic-search.browser.test.mjs',
  'test/p32-multipost-synthesis-brief.browser.test.mjs',
  'test/p20-browser-online.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
  // P19 迁移对账：2 个已验收规范文件替换了工作区中的旧版本（内容不一致）。
  'supabase/migrations/20260722023000_ops_execution_gateway.sql',
  'supabase/migrations/20260722033000_ops_business_tables_and_rls_hardening.sql',
  'supabase/migrations/20260812000000_p19_workspace_command_contract_v1.sql',
  'supabase/tests/p19_b0_command_contract.test.sql',
  'supabase/functions/p19-workspace-command/command-core.mjs',
  'supabase/functions/p19-workspace-command/index.ts',
  'test/p19-contracts.test.mjs',
  'test/p19-store.test.mjs',
  'test/p19-workbench-service.test.mjs',
  'test/p19-lineage.test.mjs',
  'test/p19-backend-command.test.mjs',
  'test/p19-forbidden-scan.test.mjs',
  'docs/P19_OPERATIONAL_WORKBENCH.md',
  'docs/P19_COMPLETION_REPORT.md',
  // P19 合并修复（repair 1）：迁移工具链 + 边界函数 + 新聚焦测试。
  'scripts/check-migrations.mjs',
  'scripts/check-p19-deployment-gate.mjs',
  'supabase/functions/p19-workspace-command/jwt-verify.mjs',
  'supabase/tests/p19_b1_rpc_boundary.test.sql',
  'supabase/tests/p19_b2_idempotency_replay.test.sql',
  'test/p19-checker.test.mjs',
  'test/p19-deployment-gate.test.mjs',
  'test/p19-sql-integration.test.mjs',
  // P19 合并修复 2（repair 2）：api 架构客户端路径测试 + 项目切换浏览器测试。
  'test/p19-api-schema.test.mjs',
  'test/p19-browser-switch.test.mjs',
  // P29 多模态 X 证据闭环新增授权路径（本里程碑）。
  'supabase/functions/p22-research-assist/assist-core.mjs',
  'supabase/functions/p22-research-assist/index.ts',
  'src/services/p22-research-assist.js',
  'src/components/integrated-workspace/P22ResearchAssistPanel.jsx',
  'test/p22-assisted-research.test.mjs',
  'test/p23-link-evidence-knowledge.test.mjs',
  'test/p24-knowledge-brief-review.test.mjs',
  'test/p29-multimodal-x-evidence.test.mjs',
  'test/p29-multimodal-x-evidence.browser.test.mjs',
  'docs/P29_MULTIMODAL_X_EVIDENCE_LOOP.md',
]);

// P19 已验收迁移对账唯一允许的删除：5 个过时时间戳变体，由已验收规范文件替代。
const ALLOWED_DELETIONS = new Set([
  'supabase/migrations/20260722141035_support_discord_and_read_business_intelligence.sql',
  'supabase/migrations/20260722142451_hard_finish_security_rls_and_search_path.sql',
  'supabase/migrations/20260722142535_restore_vector_operator_search_path.sql',
  'supabase/migrations/20260724133735_fix_content_packages_update_policy.sql',
  'supabase/migrations/20260725043407_day1_publish_state_machine.sql',
]);

const ALLOWED_CAPTURE_STATUSES = new Set(['collected_local_preview', 'not_collected']);
const ALLOWED_ANALYSIS_STATUSES = new Set(['analysed_local_preview', 'not_analysed']);

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  if (Object.isFrozen(value) === false) return false;
  return Object.keys(value).every((key) => isDeepFrozen(value[key]));
}

function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

test('演示元信息：版本、预览标签与只读边界有界且明确', () => {
  assert.equal(RESEARCH_DEMO_VERSION, 'ams-research-workspace-demo-v1');
  assert.equal(RESEARCH_DEMO_META.version, RESEARCH_DEMO_VERSION);
  assert.equal(RESEARCH_DEMO_META.previewLabel, '本地预览');
  assert.ok(RESEARCH_DEMO_META.previewNote.includes('本地示例'));
  assert.ok(RESEARCH_DEMO_META.previewNote.includes('不发起任何远程请求'));
  assert.ok(RESEARCH_DEMO_META.interactionNote.includes('不写入或修改任何数据'));
  assert.ok(RESEARCH_DEMO_META.previewNote.length <= 300);
});

test('主题：目标明确且如实声明本地预览边界', () => {
  assert.equal(RESEARCH_DEMO_TOPIC.status, 'local_preview');
  assert.equal(RESEARCH_DEMO_TOPIC.statusLabel, '本地预览');
  assert.ok(RESEARCH_DEMO_TOPIC.title.includes('示例'));
  assert.ok(RESEARCH_DEMO_TOPIC.objective.length > 20);
  assert.ok(RESEARCH_DEMO_TOPIC.boundaryNote.includes('未创建任何外部研究任务'));
});

test('证据：采集状态显式、溯源完整、无伪造真实采集', () => {
  assert.ok(RESEARCH_DEMO_EVIDENCE.length >= 2);
  for (const item of RESEARCH_DEMO_EVIDENCE) {
    assert.ok(ALLOWED_CAPTURE_STATUSES.has(item.captureStatus), `非法采集状态: ${item.captureStatus}`);
    assert.ok(item.captureStatusLabel.length > 0);
    if (item.captureStatus === 'collected_local_preview') {
      assert.ok(item.captureStatusLabel.includes('本地示例'), '已采集必须标注本地示例');
      assert.ok(item.provenance.includes('本地示例'), '溯源必须声明本地示例');
    }
    if (item.captureStatus === 'not_collected') {
      assert.equal(item.capturedAt, null, '未采集不得有采集时间');
      assert.equal(item.engagement, '无互动数据（未采集）', '未采集不得伪造互动数据');
      assert.equal(item.analysisIds.length, 0, '未采集不得关联分析');
      assert.equal(item.knowledgeIds.length, 0, '未采集不得关联知识卡');
      assert.ok(item.provenance.includes('未'), '未采集状态必须明确声明');
    }
    for (const id of item.analysisIds) {
      assert.ok(RESEARCH_DEMO_ANALYSES.some((a) => a.id === id), `分析引用缺失: ${id}`);
    }
    for (const id of item.knowledgeIds) {
      assert.ok(RESEARCH_DEMO_KNOWLEDGE.some((k) => k.id === id), `知识卡引用缺失: ${id}`);
    }
  }
});

test('分析：未分析状态显式、已分析必须标注本地示例且字段完整', () => {
  const notAnalysed = RESEARCH_DEMO_ANALYSES.filter((a) => a.status === 'not_analysed');
  const analysed = RESEARCH_DEMO_ANALYSES.filter((a) => a.status === 'analysed_local_preview');
  assert.ok(notAnalysed.length >= 1, '必须存在未分析的显式状态');
  assert.ok(analysed.length >= 1, '必须存在已分析（本地示例）条目');
  for (const item of RESEARCH_DEMO_ANALYSES) {
    assert.ok(ALLOWED_ANALYSIS_STATUSES.has(item.status), `非法分析状态: ${item.status}`);
    assert.ok(item.statusLabel.includes(item.status === 'not_analysed' ? '未分析' : '本地示例'));
    assert.ok(RESEARCH_DEMO_EVIDENCE.some((e) => e.id === item.evidenceId), `证据引用缺失: ${item.evidenceId}`);
    assert.ok(item.modelLabel.includes('示例') || item.modelLabel === '无', '不得声明调用过模型');
    assert.ok(item.analysisNote.length > 0, '分析必须带说明');
    if (item.status === 'analysed_local_preview') {
      for (const field of ['hook', 'format', 'visualStory', 'structure', 'audienceInsight']) {
        assert.ok(item[field] && item[field].length > 0, `已分析条目缺少 ${field}`);
      }
    }
  }
});

test('知识卡：引用证据必须存在且带引文', () => {
  for (const knowledge of RESEARCH_DEMO_KNOWLEDGE) {
    assert.ok(knowledge.status === 'local_preview', '知识卡状态必须是本地预览');
    assert.ok(knowledge.statusLabel.includes('示例'));
    assert.ok(knowledge.citations.length >= 1, '知识卡必须带引用');
    assert.ok(knowledge.confidence.includes('示例'), '置信度不得伪造真实评估');
    assert.ok(knowledge.note.includes('未写入知识库'), '必须声明未写入知识库');
    for (const citation of knowledge.citations) {
      assert.ok(RESEARCH_DEMO_EVIDENCE.some((e) => e.id === citation.evidenceId), `引用证据缺失: ${citation.evidenceId}`);
      assert.ok(citation.quote.length > 0, '引文不得为空');
    }
  }
});

test('Brief：P5 交接结构完整、执行标志严格 false、人工审核边界明确', () => {
  assert.equal(RESEARCH_DEMO_BRIEF.humanDecision.status, 'pending_human_review');
  assert.equal(RESEARCH_DEMO_BRIEF.humanDecision.statusLabel, '待人工审核');
  assert.ok(RESEARCH_DEMO_BRIEF.humanDecision.note.includes('未获得任何人工批准'));
  assert.deepEqual(RESEARCH_DEMO_BRIEF.executionFlags, {
    generation_executed: false,
    routing_executed: false,
    network_executed: false,
    publish_executed: false,
  });
  for (const [key, value] of Object.entries(RESEARCH_DEMO_BRIEF.executionFlags)) {
    assert.equal(value, false, `执行标志 ${key} 必须为 false`);
  }
  assert.equal(RESEARCH_DEMO_BRIEF.importOnly, true);
  assert.deepEqual(RESEARCH_DEMO_BRIEF.manualFeedback, []);
  assert.ok(RESEARCH_DEMO_BRIEF.briefProvenance.includes('本地示例'));
  assert.ok(RESEARCH_DEMO_BRIEF.constraints.length >= 2);
  assert.ok(RESEARCH_DEMO_BRIEF.externalProjectBoundary.includes('本地导入'));
  assert.ok(RESEARCH_DEMO_BRIEF.externalProjectBoundary.includes('pending_human_generation_review'));
  assert.ok(RESEARCH_DEMO_BRIEF.nextHandoffBoundary.includes('人工审核'));
  for (const citation of RESEARCH_DEMO_BRIEF.knowledgeCitations) {
    assert.ok(RESEARCH_DEMO_KNOWLEDGE.some((k) => k.id === citation.knowledgeId), `Brief 知识引用缺失: ${citation.knowledgeId}`);
  }
});

test('视图模型深冻结、不可变、无别名写入点', () => {
  for (const [label, value] of [
    ['RESEARCH_DEMO_META', RESEARCH_DEMO_META],
    ['RESEARCH_DEMO_TOPIC', RESEARCH_DEMO_TOPIC],
    ['RESEARCH_DEMO_EVIDENCE', RESEARCH_DEMO_EVIDENCE],
    ['RESEARCH_DEMO_ANALYSES', RESEARCH_DEMO_ANALYSES],
    ['RESEARCH_DEMO_KNOWLEDGE', RESEARCH_DEMO_KNOWLEDGE],
    ['RESEARCH_DEMO_BRIEF', RESEARCH_DEMO_BRIEF],
  ]) {
    assert.ok(isDeepFrozen(value), `${label} 必须整体深冻结`);
    assert.throws(() => { value[0] = null; }, TypeError, `${label} 顶层写入必须抛错`);
  }
  assert.throws(() => { RESEARCH_DEMO_KNOWLEDGE[0].citations[0].quote = '篡改'; }, TypeError, '嵌套条目写入必须抛错');
});

test('视图模型确定性强：序列化稳定、无随机/时钟/环境依赖', () => {
  const first = JSON.stringify({
    RESEARCH_DEMO_META,
    RESEARCH_DEMO_TOPIC,
    RESEARCH_DEMO_EVIDENCE,
    RESEARCH_DEMO_ANALYSES,
    RESEARCH_DEMO_KNOWLEDGE,
    RESEARCH_DEMO_BRIEF,
  });
  const second = JSON.stringify({
    RESEARCH_DEMO_META,
    RESEARCH_DEMO_TOPIC,
    RESEARCH_DEMO_EVIDENCE,
    RESEARCH_DEMO_ANALYSES,
    RESEARCH_DEMO_KNOWLEDGE,
    RESEARCH_DEMO_BRIEF,
  });
  assert.equal(first, second);
  const source = readSource('src/data/research-workspace-demo.js');
  assert.ok(!source.includes('Date.now'), '数据模块不得依赖时钟');
  assert.ok(!source.includes('Math.random'), '数据模块不得依赖随机数');
  assert.ok(!source.includes('process.env'), '数据模块不得读取环境变量');
});

test('视图模型无盘符路径、无网络目标、无 Supabase/密钥/服务端概念', () => {
  const source = readSource('src/data/research-workspace-demo.js');
  const forbidden = [
    /[A-Za-z]:[\\/]/,
    /https?:\/\//,
    /supabase/i,
    /\.env/,
    /secret/i,
    /bearer/i,
    /api[_-]?key/i,
    /password/i,
    /apify/i,
    /fetch\(/,
    /XMLHttpRequest/,
    /WebSocket/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `数据模块出现禁止内容: ${pattern}`);
  }
  const json = JSON.stringify({
    RESEARCH_DEMO_META,
    RESEARCH_DEMO_TOPIC,
    RESEARCH_DEMO_EVIDENCE,
    RESEARCH_DEMO_ANALYSES,
    RESEARCH_DEMO_KNOWLEDGE,
    RESEARCH_DEMO_BRIEF,
  });
  assert.ok(!json.includes('E:\\') && !json.includes('C:\\'), '视图模型不得包含盘符路径');
  assert.ok(!json.includes('http'), '视图模型不得包含网络目标');
});

test('导航：#/research 核心流程条目与页面 ID 一致，既有条目不受影响', () => {
  const researchItem = navigationItems.find((item) => item.id === 'research');
  assert.ok(researchItem, '导航必须包含 research 条目');
  assert.equal(researchItem.label, '研究与 Brief');
  assert.ok(!navigationSections.some((section) => section.items.some((item) => item.id === 'research')), '研究入口不得在二级导航重复');
  for (const id of ['intelligence', 'workspace', 'characters']) {
    assert.ok(navigationItems.some((item) => item.id === id), `既有导航条目缺失: ${id}`);
  }
  assert.equal(navigationSections[0].label, '资源与配置');
  assert.equal(navigationSections[0].items[0].id, 'characters');
  assert.equal(navigationSections[1].label, '高级工作台');
});

test('hash 路由：#/research 直接解析为 research 页，构建与刷新可用', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams };
  try {
    const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
    assert.equal(parseAppRoute('#/research').page, 'research');
    assert.equal(parseAppRoute('#/research/evidence-01').detailId, 'evidence-01');
    assert.equal(buildAppHash('research'), '#/research');
    assert.equal(buildAppHash('research', 'evidence-02'), '#/research/evidence-02');
    // 既有路由不受影响
    assert.equal(parseAppRoute('#/intelligence').page, 'intelligence');
    assert.equal(parseAppRoute('#/workspace').page, 'workspace');
    assert.equal(buildAppHash('intelligence'), '#/intelligence');
    assert.equal(buildAppHash('workspace'), '#/workspace');
  } finally {
    delete globalThis.window;
  }
});

test('页面源码：P36 运营研究工作台（四目的地、本地草稿、执行标志恒 false、破坏性二次确认）', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  const destinations = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // P36 主路径：单项目聚焦的四目的地工作台，不保留 P18 多面板浏览布局。
  assert.ok(source.includes('p19-workspace'), '页面必须作用域于 P19 工作台');
  assert.ok(source.includes('本地草稿'), '页面必须显式标注本地草稿');
  assert.ok(source.includes('createP19Store'), '页面必须使用有界本地存储');
  assert.ok(source.includes('P19FlagStrip'), '页面必须渲染四项执行标志');
  assert.ok(source.includes('P36Destinations'), '页面必须挂载四目的地容器');
  assert.ok(destinations.includes('P22CollectPanel'), '采集目的地必须提供智能采集面板');
  assert.ok(destinations.includes('P19EvidenceList'), '手工证据管理必须保留（采集次级工具）');
  assert.ok(destinations.includes('P19AnalysisList'), '全部分析记录必须保留（分析高级工具）');
  assert.ok(destinations.includes('P19CardList'), '知识卡列表必须保留（产物）');
  assert.ok(destinations.includes('P19BriefSection'), '产物必须提供可审核 Brief');
  assert.ok(destinations.includes('P19HandoffSection'), '产物必须提供交接包');
  assert.ok(destinations.includes('P19LineageSection'), '产物必须提供世系审计');
  assert.ok(source.includes('deriveHandoffPackage'), '页面必须经由唯一交接入口派生 P5 交接包');
  // 破坏性操作二次确认
  assert.ok(source.includes('P19ConfirmButton'), '页面必须使用二次确认按钮');
  assert.ok(source.includes('确认永久删除'), '删除项目必须二次确认');
  // 无 P18 多面板浏览/导航残留
  assert.ok(!source.includes('research-source-summary'), '不得保留 P18 来源摘要浏览');
  assert.ok(!source.includes('research-browse-toolbar'), '不得保留 P18 浏览工具栏');
  assert.ok(!source.includes('research-what-next'), '不得保留 P18 下一步操作指南');
  assert.ok(!source.includes('devFallbackOn'), '不得保留 P18 开发用示例回退开关');
  assert.ok(!source.includes('fetchResearchWorkspaceData'), '页面不再经实时后端适配器读取');
  // 只读/本地边界保留：无网络、无 Supabase、无环境变量、无未转义注入。
  assert.ok(!source.includes('fetch(') && !source.includes('axios'), '页面不得直接发起网络请求');
  assert.ok(!source.includes('XMLHttpRequest') && !source.includes('WebSocket'), '页面不得建立连接');
  assert.ok(!source.includes('@supabase/supabase-js'), '页面不得直接引入 supabase-js');
  assert.ok(!source.includes('dangerouslySetInnerHTML'), '页面不得使用未转义 HTML 注入');
  assert.ok(!source.includes('ExecutionButton') && !source.includes('execution-gateway'), '页面不得引入执行按钮/网关');
  assert.ok(!source.includes('import.meta.env'), '页面不得读取环境变量');
  assert.ok(!source.includes('http://') && !source.includes('https://'), '页面不得包含业务网络目标');
});

test('页面源码：归档只读门禁（归档后重载快照 + 编辑/分析/审核/交接全部拒绝，快照不可复活）', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  // 统一执行路径在归档状态下拒绝普通编辑/分析/审核/交接（创建新项目除外）。
  assert.ok(source.includes("status === 'archived' && !options.allowArchived"), 'run() 必须对归档项目 fail closed');
  assert.ok(source.includes("code: 'PROJECT_ARCHIVED'"), '归档拒绝必须使用 PROJECT_ARCHIVED 有界错误码');
  assert.ok(source.includes('allowArchived: true'), '创建新项目必须显式豁免归档门禁');
  // 归档成功后立即重载归档快照：后续编辑只能看到 archived 快照，无法复活归档前 active 修订。
  const archiveSection = source.slice(source.indexOf('handleArchiveProject'), source.indexOf('handleDeleteProject'));
  assert.ok(archiveSection.includes('reloadProject(id)'), '归档成功后必须重载归档快照');
  assert.ok(archiveSection.includes("'项目已归档（本地）。'"), '归档成功提示必须存在');
  // 服务层同样 fail closed（纵深防御）。
  const service = readSource('src/services/p19-workspace-service.js');
  assert.ok(service.includes('assertNotArchived(project)'), '服务层必须对每个变更操作执行归档只读门禁');
  assert.ok(service.includes("'PROJECT_ARCHIVED'"), '服务层门禁必须使用同一有界错误码');
});

test('页面源码：项目切换不保留瞬态状态（P36 目的地容器按 project.id 重挂载 + 页面级状态显式清空）', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  const destinations = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // P36 隔离契约第一层：目的地容器（采集输入/结果、选中来源/分析、分析预览、
  // 草稿与保存标记等全部瞬态状态）以 key={project.id} 挂载，切换项目即整棵重挂载，
  // 上一个项目的表单/选择值绝不流入当前项目。
  assert.ok(source.includes('key={project.id}'), '目的地容器必须按 project.id 确定性重挂载');
  assert.ok(source.includes('p19-project-scope'), '项目作用域容器必须存在');
  assert.ok(destinations.includes('setCollectTopic'), '采集输入状态必须位于目的地容器内');
  assert.ok(destinations.includes('setSelectedEvidenceId'), '选中来源状态必须位于目的地容器内');
  assert.ok(destinations.includes('setSelectedAnalysisId'), '选中分析状态必须位于目的地容器内');
  assert.ok(destinations.includes('setDrafts'), '草稿状态必须位于目的地容器内');
  assert.ok(source.includes('P19ProjectForm'), '档案表单必须存在（更多菜单抽屉内）');
  // P36 隔离契约第二层：页面级瞬态状态（热门搜索批次/综合结果/比较选择/草稿记录）
  // 在 activeId 变化时显式清空，绝不跨项目复用旧结论。
  assert.ok(source.includes('setHotSearchState(null)'), '切换项目必须清空热门搜索瞬态');
  assert.ok(source.includes('setSynthesisOutcome(null)'), '切换项目必须清空综合结果');
  assert.ok(source.includes('setComparedEvidenceIds([])'), '切换项目必须清空比较选择');
  assert.ok(source.includes('setSavedDrafts([])'), '切换项目必须清空草稿记录');
  // 顶栏破坏性确认臂按 activeId 重挂载（切换项目时确认状态复位）。
  assert.ok(source.includes('key={`archive-arm:${activeId}`}'), '归档确认臂必须按 activeId 复位');
  assert.ok(source.includes('key={`delete-arm:${activeId}`}'), '删除确认臂必须按 activeId 复位');
});

test('页面源码：损坏存储恢复 UI（CORRUPT_STORE fail closed + 恢复指引）', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  assert.ok(source.includes("error.code === 'CORRUPT_STORE'"), '错误横幅必须识别 CORRUPT_STORE');
  assert.ok(source.includes('p19-recovery-hint'), '必须提供损坏存储恢复指引区块');
  assert.ok(source.includes('导入备份'), '恢复指引必须指向本地备份导入');
  const css = readSource('src/pages/ResearchWorkspacePage.css');
  assert.ok(css.includes('.p19-recovery-hint'), '恢复指引样式必须存在于页面专属 CSS');
});

test('页面样式隔离：P36 工作台样式仅定义在页面专属 CSS 文件中', () => {
  const css = readSource('src/pages/ResearchWorkspacePage.css');
  assert.ok(css.length > 1000, '页面 CSS 应有实质内容');
  assert.ok(css.includes('.p19-workspace'), 'CSS 必须作用域于 P19 工作台');
  assert.ok(css.includes('.p19-flag-strip'), 'CSS 必须包含执行标志样式');
  assert.ok(css.includes('.p36-tabs'), 'CSS 必须包含目的地导航样式');
  assert.ok(css.includes('.p36-destination'), 'CSS 必须包含目的地布局样式');
  assert.ok(css.includes('.p19-panel'), 'CSS 必须包含面板样式');
  assert.ok(css.includes('.p19-evidence-item'), 'CSS 必须包含证据卡样式');
  assert.ok(css.includes('.p19-brief-actions'), 'CSS 必须包含 Brief 操作样式');
  assert.ok(css.includes('.p19-graph-node'), 'CSS 必须包含世系图谱节点样式');
  assert.ok(css.includes('@media (max-width: 1080px)'), 'CSS 必须包含中宽屏单列布局');
  assert.ok(css.includes('@media (max-width: 480px)'), 'CSS 必须包含 390px 级窄屏响应');
  assert.ok(css.includes(':focus-visible'), 'CSS 必须提供键盘焦点样式');
  assert.ok(!css.includes('@import'), '页面 CSS 不得引入外部资源');
  // P18 浏览样式类不再被页面引用（作用域清理完成）
  assert.ok(!css.includes('.research-source-summary'), '不得保留 P18 来源摘要样式');
  assert.ok(!css.includes('.research-what-next'), '不得保留 P18 操作指南样式');
});

test('P19 页面契约：本地草稿边界、确定性分析标注、批准/交接门禁文案', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  const panels = readSource('src/components/integrated-workspace/P19WorkbenchPanels.jsx');
  // 分析必须标注 deterministic_local，绝不暗示模型推理。
  assert.ok(panels.includes('deterministic_local'), '分析区必须标注 deterministic_local');
  assert.ok(panels.includes('不调用任何模型'), '必须声明不调用模型');
  // 交接包只读门禁文案：仅批准且未过时的当前修订可派生。
  assert.ok(panels.includes('仅本地人工批准后的当前 Brief 修订可派生'), '交接包区必须声明批准门禁');
  // 媒体元数据不上传。
  assert.ok(panels.includes('不上传文件'), '媒体元数据必须声明不上传');
  assert.ok(panels.includes('SHA-256'), '媒体元数据必须计算浏览器端 SHA-256');
  // 导入导出为本地备份。
  assert.ok(source.includes('导出备份') && source.includes('导入备份'), '页面必须提供本地备份导入导出');
  assert.ok(source.includes('本地备份'), '导入导出必须标注为本地备份');
  // 执行标志恒 false 文案。
  assert.ok(panels.includes('四项均为 false'), '必须声明四项标志均为 false');
  assert.ok(panels.includes('不采集'), '必须声明不采集');
  assert.ok(panels.includes('不发布'), '必须声明不发布');
});

test('所有权与删除防护：仅授权路径发生受跟踪修改；唯一允许删除为 5 个已验收变体', () => {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch (error) {
    assert.fail(`git status 不可用: ${error.message}`);
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') continue;
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    if (x === 'D' || y === 'D') {
      for (const path of paths) {
        assert.ok(ALLOWED_DELETIONS.has(path), `不允许删除文件: ${path}`);
      }
      continue;
    }
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path) || isHarnessOwnedPath(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});
