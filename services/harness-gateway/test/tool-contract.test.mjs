import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, TOOL_SCHEMA_VERSION, normalizeToolResult, toBoundaryRequest, validateToolCall } from '../tool-contract.mjs';

const context = {
  task_id: 'ht-11111111-1111-4111-8111-111111111111',
  user_id: 'user-1',
  project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
  approval: { paid_external_calls: true, online_writes: true, handoff_creation: true },
};

function call(operation, payload = {}, extra = {}) {
  return { schema_version: TOOL_SCHEMA_VERSION, operation, payload, idempotency_key: `idem-${operation}`, ...extra };
}

test('tool registry contains only bounded P19/P22 operations and no destructive command', () => {
  const operations = Object.keys(TOOL_DEFINITIONS);
  assert.equal(operations.length, 16);
  assert.equal(operations.some((value) => /delete|remove|archive|decide|sql|grant|auth/i.test(value)), false);
  assert.deepEqual(new Set(Object.values(TOOL_DEFINITIONS).map((value) => value.endpoint)), new Set(['p19-workspace-command', 'p22-research-assist']));
});

test('unknown fields, operations, cross-project calls, invalid revisions and oversized payloads fail closed', () => {
  assert.equal(validateToolCall({ ...call('workspace.project.list'), extra: true }, context).code, 'UNKNOWN_FIELD');
  assert.equal(validateToolCall(call('workspace.sql', {}), context).code, 'OPERATION_DENIED');
  assert.equal(validateToolCall(call('workspace.project.read', { project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb' }), context).code, 'PROJECT_BINDING_MISMATCH');
  assert.equal(validateToolCall(call('workspace.project.read', { project_id: context.project_id }, { expected_revision: 0 }), context).code, 'EXPECTED_REVISION_INVALID');
  assert.equal(validateToolCall(call('workspace.project.create', { project: { body: 'x'.repeat(70_000) } }), context).code, 'PAYLOAD_TOO_LARGE');
  assert.equal(validateToolCall(call('workspace.project.read', { project_id: context.project_id, sql: 'select 1' }), context).code, 'UNKNOWN_PAYLOAD_FIELD');
});

test('paid, online-write and handoff approvals are independently enforced', () => {
  assert.equal(validateToolCall(call('research.collect_url', { url: 'https://x.com/a/status/1' }), { ...context, approval: {} }).diagnostics.field, 'paid_external_calls');
  assert.equal(validateToolCall(call('workspace.card.create', { project_id: context.project_id, expected_fingerprint: 'a'.repeat(64), card: {} }, { expected_revision: 1 }), { ...context, approval: {} }).diagnostics.field, 'online_writes');
  assert.equal(validateToolCall(call('workspace.handoff.create', { project_id: context.project_id, expected_fingerprint: 'a'.repeat(64), handoff: {} }, { expected_revision: 1 }), { ...context, approval: { online_writes: true } }).diagnostics.field, 'handoff_creation');
});

test('a project-bound task cannot create a different project', () => {
  const input = call('workspace.project.create', {
    project: { topic: 'other', objective: 'other', audience: 'other', channel: 'X' },
  });
  const denied = validateToolCall(input, context);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PROJECT_BINDING_MISMATCH');
  assert.equal(denied.diagnostics.field, 'project');
  assert.equal(validateToolCall(input, { ...context, project_id: null }).ok, true);
});

test('trusted identity is derived outside model payload and boundary mappings are exact', () => {
  const checked = validateToolCall(call('workspace.project.read', { project_id: context.project_id }), context);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.user_id, context.user_id);
  assert.deepEqual(toBoundaryRequest(checked.value), {
    endpoint: 'p19-workspace-command',
    body: { schema_version: 'p19_command_contract_v1', command: 'project.read', idempotency_key: 'h-db3de5d93b3fcfded4be92838ffbb8c2f721d8fcaaa03fa22ad1789542e67f50', payload: { project_id: context.project_id } },
  });
  const research = validateToolCall(call('research.search_reddit', { keyword: 'AI marketing', count: 5, sort: 'hot', time_filter: 'week' }), context);
  assert.deepEqual(toBoundaryRequest(research.value), {
    endpoint: 'p22-research-assist',
    body: { action: 'search_reddit', keyword: 'AI marketing', count: 5, sort: 'hot', time_filter: 'week', idempotency_key: 'h-560722f68a6d9697f1397da4d9abf9a0ef78a02f3d5b63acb458f7296f0a55b3' },
  });
});

test('boundary idempotency is stable within one task and isolated across tasks', () => {
  const modelCall = call('research.collect_url', { url: 'https://x.com/a/status/123' }, { idempotency_key: 'model-repeat' });
  const first = validateToolCall(modelCall, context);
  const retry = validateToolCall(modelCall, context);
  const otherTask = validateToolCall(modelCall, { ...context, task_id: 'ht-22222222-2222-4222-8222-222222222222' });
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(otherTask.ok, true);
  const firstKey = toBoundaryRequest(first.value).body.idempotency_key;
  assert.equal(toBoundaryRequest(retry.value).body.idempotency_key, firstKey);
  assert.notEqual(toBoundaryRequest(otherTask.value).body.idempotency_key, firstKey);
  assert.match(firstKey, /^h-[0-9a-f]{64}$/);
});

test('write revisions and useful P22 top-level results are preserved exactly', () => {
  const checked = validateToolCall(call('workspace.project.update', { project_id: context.project_id, patch: { topic: 'new' } }, { expected_revision: 7 }), context);
  assert.equal(checked.ok, true);
  assert.equal(toBoundaryRequest(checked.value).body.payload.expected_revision, 7);
  assert.equal(validateToolCall(call('workspace.project.update', { project_id: context.project_id, patch: {} }), context).code, 'EXPECTED_REVISION_REQUIRED');

  const research = normalizeToolResult({ task_id: context.task_id, operation: 'research.search_x' }, {
    ok: true,
    items: [{ id: 'source-1' }],
    capabilities: { apify_configured: true },
    cost: { recorded_cny: 2 },
    execution_flags: { generation_executed: false },
  });
  assert.deepEqual(research.data.items, [{ id: 'source-1' }]);
  assert.deepEqual(research.data.capabilities, { apify_configured: true });
  assert.deepEqual(research.cost, { recorded_cny: 2 });

  const entity = normalizeToolResult({ task_id: context.task_id, operation: 'workspace.card.create' }, {
    ok: true, entity: { type: 'card', id: 'card-1' },
  });
  assert.deepEqual(entity.artifact_refs, ['card-1']);
});

test('tool results are bounded and never trust caller task or operation identities', () => {
  const result = normalizeToolResult({ task_id: context.task_id, operation: 'workspace.project.read' }, {
    ok: true, code: 'OK', data: { project: { id: context.project_id } }, artifact_refs: ['a'.repeat(900)], diagnostics: { issues: [] },
  });
  assert.equal(result.task_id, context.task_id);
  assert.equal(result.operation, 'workspace.project.read');
  assert.equal(result.artifact_refs[0].length, 500);
  const exactResearch = normalizeToolResult({ task_id: context.task_id, operation: 'research.search_x' }, { ok: true, items: [{ content_text: 'x'.repeat(70_000) }] });
  assert.equal(exactResearch.ok, true);
  assert.equal(exactResearch.data.items[0].content_text.length, 70_000);
  const oversized = normalizeToolResult({ task_id: context.task_id, operation: 'workspace.project.read' }, { ok: true, data: { body: 'x'.repeat(2 * 1024 * 1024 + 70_000) } });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.code, 'TOOL_RESULT_TOO_LARGE');
});
