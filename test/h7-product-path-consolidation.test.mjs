import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { compatibilitySections, harnessJourney } from '../src/data/navigation.js';

test('H7/H9：侧栏保留角色库，并只展示 Harness 需要的业务页', () => {
  assert.deepEqual(harnessJourney.map((entry) => entry.label), ['新任务', '当前会话']);
  assert.deepEqual(compatibilitySections.map((section) => section.label), ['业务结果', '业务资产', '插件连接']);
  const assets = compatibilitySections.find((section) => section.label === '业务资产');
  assert.deepEqual(assets.items.map((item) => item.id), ['characters', 'accounts', 'assets']);
  assert.ok(assets.items.some((item) => item.id === 'characters' && item.label === '角色库'), '角色库必须保留为长期业务资产页');
  const results = compatibilitySections.find((section) => section.label === '业务结果');
  assert.deepEqual(results.items.map((item) => item.id), ['research', 'knowledge', 'generation', 'publish']);
});

test('advanced research page points users back to Harness and Knowledge instead of acting as the main entry', async () => {
  const source = await readFile(new URL('../src/pages/ResearchWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(source, /onNavigate\?\.\('ai'\)/);
  assert.match(source, /onNavigate\?\.\('knowledge'\)/);
});

test('task results page prioritizes user-readable outputs and keeps technical details secondary', async () => {
  const source = await readFile(new URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="h7-outcome-roadmap"/);
  assert.match(source, /readableSectionItem/);
  assert.match(source, /ai-readable-section-item/);
  for (const label of ['研究与分析', '知识沉淀', 'Brief 草案', '生成成品']) {
    assert.match(source, new RegExp(label));
  }
});

test('task execution page defaults to user summary and folds execution internals', async () => {
  const source = await readFile(new URL('../src/pages/TaskExecutionPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="h7-execution-focus-strip"/);
  assert.match(source, /展开执行步骤详情/);
});

test('knowledge page remains a business result page, not a raw API/debug page', async () => {
  const source = await readFile(new URL('../src/pages/KnowledgeVaultPage.jsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="h7-knowledge-path-note"/);
  assert.match(source, /AI 工作台/);
});
