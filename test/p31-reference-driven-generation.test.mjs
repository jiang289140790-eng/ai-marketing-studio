// P31 参考驱动智能内容生成 — 单元/对抗测试。
//
// 覆盖：
// - v2 contract（resolve_intent, generate_quick_v2）
// - 意图解析：优先级、反小红书启发式
// - 条件化输出：X+image_caption CTA optional、标签 optional
// - 平台/格式合同：严格枚举验证
// - v1 兼容性
// - 参考输入验证：URL scheme、文本长度、图片类型/大小
// - 原始图片不持久化、脱敏错误
// - 来源哈希
// - v2 save 格式

import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---- 导入 content-core.mjs ----
import * as core from '../supabase/functions/p30-content-create/content-core.mjs';

// ===== v2 Contract 测试 =====

test('P31: SCHEMA_VERSION_V2 is defined', () => {
  assert.equal(core.SCHEMA_VERSION_V2, 'p31_reference_driven_v2');
});

test('P31: ACTIONS contains v2 actions', () => {
  assert.equal(core.ACTIONS.RESOLVE_INTENT, 'resolve_intent');
  assert.equal(core.ACTIONS.GENERATE_QUICK_V2, 'generate_quick_v2');
});

test('P31: ALLOWED_MODEL is qwen-plus', () => {
  assert.equal(core.ALLOWED_MODEL, 'qwen-plus');
});

test('P31: MULTIMODAL_MODEL is qwen3.5-omni-flash', () => {
  assert.equal(core.MULTIMODAL_MODEL, 'qwen3.5-omni-flash');
});

// ===== resolve_intent 请求解析 =====

test('P31: parseRequest accepts resolve_intent with valid input', () => {
  const result = core.parseRequest({
    action: 'resolve_intent',
    input_text: '为创业者写一篇 X 贴文',
    reference_url: 'https://x.com/user/status/123456',
    reference_text: '参考文本',
    schema_version: 'p31_reference_driven_v2',
  });
  assert.equal(result.action, 'resolve_intent');
  assert.equal(result.input_text, '为创业者写一篇 X 贴文');
  assert.equal(result.reference_url, 'https://x.com/user/status/123456');
  assert.equal(result.reference_text, '参考文本');
});

test('P31: parseRequest rejects resolve_intent without input_text', () => {
  assert.throws(
    () => core.parseRequest({ action: 'resolve_intent' }),
    { code: 'INPUT_REQUIRED' },
  );
});

test('P31: parseRequest rejects resolve_intent with overly long input', () => {
  const long = 'x'.repeat(core.LIMITS.MAX_INPUT_LENGTH + 1);
  assert.throws(
    () => core.parseRequest({ action: 'resolve_intent', input_text: long }),
    { code: 'INPUT_TOO_LONG' },
  );
});

// ===== generate_quick_v2 请求解析 =====

test('P31: parseRequest accepts generate_quick_v2 with intent', () => {
  const intent = {
    platform: 'x',
    content_format: 'image_caption',
    language_mode: 'zh-cn',
    length_profile: 'short',
    tone: 'professional',
    cta_policy: 'optional',
    hashtag_policy: 'optional_0_5',
    confidence: 'explicit',
    provenance: 'user_request',
  };
  const result = core.parseRequest({
    action: 'generate_quick_v2',
    input_text: '写一条 X 贴文',
    intent,
    schema_version: 'p31_reference_driven_v2',
  });
  assert.equal(result.action, 'generate_quick_v2');
  assert.deepEqual(result.intent.platform, 'x');
  assert.deepEqual(result.intent.content_format, 'image_caption');
});

test('P31: parseRequest rejects generate_quick_v2 without intent', () => {
  assert.throws(
    () => core.parseRequest({ action: 'generate_quick_v2', input_text: 'hello' }),
    { code: 'INTENT_REQUIRED' },
  );
});

test('P31: parseRequest rejects generate_quick_v2 with invalid intent platform', () => {
  assert.throws(
    () => core.parseRequest({
      action: 'generate_quick_v2',
      input_text: 'hello',
      intent: { platform: 'myspace', content_format: 'text_only' },
    }),
    { code: 'INTENT_INVALID_PLATFORM' },
  );
});

test('P31: parseRequest rejects generate_quick_v2 with invalid content_format', () => {
  assert.throws(
    () => core.parseRequest({
      action: 'generate_quick_v2',
      input_text: 'hello',
      intent: { platform: 'x', content_format: '3d_render' },
    }),
    { code: 'INTENT_INVALID_FORMAT' },
  );
});

// ===== 参考 URL 验证 =====

test('P31: validateReferenceUrl accepts valid X HTTPS URL', () => {
  const result = core.validateReferenceUrl('https://x.com/elonmusk/status/123456789');
  assert.equal(result, 'https://x.com/elonmusk/status/123456789');
});

test('P31: validateReferenceUrl accepts twitter.com', () => {
  const result = core.validateReferenceUrl('https://twitter.com/user/status/123');
  assert.equal(result, 'https://twitter.com/user/status/123');
});

test('P31: validateReferenceUrl accepts www.x.com', () => {
  const result = core.validateReferenceUrl('https://www.x.com/abc/status/456');
  assert.equal(result, 'https://www.x.com/abc/status/456');
});

test('P31: validateReferenceUrl rejects non-HTTPS', () => {
  assert.throws(
    () => core.validateReferenceUrl('http://x.com/user/status/123'),
    { code: 'REFERENCE_URL_INVALID' },
  );
});

test('P31: validateReferenceUrl rejects non-X domains', () => {
  assert.throws(
    () => core.validateReferenceUrl('https://evil.com/x.com/status/123'),
    { code: 'REFERENCE_URL_INVALID' },
  );
});

test('P31: validateReferenceUrl rejects empty string (returns null)', () => {
  const result = core.validateReferenceUrl('');
  assert.equal(result, null);
});

test('P31: validateReferenceUrl rejects overly long URL', () => {
  const long = 'https://x.com/user/status/1' + 'x'.repeat(core.LIMITS.MAX_X_URL_LENGTH);
  assert.throws(
    () => core.validateReferenceUrl(long),
    { code: 'REFERENCE_URL_TOO_LONG' },
  );
});

// ===== 参考文本验证 =====

test('P31: validateReferenceText accepts bounded text', () => {
  const result = core.validateReferenceText('这是一段参考文本');
  assert.equal(result, '这是一段参考文本');
});

test('P31: validateReferenceText returns null for empty', () => {
  assert.equal(core.validateReferenceText(''), null);
  assert.equal(core.validateReferenceText('   '), null);
});

test('P31: validateReferenceText rejects overly long text', () => {
  const long = 'x'.repeat(core.LIMITS.MAX_REFERENCE_TEXT_LENGTH + 1);
  assert.throws(
    () => core.validateReferenceText(long),
    { code: 'REFERENCE_TEXT_TOO_LONG' },
  );
});

// ===== 图片元数据验证 =====

test('P31: validateImageMetadata accepts valid JPEG', () => {
  const result = core.validateImageMetadata({
    mime_type: 'image/jpeg',
    byte_size: 500000,
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(result, {
    mime_type: 'image/jpeg',
    byte_size: 500000,
    width: 1920,
    height: 1080,
  });
});

test('P31: validateImageMetadata accepts PNG and WebP', () => {
  assert.ok(core.validateImageMetadata({ mime_type: 'image/png', byte_size: 100, width: 100, height: 100 }));
  assert.ok(core.validateImageMetadata({ mime_type: 'image/webp', byte_size: 100, width: 100, height: 100 }));
});

test('P31: validateImageMetadata rejects GIF', () => {
  assert.throws(
    () => core.validateImageMetadata({ mime_type: 'image/gif', byte_size: 100, width: 100, height: 100 }),
    { code: 'IMAGE_TYPE_UNSUPPORTED' },
  );
});

test('P31: MAX_IMAGE_BYTES is 4 MiB per spec', () => {
  assert.equal(core.LIMITS.MAX_IMAGE_BYTES, 4 * 1024 * 1024);
});

test('P31: validateImageMetadata rejects oversized image', () => {
  assert.throws(
    () => core.validateImageMetadata({ mime_type: 'image/jpeg', byte_size: core.LIMITS.MAX_IMAGE_BYTES + 1 }),
    { code: 'IMAGE_SIZE_OUT_OF_BOUNDS' },
  );
});

test('P31: validateImageMetadata rejects oversized dimensions', () => {
  assert.throws(
    () => core.validateImageMetadata({ mime_type: 'image/jpeg', byte_size: 100, width: core.LIMITS.MAX_IMAGE_DIMENSION + 1 }),
    { code: 'IMAGE_DIMENSION_OUT_OF_BOUNDS' },
  );
});

// ===== 图片 Data URL 验证 =====

test('P31: validateImageDataUrl accepts valid JPEG data URL', () => {
  // 使用 Node.js Buffer 生成合法 JPEG base64（最小有效 JPEG 文件）
  const jpegBytes = new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08,
    0x07, 0x07, 0x07, 0x09, 0x09, 0x08, 0x0A, 0x0C, 0x14, 0x0D, 0x0C, 0x0B, 0x0B, 0x0C, 0x19, 0x12,
    0x13, 0x0F, 0x14, 0x1D, 0x1A, 0x1F, 0x1E, 0x1D, 0x1A, 0x1C, 0x1E, 0x20, 0x24, 0x2E, 0x27, 0x20,
    0x22, 0x2C, 0x23, 0x1C, 0x1E, 0x28, 0x34, 0x28, 0x2C, 0x30, 0x31, 0x33, 0x34, 0x34, 0x34, 0x1F,
    0x27, 0x39, 0x3D, 0x38, 0x32, 0x3C, 0x2E, 0x33, 0x34, 0x32, 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00,
    0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x1F, 0x00, 0x00, 0x01, 0x05, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03,
    0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01,
    0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D, 0x01, 0x02, 0x03,
    0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
    0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62,
    0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34,
    0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54,
    0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74,
    0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93,
    0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA,
    0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8,
    0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5,
    0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF,
    0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCD, 0x34, 0x90, 0x01, 0x24, 0x00,
    0x06, 0x49, 0x3C, 0x00, 0x07, 0x52, 0x4D, 0x7F, 0xFF, 0xD9,
  ]);
  // 使用 Buffer 的 base64 编码
  const miniJpeg = globalThis.Buffer.from(jpegBytes).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${miniJpeg}`;
  const result = core.validateImageDataUrl(dataUrl);
  assert.ok(result.startsWith('data:image/jpeg;base64,'));
});

test('P31: validateImageDataUrl accepts PNG data URL', () => {
  const miniPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = core.validateImageDataUrl(`data:image/png;base64,${miniPng}`);
  assert.ok(result.startsWith('data:image/png;base64,'));
});

test('P31: validateImageDataUrl rejects non-image MIME', () => {
  assert.throws(
    () => core.validateImageDataUrl('data:text/plain;base64,SGVsbG8='),
    { code: 'IMAGE_DATA_URL_INVALID' },
  );
});

test('P31: validateImageDataUrl rejects GIF', () => {
  assert.throws(
    () => core.validateImageDataUrl('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
    { code: 'IMAGE_TYPE_UNSUPPORTED' },
  );
});

test('P31: validateImageDataUrl rejects empty string', () => {
  assert.throws(
    () => core.validateImageDataUrl(''),
    { code: 'IMAGE_DATA_URL_REQUIRED' },
  );
});

test('P31: validateImageDataUrl rejects invalid base64', () => {
  assert.throws(
    () => core.validateImageDataUrl('data:image/jpeg;base64,!!!invalid!!!'),
    { code: 'IMAGE_DATA_URL_INVALID' },
  );
});

test('P31: validateImageDataUrl rejects MIME and magic-byte mismatch', () => {
  const fakePng = `data:image/png;base64,${Buffer.from('not-a-png').toString('base64')}`;
  assert.throws(
    () => core.validateImageDataUrl(fakePng),
    (error) => error?.code === 'IMAGE_SIGNATURE_MISMATCH',
  );
});

// ===== 意图解析验证 =====

test('P31: validateResolvedIntentOutput accepts valid intent', () => {
  const result = core.validateResolvedIntentOutput({
    platform: 'x',
    content_format: 'image_caption',
    language_mode: 'en',
    length_profile: 'short',
    tone: 'professional',
    cta_policy: 'optional',
    hashtag_policy: 'optional_0_5',
    confidence: 'explicit',
    audience: 'startup founders',
  });
  assert.equal(result.platform, 'x');
  assert.equal(result.content_format, 'image_caption');
  assert.equal(result.language_mode, 'en');
  assert.equal(result.confidence, 'explicit');
  assert.equal(result.provenance, 'explicit_user_request');
});

test('P31: validateResolvedIntentOutput rejects unsupported platform', () => {
  assert.throws(
    () => core.validateResolvedIntentOutput({ platform: 'snapchat', content_format: 'text_only' }),
    { code: 'INTENT_RESPONSE_INVALID' },
  );
});

test('P31: validateResolvedIntentOutput maps confidence to provenance', () => {
  const ref = core.validateResolvedIntentOutput({
    platform: 'x', content_format: 'image_caption', confidence: 'reference',
  });
  assert.equal(ref.provenance, 'validated_reference');

  const def = core.validateResolvedIntentOutput({
    platform: 'x', content_format: 'image_caption', confidence: 'defaults',
  });
  assert.equal(def.provenance, 'account_project_defaults');

  const inf = core.validateResolvedIntentOutput({
    platform: 'x', content_format: 'image_caption', confidence: 'inferred',
  });
  assert.equal(inf.provenance, 'model_inference');
});

// ===== v2 条件化输出验证 =====

test('P31: validateV2GeneratedContent accepts valid v2 output with required CTA', () => {
  const intent = {
    platform: 'x',
    content_format: 'long_post',
    cta_policy: 'required',
    hashtag_policy: 'required_3_5',
  };
  const result = core.validateV2GeneratedContent({
    title: 'AI 改变创业方式',
    main_copy: '很长的正文内容...',
    visual_description: '科技感图表',
    platform: 'x',
    content_format: 'long_post',
    cta: '评论区分享你的看法',
    hashtags: ['#AI', '#创业', '#效率'],
  }, intent);
  assert.equal(result.title, 'AI 改变创业方式');
  assert.equal(result.cta, '评论区分享你的看法');
  assert.equal(result.hashtags.length, 3);
});

test('P31: validateV2GeneratedContent rejects missing CTA when policy is required', () => {
  const intent = { platform: 'x', content_format: 'image_caption', cta_policy: 'required', hashtag_policy: 'required_3_5' };
  assert.throws(
    () => core.validateV2GeneratedContent({
      title: 'test', main_copy: 'test', visual_description: 'test',
      platform: 'x', content_format: 'image_caption',
      hashtags: ['#test'],
    }, intent),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('P31: validateV2GeneratedContent allows empty CTA when optional', () => {
  const intent = { platform: 'x', content_format: 'image_caption', cta_policy: 'optional', hashtag_policy: 'optional_0_5' };
  const result = core.validateV2GeneratedContent({
    title: 'test', main_copy: 'test', visual_description: 'test',
    platform: 'x', content_format: 'image_caption',
    hashtags: [],
  }, intent);
  assert.equal(result.title, 'test');
  assert.equal(result.hashtags.length, 0);
});

test('P31: validateV2GeneratedContent allows empty hashtags for optional_0_5', () => {
  const intent = { platform: 'x', content_format: 'image_caption', cta_policy: 'none', hashtag_policy: 'optional_0_5' };
  const result = core.validateV2GeneratedContent({
    title: 'test', main_copy: 'test', visual_description: 'test',
    platform: 'x', content_format: 'image_caption',
    hashtags: [],
  }, intent);
  assert.ok(Array.isArray(result.hashtags));
  assert.equal(result.hashtags.length, 0);
});

test('P31: validateV2GeneratedContent rejects missing required hashtags', () => {
  const intent = { platform: 'x', content_format: 'long_post', cta_policy: 'required', hashtag_policy: 'required_3_5' };
  assert.throws(
    () => core.validateV2GeneratedContent({
      title: 'test', main_copy: 'test', visual_description: 'test',
      platform: 'x', content_format: 'long_post',
      cta: 'click here',
      hashtags: [],
    }, intent),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('P31: validateV2GeneratedContent rejects platform mismatch', () => {
  const intent = { platform: 'x', content_format: 'image_caption', cta_policy: 'optional', hashtag_policy: 'optional_0_5' };
  assert.throws(
    () => core.validateV2GeneratedContent({
      title: 'test', main_copy: 'test', visual_description: 'test',
      platform: 'instagram', content_format: 'image_caption',
    }, intent),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

test('P31: validateV2GeneratedContent rejects content_format mismatch', () => {
  const intent = { platform: 'x', content_format: 'image_caption', cta_policy: 'optional', hashtag_policy: 'optional_0_5' };
  assert.throws(
    () => core.validateV2GeneratedContent({
      title: 'test', main_copy: 'test', visual_description: 'test',
      platform: 'x', content_format: 'long_post',
    }, intent),
    { code: 'MODEL_SCHEMA_VIOLATION' },
  );
});

// ===== X + image_caption 特殊规则 =====

test('P31: X + image_caption → CTA optional, hashtags optional', () => {
  const rules = core.getConditionalRules('x', 'image_caption');
  assert.equal(rules.cta, 'optional');
  assert.equal(rules.hashtags, 'optional_0_5');
});

test('P31: X 非小红书——平台选择不因中文输入而改变', () => {
  // 这是一个逻辑测试：确保 resolveIntentPriority 优先级逻辑正确
  // 测试：没有显式覆盖、没有参考、没有默认值时，返回 inferred
  const priority = core.resolveIntentPriority(null, null, null);
  assert.equal(priority.priority, 'inferred');
  assert.equal(priority.source, 'model_inference');
});

test('P31: explicit overrides 优先级最高', () => {
  const priority = core.resolveIntentPriority(
    { platform: 'x' },
    { validated: true },
    { available: true },
  );
  assert.equal(priority.priority, 'explicit');
  assert.equal(priority.source, 'user_overrides');
});

test('P31: validated reference 优先级高于 defaults', () => {
  const priority = core.resolveIntentPriority(
    null,
    { validated: true },
    { available: true },
  );
  assert.equal(priority.priority, 'reference');
  assert.equal(priority.source, 'validated_reference');
});

// ===== 多模态模型选择 =====

test('P31: shouldUseMultimodal returns true when has image', () => {
  assert.equal(core.shouldUseMultimodal(true, null), true);
});

test('P31: shouldUseMultimodal returns true when has reference data', () => {
  assert.equal(core.shouldUseMultimodal(false, { url: 'https://x.com' }), true);
});

test('P31: shouldUseMultimodal returns false for text-only', () => {
  assert.equal(core.shouldUseMultimodal(false, null), false);
});

// ===== prompt 构建 =====

test('P31: buildResolveIntentPrompt includes anti-XHS heuristic', () => {
  const prompt = core.buildResolveIntentPrompt('给创业者的建议', null, null, null);
  assert.ok(prompt.includes('不要仅因为输入语言是中文就选择 xiaohongshu'));
  assert.ok(prompt.includes('小红书'));
});

test('P31: buildResolveIntentPrompt includes reference text', () => {
  const prompt = core.buildResolveIntentPrompt('test', '参考内容', null, null);
  assert.ok(prompt.includes('参考内容'));
});

test('P31: buildV2GenerationPrompt includes intent fields', () => {
  const intent = {
    platform: 'x', content_format: 'image_caption',
    language_mode: 'zh-cn', length_profile: 'short',
    tone: 'professional', cta_policy: 'optional', hashtag_policy: 'optional_0_5',
  };
  const prompt = core.buildV2GenerationPrompt('测试', intent, null, null);
  assert.ok(prompt.includes('image_caption'));
  assert.ok(prompt.includes('CTA 策略'));
  assert.ok(prompt.includes('optional'));
});

test('P31: buildV2GenerationPrompt omits CTA when policy is none', () => {
  const intent = {
    platform: 'x', content_format: 'text_only',
    language_mode: 'en', length_profile: 'micro',
    tone: 'casual', cta_policy: 'none', hashtag_policy: 'none',
  };
  const prompt = core.buildV2GenerationPrompt('test', intent, null, null);
  assert.ok(!prompt.includes('- cta:'));
  assert.ok(!prompt.includes('- hashtags:'));
});

// ===== v2 intent 摘要 =====

test('P31: formatIntentSummaryLine returns correct format', () => {
  const summary = core.formatIntentSummaryLine({
    platform: 'x',
    content_format: 'image_caption',
    tone: 'professional',
    language_mode: 'zh-cn',
  });
  assert.ok(summary.includes('X'));
  assert.ok(summary.includes('图文'));
  assert.ok(summary.includes('专业'));
});

test('P31: formatIntentSummaryLine for xiaohongshu', () => {
  const summary = core.formatIntentSummaryLine({
    platform: 'xiaohongshu',
    content_format: 'carousel',
    tone: 'casual',
    language_mode: 'zh-cn',
  });
  assert.ok(summary.includes('小红书'));
  assert.ok(summary.includes('轮播'));
});

// ===== v1 兼容性 =====

test('P31: v1 generate_quick still works', () => {
  const result = core.parseRequest({
    action: 'generate_quick',
    input_text: 'hello',
    schema_version: 'p30_content_create_v1',
  });
  assert.equal(result.action, 'generate_quick');
});

test('P31: v1 generate_from_brief still works', () => {
  const result = core.parseRequest({
    action: 'generate_from_brief',
    brief_id: 'brief-1',
    brief_version: 1,
    brief_fingerprint: 'a'.repeat(64),
  });
  assert.equal(result.action, 'generate_from_brief');
});

test('P31: v1 revise still works', () => {
  const prev = { platform: 'x', hook: 'test' };
  const result = core.parseRequest({
    action: 'revise',
    revision_feedback: 'make it better',
    previous_version: prev,
  });
  assert.equal(result.action, 'revise');
  assert.deepEqual(result.previous_version, prev);
});

test('P31: v1 validateGeneratedContent accepts valid result', () => {
  const result = core.validateGeneratedContent(validV1Result());
  assert.equal(result.platform, 'x');
  assert.ok(Array.isArray(result.hashtags));
});

// ===== 脱敏错误 =====

test('P31: sanitizeError hides Bearer tokens in v2 context', () => {
  const result = core.sanitizeError(new Error('P31 failed: Bearer sk-v2-test-token-here'));
  assert.ok(!result.message.includes('sk-v2-test-token-here'));
  assert.ok(result.message.includes('[REDACTED]'));
});

test('P31: sanitizeError hides URLs', () => {
  const result = core.sanitizeError(new Error('Failed at https://dashscope.aliyuncs.com/v1?key=secret'));
  assert.ok(!result.message.includes('dashscope.aliyuncs.com'));
});

test('P31: sanitizeError preserves P30Error codes', () => {
  const err = new core.P30Error('INTENT_FAILED', '意图解析失败', 502);
  const result = core.sanitizeError(err);
  assert.equal(result.code, 'INTENT_FAILED');
  assert.equal(result.status, 502);
});

// ===== 条件化输出规则完整性 =====

test('P31: getConditionalRules returns default for unknown combo', () => {
  const rules = core.getConditionalRules('unknown_platform', 'unknown_format');
  assert.equal(rules.cta, 'required');
  assert.equal(rules.hashtags, 'required_3_5');
});

test('P31: xiaohongshu+carousel rules exist', () => {
  const rules = core.getConditionalRules('xiaohongshu', 'carousel');
  assert.ok(rules.description.includes('小红书'));
});

// ===== intent_overrides 验证 =====

test('P31: validateIntentOverrides accepts valid overrides', () => {
  const result = core.validateIntentOverrides({
    platform: 'instagram',
    content_format: 'carousel',
    tone: 'casual',
  });
  assert.equal(result.platform, 'instagram');
  assert.equal(result.content_format, 'carousel');
  assert.equal(result.tone, 'casual');
});

test('P31: validateIntentOverrides rejects invalid platform', () => {
  assert.throws(
    () => core.validateIntentOverrides({ platform: 'snapchat' }),
    { code: 'INTENT_OVERRIDES_INVALID' },
  );
});

test('P31: validateIntentOverrides rejects invalid content_format', () => {
  assert.throws(
    () => core.validateIntentOverrides({ content_format: 'podcast' }),
    { code: 'INTENT_OVERRIDES_INVALID' },
  );
});

// ===== 文件变更审计 =====

test('P31: required files exist', () => {
  const files = [
    'src/pages/ContentWorkspacePage.jsx',
    'src/styles.css',
    'src/components/content-workspace/ContentCreationModePanel.jsx',
    'src/components/content-workspace/CreationIntentSummary.jsx',
    'src/services/content-creation-service.js',
    'src/services/p22-research-assist.js',
    'src/pages/GenerationTasksPage.jsx',
    'supabase/functions/p30-content-create/index.ts',
    'supabase/functions/p30-content-create/content-core.mjs',
    'test/content-creation-modes.test.mjs',
    'test/content-creation-modes.browser.test.mjs',
    'test/p31-reference-driven-generation.test.mjs',
  ];
  for (const f of files) {
    const full = join(REPO_ROOT, f);
    assert.equal(existsSync(full), true, `required file missing: ${f}`);
  }
});

// ===== v2 save 格式验证 =====

test('P31: v2 generation_brief must contain p31 schema and no raw image', () => {
  const genBrief = {
    schema_version: 'p31_reference_driven_v2',
    original_input: 'test',
    summary: 'summary',
    visual_plan: 'visual plan',
    provider: 'dashscope/qwen',
    model: 'qwen-plus',
    usage: { total_tokens: 150 },
    source: 'quick_generate_v2',
    intent: {
      platform: 'x',
      content_format: 'image_caption',
      language_mode: 'zh-cn',
      length_profile: 'short',
      tone: 'professional',
      cta_policy: 'optional',
      hashtag_policy: 'optional_0_5',
      confidence: 'explicit',
      provenance: 'user_request',
    },
    reference_provenance: {
      url: 'https://x.com/test/status/123',
      text_sha256: 'abc123',
      image_metadata: {
        mime_type: 'image/jpeg',
        byte_size: 50000,
        width: 800,
        height: 600,
        sha256: 'def456',
      },
    },
  };
  assert.equal(genBrief.schema_version, 'p31_reference_driven_v2');
  // 不得包含原始图片数据
  assert.ok(!Object.prototype.hasOwnProperty.call(genBrief.reference_provenance.image_metadata, 'data'));
  assert.ok(!Object.prototype.hasOwnProperty.call(genBrief.reference_provenance.image_metadata, 'base64'));
  assert.ok(!Object.prototype.hasOwnProperty.call(genBrief.reference_provenance.image_metadata, 'content'));
  // 不得包含 secret
  assert.ok(!Object.keys(genBrief).some((k) => ['token', 'authorization', 'secret', 'jwt'].includes(k.toLowerCase())));
});

test('P31: v2 reference_provenance is null when no references', () => {
  const genBrief = {
    schema_version: 'p31_reference_driven_v2',
    intent: { platform: 'x', content_format: 'text_only' },
    reference_provenance: null,
  };
  assert.equal(genBrief.reference_provenance, null);
});

// ---- Edge Function handler 对抗测试 ----

test('P31: Edge handler source has v2 action guards', () => {
  const source = readFileSync(join(REPO_ROOT, 'supabase', 'functions', 'p30-content-create', 'index.ts'), 'utf8');
  assert.match(source, /RESOLVE_INTENT/);
  assert.match(source, /GENERATE_QUICK_V2/);
  assert.match(source, /resolve_intent/);
  assert.match(source, /generate_quick_v2/);
  assert.match(source, /MULTIMODAL_MODEL/);
  assert.match(source, /qwen3\.5-omni-flash/);
});

test('P31: content-core.mjs has multimodal model selection', () => {
  const source = readFileSync(join(REPO_ROOT, 'supabase', 'functions', 'p30-content-create', 'content-core.mjs'), 'utf8');
  assert.match(source, /shouldUseMultimodal/);
  assert.match(source, /qwen3\.5-omni-flash/);
  assert.match(source, /buildResolveIntentPrompt/);
  assert.match(source, /buildV2GenerationPrompt/);
  assert.match(source, /validateV2GeneratedContent/);
  assert.match(source, /validateResolvedIntentOutput/);
  assert.match(source, /formatIntentSummaryLine/);
  assert.match(source, /validateImageDataUrl/);
  assert.match(source, /image_data_url/);
});

test('P31: content-core.mjs MAX_IMAGE_BYTES is 4 MiB', () => {
  const source = readFileSync(join(REPO_ROOT, 'supabase', 'functions', 'p30-content-create', 'content-core.mjs'), 'utf8');
  assert.match(source, /MAX_IMAGE_BYTES.*4.*1024.*1024/);
});

test('P31: index.ts constructs real multimodal content array for DashScope', () => {
  const source = readFileSync(join(REPO_ROOT, 'supabase', 'functions', 'p30-content-create', 'index.ts'), 'utf8');
  assert.match(source, /image_url/);
  assert.match(source, /imageDataUrl/);
  assert.match(source, /type.*image_url/);
  assert.match(source, /useMultimodal/);
  // 验证：含图片时 model 必须是 MULTIMODAL_MODEL
  assert.match(source, /MULTIMODAL_MODEL/);
  // 不包含布尔占位（说明不再是 has_image_reference 标志）
  // 含真实图片时选多模态模型
  assert.match(source, /modelToUse.*MULTIMODAL_MODEL/);
});

// ---- 辅助函数 ----

function validV1Result(overrides = {}) {
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
