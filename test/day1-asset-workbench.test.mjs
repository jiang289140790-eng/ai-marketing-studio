import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterUsableAssets,
  getCharacterLoras,
  inspectAssetAvailability,
  listJobsForContent,
} from '../src/utils/day1-asset-workbench.js';

test('generation jobs are normalized and scoped to the content package', () => {
  const jobs = listJobsForContent([
    { id: '1', status: 'pending', input_data: { content_package_id: 'day1', asset_type: 'image' } },
    { id: '2', status: 'success', input_data: { content_package_id: 'day2' } },
  ], 'day1');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].statusLabel, '排队中');
  assert.equal(jobs[0].assetType, 'image');
});

test('completed asset without output is treated as broken', () => {
  const result = inspectAssetAvailability({ status: 'completed', raw: { metadata: {} } });
  assert.equal(result.usable, false);
  assert.match(result.reasons.join(','), /没有输出文件/);
});

test('only completed assets with a usable location enter the asset picker', () => {
  const assets = filterUsableAssets([
    { id: 'ok', status: 'completed', url: 'https://example.com/image.png', raw: {} },
    { id: 'pending', status: 'generating', url: 'https://example.com/pending.png', raw: {} },
    { id: 'missing', status: 'completed', raw: {} },
  ]);
  assert.deepEqual(assets.map((asset) => asset.id), ['ok']);
});

test('LoRA values are normalized without creating a second character model', () => {
  const loras = getCharacterLoras({
    lora: 'emma-v1.safetensors',
    lora_info: { model: 'emma-v2.safetensors', version: '2' },
  });
  assert.equal(loras.length, 2);
  assert.equal(loras[0].model, 'emma-v2.safetensors');
});
