import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssetBusinessName,
  classifyAsset,
  getAssetContext,
  isAssetReferenced,
} from '../src/utils/asset-library-model.js';

test('技术文件名转换为业务名称并保留 Day 和角色', () => {
  const asset = {
    name: 'ComfyUI_00002',
    type: 'image',
    raw: { metadata: { day: 1, character_id: 'emma' } },
  };
  assert.equal(buildAssetBusinessName(asset, { characterName: 'Emma', index: 1 }), 'Emma · Day 1 候选图 01');
});

test('人工业务名称保持不变', () => {
  assert.equal(buildAssetBusinessName({ name: 'Emma 夏日街拍主图', type: 'image' }), 'Emma 夏日街拍主图');
});

test('最终素材、生成结果和上传素材分类互不混淆', () => {
  assert.equal(classifyAsset({ approvedForPublishing: true }), 'final');
  assert.equal(classifyAsset({ generationJobId: 'run' }), 'generated');
  assert.equal(classifyAsset({ source: 'upload' }), 'uploaded');
});

test('上传素材上下文从 workflow JSON 读取', () => {
  const context = getAssetContext({
    raw: {
      workflow: {
        asset_context: { campaign_id: 'campaign', day: 1, character_id: 'emma', purpose: 'reference' },
      },
    },
  });
  assert.deepEqual(context, {
    campaignId: 'campaign',
    day: 1,
    characterId: 'emma',
    contentId: '',
    purpose: 'reference',
    source: '手动上传',
    rights: '',
  });
});

test('已关联内容或发布任务的素材不可直接删除', () => {
  assert.equal(isAssetReferenced({ id: 'asset', contentId: 'content' }), true);
  assert.equal(isAssetReferenced({ id: 'asset' }, { publishTasks: [{ publish_content: { asset_ids: ['asset'] } }] }), true);
});

