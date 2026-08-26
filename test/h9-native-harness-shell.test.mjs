import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { harnessJourney, navigationItems, compatibilitySections, routablePageIds } from '../src/data/navigation.js';

const VISIBLE_BUSINESS_IDS = [
  'research', 'knowledge', 'generation', 'publish',
  'characters', 'assets',
];

const HIDDEN_LEGACY_IDS = [
  'prompts', 'campaigns', 'workspace', 'intelligence', 'data-analytics',
  'analytics', 'dailyreport', 'workflows', 'health',
  'accounts', 'connections',
];

test('H9 shell keeps one primary Harness entry and only business result/asset pages', () => {
  assert.deepEqual(harnessJourney.map((entry) => ({ id: entry.id, label: entry.label })), [
    { id: 'ai', label: '新任务' },
    { id: 'ai', label: '当前会话' },
  ]);

  const compatIds = compatibilitySections.flatMap((section) => section.items.map((item) => item.id));
  assert.deepEqual([...compatIds].sort(), [...VISIBLE_BUSINESS_IDS].sort());
  assert.equal(navigationItems.length, 7);
  assert.equal(new Set(navigationItems.map((item) => item.id)).size, navigationItems.length);
  assert.ok(navigationItems.some((item) => item.id === 'ai'));

  for (const id of VISIBLE_BUSINESS_IDS) {
    assert.ok(navigationItems.some((item) => item.id === id), `visible navigation missing ${id}`);
  }
  for (const id of HIDDEN_LEGACY_IDS) {
    assert.ok(!navigationItems.some((item) => item.id === id), `legacy entry must stay hidden: ${id}`);
    assert.ok(routablePageIds.includes(id), `legacy deep link must stay routable: ${id}`);
  }
});

test('H9 default route lands on the native Harness web entry', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/', pathname: '/', search: '' } };
  try {
    const { buildAppRoute, parseAppRoute } = await import('../src/utils/app-route.js');
    assert.deepEqual(parseAppRoute('', { pathname: '/', search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('#/', { pathname: '/', search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.equal(buildAppRoute('dashboard'), '/tasks/new');
    assert.equal(buildAppRoute('ai'), '/tasks/new');
  } finally {
    delete globalThis.window;
  }
});

test('H9 task routes remain stable for execution and result pages', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/', pathname: '/', search: '' } };
  try {
    const { buildAppRoute, parseAppRoute } = await import('../src/utils/app-route.js');
    const taskId = 'ht-00000000-0000-4000-8000-000000000001';
    assert.equal(buildAppRoute('ai'), '/tasks/new');
    assert.equal(buildAppRoute('ai-execution', taskId), `/tasks/${taskId}`);
    assert.equal(buildAppRoute('ai-results', taskId), `/tasks/${taskId}/results`);
    assert.equal(parseAppRoute('', { pathname: `/tasks/${taskId}`, search: '' }).view, 'execution');
    assert.equal(parseAppRoute('', { pathname: `/tasks/${taskId}/results`, search: '' }).view, 'results');
    assert.equal(parseAppRoute(`#/ai-execution/${taskId}`).view, 'execution');
    assert.equal(parseAppRoute(`#/ai-results/${taskId}`).view, 'results');
    assert.equal(parseAppRoute('', { pathname: '/tasks/unknown-subpath', search: '' }).detailId, 'unknown-subpath');
    assert.equal(parseAppRoute('', { pathname: `/tasks/${taskId}/unknown`, search: '' }).view, 'new');
  } finally {
    delete globalThis.window;
  }
});

test('H9 AI workspace embeds official Harness web instead of the old fixed planner UI', async () => {
  const workspace = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  const style = await readFile(new URL('../src/pages/AIWorkspacePage.css', import.meta.url), 'utf8');

  assert.match(workspace, /DEFAULT_HARNESS_WEB_URL/);
  assert.match(workspace, /harness-web\.47-251-244-196\.sslip\.io/);
  assert.match(workspace, /data-testid="official-harness-frame"/);
  assert.match(workspace, /readHarnessActiveProject/);
  assert.match(workspace, /角色库/);
  assert.match(workspace, /业务结果页/);
  assert.match(style, /official-harness-frame/);

  assert.doesNotMatch(workspace, /生成安全计划|执行详情|结果与审核|capabilityLabelFor|kind === 'tool_call'|kind === 'tool_result'/);
  assert.doesNotMatch(workspace, /fingerprint|raw JSON|ai-technical-details/i);
});

test('H9 execution/result pages keep backend contracts but are no longer the primary operation entry', async () => {
  for (const page of ['src/pages/TaskExecutionPage.jsx', 'src/pages/TaskResultsPage.jsx']) {
    const source = await readFile(new URL(`../${page}`, import.meta.url), 'utf8');
    assert.match(source, /createHarnessClient/, `${page} must use the existing harness-client`);
    assert.doesNotMatch(source, /from '\.\.\/\.\.\/test\/|from '\.\/\.\.\/.*(?:fixture|mock)/, `${page} must not import test fixtures`);
    assert.doesNotMatch(source, /mockSuccess|fakeSuccess|hardcoded.*completed/, `${page} must not fake success`);
  }
});

test('H9 harness-client keeps native and legacy contracts for compatibility', async () => {
  const client = await readFile(new URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  assert.match(client, /sendMessage[\s\S]*action: 'thread_send'/);
  assert.match(client, /sendAgentMessage[\s\S]*action: 'thread_send_agent'/);
  for (const action of ['plan', 'confirm', 'read', 'list', 'cancel', 'retryFailedStep']) {
    assert.match(client, new RegExp(`${action}\\(`), `harness-client must keep ${action}`);
  }
  assert.match(client, /HARNESS_NOT_CONFIGURED/);
  assert.match(client, /AUTH_REQUIRED/);
  assert.match(client, /HARNESS_EDGE_UNAVAILABLE/);
});

test('H9 App keeps three task pages and compatibility routes', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /case 'tasks':/);
  assert.match(app, /routeView === 'execution'/);
  assert.match(app, /routeView === 'results'/);
  assert.match(app, /<AIWorkspacePage/);
  assert.match(app, /<TaskExecutionPage/);
  assert.match(app, /<TaskResultsPage/);
  for (const id of [...VISIBLE_BUSINESS_IDS, ...HIDDEN_LEGACY_IDS]) {
    assert.match(app, new RegExp(`case '${id}':`), `App.jsx must keep ${id}`);
  }
});

test('H9 compatibility pages can still pass context into Harness links', async () => {
  const route = await readFile(new URL('../src/utils/app-route.js', import.meta.url), 'utf8');
  assert.match(route, /buildHarnessContextParams/);
  assert.match(route, /harnessContextSources/);
  assert.match(route, /parseHarnessContextParams/);
});
