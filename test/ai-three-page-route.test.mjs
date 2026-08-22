// 三页任务架构：hash 路由确定性测试（跳转、刷新恢复、taskId 稳定传递）。
// 只验证纯路由/映射逻辑；测试数据绝不进入产品运行时。

import test from 'node:test';
import assert from 'node:assert/strict';

const TASK_ID = 'ht-00000000-0000-4000-8000-000000000001';

function withWindow(hash, fn) {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash } };
  try {
    return fn();
  } finally {
    delete globalThis.window;
  }
}

test('三页任务架构：同一 taskId 在三条路由间稳定传递（构造 → 解析 → 再构造）', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  for (const page of ['ai-execution', 'ai-results']) {
    withWindow('#/', () => {
      const hash = buildAppHash(page, TASK_ID, {});
      const parsed = parseAppRoute(hash);
      assert.equal(parsed.page, page);
      assert.equal(parsed.detailId, TASK_ID, 'taskId 必须作为 detailId 精确保留');
      assert.equal(buildAppHash(parsed.page, parsed.detailId, parsed.routeParams), hash, '解析后再构造必须得到同一 hash（刷新恢复闭环）');
    });
  }
});

test('新任务首页也支持带 taskId 的稳定路由（#/ai/<taskId>）', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow('#/', () => {
    const hash = buildAppHash('ai', TASK_ID, {});
    assert.equal(hash, `#/ai/${TASK_ID}`);
    const parsed = parseAppRoute(hash);
    assert.equal(parsed.page, 'ai');
    assert.equal(parsed.detailId, TASK_ID);
    assert.equal(buildAppHash(parsed.page, parsed.detailId, parsed.routeParams), hash);
  });
});

test('直接打开与刷新恢复：hash 本身是唯一状态源，解析幂等', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  const hashes = [
    `#/ai-execution/${TASK_ID}`,
    `#/ai-results/${TASK_ID}`,
    `#/ai-execution/${TASK_ID}?source=research`,
    `#/ai-results/${TASK_ID}?focus=collect`,
  ];
  for (const hash of hashes) {
    withWindow(hash, () => {
      const first = parseAppRoute(hash);
      const second = parseAppRoute(hash);
      assert.deepEqual(first, second, `同 hash 两次解析必须完全一致：${hash}`);
    });
  }
});

test('非法任务编号：detailId 原样保留，由页面展示诚实错误态（不猜测不伪造）', async () => {
  const { buildAppHash, parseAppRoute } = await import('../src/utils/app-route.js');
  for (const bad of ['ht-not-a-uuid', 'g1j-000000000000000000000001', 'hello']) {
    withWindow('#/', () => {
      const hash = buildAppHash('ai-execution', bad, {});
      const parsed = parseAppRoute(hash);
      assert.equal(parsed.page, 'ai-execution');
      assert.equal(parsed.detailId, bad);
      assert.equal(buildAppHash(parsed.page, parsed.detailId, parsed.routeParams), hash);
    });
  }
});

test('未知页面回退 dashboard，未知查询参数不丢 taskId', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  withWindow(`#/not-a-page/${TASK_ID}?x=1`, () => {
    const parsed = parseAppRoute();
    assert.equal(parsed.page, 'dashboard', '未知页面必须回退 dashboard');
    assert.equal(parsed.detailId, TASK_ID, '回退不改变 detailId');
  });
});

test('新页面可被导航项解析（validPages 覆盖），直接进入无任务编号时 detailId 为空', async () => {
  const { parseAppRoute } = await import('../src/utils/app-route.js');
  for (const page of ['ai-execution', 'ai-results']) {
    withWindow(`#/${page}`, () => {
      const parsed = parseAppRoute();
      assert.equal(parsed.page, page);
      assert.equal(parsed.detailId, '', '无任务编号时必须是诚实空 detailId');
    });
  }
});
