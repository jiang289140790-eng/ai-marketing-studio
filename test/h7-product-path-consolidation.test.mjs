import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { harnessPlugins, navigationSections } from '../src/data/navigation.js';

test('H7：侧栏保留角色库，并把旧功能收纳为资源与高级模式', () => {
  assert.deepEqual(harnessPlugins.map((plugin) => plugin.label), ['AI 工作台', '研究与 Brief', '知识库', '生成工作台']);
  assert.equal(navigationSections[0].label, '资源与配置');
  assert.deepEqual(navigationSections[0].items.map((item) => item.label), ['角色库', '账号矩阵', '提示词库', '素材库']);
  assert.equal(navigationSections[1].label, '高级工作台');
  assert.ok(navigationSections[1].items.some((item) => item.id === 'research') === false, '研究与 Brief 只保留在核心 Harness 入口');
});

test('H7：高级研究页明确回到 AI 工作台和知识库，不再冒充主入口', async () => {
  const source = await readFile(new URL('../src/pages/ResearchWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(source, /高级研究模式 · 手动补录 \/ 对账 \/ 批量导入/);
  assert.match(source, /onNavigate\?\.\('ai'\)/);
  assert.match(source, /回 AI 工作台/);
  assert.match(source, /onNavigate\?\.\('knowledge'\)/);
  assert.match(source, /看知识库/);
});

test('H7：任务结果页优先展示产物流向，技术细节默认靠后', async () => {
  const source = await readFile(new URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="h7-outcome-roadmap"/);
  assert.match(source, /先看结论，再看产物流向/);
  assert.match(source, /readableSectionItem/);
  assert.match(source, /ai-readable-section-item/);
  for (const label of ['研究与分析', '知识沉淀', 'Brief 草案', '生成成品']) {
    assert.match(source, new RegExp(label));
  }
});

test('H7：任务执行页默认给用户摘要，后台步骤进入详情区', async () => {
  const source = await readFile(new URL('../src/pages/TaskExecutionPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="h7-execution-focus-strip"/);
  assert.match(source, /当前进度/);
  assert.match(source, /需要处理/);
  assert.match(source, /安全边界/);
  assert.match(source, /展开执行步骤详情/);
});

test('H7：知识库展示 Harness 产物路径，而不是裸接口说明', async () => {
  const source = await readFile(new URL('../src/pages/KnowledgeVaultPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /当前项目沉淀的知识与 Brief/);
  assert.match(source, /data-testid="h7-knowledge-path-note"/);
  assert.match(source, /AI 工作台发起任务 → 结果页确认 Evidence \/ Analysis → 本页查看 Knowledge \/ Brief → 生成工作台制作图片或视频/);
  assert.match(source, /高级研究模式/);
});
