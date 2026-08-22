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
      { label: '总览', items: ['AI 运营指挥中心'] },
      { label: 'AI 运营', items: ['运营活动', '内容计划', '研究工作台', '内容工作台', '内容情报', '发布中心'] },
      { label: '资产中心', items: ['账号矩阵', '角色库', '素材库', '生成工作台', '提示词库'] },
      { label: '智能分析', items: ['数据分析', 'AI 复盘', '运营日报', '知识库'] },
      { label: '系统', items: ['平台连接', '工作流与模型', '系统状态'] },
    ],
  );
});

test('侧栏展示完整分组并自动展开当前页面所在分组', async () => {
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sidebar, /PRIMARY_NAV_IDS|filter\(\(item\).*\.has\(item\.id\)/s);
  assert.match(sidebar, /navigationSections\.map/);
  assert.match(sidebar, /section\.items\.some\(\(item\) => item\.id === activeNavigationId\)/);
  assert.match(sidebar, /aria-expanded=\{expanded\}/);
  assert.match(sidebar, /hidden=\{!expanded\}/);
  assert.match(sidebar, /全部功能/);
});

