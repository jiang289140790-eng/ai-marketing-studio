import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSevenDayCalendar,
  filterPublishCenterTasks,
  getCampaignLinkId,
  summarizePublishCenter,
} from '../src/utils/publish-center-model.js';

const tasks = [
  { id: 'approval', status: 'draft', approval_status: 'pending' },
  { id: 'today', status: 'scheduled', approval_status: 'approved', scheduled_at: '2026-07-27T08:00:00Z' },
  { id: 'running', status: 'publishing', approval_status: 'approved' },
  { id: 'failed', status: 'failed', approval_status: 'approved' },
  { id: 'published', status: 'published', approval_status: 'approved' },
  { id: 'cancelled', status: 'cancelled', approval_status: 'rejected' },
];

test('发布中心四个标签不会把草稿、排期和历史混为一组', () => {
  assert.deepEqual(filterPublishCenterTasks(tasks, 'pending').map((item) => item.id), ['approval', 'failed']);
  assert.deepEqual(filterPublishCenterTasks(tasks, 'calendar').map((item) => item.id), ['today']);
  assert.deepEqual(filterPublishCenterTasks(tasks, 'publishing').map((item) => item.id), ['running']);
  assert.deepEqual(filterPublishCenterTasks(tasks, 'history').map((item) => item.id), ['published', 'cancelled']);
});

test('顶部统计区分待批准、今天排期、发布中、失败和指标待同步', () => {
  const summary = summarizePublishCenter(tasks, [], new Date('2026-07-27T02:00:00Z'));
  assert.deepEqual(summary, {
    awaitingApproval: 1,
    todayScheduled: 1,
    publishing: 1,
    failed: 1,
    metricsPending: 1,
  });
});

test('未来七天日历只收录已排期任务', () => {
  const calendar = buildSevenDayCalendar(tasks, new Date('2026-07-27T02:00:00Z'));
  assert.equal(calendar.length, 7);
  assert.equal(calendar[0].tasks.length, 1);
  assert.equal(calendar[0].tasks[0].id, 'today');
});

test('追踪链接从兼容字段读取，不占用 campaign_id', () => {
  assert.equal(getCampaignLinkId({
    campaign_id: 'campaign-1',
    publish_content: { campaign_link_id: 'link-1' },
  }), 'link-1');
});
