import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCampaignDayRows,
  getDailyPlanApprovalStatus,
  isCompleteSevenDayPlan,
  normalizeCampaignDailyPlan,
} from '../src/utils/campaign-daily-plan.js';

const completePlan = Array.from({ length: 7 }, (_, index) => ({
  day: index + 1,
  planned_date: `2026-07-${String(27 + index).padStart(2, '0')}`,
  platform: 'x',
  content_pillar: 'Education',
  content_role: index === 0 ? 'opening' : 'nurture',
  topic: `Topic ${index + 1}`,
  objective: 'Validate the idea',
  hook_type: 'problem-solution',
  format: 'short_post',
  media_requirement: 'single_image_optional',
  CTA: 'Save this',
  notes: 'Initial recommendation',
}));

test('normalizes and sorts Day 1 through Day 7', () => {
  const reversed = [...completePlan].reverse();
  assert.deepEqual(normalizeCampaignDailyPlan(reversed).map((item) => item.day), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(isCompleteSevenDayPlan(reversed), true);
});

test('reads plan approval from the latest marker', () => {
  const strategy = {
    source_insights: [
      { type: 'daily_plan_approval', status: 'draft' },
      { type: 'daily_plan_approval', status: 'approved' },
    ],
  };
  assert.equal(getDailyPlanApprovalStatus(strategy), 'approved');
  assert.equal(getDailyPlanApprovalStatus({
    source_insights: [
      { type: 'daily_plan_approval', status: 'approved' },
      { type: 'daily_plan_generation', status: 'review' },
    ],
  }), 'review');
});

test('links existing content packages to the correct day', () => {
  const rows = getCampaignDayRows(completePlan, [{
    id: 'package-1',
    title: 'Day 1 | Topic 1',
    source_insights: { day_index: 1, workflow_status: { content_status: 'in_progress' } },
  }]);
  assert.equal(rows[0].contentPackage.id, 'package-1');
  assert.equal(rows[0].status, 'in_progress');
  assert.equal(rows[1].contentPackage, undefined);
});
