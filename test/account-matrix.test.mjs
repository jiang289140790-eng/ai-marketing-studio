import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAccountMatrixRows,
  findDuplicateAccounts,
  getAccountRole,
  safeBusinessText,
} from '../src/utils/account-matrix.js';

test('账号角色兼容三个历史字段', () => {
  assert.equal(getAccountRole({ account_role: 'competitor' }), 'competitor');
  assert.equal(getAccountRole({ account_type: 'inspiration' }), 'inspiration');
  assert.equal(getAccountRole({ account_category: 'brand' }), 'owned');
});

test('乱码只标记不伪造恢复内容', () => {
  assert.deepEqual(safeBusinessText('璐﹀彿??'), { text: '原内容损坏', damaged: true });
  assert.deepEqual(safeBusinessText('正常账号'), { text: '正常账号', damaged: false });
});

test('重复检测覆盖平台账号名、主页 URL 和外部用户 ID', () => {
  const accounts = [
    { id: 'a', platform: 'X', username: '@same', profile_url: 'https://x.com/same' },
    { id: 'b', platform: 'x', username: 'same', profile_url: 'https://x.com/other' },
    { id: 'c', platform: 'X', username: 'third', profile_url: 'https://x.com/same/' },
  ];
  const connections = [
    { account_id: 'a', metadata: { external_user_id: '42' } },
    { account_id: 'c', metadata: { external_user_id: '42' } },
  ];
  const result = findDuplicateAccounts(accounts, connections);
  assert.ok(result.get('a').includes('平台和账号名相同'));
  assert.ok(result.get('a').includes('主页链接相同'));
  assert.ok(result.get('a').includes('平台用户 ID 相同'));
});

test('自有账号与对标账号生成不同业务数据', () => {
  const rows = buildAccountMatrixRows({
    accounts: [
      { id: 'owned', platform: 'X', username: 'brand', account_role: 'owned', character_id: 'emma' },
      { id: 'ref', platform: 'X', username: 'reference', account_type: 'competitor' },
    ],
    connections: [{ id: 'cx', account_id: 'owned', status: 'connected', permissions: ['tweet.read', 'tweet.write'] }],
    viralContents: [{ id: 'v1', social_account_id: 'ref', source_platform: 'X' }],
    characters: [{ id: 'emma', name: 'Emma' }],
  });
  assert.equal(rows[0].nextAction, '生成账号大脑');
  assert.equal(rows[0].character.name, 'Emma');
  assert.equal(rows[1].nextAction, '分析账号');
  assert.equal(rows[1].samples.length, 1);
});

test('账号已登记但 OAuth 过期时不再显示已连接或可发布', () => {
  const [row] = buildAccountMatrixRows({
    accounts: [{ id: 'owned', platform: 'X', username: 'brand', account_role: 'owned' }],
    connections: [{
      account_id: 'owned',
      platform: 'X',
      status: 'connected',
      is_connected: false,
      expires_at: '2026-07-20T14:31:02.804Z',
      permissions: ['tweet.read', 'tweet.write'],
    }],
  });
  assert.equal(row.connectionState.registration.label, '账号已登记');
  assert.equal(row.connectionState.oauth.label, 'OAuth 已过期');
  assert.equal(row.publishCapability.label, '不可发布');
  assert.equal(row.nextAction, '连接平台');
});
