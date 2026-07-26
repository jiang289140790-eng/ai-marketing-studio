import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeProductionWorkflows,
  mergeWorkflowRuns,
  productionWorkflowCapabilities,
} from '../src/data/production-workflows.js';

test('生产注册表与数据库工作流合并后保留图片和视频能力', () => {
  const rows = [{
    id: 'emma-s1-sdxl-t2i',
    name: '数据库中的 Emma 工作流',
    status: 'active',
  }];

  const result = mergeProductionWorkflows(rows);

  assert.equal(result.length, productionWorkflowCapabilities.length);
  assert.equal(result.find((item) => item.id === 'emma-s1-sdxl-t2i').status, 'active');
  assert.ok(result.some((item) => item.mode === 'video'));
  assert.ok(result.some((item) => item.id === 'wan-remix-i2v'));
});

test('素材回传任务与数据库任务合并且不重复', () => {
  const assets = [{
    id: 'asset-1',
    generation_provider: 'autodl',
    generation_workflow: 'wan-remix-i2v',
    status: 'completed',
    created_at: '2026-07-26T00:00:00.000Z',
    updated_at: '2026-07-26T00:01:00.000Z',
    metadata: {},
  }];

  const result = mergeWorkflowRuns([{
    id: 'asset-run:asset-1',
    status: 'success',
    output_data: { asset_id: 'asset-1' },
  }], assets);

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'success');
  assert.equal(result[0].output_data.asset_id, 'asset-1');
});
