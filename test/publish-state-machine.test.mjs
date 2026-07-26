import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublishPreflightChecks,
  getContentApprovalState,
  getDryRunPresentation,
  getPublishErrorPresentation,
  getPublishReadiness,
  getPublishTaskState,
} from '../src/services/publish-state-machine.js';

const approvedContent = {
  id: 'package-1',
  reviewStatus: 'approved',
  approvedForPublishing: true,
  body: 'Telegram Day 1 test content',
  platform: 'telegram',
  raw: { review_status: 'approved' },
};

const approvedAsset = {
  id: 'asset-1',
  url: 'https://example.com/day1.jpg',
  approvedForPublishing: true,
  raw: { approved_for_publishing: true },
};

test('content approval and publish task state stay separate', () => {
  const task = { status: 'draft', approval_status: 'pending' };
  assert.equal(getContentApprovalState(task, approvedContent), 'approved');
  assert.equal(getPublishTaskState(task), 'pending_approval');

  assert.equal(getPublishTaskState({ status: 'scheduled', approval_status: 'approved' }), 'scheduled');
  assert.equal(getPublishTaskState({ status: 'failed', approval_status: 'approved' }), 'failed');
  assert.equal(getPublishTaskState({ status: 'cancelled', approval_status: 'rejected' }), 'cancelled');
});

test('Telegram preflight covers all required safety checks', () => {
  const task = {
    platform: 'Telegram',
    status: 'draft',
    approval_status: 'pending',
    publish_content: {
      body: 'Telegram Day 1 test content',
      selected_asset_id: 'asset-1',
    },
    publish_result: { execution_mode: 'dry_run' },
  };
  const checks = buildPublishPreflightChecks({
    task,
    content: approvedContent,
    connection: { id: 'connection-1', platform: 'telegram', status: 'connected', account_id: 'account-1' },
    account: { id: 'account-1' },
    asset: approvedAsset,
  });

  assert.equal(checks.length, 8);
  assert.ok(checks.every((item) => item.passed));
  assert.deepEqual(checks.map((item) => item.code), [
    'content_approved',
    'asset_approved',
    'account_connected',
    'publish_permission',
    'platform_format',
    'asset_url',
    'schedule_valid',
    'execution_mode',
  ]);
});

test('X preflight accepts four approved images and rejects mixed image plus video', () => {
  const baseTask = {
    platform: 'X',
    status: 'draft',
    approval_status: 'pending',
    publish_result: { execution_mode: 'dry_run' },
  };
  const connection = {
    id: 'connection-x',
    platform: 'X',
    status: 'connected',
    is_connected: true,
    account_id: 'account-x',
    permissions: ['tweet.read', 'tweet.write', 'media.write'],
  };
  const images = Array.from({ length: 4 }, (_, index) => ({
    id: `image-${index}`,
    type: 'image',
    output_url: `https://example.com/image-${index}.jpg`,
    status: 'completed',
    approved_for_publishing: true,
  }));
  const imageTask = {
    ...baseTask,
    publish_content: {
      body: 'Four-image X post',
      selected_asset_ids: images.map((item) => item.id),
      assets: images,
    },
  };
  const imageChecks = buildPublishPreflightChecks({
    task: imageTask,
    content: { ...approvedContent, platform: 'X' },
    connection,
    account: { id: 'account-x' },
  });
  assert.equal(imageChecks.find((item) => item.code === 'platform_format').passed, true);
  assert.equal(imageChecks.find((item) => item.code === 'asset_url').passed, true);

  const mixed = [...images.slice(0, 1), {
    id: 'video-1',
    type: 'video',
    output_url: 'https://example.com/video.mp4',
    status: 'completed',
    approved_for_publishing: true,
  }];
  const mixedChecks = buildPublishPreflightChecks({
    task: {
      ...baseTask,
      publish_content: {
        body: 'Mixed media is invalid',
        selected_asset_ids: mixed.map((item) => item.id),
        assets: mixed,
      },
    },
    content: { ...approvedContent, platform: 'X' },
    connection,
    account: { id: 'account-x' },
  });
  assert.equal(mixedChecks.find((item) => item.code === 'platform_format').passed, false);
});

test('X preflight accepts one approved video', () => {
  const video = {
    id: 'video-1',
    type: 'video',
    output_url: 'https://example.com/day1.mp4',
    status: 'completed',
    approved_for_publishing: true,
  };
  const checks = buildPublishPreflightChecks({
    task: {
      platform: 'X',
      publish_content: {
        body: 'Video post',
        selected_asset_id: video.id,
        selected_asset_ids: [video.id],
        assets: [video],
      },
      publish_result: { execution_mode: 'dry_run' },
    },
    content: { ...approvedContent, platform: 'X' },
    connection: {
      platform: 'X',
      status: 'connected',
      is_connected: true,
      account_id: 'account-x',
      permissions: ['tweet.write', 'media.write'],
    },
    account: { id: 'account-x' },
  });
  assert.ok(checks.every((item) => item.passed));
});

test('dry-run success is presented as completed test, never publish failure', () => {
  const presentation = getDryRunPresentation({
    status: 'draft',
    publish_result: {
      execution_mode: 'dry_run',
      preflight: { passed: true, checked_at: '2026-07-25T05:00:00Z' },
      last_execution: { mode: 'dry_run', status: 'preflight_passed', publish_triggered: false },
    },
  });
  assert.equal(presentation.title, '上次安全预演通过');
  assert.match(presentation.summary, /未执行真实发布/);
  assert.equal(getPublishTaskState({ status: 'draft', approval_status: 'pending' }), 'pending_approval');
});

test('历史安全预演失败不会覆盖当前业务检查结论', () => {
  const presentation = getDryRunPresentation({
    publish_result: {
      execution_mode: 'dry_run',
      preflight: { passed: false, checked_at: '2026-07-25T05:00:00Z' },
    },
  });
  assert.equal(presentation.title, '上次安全预演未通过');
  assert.match(presentation.summary, /以当前业务检查和执行条件为准/);
});

test('业务检查全通过但执行授权未满足时显示暂不可发布', () => {
  const checks = Array.from({ length: 8 }, (_, index) => ({ code: `check-${index}`, passed: true }));
  const readiness = getPublishReadiness({
    checks,
    task: { publish_result: { preflight: { passed: false } } },
    humanAuthorized: false,
  });
  assert.equal(readiness.businessPassed, 8);
  assert.equal(readiness.businessReady, true);
  assert.equal(readiness.executionConditionsMet, false);
  assert.equal(readiness.finalLabel, '暂不可发布');
});

test('旧 connected 文本不能绕过后端明确的 OAuth 失效状态', () => {
  const checks = buildPublishPreflightChecks({
    task: {
      platform: 'X',
      publish_content: { body: 'approved text', asset_approved: true },
      publish_result: { execution_mode: 'dry_run' },
    },
    content: approvedContent,
    connection: {
      platform: 'X',
      status: 'connected',
      is_connected: false,
      account_id: 'account-1',
      permissions: ['tweet.write'],
    },
    account: { id: 'account-1' },
    asset: approvedAsset,
  });
  assert.equal(checks.find((item) => item.code === 'account_connected').passed, false);
  assert.equal(checks.find((item) => item.code === 'publish_permission').passed, false);
});

test('failed task exposes safe retry guidance instead of technical details', () => {
  const error = getPublishErrorPresentation({
    status: 'failed',
    retry_count: 1,
    max_retries: 3,
    error_message: '平台未能完成发布。',
    publish_result: {
      error: {
        code: 'PLATFORM_PUBLISH_FAILED',
        retryable: true,
        summary: '平台未能完成发布。',
        recommended_action: '检查连接后重试',
      },
    },
  });
  assert.deepEqual(error, {
    code: 'PLATFORM_PUBLISH_FAILED',
    summary: '平台未能完成发布。',
    retryable: true,
    recommendedAction: '检查连接后重试',
  });
});
