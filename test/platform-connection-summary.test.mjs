import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlatformSummaries } from '../src/utils/platform-connection-summary.js';

test('平台摘要不依赖或返回凭据字段', () => {
  const [summary] = buildPlatformSummaries({
    cards: [{ platform: 'X', title: 'X', implemented: true }],
    connections: [{
      id: 'connection',
      platform: 'X',
      account_id: 'account',
      status: 'connected',
      permissions: ['tweet.read', 'tweet.write'],
      metadata: { credits_remaining: 12, secret: 'never-show' },
    }],
    accounts: [{ id: 'account', platform: 'X' }],
    gateway: { connected: true, status: { x_mcp: 'connected', x_tools: true } },
  });
  assert.equal(summary.accountCount, 1);
  assert.equal(summary.read.state, 'available');
  assert.equal(summary.publish.state, 'available');
  assert.equal(summary.xMcp.state, 'available');
  assert.equal(summary.quota.label, '剩余 12');
  assert.equal(JSON.stringify(summary).includes('never-show'), false);
  assert.equal('requiredSecrets' in summary, false);
});

test('X credits depleted 显示明确业务影响', () => {
  const [summary] = buildPlatformSummaries({
    cards: [{ platform: 'X', title: 'X', implemented: true }],
    connections: [{
      platform: 'X',
      status: 'connected',
      metadata: { credits_status: 'depleted', credits_remaining: 0 },
    }],
  });
  assert.equal(summary.quota.state, 'failed');
  assert.match(summary.quota.detail, /读取、发布或指标回收/);
});

test('平台卡可按相同结构表达未连接和准备中状态', () => {
  const summaries = buildPlatformSummaries({
    cards: [
      { platform: 'X', title: 'X', implemented: true },
      { platform: 'YouTube', title: 'YouTube', implemented: false },
    ],
  });
  assert.equal(summaries[0].connectionState.state, 'not_connected');
  assert.equal(summaries[1].connectionState.state, 'preparing');
});

test('后端明确标记未连接时不得被旧 connected 文本误判为可用', () => {
  const [summary] = buildPlatformSummaries({
    cards: [{ platform: 'X', title: 'X', implemented: true }],
    connections: [{
      platform: 'X',
      status: 'connected',
      is_connected: false,
      expires_at: '2026-07-20T14:31:02.804Z',
      permissions: ['tweet.read', 'tweet.write'],
    }],
  });
  assert.equal(summary.connectionState.state, 'failed');
  assert.equal(summary.connectionState.label, 'OAuth 已过期');
  assert.equal(summary.read.state, 'not_connected');
  assert.equal(summary.publish.state, 'not_connected');
  assert.equal(summary.token.label, 'OAuth 已过期');
});
