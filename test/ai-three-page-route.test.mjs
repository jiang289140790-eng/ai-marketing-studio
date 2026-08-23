// 任务信息架构规范路由确定性测试。
// 规范路由（一等路由，测试使用这三个路径）：
//   /tasks/new                 → 新任务页
//   /tasks/<taskId>            → 任务执行详情
//   /tasks/<taskId>/results    → 任务结果与审核
// 覆盖：路径/哈希解析、旧 hash 兼容重定向、刷新恢复闭环、404.html SPA 恢复、
// 非法编号诚实传递、未知子路径回落空状态。只验证纯路由/映射逻辑；
// 测试数据绝不进入产品运行时。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const TASK_ID = 'ht-00000000-0000-4000-8000-000000000001';

function withWindow(location, fn) {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '', pathname: '/', search: '', ...location } };
  try { return fn(); } finally { delete globalThis.window; }
}

test('三个规范路由：同一 taskId 在路径形式间稳定传递（构造 → 解析 → 再构造）', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    assert.equal(buildAppHash('ai'), '/tasks/new');
    assert.equal(buildAppHash('ai-execution', TASK_ID), `/tasks/${TASK_ID}`);
    assert.equal(buildAppHash('ai-results', TASK_ID), `/tasks/${TASK_ID}/results`);
    const expectations = [
      [`/tasks/${TASK_ID}`, 'execution', TASK_ID],
      [`/tasks/${TASK_ID}/results`, 'results', TASK_ID],
      ['/tasks/new', 'new', ''],
    ];
    for (const [pathname, view, expectedId] of expectations) {
      const parsed = parseAppRoute('', { pathname, search: '' });
      assert.equal(parsed.page, 'tasks', `规范路径 ${pathname} 必须解析为 tasks 页`);
      assert.equal(parsed.view, view, `规范路径 ${pathname} 必须解析为 ${view} 视图`);
      assert.equal(parsed.detailId, expectedId, `规范路径 ${pathname} 必须保持同一 taskId`);
      // 刷新恢复闭环：解析后再构造必须得到同一规范路径。
      assert.equal(buildAppHash(parsed.page, parsed.detailId, parsed.routeParams, parsed.view), pathname);
    }
  });
});

test('规范路由的哈希形式（404.html 重写结果）同样是一等路由', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    assert.deepEqual(parseAppRoute('#/tasks/new'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute(`#/tasks/${TASK_ID}`), { page: 'tasks', view: 'execution', detailId: TASK_ID, routeParams: {} });
    assert.deepEqual(parseAppRoute(`#/tasks/${TASK_ID}/results`), { page: 'tasks', view: 'results', detailId: TASK_ID, routeParams: {} });
  });
});

test('硬刷新恢复：pathname 精确读取 taskId 与查询参数，解析幂等', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    const first = parseAppRoute('', { pathname: `/tasks/${TASK_ID}/results`, search: '?source=research&focus=collect' });
    const second = parseAppRoute('', { pathname: `/tasks/${TASK_ID}/results`, search: '?source=research&focus=collect' });
    assert.deepEqual(first, second);
    assert.equal(first.detailId, TASK_ID);
    assert.equal(first.view, 'results');
    assert.equal(first.routeParams.source, 'research');
    assert.equal(first.routeParams.focus, 'collect');
  });
});

test('旧 hash 路由兼容迁移：ai/ai-execution/ai-results/dashboard → 规范任务模型', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    assert.deepEqual(parseAppRoute('#/ai'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('#/dashboard'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('#/ai-execution'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} }, '无 taskId 的执行详情必须回落到新任务空状态');
    assert.deepEqual(parseAppRoute('#/ai-results'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute(`#/ai/${TASK_ID}`), { page: 'tasks', view: 'execution', detailId: TASK_ID, routeParams: {} });
    assert.deepEqual(parseAppRoute(`#/ai-execution/${TASK_ID}`), { page: 'tasks', view: 'execution', detailId: TASK_ID, routeParams: {} });
    assert.deepEqual(parseAppRoute(`#/ai-results/${TASK_ID}`), { page: 'tasks', view: 'results', detailId: TASK_ID, routeParams: {} });
    assert.equal(parseAppRoute('#/ai?source=research').routeParams.source, 'research', '旧哈希查询参数必须保留');
  });
});

test('非法 taskId 原样保留交给页面显示真实错误态（不猜测不伪造）', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    for (const bad of ['ht-not-a-uuid', 'g1j-000000000000000000000001', 'hello']) {
      const hash = buildAppHash('ai-execution', bad);
      assert.equal(hash, `/tasks/${bad}`);
      const parsed = parseAppRoute('', { pathname: `/tasks/${bad}`, search: '' });
      assert.equal(parsed.page, 'tasks');
      assert.equal(parsed.view, 'execution');
      assert.equal(parsed.detailId, bad);
    }
  });
});

test('未知任务子路径不猜测：回到新任务页真实空状态', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    assert.deepEqual(parseAppRoute('', { pathname: `/tasks/${TASK_ID}/unknown`, search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('', { pathname: '/tasks', search: '' }), { page: 'tasks', view: 'new', detailId: '', routeParams: {} });
    assert.deepEqual(parseAppRoute('#/not-a-page'), { page: 'tasks', view: 'new', detailId: '', routeParams: {} }, '未知页面回落到新任务空状态');
  });
});

test('非任务页面继续使用哈希路由，不受规范路由影响', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    assert.deepEqual(parseAppRoute('#/research'), { page: 'research', detailId: '', view: '', routeParams: {} });
    assert.equal(parseAppRoute('#/research/evidence-01').detailId, 'evidence-01');
    assert.equal(buildAppHash('research'), '#/research');
    assert.equal(buildAppHash('research', 'evidence-01'), '#/research/evidence-01');
    assert.equal(parseAppRoute('#/plan').page, 'campaigns', '旧别名 plan → campaigns 继续生效');
  });
});

test('404.html SPA 路由恢复契约：GitHub Pages 未知路径无损重写为 #/tasks/...', async () => {
  const source = await readFile(join(import.meta.dirname, '..', 'public', '404.html'), 'utf8');
  const match = /function redirectTarget\(pathname, search\) \{([\s\S]*?)\n {6}\}/.exec(source);
  assert.ok(match, '404.html 必须包含可测试的 redirectTarget 纯函数');
  const redirect = new Function(`function redirectTarget(pathname, search) {${match[1]}\n}\nreturn redirectTarget;`)();
  // 规范任务路径 → base#/tasks/...（含 taskId 全程保持）。
  assert.equal(redirect('/ai-marketing-studio/tasks/new', ''), '/ai-marketing-studio/#/tasks/new');
  assert.equal(redirect(`/ai-marketing-studio/tasks/${TASK_ID}`, ''), `/ai-marketing-studio/#/tasks/${TASK_ID}`);
  assert.equal(redirect(`/ai-marketing-studio/tasks/${TASK_ID}/results`, '?source=research'), `/ai-marketing-studio/#/tasks/${TASK_ID}/results?source=research`);
  // 非任务路径不重写。
  assert.equal(redirect('/ai-marketing-studio/assets/logo.png', ''), '/ai-marketing-studio/assets/logo.png');
  // 重写后的哈希必须是 app-route 可解析的一等路由（刷新恢复闭环）。
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow({}, () => {
    const hash = `#/tasks/${TASK_ID}/results`;
    const parsed = parseAppRoute(hash);
    assert.equal(parsed.page, 'tasks');
    assert.equal(parsed.view, 'results');
    assert.equal(parsed.detailId, TASK_ID, '404 重写 → 哈希解析必须恢复同一 taskId');
  });
});
