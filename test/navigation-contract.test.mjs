/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessJourney, navigationItems, compatibilitySections, routablePageIds } from '../src/data/navigation.js';

test('H9 主导航只保留 Harness 锚点、业务结果、业务资产与插件连接', () => {
  assert.deepEqual(harnessJourney.map((entry) => entry.label), ['新任务', '当前会话']);
  assert.deepEqual(
    compatibilitySections.map((section) => ({
      label: section.label,
      items: section.items.map((item) => item.label),
    })),
    [
      { label: '业务结果', items: ['研究与 Brief', '知识库', '生成结果', '发布中心'] },
      { label: '业务资产', items: ['角色库', '账号矩阵', '素材库'] },
      { label: '插件连接', items: ['平台连接'] },
    ],
  );
});

test('visible navigation ids and labels are unique', () => {
  const ids = navigationItems.map((item) => item.id);
  const labels = navigationItems.map((item) => item.label);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(labels).size, labels.length);
  assert.equal(new Set(compatibilitySections.map((section) => section.label)).size, compatibilitySections.length);
  for (const item of navigationItems) {
    assert.ok(item.id && typeof item.id === 'string');
    assert.ok(item.label && typeof item.label === 'string');
  }
});

test('旧固定规划器、后台配置和调试页不进入用户可见导航，但保留路由兼容', async () => {
  const visibleIds = new Set(navigationItems.map((item) => item.id));
  for (const id of ['prompts', 'workflows', 'health', 'workspace', 'intelligence', 'data-analytics', 'analytics', 'dailyreport', 'campaigns']) {
    assert.ok(!visibleIds.has(id), `${id} must stay hidden from visible navigation`);
    assert.ok(routablePageIds.includes(id), `${id} must remain in the route compatibility list`);
  }
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const id of ['prompts', 'workflows', 'health', 'workspace', 'intelligence']) {
    assert.match(app, new RegExp(`case '${id}'`), `${id} remains route-compatible for old links`);
  }
});

test('Harness journey is the only primary operation entry; business pages do not duplicate it', () => {
  assert.equal(harnessJourney.length, 2);
  const compatLabels = compatibilitySections.flatMap((section) => section.items.map((item) => item.label));
  for (const entry of harnessJourney) {
    assert.ok(!compatLabels.includes(entry.label));
  }
  const journeyIds = harnessJourney.map((entry) => entry.id);
  for (const id of ['research', 'knowledge', 'generation']) {
    assert.ok(!journeyIds.includes(id));
  }
});

test('sidebar consumes the shared navigation registry and defaults to compact Harness shell', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /import \{ compatibilitySections, harnessJourney \} from '\.\.\/data\/navigation'/);
  assert.match(sidebar, /const secondarySections = compatibilitySections/);
  assert.match(sidebar, /journeyNew\.testId/);
  assert.match(sidebar, /journeySession\.testId/);
  assert.match(sidebar, /结果与资产/);
  assert.match(sidebar, /primaryBusinessIds/);
  assert.match(sidebar, /更多/);
  assert.doesNotMatch(workspace, /businessPlugins|ai-plugin-rail/);
  assert.doesNotMatch(sidebar, /display:\s*none/);
});

test('canonical task routes stay on /tasks and keep task ids', async () => {
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

test('Pages deployment keeps custom task-route fallback', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy-github-pages.yml', import.meta.url), 'utf8');
  const fallback = await readFile(new URL('../public/404.html', import.meta.url), 'utf8');
  assert.doesNotMatch(workflow, /cp dist\/index\.html dist\/404\.html/);
  assert.match(workflow, /grep -q "redirectTarget" dist\/404\.html/);
  assert.match(fallback, /function redirectTarget/);
});
