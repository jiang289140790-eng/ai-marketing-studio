import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsRawBackendDetail,
  normalizeBusinessError,
  sanitizeTechnicalError,
} from '../src/utils/business-error.js';
import { dateKey, getRelativeDate } from '../src/utils/report-time.js';
import { statusLabel } from '../src/utils/formatters.js';

test('ordinary business error hides PostgREST relationship details', () => {
  const error = normalizeBusinessError(new Error(
    "Could not find a relationship between 'publish_tasks' and 'campaign_links' in the schema cache",
  ));

  assert.equal(error.message, '相关业务数据暂时无法组合展示。');
  assert.equal(error.retryable, true);
  assert.match(error.code, /^AMS-DATA-/);
  assert.equal(containsRawBackendDetail(error.message), false);
  assert.equal(containsRawBackendDetail(error.technicalDetail), true);
});

test('technical details redact secrets and internal addresses', () => {
  const detail = sanitizeTechnicalError('token=abcdef http://192.168.1.5:8188 prompt failed');
  assert.doesNotMatch(detail, /abcdef/);
  assert.doesNotMatch(detail, /192\.168\.1\.5/);
});

test('daily report date uses Asia Shanghai day instead of UTC date slice', () => {
  const instant = new Date('2026-07-25T16:30:00.000Z');
  assert.equal(dateKey(instant, 'Asia/Shanghai'), '2026-07-26');
  assert.equal(getRelativeDate(-1, 'Asia/Shanghai', instant), '2026-07-25');
});

test('required online statuses are centralized in Chinese', () => {
  const expected = {
    validated: '已验证',
    planned: '已计划',
    review: '待审核',
    connected: '已连接',
    pending: '待处理',
    completed: '已完成',
    failed: '失败',
    not_started: '未开始',
    dry_run: '安全预演',
    live: '正式执行',
  };

  Object.entries(expected).forEach(([status, label]) => {
    assert.equal(statusLabel(status), label);
  });
});
