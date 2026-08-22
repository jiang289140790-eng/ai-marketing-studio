/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { navigationSections } from '../src/data/navigation.js';

test('最终导航与辅助页面职责清单一致', () => {
  assert.deepEqual(
    navigationSections.map((section) => ({
      label: section.label,
      items: section.items.map((item) => item.label),
    })),
    [
      { label: '智能工作', items: ['AI 工作台'] },
      { label: 'AI 任务', items: ['执行详情', '结果与审核'] },
      { label: '总览', items: ['AI 运营指挥中心'] },
      { label: 'AI 运营', items: ['运营活动', '内容计划', '研究工作台', '内容工作台', '内容情报', '发布中心'] },
      { label: '资产中心', items: ['账号矩阵', '角色库', '素材库', '生成工作台', '提示词库'] },
      { label: '智能分析', items: ['数据分析', 'AI 复盘', '运营日报', '知识库'] },
      { label: '系统', items: ['平台连接', '工作流与模型', '系统状态'] },
    ],
  );
});

test('三页任务架构路由契约：ai-execution / ai-results 使用任务编号作为 detailId', async () => {
  const routeSource = await readFile(new URL('../src/utils/app-route.js', import.meta.url), 'utf8');
  assert.match(routeSource, /legacyAliases = \{ dashboard: 'ai', plan: 'campaigns', aiworks: 'generation' \}/);
  // 新页面必须被合法页面集合覆盖（来自导航项），保证 hash 路由可解析。
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/' } };
  try {
    const { parseAppRoute, buildAppHash } = await import('../src/utils/app-route.js');
    const taskId = 'ht-00000000-0000-4000-8000-000000000001';
    for (const page of ['ai-execution', 'ai-results']) {
      const hash = buildAppHash(page, taskId, {});
      assert.equal(hash, `#/${page}/${taskId}`);
      const parsed = parseAppRoute(hash);
      assert.equal(parsed.page, page);
      assert.equal(parsed.detailId, taskId);
    }
  } finally {
    delete globalThis.window;
  }
});

test('侧栏优先展示 Harness 核心插件并将完整产品图收纳为更多工具', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  assert.match(sidebar, /const corePlugins = \[/);
  for (const plugin of ['AI 工作台', '研究工作台', 'Evidence', 'Knowledge', 'Brief 审核', '生成中心', '成品库']) {
    assert.match(sidebar, new RegExp(plugin));
  }
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

