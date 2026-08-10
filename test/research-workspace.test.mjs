import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('导航：#/research 侧栏条目与页面 ID 一致，既有条目不受影响', () => {
  const researchItem = navigationItems.find((item) => item.id === 'research');
  assert.ok(researchItem, '导航必须包含 research 条目');
  assert.equal(researchItem.label, '研究工作台');
  assert.ok(navigationSections.some((section) => section.items.some((item) => item.id === 'research')));
  for (const id of ['intelligence', 'workspace']) {
    assert.ok(navigationItems.some((item) => item.id === id), `既有导航条目缺失: ${id}`);
  }
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

test('页面源码：V3 可用浏览布局（摘要/搜索/筛选/详情），只读边界与真相保留', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  // V1 页面结构线保留：状态栏、四条产品链 lane、执行标志、来源选择、双导航。
  assert.ok(source.includes('research-status-bar'), '页面必须包含顶部安全/状态栏');
  assert.ok(source.includes('来源证据'), '页面必须包含证据 lane');
  assert.ok(source.includes('多模态分析'), '页面必须包含分析 lane');
  assert.ok(source.includes('知识卡'), '页面必须包含知识卡 lane');
  assert.ok(source.includes('可审核 Brief'), '页面必须包含 Brief 面板');
  assert.ok(source.includes('executionFlags'), '页面必须渲染执行标志');
  assert.ok(source.includes("onNavigate('intelligence')"), '必须提供前往内容情报的导航');
  assert.ok(source.includes("onNavigate('knowledge')"), '必须提供前往知识库的导航');
  assert.ok(source.includes("onNavigate('workspace')"), '必须提供前往内容工作台的导航');
  assert.ok(source.includes('setSelectedEvidenceId'), '必须存在来源选择交互');
  // V2：页面只经专用只读适配器访问实时数据，提供可见刷新动作。
  assert.ok(source.includes('from \'../services/research-workspace-service\''), '页面必须只引入专用只读研究服务');
  assert.ok(source.includes('fetchResearchWorkspaceData'), '页面必须调用只读研究服务');
  assert.ok(source.includes('刷新只读数据'), '页面必须提供可见的“刷新只读数据”动作');
  assert.ok(source.includes('当前后端数据不可用'), '后端缺失的字段/关联必须显式标注不可用');
  assert.ok(source.includes('useState(false)'), '开发用本地示例必须默认关闭');
  assert.ok(source.includes('devFallbackOn'), '开发用本地示例必须由显式开关控制');
  assert.ok(source.includes('!configured && devFallbackOn'), '开发回退只能在未配置运行时被激活');
  // V3：来源摘要、搜索、筛选、选中记录详情与可见计数。
  assert.ok(source.includes('来源摘要'), '页面必须提供来源摘要');
  assert.ok(source.includes('research-source-summary'), '来源摘要必须有专属样式类');
  assert.ok(source.includes('research-browse-toolbar'), '页面必须提供浏览筛选工具栏');
  assert.ok(source.includes('research-search-input'), '页面必须提供搜索输入框');
  assert.ok(source.includes('type="search"'), '搜索输入框必须是 search 类型');
  assert.ok(source.includes('research-filter-chip'), '页面必须提供筛选芯片');
  assert.ok(source.includes('research-detail-panel'), '页面必须提供选中记录详情面板');
  assert.ok(source.includes('记录详情'), '详情面板必须显式标注标题');
  assert.ok(source.includes('内容 {visibleCount} / {totalCount}'), '筛选后计数必须显式标注可见数量');
  assert.ok(source.includes('清除筛选'), '筛选激活时必须可一键清除');
  assert.ok(source.includes('未包含此记录'), '选中记录被筛掉时必须如实标注');
  assert.ok(source.includes('matchesFilter'), '必须存在搜索/筛选谓词');
  assert.ok(source.includes('countBy'), '来源摘要必须由可见数据聚合');
  assert.ok(source.includes('searchQuery'), '搜索词必须是受控状态');
  assert.ok(source.includes('platformFilter'), '平台筛选必须是受控状态');
  assert.ok(source.includes('categoryFilter'), '类别筛选必须是受控状态');
  assert.ok(source.includes('filteredEvidence'), '证据浏览列表必须来自筛选结果');
  assert.ok(source.includes('filteredSources'), '来源浏览列表必须来自筛选结果');
  assert.ok(!source.includes('research-workspace-demo'), '页面不得直接引入示例数据模块');
  assert.ok(!source.includes('fetch(') && !source.includes('axios'), '页面不得直接发起网络请求');
  assert.ok(!source.includes('XMLHttpRequest') && !source.includes('WebSocket'), '页面不得建立连接');
  assert.ok(!source.includes('supabase'), '页面不得直接引入 Supabase 客户端');
  assert.ok(!source.includes('@supabase/supabase-js'), '页面不得直接引入 supabase-js');
  assert.ok(!source.includes('dangerouslySetInnerHTML'), '页面不得使用未转义 HTML 注入');
  assert.ok(!source.includes('ExecutionButton'), '页面不得引入执行按钮');
  assert.ok(!source.includes('execution-gateway'), '页面不得引入执行网关');
  assert.ok(!source.includes('type="submit"'), '页面不得包含提交动作');
  assert.ok(!source.includes('<a '), '页面不得渲染可点击外链');
  assert.ok(!source.includes('<img'), '页面不得加载外部图片');
  assert.ok(!source.includes('import.meta.env'), '页面不得读取环境变量');
});

test('页面样式隔离：V3 浏览样式仅定义在页面专属 CSS 文件中', () => {
  const css = readSource('src/pages/ResearchWorkspacePage.css');
  assert.ok(css.length > 1000, '页面 CSS 应有实质内容');
  assert.ok(css.includes('.research-workspace'), 'CSS 必须作用域于研究工作台');
  assert.ok(css.includes('.research-status-bar'), 'CSS 必须包含状态栏样式');
  assert.ok(css.includes('.research-evidence-card'), 'CSS 必须包含证据卡样式');
  assert.ok(css.includes('.research-brief'), 'CSS 必须包含 Brief 样式');
  assert.ok(css.includes('.research-source-summary'), 'CSS 必须包含来源摘要样式');
  assert.ok(css.includes('.research-browse-toolbar'), 'CSS 必须包含浏览工具栏样式');
  assert.ok(css.includes('.research-filter-chip'), 'CSS 必须包含筛选芯片样式');
  assert.ok(css.includes('.research-detail-panel'), 'CSS 必须包含详情面板样式');
  assert.ok(css.includes('@media (max-width: 980px)'), 'CSS 必须包含中窄屏单列布局');
  assert.ok(!css.includes('@import'), '页面 CSS 不得引入外部资源');
});

test('V4 下一步操作指南：三目的地、纯导航语言与真相边界', () => {
  const source = readSource('src/pages/ResearchWorkspacePage.jsx');
  const css = readSource('src/pages/ResearchWorkspacePage.css');
  // 结构：必须有下一步操作指南 section
  assert.ok(source.includes('下一步操作指南'), '页面必须包含下一步操作指南区段');
  assert.ok(source.includes('research-what-next'), '操作指南必须有专属样式类');
  assert.ok(source.includes('research-what-next-grid'), '操作指南必须有三卡网格布局');
  assert.ok(source.includes('research-what-next-card'), '操作指南每张卡片必须有专属样式类');
  // 三目的地全部存在
  assert.ok(source.includes('内容情报'), '指南必须包含内容情报目的地');
  assert.ok(source.includes('知识库'), '指南必须包含知识库目的地');
  assert.ok(source.includes('内容工作台'), '指南必须包含内容工作台目的地');
  // 三处导航都使用 onNavigate
  const intelligenceNavs = source.split("onNavigate('intelligence')").length - 1;
  const knowledgeNavs = source.split("onNavigate('knowledge')").length - 1;
  const workspaceNavs = source.split("onNavigate('workspace')").length - 1;
  assert.ok(intelligenceNavs >= 1, `intelligence 导航至少出现 1 次，实际 ${intelligenceNavs}`);
  assert.ok(knowledgeNavs >= 1, `knowledge 导航至少出现 1 次，实际 ${knowledgeNavs}`);
  assert.ok(workspaceNavs >= 1, `workspace 导航至少出现 1 次，实际 ${workspaceNavs}`);
  // 纯导航语言：必须声明"仅导航"或"仅执行页面导航"
  assert.ok(
    source.includes('仅导航') || source.includes('仅执行页面导航'),
    '指南必须声明操作仅为页面导航',
  );
  // 真相边界：必须声明不采集、不分析、不生成
  assert.ok(source.includes('不采集'), '指南必须声明不采集');
  assert.ok(source.includes('不生成'), '指南必须声明不生成');
  // 不得暗示下游数据已就绪
  assert.ok(
    source.includes('不承诺任何下游数据已就绪') || source.includes('数据状态取决于'),
    '指南必须如实声明不承诺下游数据已就绪',
  );
  // 按钮可键盘访问：所有操作指南按钮均为 semantic button
  assert.ok(source.includes('aria-label="前往内容情报（仅导航）"'), '情报按钮必须有 aria-label');
  assert.ok(source.includes('aria-label="前往知识库（仅导航）"'), '知识库按钮必须有 aria-label');
  assert.ok(source.includes('aria-label="前往内容工作台（仅导航）"'), '工作台按钮必须有 aria-label');
  // CSS 覆盖
  assert.ok(css.includes('.research-what-next'), 'CSS 必须定义操作指南样式');
  assert.ok(css.includes('.research-what-next-grid'), 'CSS 必须定义三卡网格');
  assert.ok(css.includes('.research-what-next-card'), 'CSS 必须定义卡片样式');
  assert.ok(css.includes('.research-what-next-boundary'), 'CSS 必须定义边界声明样式');
  // 窄屏响应
  assert.ok(css.includes('@media (max-width: 640px)'), 'CSS 必须包含窄屏响应规则');
});

test('所有权与删除防护：仅授权路径发生受跟踪修改，无删除', () => {
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
    assert.ok(x !== 'D' && y !== 'D', `不允许删除文件: ${line}`);
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});
