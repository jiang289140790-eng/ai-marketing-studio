import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('H6 execution page leads with user-readable status and keeps backend noise collapsed', async () => {
  const page = await read('src/pages/TaskExecutionPage.jsx');
  const css = await read('src/pages/ai-task-pages.css');

  assert.match(page, /data-testid="h6-execution-user-summary"/);
  assert.match(page, /现在该看什么/);
  assert.match(page, /计划已准备好，等待你确认/);
  assert.match(page, /任务需要处理/);
  assert.match(page, /查看产物/);
  assert.match(page, /data-testid="ai-task-step-details"/);
  assert.match(page, /技术诊断（默认隐藏）/);
  assert.match(page, /展开完整内部字段/);
  assert.match(css, /\.ai-task-user-summary/);
  assert.match(css, /@media \(max-width: 760px\)/);
});

test('H6 results page leads with outcomes, artifacts and recovery actions', async () => {
  const page = await read('src/pages/TaskResultsPage.jsx');

  assert.match(page, /data-testid="h6-results-user-summary"/);
  assert.match(page, /结果怎么用/);
  assert.match(page, /已有部分成果，仍有步骤需要处理/);
  assert.match(page, /Brief 草案已经生成/);
  assert.match(page, /去生成工作台/);
  assert.match(page, /回研究工作台/);
  assert.match(page, /data-testid="ai-task-attachment-preview"/);
  assert.match(page, /data-testid="ai-task-generation-preview"/);
  assert.match(page, /完整产物/);
  assert.match(page, /技术诊断（默认隐藏）/);
});

test('H6 AI workspace keeps a native Harness-style conversation surface without fixed prompt clutter', async () => {
  const aiPage = await read('src/pages/AIWorkspacePage.jsx');
  const aiCss = await read('src/pages/AIWorkspacePage.css');
  const generationPage = await read('src/pages/GenerationTasksPage.jsx');

  assert.match(aiPage, /data-testid="ai-official-harness-page"/);
  assert.match(aiPage, /native-harness-topbar/);
  assert.match(aiPage, /sendAgentMessage/);
  assert.match(aiPage, /data-testid="harness-intent"/);
  assert.match(aiPage, /placeholder="描述你想要构建的内容"/);
  assert.match(aiCss, /探索未至之境/);
  assert.match(aiCss, /border: 1\.5px dashed #8bb5ff/);
  assert.doesNotMatch(aiPage, /data-testid="official-harness-frame"/);
  assert.doesNotMatch(aiPage, /QUICK_PROMPTS/);
  assert.doesNotMatch(aiPage, /quick-prompts/);
  assert.doesNotMatch(aiPage, /conversation-hero/);
  assert.doesNotMatch(aiPage, /official-business-dock/);
  assert.doesNotMatch(aiPage, /AMS × DeepSeek Harness/);
  assert.doesNotMatch(aiPage, /data-testid="ai-task-flow"/);
  assert.doesNotMatch(aiPage, /技术诊断（默认隐藏）/);
  assert.doesNotMatch(aiPage, /Harness 已批准能力与对应页面/);
  assert.match(generationPage, /G2 · 简洁生成工作台/);
  assert.match(generationPage, /查看报价不会调用生成模型，也不会产生费用/);
  assert.match(generationPage, /GenerationArtifactViewer/);
  assert.match(generationPage, /data-testid="g2-results-section"/);
});
