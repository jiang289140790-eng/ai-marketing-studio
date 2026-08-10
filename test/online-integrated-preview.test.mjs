import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACCEPTED_CAPABILITIES,
  EXECUTION_FLAGS,
  NOT_DEFINED_SCOPES,
  PENDING_INDEPENDENT_REVIEW,
  PREVIEW_CATEGORIES,
  PREVIEW_META,
  PREVIEW_VERSION,
} from '../src/data/online-integrated-preview.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const OWNED_PATHS = new Set([
  'src/pages/Dashboard.jsx',
  'src/pages/KnowledgeVaultPage.jsx',
  'src/pages/ContentWorkspacePage.jsx',
  'src/data/online-integrated-preview.js',
  'src/styles.css',
  'test/online-integrated-preview.test.mjs',
  // 研究工作台里程碑（ams-web-research-workspace-v1）授权路径并入守卫清单。
  'src/App.jsx',
  'src/data/navigation.js',
  'src/utils/app-route.js',
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/data/research-workspace-demo.js',
  'test/research-workspace.test.mjs',
  'test/navigation-contract.test.mjs',
]);

// 权威已验收任务记录：任务 ID 与修订号逐字来自控制中心任务/复核记录。
const AUTHORITATIVE_ACCEPTED = [
  { taskId: 'ams-ke-p5-local-handoff-export-completion', revision: 1, reviewId: 'rev-ams-ke-p5-local-handoff-export-completion-r1' },
  { taskId: 'ams-ke-p6-local-handoff-package-catalog-repair2', revision: 1, reviewId: 'rev-ams-ke-p6-local-handoff-package-catalog-repair2-r1' },
  { taskId: 'ams-ke-p7-local-handoff-coverage-audit-repair1', revision: 1, reviewId: 'rev-ams-ke-p7-local-handoff-coverage-audit-repair1-r1' },
  { taskId: 'ams-ke-p8-local-handoff-readiness-review', revision: 1, reviewId: 'rev-ams-ke-p8-local-handoff-readiness-review-r1' },
  { taskId: 'ams-ke-p9-local-manual-transfer-evidence-manifest', revision: 1, reviewId: 'rev-ams-ke-p9-local-manual-transfer-evidence-manifest-r1' },
  { taskId: 'ams-ke-p10-local-transfer-evidence-review-workbook', revision: 1, reviewId: 'rev-ams-ke-p10-local-transfer-evidence-review-workbook-r1' },
  { taskId: 'ams-cc-v10-local-next-stage-dependency-gates', revision: 1, reviewId: 'rev-ams-cc-v10-local-next-stage-dependency-gates-r1' },
];

// 未验收、待独立复核：仅允许以下精确状态。
const AUTHORITATIVE_PENDING = [
  {
    taskId: 'ams-vg-p15-final-evidence-repair-exception9',
    revision: 1,
    state: 'blocked',
    exactReason: 'infrastructure: review_infrastructure_attempts_exhausted (worker timed out; manual review required)',
  },
  {
    taskId: 'ams-cc-v11-local-staging-readiness-audit-repair1',
    revision: 1,
    state: 'reviewing',
    exactReason: 'review requested',
  },
];

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object') return true; // 原始值视为天然不可变
  if (Object.isFrozen(value) === false) return false;
  return Object.keys(value).every((key) => isDeepFrozen(value[key]));
}

function readPageSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

test('预览元信息：版本、标签与只读边界有界且确定', () => {
  assert.equal(PREVIEW_VERSION, 'ams-online-integrated-preview-v1');
  assert.equal(PREVIEW_META.version, PREVIEW_VERSION);
  assert.equal(PREVIEW_META.sectionLabel, '近期已验收能力');
  assert.equal(PREVIEW_META.sectionLabelEn, 'Recent Accepted Capabilities');
  assert.ok(PREVIEW_META.scopeNote.length > 0 && PREVIEW_META.scopeNote.length <= 300);
});

test('已验收能力精确回显权威任务 ID / 修订号 / 复核记录', () => {
  assert.equal(ACCEPTED_CAPABILITIES.length, 7);
  assert.deepEqual(
    ACCEPTED_CAPABILITIES.map((item) => ({
      taskId: item.taskId,
      revision: item.revision,
      reviewId: item.reviewId,
    })),
    AUTHORITATIVE_ACCEPTED,
  );
  for (const item of ACCEPTED_CAPABILITIES) {
    assert.equal(item.state, 'accepted');
    assert.equal(item.stateLabel, '已验收');
    assert.ok(item.title.length > 0 && item.title.length <= 80);
    assert.ok(item.description.length > 0 && item.description.length <= 300);
    assert.ok(item.boundaryNote.length > 0 && item.boundaryNote.length <= 200);
    assert.ok(['workspace', 'knowledge'].includes(item.targetPage), `非法导航目标: ${item.targetPage}`);
  }
});

test('待独立复核仅回显权威非验收状态，无就绪/已部署措辞', () => {
  assert.equal(PENDING_INDEPENDENT_REVIEW.length, 2);
  const actual = PENDING_INDEPENDENT_REVIEW.map((item) => ({
    taskId: item.taskId,
    revision: item.revision,
    state: item.state,
    exactReason: item.exactReason,
  }));
  assert.deepEqual(actual, AUTHORITATIVE_PENDING);
  for (const item of PENDING_INDEPENDENT_REVIEW) {
    const text = [item.title, item.description, item.exactStateLabel, item.exactReason].join(' ');
    assert.ok(!/\bready\b/i.test(text), `待复核条目出现 ready 措辞: ${item.taskId}`);
    assert.ok(!/deploy/i.test(text), `待复核条目出现 deploy 措辞: ${item.taskId}`);
    assert.ok(!/complete/i.test(text), `待复核条目出现 complete 措辞: ${item.taskId}`);
    assert.ok(!/accepted/i.test(text), `待复核条目出现 accepted 措辞: ${item.taskId}`);
    assert.ok(!/已验收|已就绪|已部署|已完成/.test(text), `待复核条目出现中文完成措辞: ${item.taskId}`);
    assert.ok(item.description.includes('未验收'), `待复核条目未声明未验收: ${item.taskId}`);
  }
});

test('未定义/未断言边界精确标注', () => {
  assert.deepEqual(
    NOT_DEFINED_SCOPES.map((item) => [item.id, item.status, item.statusLabel]),
    [
      ['storage-upload', 'not_asserted', '未断言完成'],
      ['execution-bridge', 'not_asserted', '未断言完成'],
      ['online-publish', 'not_defined', '未定义'],
    ],
  );
});

test('执行标志严格全 false', () => {
  assert.deepEqual(EXECUTION_FLAGS, {
    generation_executed: false,
    routing_executed: false,
    network_executed: false,
    publish_executed: false,
  });
  for (const [name, flag] of Object.entries(EXECUTION_FLAGS)) {
    assert.equal(flag, false, `执行标志 ${name} 必须为 false`);
  }
});

test('视图模型深冻结、不可变、无别名写入点', () => {
  for (const [label, value] of [
    ['PREVIEW_META', PREVIEW_META],
    ['EXECUTION_FLAGS', EXECUTION_FLAGS],
    ['ACCEPTED_CAPABILITIES', ACCEPTED_CAPABILITIES],
    ['PENDING_INDEPENDENT_REVIEW', PENDING_INDEPENDENT_REVIEW],
    ['NOT_DEFINED_SCOPES', NOT_DEFINED_SCOPES],
    ['PREVIEW_CATEGORIES', PREVIEW_CATEGORIES],
  ]) {
    assert.ok(isDeepFrozen(value), `${label} 必须整体深冻结`);
    assert.throws(() => { value[0] = null; }, TypeError, `${label} 顶层写入必须抛错`);
  }
  assert.throws(() => { ACCEPTED_CAPABILITIES[0].title = '篡改'; }, TypeError, '嵌套条目写入必须抛错');
});

test('视图模型确定性强：序列化稳定、无随机/时钟/环境依赖', () => {
  const first = JSON.stringify({
    ACCEPTED_CAPABILITIES,
    PENDING_INDEPENDENT_REVIEW,
    NOT_DEFINED_SCOPES,
    EXECUTION_FLAGS,
    PREVIEW_META,
  });
  const second = JSON.stringify({
    ACCEPTED_CAPABILITIES,
    PENDING_INDEPENDENT_REVIEW,
    NOT_DEFINED_SCOPES,
    EXECUTION_FLAGS,
    PREVIEW_META,
  });
  assert.equal(first, second);
  const source = readPageSource('src/data/online-integrated-preview.js');
  assert.ok(!source.includes('Date.now'), '数据模块不得依赖时钟');
  assert.ok(!source.includes('Math.random'), '数据模块不得依赖随机数');
  assert.ok(!source.includes('process.env'), '数据模块不得读取环境变量');
});

test('视图模型无路径、无密钥、无网络目标、无服务端概念', () => {
  const source = readPageSource('src/data/online-integrated-preview.js');
  const forbidden = [
    /[A-Za-z]:[\\/]/,
    /https?:\/\//,
    /supabase/i,
    /\.env/,
    /secret/i,
    /bearer/i,
    /api[_-]?key/i,
    /password/i,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `数据模块出现禁止内容: ${pattern}`);
  }
  const json = JSON.stringify({ ACCEPTED_CAPABILITIES, PENDING_INDEPENDENT_REVIEW, NOT_DEFINED_SCOPES, PREVIEW_META });
  assert.ok(!json.includes('E:\\') && !json.includes('C:\\'), '视图模型不得包含盘符路径');
  assert.ok(!json.includes('https://'), '视图模型不得包含网络目标');
});

test('类别筛选完整性：能力类别全部在预定义类别内', () => {
  const defined = new Set(PREVIEW_CATEGORIES.map((entry) => entry.id));
  assert.ok(defined.has('all'));
  for (const item of ACCEPTED_CAPABILITIES) {
    assert.ok(defined.has(item.category), `未知类别: ${item.category}`);
    assert.equal(PREVIEW_CATEGORIES.find((entry) => entry.id === item.category).label, item.categoryLabel);
  }
});

test('Dashboard 页面：预览在首屏，精确 ID 与状态，无执行能力', () => {
  const source = readPageSource('src/pages/Dashboard.jsx');
  const previewUsage = source.indexOf('<RecentAcceptedCapabilities');
  const heroIndex = source.indexOf('AI Marketing Studio 线上控制台');
  assert.ok(previewUsage >= 0, 'Dashboard 必须在首屏渲染能力预览');
  assert.ok(heroIndex > previewUsage, '预览必须位于既有首屏内容之前（above the fold）');
  assert.ok(source.includes('PREVIEW_META.sectionLabel'), 'Dashboard 必须绑定预览标题标签');
  assert.ok(source.includes('PREVIEW_META.sectionLabelEn'), 'Dashboard 必须绑定英文预览标签');
  assert.ok(source.includes('PENDING_INDEPENDENT_REVIEW'), 'Dashboard 必须引用待复核视图模型');
  assert.ok(source.includes('item.taskId'), 'Dashboard 必须绑定渲染任务 ID');
  assert.ok(source.includes('item.exactReason'), 'Dashboard 必须绑定渲染权威状态原因');
  assert.ok(source.includes('item.revision'), 'Dashboard 必须绑定渲染修订号');
  assert.ok(source.includes('item.reviewId'), 'Dashboard 必须绑定渲染复核记录');
  assert.ok(!source.includes('dangerouslySetInnerHTML'), 'Dashboard 不得使用未转义 HTML 注入');
  assert.ok(!source.includes('ExecutionButton'), 'Dashboard 不得引入执行按钮');
  assert.ok(!source.includes('execution-gateway'), 'Dashboard 不得引入执行网关');
  assert.ok(!source.includes('fetch(') && !source.includes('axios'), 'Dashboard 不得发起网络请求');
  assert.ok(!source.includes('type="submit"'), 'Dashboard 不得包含提交动作');
});

test('知识库页面：只读预览卡片、待复核区与登录门顺序', () => {
  const source = readPageSource('src/pages/KnowledgeVaultPage.jsx');
  assert.ok(source.includes('KnowledgeCapabilityPreview'), '知识库页面必须包含能力预览组件');
  assert.ok(source.includes('近期已验收能力'), '知识库页面必须包含预览标题');
  assert.ok(source.includes('待独立复核'), '知识库页面必须包含待复核区');
  assert.ok(source.includes('PENDING_INDEPENDENT_REVIEW'), '知识库页面必须引用待复核视图模型');
  assert.ok(source.includes('item.taskId'), '知识库页面必须绑定渲染任务 ID');
  assert.ok(source.includes('item.exactReason'), '知识库页面必须绑定渲染权威状态原因');
  assert.ok(source.includes('ACCEPTED_CAPABILITIES'), '知识库页面必须引用已验收视图模型');
  const firstRenderUsage = source.indexOf('<KnowledgeCapabilityPreview');
  const loginIndex = source.indexOf('请先登录');
  assert.ok(firstRenderUsage >= 0 && loginIndex > firstRenderUsage, '未登录分支必须先渲染预览，再显示登录门');
  assert.ok(!source.includes('dangerouslySetInnerHTML'), '知识库页面不得使用未转义 HTML 注入');
  assert.ok(!source.includes('ExecutionButton'), '知识库页面不得引入执行按钮');
});

test('内容工作台：保留 d769d7f 本地图像编辑实现并新增只读横幅', () => {
  const source = readPageSource('src/pages/ContentWorkspacePage.jsx');
  assert.ok(source.includes('LOCAL_EDIT_PRESETS'), '必须保留本地编辑预设');
  assert.ok(source.includes('persephone_klein_outfit_edit_api_v1'), '必须保留本地换衣工作流 ID');
  assert.ok(source.includes('persephone_klein_body_repair_api_v1'), '必须保留本地修复工作流 ID');
  assert.ok(source.includes('persephone_klein_background_edit_api_v1'), '必须保留本地改背景工作流 ID');
  assert.ok(source.includes('preview-workspace-banner'), '必须新增只读预览横幅');
  assert.ok(source.includes('未断言完成'), '横幅必须如实声明未断言边界');
  assert.ok(!source.includes('dangerouslySetInnerHTML'), '内容工作台不得新增未转义注入');
});

test('所有权与删除防护：仅授权路径发生受跟踪修改', () => {
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
    if (x === '?' && y === '?') continue; // 未跟踪文件允许存在且不改动
    assert.ok(x !== 'D' && y !== 'D', `不允许删除文件: ${line}`);
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});

test('预览视图模型仅包含有界条目数量', () => {
  assert.ok(ACCEPTED_CAPABILITIES.length <= 10);
  assert.ok(PENDING_INDEPENDENT_REVIEW.length <= 4);
  assert.ok(NOT_DEFINED_SCOPES.length <= 6);
  assert.ok(PREVIEW_CATEGORIES.length <= 8);
});
