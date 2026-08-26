import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { harnessJourney, navigationItems, compatibilitySections, routablePageIds } from '../src/data/navigation.js';

const VISIBLE_BUSINESS_IDS = [
  'research', 'knowledge', 'generation', 'publish',
  'characters', 'accounts', 'assets',
  'connections',
];

const HIDDEN_LEGACY_IDS = [
  'prompts', 'campaigns', 'workspace', 'intelligence', 'data-analytics',
  'analytics', 'dailyreport', 'workflows', 'health',
];

test('H9：主壳导航 = Harness 旅程入口 + 业务页面', () => {
  assert.deepEqual(harnessJourney.map((entry) => ({ id: entry.id, label: entry.label })), [
    { id: 'ai', label: '新任务' },
    { id: 'ai', label: '当前会话' },
  ]);
  // 用户可见区只保留业务结果、业务资产与插件连接；旧固定规划器/调试入口隐藏。
  const compatIds = compatibilitySections.flatMap((section) => section.items.map((item) => item.id));
  assert.deepEqual([...compatIds].sort(), [...VISIBLE_BUSINESS_IDS].sort());
  assert.equal(compatibilitySections.length, 3);
  // 可见导航 = 主旅程入口 + 用户可见业务页，且无重复（每页一个定义）。
  assert.equal(navigationItems.length, 9);
  assert.equal(new Set(navigationItems.map((item) => item.id)).size, navigationItems.length);
  assert.ok(navigationItems.some((item) => item.id === 'ai'));
  for (const id of VISIBLE_BUSINESS_IDS) {
    assert.ok(navigationItems.some((item) => item.id === id), `导航缺失: ${id}`);
  }
  for (const id of HIDDEN_LEGACY_IDS) {
    assert.ok(!navigationItems.some((item) => item.id === id), `旧入口必须隐藏: ${id}`);
    assert.ok(routablePageIds.includes(id), `旧深链接必须保留路由兼容: ${id}`);
  }
  assert.equal(new Set(routablePageIds).size, routablePageIds.length);
  // 主旅程锚点不得出现在兼容区，兼容区条目不得出现在主旅程。
  const journeyIds = harnessJourney.map((entry) => entry.id);
  assert.deepEqual(journeyIds, ['ai', 'ai']);
  for (const section of compatibilitySections) {
    for (const item of section.items) {
      assert.ok(item.id !== 'ai' && item.id !== 'tasks', `兼容区不得包含主旅程路由: ${item.id}`);
    }
  }
});

test('H9：默认落地路由解析为 /tasks/new（规范默认入口）', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/', pathname: '/', search: '' } };
  try {
    const { buildAppRoute, parseAppRoute } = await import('../src/utils/app-route.js');
    // 空 URL / 根路径 / 未知页面一律回落到新任务页真实空状态。
    assert.deepEqual(parseAppRoute('', { pathname: '/', search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('#/', { pathname: '/', search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.equal(buildAppRoute('dashboard'), '/tasks/new');
    assert.equal(buildAppRoute('ai'), '/tasks/new');
  } finally {
    delete globalThis.window;
  }
});

test('H9：三页旅程可确定性导航，直达/刷新保持 taskId', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/', pathname: '/', search: '' } };
  try {
    const { buildAppRoute, parseAppRoute } = await import('../src/utils/app-route.js');
    const taskId = 'ht-00000000-0000-4000-8000-000000000001';
    assert.equal(buildAppRoute('ai'), '/tasks/new');
    assert.equal(buildAppRoute('ai-execution', taskId), `/tasks/${taskId}`);
    assert.equal(buildAppRoute('ai-results', taskId), `/tasks/${taskId}/results`);
    // 直达/刷新兼容：规范路径直接解析。
    const direct = parseAppRoute('', { pathname: `/tasks/${taskId}`, search: '' });
    assert.equal(direct.page, 'tasks');
    assert.equal(direct.view, 'execution');
    assert.equal(direct.detailId, taskId);
    const results = parseAppRoute('', { pathname: `/tasks/${taskId}/results`, search: '' });
    assert.equal(results.view, 'results');
    assert.equal(results.detailId, taskId);
    // 旧哈希兼容：跳转同一规范路由。
    assert.equal(parseAppRoute(`#/ai-execution/${taskId}`).view, 'execution');
    assert.equal(parseAppRoute(`#/ai-results/${taskId}`).view, 'results');
    // 非法编号诚实传递：路由不猜测，交给执行页显示真实错误态（ai-task-invalid-id）。
    assert.equal(parseAppRoute('', { pathname: '/tasks/unknown-subpath', search: '' }).view, 'execution');
    assert.equal(parseAppRoute('', { pathname: '/tasks/unknown-subpath', search: '' }).detailId, 'unknown-subpath');
    // 未知任务子路径不猜测：第三个段不是 results 时回到新任务页。
    assert.equal(parseAppRoute('', { pathname: `/tasks/${taskId}/unknown`, search: '' }).view, 'new');
  } finally {
    delete globalThis.window;
  }
});

test('H9：侧栏主旅程锚点 + 业务页面披露区，键盘可达且不用 CSS 隐藏', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  const navigation = await readFile(new URL('../src/data/navigation.js', import.meta.url), 'utf8');
  // 主旅程锚点渲染：新任务（默认入口）+ 当前会话（恢复会话）。
  assert.match(sidebar, /data-testid=\{journeyNew\.testId\}/);
  assert.match(sidebar, /data-testid=\{journeySession\.testId\}/);
  assert.match(sidebar, /startNewTask/);
  assert.match(sidebar, /onNavigate\('ai', '', \{ new: String\(Date\.now\(\)\) \}\)/);
  // 业务页面披露区：明确标注为结果、资产和插件连接，展开/收起可键盘操作。
  assert.match(sidebar, /<span>业务页面<\/span>/);
  assert.match(sidebar, /业务结果、资产与插件连接页面/);
  assert.match(sidebar, /aria-expanded=\{expanded\}/);
  assert.match(sidebar, /aria-controls=\{sectionId\}/);
  assert.match(sidebar, /hidden=\{!expanded && !collapsed\}/);
  assert.doesNotMatch(sidebar, /display:\s*none/, '不得用 CSS 隐藏掩盖重复注册');
  // 兼容区条目全部派生自唯一注册源。
  assert.match(navigation, /export const compatibilitySections/);
  assert.match(sidebar, /const secondarySections = compatibilitySections/);
  assert.match(sidebar, /secondarySections\.map/);
});

test('H9：三页旅程继续使用既有 harness-client 后端契约，无 mock 成功路径', async () => {
  const pages = ['src/pages/AIWorkspacePage.jsx', 'src/pages/TaskExecutionPage.jsx', 'src/pages/TaskResultsPage.jsx'];
  for (const page of pages) {
    const source = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(source, /createHarnessClient/, `${page} 必须使用既有 harness-client`);
    assert.doesNotMatch(source, /from '\.\.\/\.\.\/test\/|from '\.\/\.\.\/.*(?:fixture|mock)/, `${page} 不得引入测试夹具成功路径`);
    assert.doesNotMatch(source, /mockSuccess|fakeSuccess|hardcoded.*completed/, `${page} 不得伪造成功结果`);
  }
  const client = await readFile(new URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  assert.match(client, /sendMessage[\s\S]*action: 'thread_send'/, '显式 legacy 回退必须保留确定性 thread_send 合同');
  assert.match(client, /sendAgentMessage[\s\S]*action: 'thread_send_agent'/, '原生 Harness 默认路径必须使用 thread_send_agent 合同');
  for (const action of ['plan', 'confirm', 'read', 'list', 'cancel', 'retryFailedStep']) {
    assert.match(client, new RegExp(`${action}\\(`), `harness-client 必须保留 ${action} 契约`);
  }
});

test('H9：默认视图不暴露执行器术语/指纹/原始 JSON，技术信息保持折叠', async () => {
  const workspace = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  // 计划步骤默认用能力级说法（用户语言），原始操作标识只进 title 提示。
  assert.match(workspace, /capabilityLabelFor\(step\.operation\)/);
  assert.match(workspace, /title=\{step\.operation \|\| ''\}/);
  assert.doesNotMatch(workspace, /<small>\{step\.operation \|\| step\.tool/);
  // 工具调用与工具结果摘要默认折叠；Evidence/Analysis/Brief 等产物保持可见。
  assert.match(workspace, /kind === 'tool_call' && <details/);
  assert.match(workspace, /kind === 'tool_result' && <details/);
  assert.match(workspace, /\['evidence', 'analysis', 'knowledge', 'brief', 'artifact'\]\.includes\(kind\)/);
  // 内部 ID 与诊断默认隐藏。
  assert.match(workspace, /ai-technical-details/);
  assert.match(workspace, /技术诊断（默认隐藏）/);

  const execution = await readFile(new URL('../src/pages/TaskExecutionPage.jsx', import.meta.url), 'utf8');
  assert.match(execution, /展开执行步骤详情/);
  assert.match(execution, /ai-task-tool-calls/);
  assert.match(execution, /技术诊断（默认隐藏）/);

  const results = await readFile(new URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(results, /默认收起/);
  assert.match(results, /技术诊断（默认隐藏）/);
});

test('H9：未配置/未登录/读取失败状态保持真实且可行动', async () => {
  const client = await readFile(new URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  assert.match(client, /HARNESS_NOT_CONFIGURED/);
  assert.match(client, /AUTH_REQUIRED/);
  assert.match(client, /HARNESS_EDGE_UNAVAILABLE/);
  const execution = await readFile(new URL('../src/pages/TaskExecutionPage.jsx', import.meta.url), 'utf8');
  assert.match(execution, /data-testid="ai-task-read-error"/);
  assert.match(execution, /data-testid="ai-task-invalid-id"/);
  assert.match(execution, /data-testid="ai-task-not-found"/);
  const results = await readFile(new URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(results, /data-testid="ai-task-read-error"/);
});

test('H9：App.jsx 保持三页一等路由与兼容页解析，默认入口为 tasks', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /case 'tasks':/);
  assert.match(app, /routeView === 'execution'/);
  assert.match(app, /routeView === 'results'/);
  assert.match(app, /<AIWorkspacePage/);
  assert.match(app, /<TaskExecutionPage/);
  assert.match(app, /<TaskResultsPage/);
  assert.match(app, /key=\{routeParams\?\.legacy === '1' \? 'legacy' : 'harness-native'\}/, '切换原生/兼容模式必须重新挂载，避免复用另一模式会话状态');
  for (const id of [...VISIBLE_BUSINESS_IDS, ...HIDDEN_LEGACY_IDS]) {
    assert.match(app, new RegExp(`case '${id}':`), `App.jsx 必须保留 ${id} 页面路由`);
  }
});

test('H9：兼容页到 Harness 的上下文交接参数保留', async () => {
  const route = await readFile(new URL('../src/utils/app-route.js', import.meta.url), 'utf8');
  assert.match(route, /buildHarnessContextParams/);
  assert.match(route, /harnessContextSources/);
  assert.match(route, /parseHarnessContextParams/);
});
