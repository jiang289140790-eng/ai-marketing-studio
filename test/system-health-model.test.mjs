import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCoreServices,
  buildHealthExceptions,
  filterRowsByTimeRange,
  sanitizeTechnicalDetails,
  summarizeRuntime,
} from '../src/utils/system-health-model.js';

const now = new Date('2026-07-25T12:00:00Z');

test('完成率只使用已结束任务，未开始任务不计入失败', () => {
  const result = summarizeRuntime({
    workflow: [
      { status: 'success', created_at: '2026-07-25T10:00:00Z' },
      { status: 'failed', created_at: '2026-07-25T09:00:00Z' },
      { status: 'pending', created_at: '2026-07-25T11:50:00Z' },
      { status: 'draft', created_at: '2026-07-25T11:00:00Z' },
    ],
  }, '24h', now);
  assert.equal(result.completionRate, 50);
  assert.equal(result.failed, 1);
  assert.equal(result.formula, '1 个成功任务 ÷ 2 个已结束任务');
});

test('失败任务为 0 且无已结束任务时完成率不显示 0 或 100', () => {
  const result = summarizeRuntime({
    publish: [{ status: 'draft', created_at: '2026-07-25T10:00:00Z' }],
  }, '24h', now);
  assert.equal(result.failed, 0);
  assert.equal(result.completionRate, null);
});

test('时间范围严格过滤 24 小时、7 天和 30 天', () => {
  const rows = [
    { created_at: '2026-07-25T11:00:00Z' },
    { created_at: '2026-07-20T11:00:00Z' },
    { created_at: '2026-06-30T11:00:00Z' },
  ];
  assert.equal(filterRowsByTimeRange(rows, '24h', now).length, 1);
  assert.equal(filterRowsByTimeRange(rows, '7d', now).length, 2);
  assert.equal(filterRowsByTimeRange(rows, '30d', now).length, 3);
});

test('等待超过一小时的任务进入异常但不算失败', () => {
  const exceptions = buildHealthExceptions({
    workflow: [{ id: 'run-1', status: 'running', created_at: '2026-07-25T09:00:00Z' }],
  }, '24h', now);
  assert.equal(exceptions.length, 1);
  assert.match(exceptions[0].errorCode, /TIMEOUT/);
});

test('普通技术详情隐藏凭据、内网地址、SQL 和调用栈', () => {
  const result = sanitizeTechnicalDetails({
    token: 'secret-token-value',
    sql: 'select * from private',
    message: 'failed at http://127.0.0.1:8188/api\n at worker.js:12',
  });
  assert.equal(result.token, '已隐藏');
  assert.equal(result.sql, '高级原始信息已隐藏');
  assert.match(result.message, /内部地址已隐藏/);
  assert.doesNotMatch(result.message, /worker\.js/);
});

test('核心服务包含 AutoDL、ComfyUI 和 X MCP', () => {
  const services = buildCoreServices({
    configured: true,
    userId: 'user-1',
    executionStatus: { status: { edge_function: true, bridge_configured: true, bridge: true, mcp: true, x_mcp: 'connected', x_tools: true } },
    comfyWorkflows: [{ status: 'active', name: 'emma_s1_sdxl_t2i_v01' }],
    workflowRuns: [{ status: 'success', input_data: { provider: 'autodl', workflow_name: 'emma_s1_sdxl_t2i_v01' } }],
  });
  assert.equal(services.find((item) => item.id === 'autodl').status, 'healthy');
  assert.equal(services.find((item) => item.id === 'comfyui').status, 'healthy');
  assert.equal(services.find((item) => item.id === 'x-mcp').status, 'healthy');
});
