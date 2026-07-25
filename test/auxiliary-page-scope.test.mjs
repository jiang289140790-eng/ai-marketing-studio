import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterRecordsForAuxiliaryScope,
  isTestRecord,
} from '../src/utils/auxiliary-page-scope.js';
import { statusLabel } from '../src/utils/formatters.js';

const context = {
  campaign: { id: 'campaign-1', metadata: { default_character_id: 'character-1' } },
  primaryAccount: { id: 'account-1' },
  competitorAccounts: [{ id: 'account-2' }],
  currentStrategy: { id: 'strategy-1' },
  contentPackages: [{ id: 'package-1', strategy_plan_id: 'strategy-1' }],
  characterBindings: [{ characterId: 'character-1' }],
  publishTasks: [{ id: 'publish-1' }],
  mediaAssets: [],
};

test('recognizes historical test patterns without deleting them', () => {
  assert.equal(isTestRecord({ name: 'Phase8 publish package' }), true);
  assert.equal(isTestRecord({ account_name: 'test account' }), true);
  assert.equal(isTestRecord({ metadata: { environment: 'debug' } }), true);
  assert.equal(isTestRecord({ name: 'X 媒体优先短内容测试' }), false);
});

test('current campaign scope follows direct and nested business relationships', () => {
  const rows = [
    { id: 'direct', campaign_id: 'campaign-1' },
    { id: 'package', metadata: { content_package_id: 'package-1' } },
    { id: 'character-1', name: 'Emma' },
    { id: 'other', campaign_id: 'campaign-2' },
    { id: 'phase', name: 'phase7 debug', campaign_id: 'campaign-1' },
  ];
  const result = filterRecordsForAuxiliaryScope(rows, {
    scope: 'campaign',
    campaignContext: context,
    activeCampaignId: 'campaign-1',
  });
  assert.deepEqual(result.map((item) => item.id), ['direct', 'package', 'character-1']);
});

test('history excludes tests while test scope only returns test records', () => {
  const rows = [
    { id: 'production', title: '正式内容' },
    { id: 'test', title: 'phase2 fixture' },
  ];
  assert.deepEqual(
    filterRecordsForAuxiliaryScope(rows, { scope: 'history' }).map((item) => item.id),
    ['production'],
  );
  assert.deepEqual(
    filterRecordsForAuxiliaryScope(rows, { scope: 'test' }).map((item) => item.id),
    ['test'],
  );
});

test('current account scope only includes records linked to the primary account', () => {
  const rows = [
    { id: 'one', social_account_id: 'account-1' },
    { id: 'two', account_id: 'account-2' },
    { id: 'three', account_id: 'account-3' },
  ];
  const result = filterRecordsForAuxiliaryScope(rows, {
    scope: 'account',
    campaignContext: context,
    activeCampaignId: 'campaign-1',
  });
  assert.deepEqual(result.map((item) => item.id), ['one']);
});

test('shared status map keeps database values in English and presents Chinese labels', () => {
  assert.equal(statusLabel('draft'), '草稿');
  assert.equal(statusLabel('review'), '待审核');
  assert.equal(statusLabel('dry_run'), '安全预演');
  assert.equal(statusLabel('live'), '正式执行');
  assert.equal(statusLabel('not_started'), '未开始');
});
