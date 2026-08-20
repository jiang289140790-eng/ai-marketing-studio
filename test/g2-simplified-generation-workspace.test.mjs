import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

test('G2 presents one guided describe → quote → confirm → artifact workspace', () => {
  const page = read('src', 'pages', 'GenerationTasksPage.jsx');

  for (const selector of [
    'g2-workspace',
    'g2-flow',
    'g2-source-summary',
    'g2-mode-image',
    'g2-mode-video',
    'g2-advanced-settings',
    'g2-results-section',
  ]) {
    assert.match(page, new RegExp(`data-testid=["']${selector}["']`), `${selector} must be rendered`);
  }

  for (const label of ['描述', '报价', '确认', '成品']) assert.match(page, new RegExp(label));
  assert.match(page, /下一步：查看报价/);
  assert.match(page, /查看报价不会调用生成模型，也不会产生费用/);
});

test('G2 automatically binds current Brief, Knowledge and Evidence without a second manual form', () => {
  const page = read('src', 'pages', 'GenerationTasksPage.jsx');

  assert.match(page, /brief\.topic/);
  assert.match(page, /brief\.version/);
  assert.match(page, /briefCardIds\.length/);
  assert.match(page, /briefEvidenceIds\.length/);
  assert.match(page, /knowledge_card_ids:\s*briefCardIds/);
  assert.match(page, /evidence_ids:\s*briefEvidenceIds/);
  assert.doesNotMatch(page, /setKnowledgeCardIds|setEvidenceIds/);
});

test('G2 preserves G1 paid-execution safety gates and recovery surfaces', () => {
  const page = read('src', 'pages', 'GenerationTasksPage.jsx');
  const quotePanel = read('src', 'components', 'generation-execution', 'GenerationQuotePanel.jsx');
  const artifactViewer = read('src', 'components', 'generation-execution', 'GenerationArtifactViewer.jsx');

  assert.match(page, /client\.quote\(requestPayload\)/);
  assert.match(page, /client\.approveSubmit/);
  assert.match(page, /newGenerationRequestId\(\)/);
  assert.match(quotePanel, /g1-approval-check/);
  assert.match(quotePanel, /批准并提交生成/);
  assert.match(artifactViewer, /g1-version-history/);
  assert.match(artifactViewer, /g1-artifact-download/);
  assert.match(artifactViewer, /brief_id/);
  assert.match(artifactViewer, /knowledge_card_ids/);
  assert.match(artifactViewer, /evidence_ids/);
  assert.doesNotMatch(page, /dashscope\.aliyuncs|api\.aliyun|fetch\(['"]https:\/\//);
});

test('G2 responsive layout is single-column on narrow screens', () => {
  const css = read('src', 'pages', 'GenerationTasksPage.css');
  assert.match(css, /\.g2-results-layout/);
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /grid-template-columns:\s*1fr/);
});
