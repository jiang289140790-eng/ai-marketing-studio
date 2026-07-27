import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCampaignContextFromRows,
  findDayOnePackage,
  filterCampaignRows,
  getCampaignBlockingItems,
  selectActiveCampaignFromList,
} from '../src/services/campaign-context-service.js';

test('duplicate Day 1 packages prefer the published business record', () => {
  const selected = findDayOnePackage({
    contentPackages: [
      { id: 'old-day1', title: 'Day 1 old', status: 'ready_for_publish', created_at: '2026-07-20T00:00:00Z' },
      { id: 'published-day1', title: 'Day 1 published', status: 'published', created_at: '2026-07-26T00:00:00Z' },
    ],
  });
  assert.equal(selected.id, 'published-day1');
});

const campaign = {
  id: 'campaign-1',
  user_id: 'owner-1',
  name: '最小闭环',
  status: 'active',
  target_accounts: [{ account_id: 'owned-1' }, { account_id: 'competitor-1' }],
};

test('无 Campaign 时不选择活动', () => {
  assert.equal(selectActiveCampaignFromList([], 'missing'), null);
});

test('单 Campaign 自动选择', () => {
  assert.equal(selectActiveCampaignFromList([campaign])?.id, campaign.id);
});

test('多 Campaign 时使用最近且仍有权限的选择', () => {
  const second = { ...campaign, id: 'campaign-2' };
  assert.equal(selectActiveCampaignFromList([campaign, second], second.id)?.id, second.id);
});

test('无权限 Campaign ID 不会绕过当前可见列表', () => {
  assert.notEqual(selectActiveCampaignFromList([campaign], 'other-user-campaign')?.id, 'other-user-campaign');
});

test('缺少主账号会形成阻塞项', () => {
  const context = buildCampaignContextFromRows(campaign, {
    accounts: [],
    strategies: [],
    contentPackages: [],
  });
  assert.ok(getCampaignBlockingItems(context).some((item) => item.code === 'primary_account_missing'));
});

test('已有策略但无 7 天计划会形成阻塞项', () => {
  const context = buildCampaignContextFromRows(campaign, {
    accounts: [{ id: 'owned-1', account_role: 'owned', brain_data: { summary: 'ok' } }],
    strategies: [{ id: 'strategy-1', campaign_id: campaign.id, status: 'approved', daily_plan: [] }],
    contentPackages: [],
  });
  assert.ok(context.blockingItems.some((item) => item.code === 'daily_plan_missing'));
});

test('历史 campaign_id 为空的数据不会混入当前 Campaign', () => {
  const rows = filterCampaignRows([
    { id: 'current', campaign_id: campaign.id },
    { id: 'legacy-null', campaign_id: null },
    { id: 'other', campaign_id: 'campaign-2' },
  ], campaign.id);
  assert.deepEqual(rows.map((item) => item.id), ['current']);
});
