// P30 内容创建模式 — 单元测试。
// 测试 content-core.mjs 纯逻辑、service 合同、组件纯函数边界。

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---- 导入 content-core.mjs（遵循现有 test 模式直接相对路径导入）------------------
import * as coreModule from '../supabase/functions/p30-content-create/content-core.mjs';

// ---- parseRequest 测试 ---------------------------------------------------------
test('parseRequest rejects non-object body', () => {
  assert.throws(() => coreModule.parseRequest(null), { code: 'INVALID_BODY' });
  assert.throws(() => coreModule.parseRequest('string'), { code: 'INVALID_BODY' });
  assert.throws(() => coreModule.parseRequest([]), { code: 'INVALID_BODY' });
});

test('parseRequest rejects unknown action', () => {
  assert.throws(() => coreModule.parseRequest({ action: 'delete' }), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => coreModule.parseRequest({ action: '' }), { code: 'UNKNOWN_ACTION' });
  assert.throws(() => coreModule.parseRequest({}), { code: 'UNKNOWN_ACTION' });
});

test('parseRequest accepts status action', () => {
  const result = coreModule.parseRequest({ action: 'status' });
  assert.equal(result.action, 'status');
});

test('parseRequest rejects unknown fields in generate_quick', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_quick', input_text: 'hello', unknown_field: 123 }),
    { code: 'UNKNOWN_FIELDS' },
  );
});

test('parseRequest rejects empty input_text', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_quick', input_text: '' }),
    { code: 'INPUT_REQUIRED' },
  );
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_quick', input_text: '   ' }),
    { code: 'INPUT_REQUIRED' },
  );
});

test('parseRequest rejects overly long input_text', () => {
  const long = 'x'.repeat(coreModule.LIMITS.MAX_INPUT_LENGTH + 1);
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_quick', input_text: long }),
    { code: 'INPUT_TOO_LONG' },
  );
});

test('parseRequest accepts valid generate_quick', () => {
  const result = coreModule.parseRequest({ action: 'generate_quick', input_text: '为创业者写一篇贴文' });
  assert.equal(result.action, 'generate_quick');
  assert.equal(result.input_text, '为创业者写一篇贴文');
});

test('parseRequest accepts generate_quick with previous_version', () => {
  const prev = { platform: 'x', hook: 'test' };
  const result = coreModule.parseRequest({
    action: 'generate_quick',
    input_text: 'revise this',
    previous_version: prev,
  });
  assert.deepEqual(result.previous_version, prev);
});

test('parseRequest rejects generate_from_brief without brief_id', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_from_brief' }),
    { code: 'BRIEF_REQUIRED' },
  );
});

test('parseRequest accepts valid generate_from_brief', () => {
  const result = coreModule.parseRequest({
    action: 'generate_from_brief',
    brief_id: 'brief-1',
    brief_version: 2,
    brief_fingerprint: 'a'.repeat(64),
    brief_target_audience: '创业者',
    brief_channels: 'x, instagram',
    brief_constraints: '不含促销用语',
    brief_summary: 'AI 提效产品发布',
  });
  assert.equal(result.action, 'generate_from_brief');
  assert.equal(result.brief_id, 'brief-1');
  assert.equal(result.brief_version, 2);
  assert.equal(result.brief_fingerprint, 'a'.repeat(64));
});

test('parseRequest rejects brief generation without exact version and fingerprint', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_from_brief', brief_id: 'brief-1' }),
    { code: 'BRIEF_VERSION_REQUIRED' },
  );
  assert.throws(
    () => coreModule.parseRequest({ action: 'generate_from_brief', brief_id: 'brief-1', brief_version: 1 }),
    { code: 'BRIEF_FINGERPRINT_REQUIRED' },
  );
});

test('parseRequest rejects revise without feedback', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'revise', revision_feedback: '' }),
    { code: 'REVISION_FEEDBACK_REQUIRED' },
  );
});

test('parseRequest rejects revise without previous_version', () => {
  assert.throws(
    () => coreModule.parseRequest({ action: 'revise', revision_feedback: '改温和一点' }),
    { code: 'PREVIOUS_VERSION_REQUIRED' },
  );
});

test('parseRequest accepts valid revise', () => {
  const prev = { platform: 'x', hook: 'old' };
  const result = coreModule.parseRequest({
    action: 'revise',
    revision_feedback: '改温和一点',
    previous_version: prev,
  });
  assert.equal(result.action, 'revise');
  assert.equal(result.revision_feedback, '改温和一点');
  assert.deepEqual(result.previous_version, prev);
});

// ---- validateGeneratedContent 测试 ---------------------------------------------
test('validateGeneratedContent rejects non-object', () => {
  assert.throws(() => coreModule.validateGeneratedContent(null), { code: 'INVALID_MODEL_RESPONSE' });
  assert.throws(() => coreModule.validateGeneratedContent('text'), { code: 'INVALID_MODEL_RESPONSE' });
});

test('validateGeneratedContent rejects missing fields', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent({ platform: 'x' }),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent rejects invalid platform', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent(validResult({ platform: 'myspace' })),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent rejects invalid visual_type', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent(validResult({ visual_type: '3d_model' })),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent rejects invalid aspect_ratio', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent(validResult({ aspect_ratio: '21:9' })),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent rejects non-string fields', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent({ ...validResult(), platform: 123 }),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent rejects non-array hashtags', () => {
  assert.throws(
    () => coreModule.validateGeneratedContent({ ...validResult(), hashtags: '#tag' }),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('validateGeneratedContent accepts valid result', () => {
  const result = coreModule.validateGeneratedContent(validResult());
  assert.equal(result.platform, 'x');
  assert.equal(result.audience, '独立创业者');
  assert.equal(result.tone, '专业直接');
  assert.ok(Array.isArray(result.hashtags));
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.length <= 2);
});

test('validateGeneratedContent rejects invalid candidates', () => {
  assert.throws(() => coreModule.validateGeneratedContent(validResult({
    candidates: [{ hook: 'good', copy: 'text' }, null],
  })), { code: 'MODEL_SCHEMA_VIOLATION' });
});

test('validateGeneratedContent rejects more than 2 candidates', () => {
  const candidates = [
    { hook: 'h1', copy: 'c1', cta: 'a1' },
    { hook: 'h2', copy: 'c2', cta: 'a2' },
    { hook: 'h3', copy: 'c3', cta: 'a3' },
  ];
  assert.throws(() => coreModule.validateGeneratedContent(validResult({ candidates })), { code: 'MODEL_SCHEMA_VIOLATION' });
});

test('previous_version and model output are depth and size bounded', () => {
  let deep = { value: 'x' };
  for (let index = 0; index < coreModule.LIMITS.MAX_NESTING_DEPTH + 2; index += 1) deep = { child: deep };
  assert.throws(() => coreModule.parseRequest({
    action: 'revise', revision_feedback: '改一下', previous_version: deep,
  }), { code: 'PREVIOUS_VERSION_OUT_OF_BOUNDS' });
  assert.throws(() => coreModule.validateGeneratedContent(validResult({ hook: 'x'.repeat(121) })), {
    code: 'MODEL_SCHEMA_VIOLATION',
  });
  assert.throws(() => coreModule.validateGeneratedContent(validResult({ hashtags: ['not-a-tag'] })), {
    code: 'MODEL_SCHEMA_VIOLATION',
  });
});

// ---- buildQuickPrompt 测试 ----------------------------------------------------
test('buildQuickPrompt includes input text', () => {
  const prompt = coreModule.buildQuickPrompt('测试内容');
  assert.ok(prompt.includes('测试内容'));
  assert.ok(prompt.includes('platform'));
  assert.ok(prompt.includes('main_copy'));
});

test('buildQuickPrompt includes previous version when provided', () => {
  const prev = { platform: 'x', hook: 'old hook', main_copy: 'old copy' };
  const prompt = coreModule.buildQuickPrompt('revise', prev);
  assert.ok(prompt.includes('前一版本内容'));
  assert.ok(prompt.includes('old hook'));
});

// ---- buildBriefPrompt 测试 ----------------------------------------------------
test('buildBriefPrompt includes brief data', () => {
  const brief = {
    brief_topic: 'AI 创业',
    brief_objective: '解释效率价值',
    brief_target_audience: '创业者',
    brief_channels: 'x',
    brief_constraints: '不含促销',
    brief_summary: 'AI 产品发布',
    structural_guidance: ['保留来源事实'],
    knowledge_citation_ids: ['kc-1'],
    evidence_provenance: { source: 'approved_brief' },
  };
  const prompt = coreModule.buildBriefPrompt(brief);
  assert.ok(prompt.includes('创业者'));
  assert.ok(prompt.includes('AI 产品发布'));
  assert.ok(prompt.includes('kc-1'));
  assert.ok(prompt.includes('保留来源事实'));
});

// ---- sanitizeError 测试 -------------------------------------------------------
test('sanitizeError returns sanitized P30Error', () => {
  const err = new coreModule.P30Error('TEST_CODE', '测试错误', 400);
  const result = coreModule.sanitizeError(err);
  assert.equal(result.code, 'TEST_CODE');
  assert.equal(result.message, '测试错误');
  assert.equal(result.status, 400);
});

test('sanitizeError redacts Bearer tokens', () => {
  const result = coreModule.sanitizeError(new Error('Auth failed: Bearer sk-abc123xyz'));
  assert.ok(!result.message.includes('sk-abc123xyz'));
  assert.ok(result.message.includes('[REDACTED]'));
});

test('sanitizeError redacts URLs', () => {
  const result = coreModule.sanitizeError(new Error('Failed at https://api.example.com/secret?key=val'));
  assert.ok(!result.message.includes('api.example.com'));
  assert.ok(result.message.includes('[URL_REDACTED]'));
});

// ---- formatSummaryLine 测试 ---------------------------------------------------
test('formatSummaryLine produces expected format', () => {
  const summary = coreModule.formatSummaryLine({
    platform: 'x',
    audience: '独立创业者',
    tone: '专业直接',
    visual_type: 'single_image',
  });
  assert.equal(summary, 'x / 独立创业者 / 专业直接 / 单图');
});

// ---- LIMITS 常量 -------------------------------------------------------------
test('LIMITS.MAX_INPUT_LENGTH is 500', () => {
  assert.equal(coreModule.LIMITS.MAX_INPUT_LENGTH, 500);
});

test('LIMITS.MAX_TOKENS is bounded', () => {
  assert.ok(coreModule.LIMITS.MAX_TOKENS > 0);
  assert.ok(coreModule.LIMITS.MAX_TOKENS <= 4000);
});

test('ALLOWED_MODEL is qwen-plus', () => {
  assert.equal(coreModule.ALLOWED_MODEL, 'qwen-plus');
});

// ---- ACTIONS 常量 -------------------------------------------------------------
test('ACTIONS contains all required actions', () => {
  assert.equal(coreModule.ACTIONS.STATUS, 'status');
  assert.equal(coreModule.ACTIONS.GENERATE_QUICK, 'generate_quick');
  assert.equal(coreModule.ACTIONS.GENERATE_FROM_BRIEF, 'generate_from_brief');
  assert.equal(coreModule.ACTIONS.REVISE, 'revise');
});

// ---- 文件变更审计 -------------------------------------------------------------
test('allowed files exist and are within scope', () => {
  const files = [
    'src/pages/ContentWorkspacePage.jsx',
    'src/styles.css',
    'src/components/content-workspace/ContentCreationModePanel.jsx',
    'src/services/content-creation-service.js',
    'supabase/functions/p30-content-create/index.ts',
    'supabase/functions/p30-content-create/content-core.mjs',
    'test/content-creation-modes.test.mjs',
    'test/content-creation-modes.browser.test.mjs',
    'docs/P30_CONTENT_CREATION_MODES.md',
  ];
  for (const f of files) {
    const full = join(REPO_ROOT, f);
    assert.equal(existsSync(full), true, `required owned file missing: ${f}`);
  }
});

// ---- 辅助函数 ----------------------------------------------------------------
function validResult(overrides = {}) {
  return {
    platform: 'x',
    audience: '独立创业者',
    tone: '专业直接',
    content_goal: '提升品牌认知',
    hook: '你知道吗？AI 正在改变创业的方式。',
    cta: '在评论区分享你的看法',
    main_copy: '人工智能正在以前所未有的方式改变创业生态...',
    hashtags: ['#AI', '#创业', '#效率提升'],
    visual_type: 'single_image',
    visual_description: '一张简洁的图表展示 AI 提效数据',
    aspect_ratio: '1:1',
    candidates: [
      { hook: '备选开头 1', copy: '备选正文 1', cta: '备选 CTA 1' },
    ],
    ...overrides,
  };
}
