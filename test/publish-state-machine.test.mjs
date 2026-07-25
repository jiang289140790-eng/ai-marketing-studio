import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublishPreflightChecks,
  getContentApprovalState,
  getDryRunPresentation,
  getPublishErrorPresentation,
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

test('dry-run success is presented as completed test, never publish failure', () => {
  const presentation = getDryRunPresentation({
    status: 'draft',
    publish_result: {
      execution_mode: 'dry_run',
      preflight: { passed: true, checked_at: '2026-07-25T05:00:00Z' },
      last_execution: { mode: 'dry_run', status: 'preflight_passed', publish_triggered: false },
    },
  });
  assert.equal(presentation.title, '预检通过');
  assert.match(presentation.summary, /未执行真实发布/);
  assert.equal(getPublishTaskState({ status: 'draft', approval_status: 'pending' }), 'pending_approval');
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
