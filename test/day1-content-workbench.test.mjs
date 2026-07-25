import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReadiness,
  deriveContentDisplayStatus,
  getVersionsForPackage,
  inspectContentRisks,
} from '../src/utils/day1-content-workbench.js';

test('content versions are filtered by package and sorted', () => {
  const rows = [
    { id: 'v2', title: 'B', content_text: 'Body B', created_at: '2026-07-25T02:00:00Z', generation_brief: { content_package_id: 'p1', version_number: 2 } },
    { id: 'other', title: 'Other', content_text: 'Other', generation_brief: { content_package_id: 'p2', version_number: 1 } },
    { id: 'v1', title: 'A', content_text: 'Body A', created_at: '2026-07-25T01:00:00Z', generation_brief: { content_package_id: 'p1', version_number: 1 } },
  ];
  assert.deepEqual(getVersionsForPackage(rows, 'p1').map((item) => item.id), ['v1', 'v2']);
});

test('risk check identifies blocking claims without mutating content', () => {
  const risks = inspectContentRisks({ body: '这个方案绝对有效', cta: '', hook: '', hashtags: [] }, 'x');
  assert.ok(risks.blocking.includes('缺少行动引导'));
  assert.ok(risks.blocking.includes('包含绝对化或保证性表述'));
});

test('readiness requires selected and approved copy plus confirmed media', () => {
  const contentPackage = {
    platform: 'x',
    reviewStatus: 'approved',
    raw: {
      source_insights: {
        content_workbench: { selected_version_id: 'v1', copy_approved: true },
      },
    },
  };
  const readiness = buildReadiness({
    contentPackage,
    copy: { body: '正文', cta: '回复你的看法', hook: '你会怎么做？', hashtags: ['AI'] },
    assets: [{ id: 'a1', status: 'completed', raw: { approved_for_publishing: true } }],
    character: { id: 'c1' },
    lora: { id: 'l1' },
  });
  assert.equal(readiness.readyForPublishTask, true);
  assert.equal(deriveContentDisplayStatus({
    contentPackage,
    assets: [{ id: 'a1', status: 'completed', raw: { approved_for_publishing: true } }],
    selectedVersionId: 'v1',
  }), 'ready_to_publish');
});
