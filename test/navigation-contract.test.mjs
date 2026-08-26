/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harnessJourney, navigationItems, compatibilitySections, routablePageIds } from '../src/data/navigation.js';

test('H9 visible navigation is Harness entry plus business result and asset pages only', () => {
  assert.deepEqual(harnessJourney.map((entry) => entry.id), ['ai', 'ai']);
  assert.deepEqual(
    compatibilitySections.map((section) => ({
      label: section.label,
      items: section.items.map((item) => item.id),
    })),
    [
      { label: '业务结果', items: ['research', 'knowledge', 'generation', 'publish'] },
      { label: '业务资产', items: ['characters', 'assets'] },
    ],
  );
  assert.deepEqual(navigationItems.map((item) => item.id), [
    'ai', 'research', 'knowledge', 'generation', 'publish', 'characters', 'assets',
  ]);
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

test('legacy planner, settings and low-frequency pages stay route-compatible but hidden from navigation', async () => {
  const visibleIds = new Set(navigationItems.map((item) => item.id));
  const hiddenIds = [
    'prompts', 'workflows', 'health', 'workspace', 'intelligence', 'data-analytics',
    'analytics', 'dailyreport', 'campaigns', 'accounts', 'connections',
  ];
  for (const id of hiddenIds) {
    assert.ok(!visibleIds.has(id), `${id} must stay hidden from visible navigation`);
    assert.ok(routablePageIds.includes(id), `${id} must remain in the route compatibility list`);
  }
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  for (const id of hiddenIds) {
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
  assert.match(sidebar, /primaryBusinessIds/);
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
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /Verify task route fallback/);
  assert.match(workflow, /redirectTarget/);
  const fallback = await readFile(new URL('../public/404.html', import.meta.url), 'utf8');
  assert.match(fallback, /redirectTarget/);
  assert.match(fallback, /tasks/);
});
