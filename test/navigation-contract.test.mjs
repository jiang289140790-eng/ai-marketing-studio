/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessPlugins, navigationItems, navigationSections } from '../src/data/navigation.js';

test('最终导航与辅助页面职责清单一致（任务详情页不再作为独立菜单项）', () => {
  assert.deepEqual(
    navigationSections.map((section) => ({
      label: section.label,
      items: section.items.map((item) => item.label),
    })),
    [
      { label: '智能工作', items: ['AI 工作台'] },
      { label: '总览', items: ['AI 运营指挥中心'] },
      { label: 'AI 运营', items: ['运营活动', '内容计划', '研究工作台', '内容工作台', '内容情报', '发布中心'] },
      { label: '资产中心', items: ['账号矩阵', '角色库', '素材库', '生成工作台', '提示词库'] },
      { label: '智能分析', items: ['数据分析', 'AI 复盘', '运营日报', '知识库'] },
      { label: '系统', items: ['平台连接', '工作流与模型', '系统状态'] },
    ],
  );
});

test('导航契约：全部可见菜单 ID 唯一、可见标签不重复（不依赖 CSS 隐藏）', () => {
  const ids = navigationItems.map((item) => item.id);
  const labels = navigationItems.map((item) => item.label);
  assert.equal(new Set(ids).size, ids.length, '菜单 ID 必须唯一');
  assert.equal(new Set(labels).size, labels.length, '可见菜单标签不得重复');
  const sectionLabels = navigationSections.map((section) => section.label);
  assert.equal(new Set(sectionLabels).size, sectionLabels.length, '分组标签不得重复');
  for (const item of navigationItems) {
    assert.ok(item.id && typeof item.id === 'string', '菜单条目必须有 id');
    assert.ok(item.label && typeof item.label === 'string', '菜单条目必须有可见标签');
  }
  // 用户截图点名的重复项：账号矩阵/角色库/提示词库/数据分析 每项只注册一次。
  for (const label of ['账号矩阵', '角色库', '提示词库', '数据分析']) {
    assert.equal(labels.filter((entry) => entry === label).length, 1, `“${label}”只能出现一次`);
  }
});

test('harnessPlugins 唯一注册源：ID 唯一、标签唯一、路由目标可解析', () => {
  assert.equal(harnessPlugins.length, 7, '核心插件固定 7 个');
  const ids = harnessPlugins.map((plugin) => plugin.id);
  const labels = harnessPlugins.map((plugin) => plugin.label);
  assert.equal(new Set(ids).size, ids.length, '插件 ID 必须唯一');
  assert.equal(new Set(labels).size, labels.length, '插件可见标签不得重复');
  const navIds = new Set(navigationItems.map((item) => item.id));
  for (const plugin of harnessPlugins) {
    assert.ok(plugin.testId && plugin.testId.startsWith('harness-plugin-'), `插件 ${plugin.id} 必须有唯一 testId`);
    const target = plugin.route || plugin.id;
    assert.ok(navIds.has(target) || target === 'research-evidence' || target === 'research-brief', `插件目标 ${target} 必须可解析`);
  }
  // 侧栏可见标签契约：核心插件标签与“更多工具”二级条目不得重叠。
  const secondaryLabels = navigationSections
    .flatMap((section) => section.items)
    .filter((item) => !['ai', 'research', 'knowledge', 'generation', 'assets'].includes(item.id))
    .map((item) => item.label);
  for (const plugin of harnessPlugins) {
    assert.ok(!secondaryLabels.includes(plugin.label), `核心插件标签“${plugin.label}”不得在“更多工具”中重复`);
  }
});

test('三页任务架构路由契约：规范任务路由派生自唯一导航配置，侧栏只消费共享注册源', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  // 侧栏核心插件必须来自唯一注册源，组件内不得复制第二份菜单配置。
  assert.match(sidebar, /import \{ harnessPlugins, navigationSections \} from '\.\.\/data\/navigation'/);
  assert.match(sidebar, /const corePlugins = harnessPlugins/);
  // 工作台页面不得再渲染第二份业务插件菜单（此前靠 CSS display:none 掩盖重复注册）。
  assert.doesNotMatch(workspace, /businessPlugins|ai-plugin-rail/, 'AIWorkspacePage 不得包含重复插件菜单');
  assert.doesNotMatch(sidebar, /display:\s*none/, '侧栏不得用 CSS 隐藏掩盖重复注册');
});

test('三页任务架构路由契约：规范路由使用 /tasks 路径且保持 taskId', async () => {
  const routeSource = await readFile(new URL('../src/utils/app-route.js', import.meta.url), 'utf8');
  assert.match(routeSource, /\/tasks\/new/);
  assert.match(routeSource, /tasks\/\$\{encodeURIComponent\(canonical\.detailId\)\}/);
  assert.match(routeSource, /\/results/);
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/', pathname: '/', search: '' } };
  try {
    const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
    const taskId = 'ht-00000000-0000-4000-8000-000000000001';
    assert.equal(buildAppHash('ai'), '/tasks/new');
    assert.equal(buildAppHash('ai-execution', taskId), `/tasks/${taskId}`);
    assert.equal(buildAppHash('ai-results', taskId), `/tasks/${taskId}/results`);
    const parsed = parseAppRoute('', { pathname: `/tasks/${taskId}/results`, search: '' });
    assert.equal(parsed.page, 'tasks');
    assert.equal(parsed.view, 'results');
    assert.equal(parsed.detailId, taskId);
  } finally {
    delete globalThis.window;
  }
});

test('侧栏优先展示 Harness 核心插件并将完整产品图收纳为更多工具', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  const navigation = await readFile(new URL('../src/data/navigation.js', import.meta.url), 'utf8');
  assert.match(sidebar, /const corePlugins = harnessPlugins/);
  // 可见插件标签只注册在唯一配置源；侧栏从共享配置派生，不复制第二份。
  for (const plugin of ['AI 工作台', '研究工作台', 'Evidence', 'Knowledge', 'Brief 审核', '生成中心', '成品库']) {
    assert.match(navigation, new RegExp(plugin));
  }
  assert.doesNotMatch(sidebar, /label: '研究工作台'|label: 'Evidence'|label: 'Knowledge'/, '侧栏不得再内联注册插件标签');
  assert.match(sidebar, /const secondarySections = navigationSections/);
  assert.match(sidebar, /secondarySections\.map/);
  assert.match(sidebar, /section\.items\.some\(\(item\) => item\.id === activeNavigationId\)/);
  assert.match(sidebar, /aria-expanded=\{expanded\}/);
  assert.match(sidebar, /hidden=\{!expanded && !collapsed\}/);
  assert.match(sidebar, /sidebar-collapse-toggle/);
  assert.match(sidebar, /aria-label=\{collapsed \? '展开侧栏' : '收起侧栏'\}/);
  assert.match(sidebar, /全部功能/);
  assert.match(sidebar, /更多工具/);
});
