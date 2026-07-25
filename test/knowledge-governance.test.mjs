import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findKnowledgeDuplicates,
  getKnowledgeCategory,
  getKnowledgeSource,
  getKnowledgeStatus,
  isTechnicalKnowledge,
  isTestKnowledge,
  normalizeKnowledge,
  sanitizeAdvancedKnowledgeData,
} from '../src/utils/knowledge-governance.js';

test('素材、任务和工作流输出默认不进入知识主列表', () => {
  assert.equal(isTechnicalKnowledge({ type: 'asset', title: 'Asset image: test' }), true);
  assert.equal(isTechnicalKnowledge({ type: 'insight', title: 'Generation Job output' }), true);
  assert.equal(isTechnicalKnowledge({ type: 'insight', content: 'https://example.com/file.png' }), true);
  assert.equal(isTechnicalKnowledge({ type: 'strategy_memory', content: '可复用内容比例假设' }), false);
});

test('Phase marker 和测试知识被识别但不删除', () => {
  assert.equal(isTestKnowledge({ title: 'Phase2 hook marker' }), true);
  assert.equal(isTestKnowledge({ title: 'Emma 内容视觉规律', metadata: { source: 'research' } }), false);
});

test('知识分类优先复用 type、metadata 和 tags', () => {
  assert.equal(getKnowledgeCategory({ type: 'account_intelligence_report' }), 'account');
  assert.equal(getKnowledgeCategory({ type: 'insight', metadata: { tags: ['character-brain'] } }), 'character');
  assert.equal(getKnowledgeCategory({ type: 'research_report', metadata: { tags: ['market-research', 'x'] } }), 'platform');
  assert.equal(getKnowledgeCategory({ type: 'strategy_memory' }), 'strategy');
});

test('X 原生证据、人工结论和外部推断明确区分', () => {
  assert.equal(getKnowledgeSource({ metadata: { source_type: 'x_api' } }).id, 'x_native');
  assert.equal(getKnowledgeSource({ metadata: { source: 'human_approved' } }).id, 'human_approved');
  assert.equal(getKnowledgeSource({ metadata: { source: 'research' } }).id, 'external_inference');
});

test('缺少显式验证状态时不会把高置信度推断伪装成人工验证', () => {
  assert.equal(getKnowledgeStatus({ metadata: { confidence: 0.82, source: 'research' } }), 'preliminary');
  assert.equal(getKnowledgeStatus({ metadata: { status: 'approved', human_approved: true } }), 'verified');
});

test('重复知识只生成候选关系，不删除任何条目', () => {
  const items = [
    normalizeKnowledge({ id: 'a', type: 'insight', title: '同一结论', content: '内容 A', metadata: { source: 'research' } }),
    normalizeKnowledge({ id: 'b', type: 'insight', title: '同一结论', content: '内容 B', metadata: { source: 'research' } }),
  ];
  const duplicates = findKnowledgeDuplicates(items);
  assert.deepEqual(duplicates.get('a'), ['b']);
  assert.equal(items.length, 2);
});

test('高级数据始终隐藏凭据与签名地址', () => {
  const result = sanitizeAdvancedKnowledgeData({
    token: 'secret-token',
    nested: { api_key: 'secret-key', signed_url: 'https://example.com/private' },
    storage_path: 'campaign/file.png',
  });
  assert.equal(result.token, '已隐藏');
  assert.equal(result.nested.api_key, '已隐藏');
  assert.equal(result.nested.signed_url, '已隐藏');
  assert.equal(result.storage_path, 'campaign/file.png');
});

