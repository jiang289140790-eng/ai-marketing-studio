import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMetrics,
  buildReviewSuggestions,
  isSmallSample,
  normalizeAnalyticsRow,
  readMetric,
} from '../src/utils/analytics-review-model.js';

test('缺失指标显示平台暂不提供而不是伪造 0', () => {
  assert.deepEqual(readMetric({}, 'impressions'), {
    status: 'unavailable',
    value: null,
    reason: '平台暂不提供',
  });
});

test('真实返回的 0 是可用指标', () => {
  assert.deepEqual(readMetric({ metrics: { values: { likes: 0 } } }, 'likes'), {
    status: 'available',
    value: 0,
  });
});

test('汇总仅计算实际可用样本', () => {
  const result = aggregateMetrics([
    { metrics: { values: { views: 12 } } },
    { metrics: { availability: { impressions: { status: 'unavailable' } } } },
  ]);
  assert.equal(result.impressions.value, 12);
  assert.equal(result.impressions.sampleCount, 1);
  assert.equal(result.link_clicks.status, 'unavailable');
});

test('分析维度复用内容包和发布任务关系', () => {
  const packageById = new Map([['package-1', {
    id: 'package-1',
    title: 'Day 1｜软信号内容',
    platform: 'X',
    hook: '一个反常识开头',
    source_insights: { day_index: 1, format: '短帖' },
  }]]);
  const row = normalizeAnalyticsRow(
    { id: 'metric-1', content_package_id: 'package-1', publish_task_id: 'task-1', views: 20 },
    {
      campaignName: 'X 媒体优先短内容测试',
      accountName: '@example',
      packageById,
      taskById: new Map([['task-1', { platform: 'X', published_at: '2026-07-25T08:00:00Z' }]]),
    },
  );
  assert.equal(row.day, 'Day 1');
  assert.equal(row.contentType, '短帖');
  assert.equal(row.hook, '一个反常识开头');
});

test('复盘建议包含证据、样本、状态与动作', () => {
  const suggestions = buildReviewSuggestions({
    findings: [{
      conclusion: '问题式 Hook 互动更高',
      evidence: '评论率高于账号均值',
      sample_count: 2,
      confidence: 0.62,
      classification: 'initial_signal',
      recommended_action: '下一条继续测试',
    }],
  });
  assert.equal(suggestions[0].sampleCount, 2);
  assert.equal(suggestions[0].confidence, 62);
  assert.equal(suggestions[0].dataStatus, '初步信号');
});

test('少于三个真实样本时明确属于小样本', () => {
  assert.equal(isSmallSample([{}, {}]), true);
  assert.equal(isSmallSample([]), false);
});
