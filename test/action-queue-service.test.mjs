import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUserActionQueue } from '../src/services/action-queue-service.js';

function baseData(overrides = {}) {
  return {
    campaigns: [{
      id: 'campaign-1',
      name: '增长活动',
      metadata: { primary_account_id: 'account-1' },
    }],
    accounts: [{ id: 'account-1', platform: 'x', username: '@brand' }],
    strategies: [],
    contentPackages: [],
    legacyContent: [],
    legacyAssets: [],
    assets: [],
    publishTasks: [],
    agentRuns: [],
    workflowRuns: [],
    ...overrides,
  };
}

test('strategy and seven day plan approvals become direct action items', () => {
  const queue = buildUserActionQueue(baseData({
    strategies: [
      { id: 'strategy-review', campaign_id: 'campaign-1', status: 'review' },
      {
        id: 'strategy-plan',
        campaign_id: 'campaign-1',
        status: 'approved',
        daily_plan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, topic: `主题 ${index + 1}` })),
        source_insights: [{ type: 'daily_plan_generation', status: 'review' }],
      },
    ],
  }));

  assert.deepEqual(queue.map((item) => item.action_type), ['approve_7_day_plan', 'approve_strategy']);
  assert.equal(queue[0].campaign_name, '增长活动');
  assert.equal(queue[0].account_name, '@brand');
  assert.match(queue[0].target_url, /campaign_id=campaign-1/);
});

test('Day 1 progresses from generation to copy review without duplicate actions', () => {
  const emptyCopyQueue = buildUserActionQueue(baseData({
    contentPackages: [{
      id: 'package-1',
      campaign_id: 'campaign-1',
      title: 'Day 1｜品牌故事',
      source_insights: { day_index: 1 },
    }],
  }));
  assert.deepEqual(emptyCopyQueue.map((item) => item.action_type), ['generate_day1_content']);

  const reviewQueue = buildUserActionQueue(baseData({
    contentPackages: [{
      id: 'package-1',
      campaign_id: 'campaign-1',
      title: 'Day 1｜品牌故事',
      source_insights: {
        day_index: 1,
        content_workbench: { selected_version_id: 'version-1' },
      },
    }],
    legacyContent: [{
      id: 'version-1',
      title: '候选文案',
      generation_brief: { content_package_id: 'package-1' },
    }],
  }));
  assert.deepEqual(reviewQueue.map((item) => item.action_type), ['review_copy']);
  assert.equal(reviewQueue[0].day, 1);
  assert.match(reviewQueue[0].target_url, /day=1/);
});

test('approved copy requests asset creation then asset confirmation', () => {
  const contentPackage = {
    id: 'package-1',
    campaign_id: 'campaign-1',
    title: 'Day 1｜品牌故事',
    source_insights: {
      day_index: 1,
      content_workbench: { selected_version_id: 'version-1', copy_approved: true },
    },
  };
  const data = baseData({
    contentPackages: [contentPackage],
    legacyContent: [{ id: 'version-1', generation_brief: { content_package_id: 'package-1' } }],
  });

  assert.equal(buildUserActionQueue(data)[0].action_type, 'generate_asset');

  const withAsset = {
    ...data,
    legacyAssets: [{
      id: 'asset-1',
      content_package_id: 'package-1',
      status: 'completed',
      output_url: 'https://example.com/asset.jpg',
    }],
  };
  assert.equal(buildUserActionQueue(withAsset)[0].action_type, 'confirm_asset');
});

test('business failures sort before approval work and keep required contract', () => {
  const queue = buildUserActionQueue(baseData({
    publishTasks: [
      { id: 'publish-failed', campaign_id: 'campaign-1', status: 'failed', last_error: '平台拒绝' },
      { id: 'publish-review', campaign_id: 'campaign-1', status: 'pending', approval_status: 'pending' },
    ],
    workflowRuns: [{
      id: 'metrics-failed',
      campaign_id: 'campaign-1',
      status: 'failed',
      workflow_name: 'content metrics collector',
      error_summary: '指标接口超时',
    }],
  }));

  assert.deepEqual(queue.map((item) => item.priority), ['urgent', 'urgent', 'high']);
  for (const item of queue) {
    for (const key of [
      'action_type',
      'entity_type',
      'entity_id',
      'campaign_id',
      'day',
      'title',
      'summary',
      'priority',
      'target_url',
      'recommended_action',
    ]) {
      assert.ok(Object.hasOwn(item, key), `missing ${key}`);
    }
  }
});

test('campaign filter only returns actions visible for the selected campaign', () => {
  const queue = buildUserActionQueue(baseData({
    campaigns: [
      { id: 'campaign-1', name: '活动 1' },
      { id: 'campaign-2', name: '活动 2' },
    ],
    strategies: [
      { id: 'strategy-1', campaign_id: 'campaign-1', status: 'review' },
      { id: 'strategy-2', campaign_id: 'campaign-2', status: 'review' },
    ],
  }), { campaignId: 'campaign-2' });

  assert.equal(queue.length, 1);
  assert.equal(queue[0].campaign_id, 'campaign-2');
});
