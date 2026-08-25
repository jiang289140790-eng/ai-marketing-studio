/* global Buffer, ReadableStream, Request, TextEncoder */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_SCHEMA_VERSION, fixedGatewayBase, signGatewayRequest, validateEdgeRequest } from '../supabase/functions/harness-command/edge-core.mjs';
import { G1_COMMAND_SCHEMA_VERSION as BRIDGE_G1_COMMAND_SCHEMA_VERSION, OPERATIONS, readBoundedText, sha256Hex, summarizeBridgeResponse, validateBridgeEnvelope, verifyToolBridgeSignature } from '../supabase/functions/harness-tool-bridge/bridge-core.mjs';
import { signRequest, verifySignedRequest } from '../services/harness-gateway/gateway-core.mjs';
import { G1_COMMAND_SCHEMA_VERSION as GATEWAY_G1_COMMAND_SCHEMA_VERSION, TOOL_DEFINITIONS, TOOL_SCHEMA_VERSION, toBoundaryRequest } from '../services/harness-gateway/tool-contract.mjs';
import { G1_EDGE_SCHEMA_VERSION } from '../supabase/functions/g1-generation-command/generation-core.mjs';
import { executeCommand, parseCommandRequest } from '../supabase/functions/p19-workspace-command/command-core.mjs';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';

async function loadP22CostContract() {
  const path = new URL('../supabase/functions/p22-research-assist/index.ts', import.meta.url);
  const edge = readFileSync(path, 'utf8');
  const shaSource = edge.slice(edge.indexOf('async function sha256'), edge.indexOf('function configured'));
  const costSource = edge.slice(edge.indexOf('async function paidReservationId'), edge.indexOf('async function costStatus'));
  let source = `${shaSource}\n${costSource}`
    .replace('async function sha256(value: string)', 'async function sha256(value)')
    .replace('async function sha256Bytes(value: Uint8Array)', 'async function sha256Bytes(value)')
    .replace('function canonicalJson(value: unknown, depth=0, state={nodes:0}): string', 'function canonicalJson(value, depth=0, state={nodes:0})')
    .replace('const record=value as Record<string,unknown>;', 'const record=value;')
    .replace('async function canonicalRequestSha256(value: unknown)', 'async function canonicalRequestSha256(value)')
    .replace('function hasDatabaseCode(error, code: string)', 'function hasDatabaseCode(error, code)')
    .replace('async function paidReservationId(userId: string, provider: string, operation: string, idempotencyKey: string | null, sequence = 0)', 'async function paidReservationId(userId, provider, operation, idempotencyKey, sequence = 0)')
    .replace('async function recordProviderCost(db, userId: string, provider: string, operation: string, amount: number, idempotencyKey: string | null, sequence = 0, requestBinding: unknown = {})', 'async function recordProviderCost(db, userId, provider, operation, amount, idempotencyKey, sequence = 0, requestBinding = {})');
  source = `class P22Error extends Error {
    constructor(code, message, status, details = {}) { super(message); this.code = code; this.status = status; this.details = details; }
  }\n${source}\nexport { canonicalRequestSha256, paidReservationId, recordProviderCost };\n`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#p22-cost-${Date.now()}`);
}

function costDb({ rpc }) {
  return {
    schema(schema) {
      assert.equal(schema, 'api');
      return { rpc };
    },
  };
}

function withoutKey(source, key) {
  const { [key]: _removed, ...rest } = source;
  return rest;
}

test('gateway base is HTTPS root-only so routed paths cannot discard configuration', () => {
  assert.equal(fixedGatewayBase('https://gateway.example/').toString(), 'https://gateway.example/');
  for (const raw of [
    'http://gateway.example/',
    'https://gateway.example/harness',
    'https://gateway.example/?region=cn',
    'https://user:password@gateway.example/',
  ]) assert.throws(() => fixedGatewayBase(raw), /GATEWAY_URL_INVALID/);
});

test('tool bridge reads request bodies incrementally and cancels oversized streams', async () => {
  const exact = new Request('https://bridge.example/', { method: 'POST', body: '12345' });
  assert.equal(await readBoundedText(exact, 5), '12345');

  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'));
      controller.enqueue(new TextEncoder().encode('5678'));
    },
    cancel() { cancelled = true; },
  });
  const oversized = new Request('https://bridge.example/', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readBoundedText(oversized, 5), (error) => error?.code === 'BODY_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('browser Edge contract derives identity, enforces operator writes and rejects unknown scope', () => {
  const input = {
    schema_version: EDGE_SCHEMA_VERSION,
    action: 'submit',
    request_id: 'h2-request-1',
    project_id: projectId,
    intent: 'Collect the supplied X source, analyze it, and prepare a pending-review brief.',
    approval: { paid_external_calls: true, online_writes: true, handoff_creation: false },
  };
  const checked = validateEdgeRequest(input, { userId, accessRole: 'operator' });
  assert.equal(checked.ok, true);
  assert.equal(checked.body.user_id, userId);
  assert.equal(validateEdgeRequest({ ...input, user_id: 'attacker' }, { userId, accessRole: 'operator' }).code, 'UNKNOWN_FIELD');
  assert.equal(validateEdgeRequest(input, { userId, accessRole: 'viewer' }).code, 'OPERATOR_REQUIRED');
  assert.equal(validateEdgeRequest(input, { userId, accessRole: 'reviewer' }).code, 'OPERATOR_REQUIRED');
  assert.equal(validateEdgeRequest(input, { userId, accessRole: 'admin' }).ok, true);
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'list', limit: 10 }, { userId, accessRole: 'reviewer' }).ok, true);
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'cancel', task_id: `ht-${userId}` }, { userId, accessRole: 'reviewer' }).code, 'OPERATOR_REQUIRED');
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'cancel', task_id: `ht-${userId}` }, { userId, accessRole: 'admin' }).ok, true);
  assert.equal(validateEdgeRequest({ ...input, approval: { admin: true } }, { userId, accessRole: 'operator' }).code, 'APPROVAL_UNKNOWN_FIELD');
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'delete', task_id: `ht-${userId}` }, { userId, accessRole: 'operator' }).code, 'ACTION_DENIED');
});

test('browser Edge two-phase contract forwards exact plan, confirm and failed-step retry bindings', () => {
  const plan = validateEdgeRequest({
    schema_version: EDGE_SCHEMA_VERSION,
    action: 'plan',
    request_id: 'plan-request-1',
    project_id: projectId,
    intent: 'Analyze the current project.',
  }, { userId, accessRole: 'operator' });
  assert.equal(plan.ok, true);
  assert.equal(plan.path, '/v1/tasks/plan');
  assert.equal(Object.hasOwn(plan.body, 'approval'), false);
  assert.equal(validateEdgeRequest({ ...plan, approval: { paid_external_calls: false } }, { userId, accessRole: 'operator' }).code, 'UNKNOWN_FIELD');

  const taskId = `ht-${userId}`;
  const approval = { paid_external_calls: true, online_writes: true, handoff_creation: false };
  const confirm = validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'confirm', task_id: taskId, plan_fingerprint: 'a'.repeat(64), approval }, { userId, accessRole: 'operator' });
  assert.equal(confirm.ok, true);
  assert.equal(confirm.path, `/v1/tasks/${taskId}/confirm`);
  assert.deepEqual(confirm.body, { schema_version: 'ams_harness_gateway_v1', task_id: taskId, plan_fingerprint: 'a'.repeat(64), approval });

  const retry = validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'retry_failed_step', task_id: taskId, plan_fingerprint: 'a'.repeat(64), step_id: 'st-3', approval }, { userId, accessRole: 'operator' });
  assert.equal(retry.ok, true);
  assert.equal(retry.path, `/v1/tasks/${taskId}/retry`);
  assert.equal(retry.body.step_id, 'st-3');
  assert.equal(validateEdgeRequest({ ...retry.body, action: 'retry_failed_step', schema_version: EDGE_SCHEMA_VERSION, step_id: 'wrong' }, { userId, accessRole: 'operator' }).code, 'STEP_ID_INVALID');
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'confirm', task_id: taskId, plan_fingerprint: 'b'.repeat(64), approval: { paid_external_calls: true } }, { userId, accessRole: 'operator' }).code, 'APPROVAL_INVALID');
});

test('Edge HMAC binds the delegated authorization digest and matches the Alibaba gateway verifier', async () => {
  const secret = 'g'.repeat(32);
  const delegatedAuthorization = `Bearer ${'j'.repeat(48)}`;
  const timestamp = '1786686000000';
  const rawBody = '{}';
  const signed = await signGatewayRequest(secret, { method: 'POST', path: '/v1/tasks', userId, timestamp, rawBody, delegatedAuthorization });
  assert.equal(signed.signature, signRequest(secret, { method: 'POST', path: '/v1/tasks', userId, timestamp, rawBody, authorizationDigest: signed.authorizationDigest }));
  assert.equal(verifySignedRequest({ secret, method: 'POST', path: '/v1/tasks', userId, timestamp, rawBody, authorizationDigest: signed.authorizationDigest, signature: signed.signature, now: Number(timestamp) }), true);
  assert.notEqual(signed.authorizationDigest, await sha256Hex(`Bearer ${'k'.repeat(48)}`));
});

test('tool bridge operation registry exactly matches the gateway allowlist', () => {
  assert.deepEqual(Object.keys(OPERATIONS).sort(), Object.keys(TOOL_DEFINITIONS).sort());
  for (const [operation, definition] of Object.entries(TOOL_DEFINITIONS)) {
    const payload = Object.fromEntries(definition.fields.map((field) => [field, field === 'project_id' ? projectId : field === 'count' ? 5 : field === 'sort' ? 'latest' : field === 'expected_fingerprint' ? 'fp' : {}]));
    const call = { schema_version: TOOL_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', user_id: userId, project_id: projectId, operation, payload, idempotency_key: 'idem-1', expected_revision: null };
    const boundary = toBoundaryRequest(call);
    assert.equal(validateBridgeEnvelope({ schema_version: 'ams_harness_bridge_v1', call, boundary }, userId).ok, true, operation);
  }
});

test('G1 command schema version is immutable across gateway, bridge and edge, and the bridge fails closed on missing/wrong/override values', () => {
  assert.equal(GATEWAY_G1_COMMAND_SCHEMA_VERSION, 'g1_generation_command_v1');
  assert.equal(BRIDGE_G1_COMMAND_SCHEMA_VERSION, GATEWAY_G1_COMMAND_SCHEMA_VERSION, '桥梁常量必须与网关常量逐字一致');
  assert.equal(G1_EDGE_SCHEMA_VERSION, GATEWAY_G1_COMMAND_SCHEMA_VERSION, 'G1 Edge 精确版本必须与网关/桥梁一致');

  const payloads = {
    'generation.quote': { project_id: projectId, brief_id: 'brief-111111111111111111111111', mode: 'image', prompt: '猫' },
    'generation.submit': {
      project_id: projectId, brief_id: 'brief-111111111111111111111111', mode: 'image', prompt: '猫',
      quote_id: `g1q-${'a'.repeat(24)}`, quote_fingerprint: 'f'.repeat(64), estimated_max_cost_cny: 0.3,
    },
    'generation.status': { project_id: projectId, job_id: `g1j-${'b'.repeat(24)}` },
    'generation.artifact': { project_id: projectId, job_id: `g1j-${'b'.repeat(24)}`, artifact_id: `g1x-${'c'.repeat(24)}` },
  };
  for (const [operation, payload] of Object.entries(payloads)) {
    const call = {
      schema_version: TOOL_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111',
      user_id: userId, project_id: projectId, operation, payload,
      idempotency_key: `idem-g1-${operation}`,
      ...(operation === 'generation.submit' ? { expected_revision: 1 } : {}),
    };
    const boundary = toBoundaryRequest(call);
    assert.equal(boundary.body.schema_version, 'g1_generation_command_v1', '网关必须在边界请求中固定写入精确版本');
    const envelope = { schema_version: 'ams_harness_bridge_v1', call, boundary };
    assert.equal(validateBridgeEnvelope(envelope, userId).ok, true, `${operation} 精确版本必须通过桥梁校验`);

    const without = validateBridgeEnvelope({ ...envelope, boundary: { ...boundary, body: withoutKey(boundary.body, 'schema_version') } }, userId);
    assert.equal(without.code, 'BOUNDARY_SCHEMA_VERSION_MISSING', `${operation} 缺失版本必须 fail closed`);
    assert.equal(without.diagnostics.field, 'schema_version');

    const wrong = validateBridgeEnvelope({ ...envelope, boundary: { ...boundary, body: { ...boundary.body, schema_version: 'g1_generation_command_v2' } } }, userId);
    assert.equal(wrong.code, 'BOUNDARY_SCHEMA_VERSION_MISMATCH', `${operation} 错误版本必须 fail closed`);
    assert.equal(wrong.diagnostics.field, 'schema_version');

    const override = validateBridgeEnvelope({
      schema_version: 'ams_harness_bridge_v1',
      call: { ...call, payload: { ...payload, schema_version: 'evil' } },
      boundary: { ...boundary, body: { ...boundary.body, schema_version: 'evil' } },
    }, userId);
    assert.equal(override.code, 'BOUNDARY_SCHEMA_VERSION_OVERRIDE', `${operation} 经 payload 键注入的覆盖尝试必须 fail closed`);
    assert.equal(override.diagnostics.field, 'schema_version');

    const duplicateSameValue = validateBridgeEnvelope({
      schema_version: 'ams_harness_bridge_v1',
      call: { ...call, payload: { ...payload, schema_version: GATEWAY_G1_COMMAND_SCHEMA_VERSION } },
      boundary,
    }, userId);
    assert.equal(duplicateSameValue.code, 'BOUNDARY_SCHEMA_VERSION_OVERRIDE', `${operation} 即使重复注入同值也必须 fail closed`);
    assert.equal(duplicateSameValue.diagnostics.field, 'schema_version');
  }
});

test('private attachment inspection binds the bridge task id and rejects substitution', () => {
  const threadId = 'thread-11111111-1111-4111-8111-111111111111';
  const payload = {
    project_id: projectId,
    thread_id: threadId,
    attachments: [{
      ref: `harness-thread-attachments:${userId}/${threadId}/source.png`,
      name: 'source.png',
      size: 4,
      mime_type: 'image/png',
    }],
  };
  const call = {
    schema_version: TOOL_SCHEMA_VERSION,
    task_id: 'ht-11111111-1111-4111-8111-111111111111',
    user_id: userId,
    project_id: projectId,
    operation: 'research.inspect_attachments',
    payload,
    idempotency_key: 'idem-attachment-binding',
    expected_revision: null,
  };
  const boundary = toBoundaryRequest(call);
  assert.equal(validateBridgeEnvelope({ schema_version: 'ams_harness_bridge_v1', call, boundary }, userId).ok, true);
  const substituted = validateBridgeEnvelope({
    schema_version: 'ams_harness_bridge_v1',
    call,
    boundary: { ...boundary, body: { ...boundary.body, harness_task_id: 'ht-22222222-2222-4222-8222-222222222222' } },
  }, userId);
  assert.equal(substituted.code, 'TASK_BINDING_MISMATCH');
  assert.equal(substituted.diagnostics.field, 'harness_task_id');
});

test('tool bridge fails closed for invented operation, identity, or boundary substitution', () => {
  const call = { schema_version: TOOL_SCHEMA_VERSION, task_id: 'ht-11111111-1111-4111-8111-111111111111', user_id: userId, project_id: projectId, operation: 'workspace.project.list', payload: {}, idempotency_key: 'idem-2' };
  const boundary = toBoundaryRequest(call);
  assert.equal(validateBridgeEnvelope({ schema_version: 'ams_harness_bridge_v1', call: { ...call, operation: 'database.sql' }, boundary }, userId).code, 'OPERATION_DENIED');
  assert.equal(validateBridgeEnvelope({ schema_version: 'ams_harness_bridge_v1', call, boundary }, 'other-user').code, 'USER_BINDING_MISMATCH');
  assert.equal(validateBridgeEnvelope({ schema_version: 'ams_harness_bridge_v1', call, boundary: { endpoint: 'p22-research-assist', body: { action: 'status' } } }, userId).code, 'BOUNDARY_BINDING_MISMATCH');
});

test('tool bridge signature is timestamp, token digest, and body bound', async () => {
  const secret = 't'.repeat(32);
  const timestamp = '1786686000000';
  const authorizationDigest = 'a'.repeat(64);
  const rawBody = '{}';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${authorizationDigest}\n${rawBody}`));
  const signature = [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyToolBridgeSignature({ secret, timestamp, authorizationDigest, rawBody, signature, now: Number(timestamp) }), true);
  assert.equal(await verifyToolBridgeSignature({ secret, timestamp, authorizationDigest: 'b'.repeat(64), rawBody, signature, now: Number(timestamp) }), false);
  assert.equal(await verifyToolBridgeSignature({ secret, timestamp, authorizationDigest, rawBody: '{ }', signature, now: Number(timestamp) }), false);
});

test('Harness writes carry an exact project revision and stale writes fail closed before persistence', async () => {
  const parsed = parseCommandRequest({
    schema_version: 'p19_command_contract_v1',
    command: 'project.update',
    idempotency_key: 'harness-revision-1',
    payload: { project_id: projectId, expected_revision: 2, patch: { topic: 'stale' } },
  });
  assert.equal(parsed.ok, true);
  let writes = 0;
  const result = await executeCommand({ ...parsed, user_id: userId, access_role: 'operator' }, {
    db: {
      async getProject() {
        return {
          schema_version: 'p19_research_project_v1', id: projectId, version: 3, status: 'active',
          topic: 'current', objective: 'objective', audience: 'audience', channel: 'x', constraints: [],
          execution_flags: { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false },
        };
      },
      async writeEntity() { writes += 1; throw new Error('must not write'); },
    },
  });
  assert.equal(result.code, 'PROJECT_REVISION_STALE');
  assert.equal(writes, 0);
});

test('Harness revision guard remains function-only while P22 adds a private exact-request binding', () => {
  const migration = readFileSync(new URL('../supabase/migrations/20260815085353_harness_brief_version_concurrency_guard.sql', import.meta.url), 'utf8');
  const binding = readFileSync(new URL('../supabase/migrations/20260815035041_p22_full_request_idempotency_binding.sql', import.meta.url), 'utf8');
  const p22 = readFileSync(new URL('../supabase/functions/p22-research-assist/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(migration, /\b(?:create|alter)\s+table\b/i);
  assert.doesNotMatch(migration, /\bcreate\s+policy\b/i);
  assert.match(binding, /create table ams_private\.p22_paid_operation_bindings_v1/i);
  assert.match(binding, /insert into ams_private\.p22_paid_operation_bindings_v1[\s\S]+from ams_private\.p22_paid_operation_replays_v1/i);
  assert.ok(
    binding.indexOf('insert into ams_private.p22_paid_operation_bindings_v1')
      < binding.indexOf('drop table if exists ams_private.p22_paid_operation_replays_v1'),
    'legacy replay receipts must be copied before the old table is retired',
  );
  assert.match(binding, /drop function if exists api\.p22_claim_paid_operation_replay\(uuid,uuid,text,text,integer,text\)/i);
  assert.match(binding, /drop function if exists api\.p22_get_paid_operation_replay\(uuid,uuid,text,text,integer,text\)/i);
  assert.match(binding, /drop function if exists api\.p22_complete_paid_operation_replay\(uuid,uuid,text,text,integer,text,jsonb\)/i);
  assert.match(binding, /drop function if exists api\.p22_fail_paid_operation_replay\(uuid,uuid,text,text,integer,text,text\)/i);
  assert.match(binding, /drop table if exists ams_private\.p22_paid_operation_replays_v1/i);
  assert.match(binding, /unique \(user_id, provider, operation, sequence, idempotency_key\)/i);
  assert.match(binding, /request_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(binding, /enable row level security[\s\S]+force row level security/i);
  assert.match(binding, /revoke all on table[\s\S]+from public, anon, authenticated/i);
  assert.match(binding, /grant select on table[\s\S]+to service_role/i);
  assert.match(binding, /revoke all on function api\.p22_claim_paid_operation[\s\S]+from public, anon, authenticated/i);
  assert.match(binding, /grant execute on function api\.p22_claim_paid_operation[\s\S]+to service_role/i);
  assert.match(p22, /rpc\('p22_claim_paid_operation'/);
  assert.match(p22, /sha256\(`\$\{userId\}\\n\$\{provider\}\\n\$\{operation\}\\n\$\{idempotencyKey\}\\n\$\{sequence\}`\)/);
  assert.match(p22, /data\?\.outcome !== 'claimed'[\s\S]+IDEMPOTENT_RESULT_UNAVAILABLE/);
  assert.match(p22, /P22_IDEMPOTENCY_CONFLICT'[\s\S]+IDEMPOTENCY_CONFLICT/);
  assert.match(p22, /analyzePersisted[\s\S]+evidence_version:loaded\.evidence\.version[\s\S]+evidence_fingerprint:loaded\.evidence\.fingerprint[\s\S]+requestBinding/);
  assert.match(p22, /generateSimilar[\s\S]+evidence_version:loaded\.evidence\.version[\s\S]+evidence_fingerprint:loaded\.evidence\.fingerprint[\s\S]+analysis_version:analysis\.version[\s\S]+analysis_fingerprint:analysis\.fingerprint[\s\S]+requestBinding/);
  assert.match(migration, /p19_apply_entity_write_v2[\s\S]+p_expected_project_revision/);
});

test('P22 same-day idempotent retry is terminal and never reaches the paid provider', async () => {
  const { recordProviderCost } = await loadP22CostContract();
  let providerCalls = 0;
  const db = costDb({
    rpc: async () => ({ data: { outcome: 'already_claimed' }, error: null }),
  });
  await assert.rejects(
    async () => {
      await recordProviderCost(db, userId, 'apify', 'collect_url', 2, 'same-day-key', 0, { action: 'collect_url', url: 'https://x.com/a/status/1' });
      providerCalls += 1;
    },
    (error) => error?.code === 'IDEMPOTENT_RESULT_UNAVAILABLE' && error?.status === 409,
  );
  assert.equal(providerCalls, 0);
});

test('P22 cross-UTC-date retry is terminal because the database binding is date-independent', async () => {
  const { recordProviderCost } = await loadP22CostContract();
  let providerCalls = 0;
  const db = costDb({
    rpc: async () => ({ data: { outcome: 'already_claimed' }, error: null }),
  });
  await assert.rejects(
    async () => {
      await recordProviderCost(db, userId, 'qwen', 'analyze_persisted', 1, 'cross-date-key', 0, { action: 'analyze_persisted', project_id: projectId, evidence_id: 'ev-1' });
      providerCalls += 1;
    },
    (error) => error?.code === 'IDEMPOTENT_RESULT_UNAVAILABLE' && error?.status === 409,
  );
  assert.equal(providerCalls, 0);

});

test('P22 same key with a different canonical request fails as an explicit conflict', async () => {
  const { canonicalRequestSha256, recordProviderCost } = await loadP22CostContract();
  assert.equal(
    await canonicalRequestSha256({ action: 'collect_url', url: 'https://x.com/a/status/1', idempotency_key: 'key' }),
    await canonicalRequestSha256({ url: 'https://x.com/a/status/1', action: 'collect_url', idempotency_key: 'other' }),
  );
  const persistedBase = {
    action: 'analyze_persisted', project_id: projectId, evidence_id: 'ev-1',
    evidence_version: 3, evidence_fingerprint: 'a'.repeat(64),
  };
  assert.equal(
    await canonicalRequestSha256(persistedBase),
    await canonicalRequestSha256({ ...persistedBase }),
  );
  assert.notEqual(
    await canonicalRequestSha256(persistedBase),
    await canonicalRequestSha256({ ...persistedBase, evidence_version: 4, evidence_fingerprint: 'b'.repeat(64) }),
    'a changed persisted Evidence snapshot must be a different paid request',
  );
  const generationBase = {
    action: 'generate_similar', project_id: projectId, evidence_id: 'ev-1', analysis_id: 'an-1',
    evidence_version: 3, evidence_fingerprint: 'a'.repeat(64), analysis_version: 2, analysis_fingerprint: 'c'.repeat(64),
  };
  assert.notEqual(
    await canonicalRequestSha256(generationBase),
    await canonicalRequestSha256({ ...generationBase, analysis_version: 3, analysis_fingerprint: 'd'.repeat(64) }),
    'a changed persisted Analysis snapshot must be a different paid request',
  );
  assert.notEqual(
    await canonicalRequestSha256({ action: 'collect_url', url: 'https://x.com/a/status/1' }),
    await canonicalRequestSha256({ action: 'collect_url', url: 'https://x.com/b/status/2' }),
  );
  assert.equal(
    await canonicalRequestSha256({ action: 'analyze', items: [], source_metadata: undefined, media_assets: undefined }),
    await canonicalRequestSha256({ action: 'analyze', items: [] }),
    'omitted optional fields and parsed undefined properties must have the same canonical request identity',
  );
  const db = costDb({ rpc: async (_name, args) => {
    assert.equal(args.p_operation, 'collect_url');
    assert.match(args.p_request_sha256, /^[0-9a-f]{64}$/);
    return { data: null, error: { message: 'P22_IDEMPOTENCY_CONFLICT' } };
  } });
  await assert.rejects(
    recordProviderCost(db, userId, 'apify', 'collect_url', 2, 'shared-key', 0, { action: 'collect_url', url: 'https://x.com/b/status/2' }),
    (error) => error?.code === 'IDEMPOTENCY_CONFLICT' && error?.status === 409,
  );
});

test('P22 deterministic reservation identity isolates user, provider, operation and sequence', async () => {
  const { paidReservationId } = await loadP22CostContract();
  const base = await paidReservationId(userId, 'apify', 'collect_url', 'isolation-key', 0);
  const variants = await Promise.all([
    paidReservationId('22222222-2222-4222-8222-222222222222', 'apify', 'collect_url', 'isolation-key', 0),
    paidReservationId(userId, 'qwen', 'collect_url', 'isolation-key', 0),
    paidReservationId(userId, 'apify', 'search', 'isolation-key', 0),
    paidReservationId(userId, 'apify', 'collect_url', 'isolation-key', 1),
  ]);
  assert.equal(new Set([base, ...variants]).size, 5);
  for (const id of [base, ...variants]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('P22 concurrent duplicate paid requests admit exactly one provider call', async () => {
  const { recordProviderCost } = await loadP22CostContract();
  let claimed = false;
  let providerCalls = 0;
  const db = costDb({
    rpc: async () => {
      if (!claimed) {
        claimed = true;
        await Promise.resolve();
        return { data: { outcome: 'claimed', reservation_id: '11111111-1111-4111-a111-111111111111', cost: { outcome: 'recorded' } }, error: null };
      }
      return { data: { outcome: 'already_claimed' }, error: null };
    },
  });
  const attempt = async () => {
    await recordProviderCost(db, userId, 'apify', 'collect_url', 2, 'concurrent-key', 0, { action: 'collect_url', url: 'https://x.com/a/status/1' });
    providerCalls += 1;
  };
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  const rejected = results.filter((item) => item.status === 'rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'IDEMPOTENT_RESULT_UNAVAILABLE');
  assert.equal(rejected[0].reason?.status, 409);
  assert.equal(providerCalls, 1);
});

test('Reddit proof verification preserves the exact signed source platform', () => {
  const edge = readFileSync(new URL('../supabase/functions/p19-workspace-command/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /sourcePlatform = String\(provenance\?\.source_platform/);
  assert.match(edge, /platform: sourcePlatform/);
  assert.doesNotMatch(edge, /platform: 'x',[\s\S]{0,500}verifyCollectionProof/);
});

test('project reads preserve complete existing artifacts or fail closed at the bounded transport limit', () => {
  const huge = 'x'.repeat(2_000);
  const evidence = Array.from({ length: 20 }, (_, index) => ({
    schema_version: 'p19_evidence_v1', id: `ev-${String(index).padStart(24, '0')}`, version: index + 1,
    project_id: projectId, fingerprint: `fp-${index}`, source_url: `https://example.test/${index}`,
    content: huge, media_assets: [{ bytes: huge }],
  }));
  const body = { ok: true, data: { project: {
    schema_version: 'p19_research_project_v1', id: projectId, version: 17, status: 'active',
    topic: 'topic', objective: 'objective', audience: 'audience', channel: 'x', constraints: [],
    execution_flags: { generation_executed: false }, fingerprint: 'project-fp', evidence,
    analyses: [], knowledge_cards: [], handoffs: [], brief: null, handoff: null,
  } } };
  const summary = summarizeBridgeResponse('workspace.project.read', body, 2 * 1024 * 1024);
  assert.equal(summary.data.project.version, 17);
  assert.equal(summary.data.project.evidence.length, 20);
  assert.equal(summary.data.project.evidence[19].id, 'ev-000000000000000000000019');
  assert.equal(summary.data.project.evidence[0].content, huge);
  assert.equal(summary.data.project.evidence[0].media_assets[0].bytes, huge);
  assert.throws(() => summarizeBridgeResponse('workspace.project.read', body, 1024), (error) => error.code === 'PROJECT_SUMMARY_TOO_LARGE');
});

test('every proof-bound research response crosses the gateway exactly or fails closed', () => {
  const body = {
    ok: true,
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `source-${index}`,
      source_url: `https://example.com/${index}`,
      content_text: 'x'.repeat(5000),
      source_metadata: { author: { name: 'author' }, engagement: { views: index } },
    })),
    cost: { provider: 'apify', amount_cny: 2 },
  };
  const summary = summarizeBridgeResponse('research.search_x', body, 2 * 1024 * 1024);
  const bytes = new TextEncoder().encode(JSON.stringify(summary)).length;
  assert.ok(bytes <= 2 * 1024 * 1024, `exact response was ${bytes} bytes`);
  assert.equal(summary.ok, true);
  assert.equal(summary.items.length, 20);
  assert.equal(summary.items[0].content_text, body.items[0].content_text);
  assert.equal(summary.harness_summary, undefined);
  assert.equal(summary.cost.amount_cny, 2);
  assert.throws(() => summarizeBridgeResponse('research.search_x', body, 1024), (error) => error.code === 'BRIDGE_RESPONSE_TOO_LARGE');
});

test('Harness Edge body bound accommodates the declared 12000-character intent', () => {
  const edge = readFileSync(new URL('../supabase/functions/harness-command/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /const MAX_BODY = 64 \* 1024/);
});

test('Harness Edge response bound accommodates the maximum valid completed task envelope', () => {
  const edge = readFileSync(new URL('../supabase/functions/harness-command/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /const MAX_RESPONSE = 192 \* 1024/);
  const task = {
    ok: true,
    task: {
      id: 'ht-11111111-1111-4111-8111-111111111111', state: 'succeeded',
      created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:01.000Z',
      request: {
        schema_version: 'ams_harness_task_v1', request_id: 'r'.repeat(200),
        intent: '😀'.repeat(6_000), project_id: '11111111-1111-4111-8111-111111111111',
        approval: { paid_external_calls: true, online_writes: true, generation_handoff: true },
      },
      result: {
        final_response: '结'.repeat(4096),
        artifact_refs: Array.from({ length: 50 }, () => '😀'.repeat(250)),
      },
      error: null,
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(task)).length;
  assert.ok(bytes > 64 * 1024, `maximum task envelope unexpectedly fit the old cap: ${bytes}`);
  assert.ok(bytes < 192 * 1024, `maximum task envelope exceeded the declared cap: ${bytes}`);
});

test('gateway readiness requires a configured model proxy and project tasks disclose only their trusted bound identity', () => {
  const server = readFileSync('services/harness-gateway/server.mjs', 'utf8');
  const runner = readFileSync('services/harness-gateway/harness-runner.mjs', 'utf8');
  assert.match(server, /readiness\.model_credential_configured/);
  assert.match(runner, /Trusted bound project id \(JSON; use this exact value for project-scoped tools\)/);
  assert.match(runner, /JSON\.stringify\(request\.project_id \|\| null\)/);
});

test('signed tool bridge envelope accommodates two exact copies of the 64 KiB business payload', () => {
  const bridge = readFileSync(new URL('../supabase/functions/harness-tool-bridge/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /const MAX_BODY = 192 \* 1024/);
  const checked = {
    schema_version: TOOL_SCHEMA_VERSION,
    task_id: 'ht-11111111-1111-4111-8111-111111111111', user_id: userId, project_id: projectId,
    operation: 'workspace.evidence.create', payload: { project_id: projectId, evidence: { content_text: 'x'.repeat(60 * 1024) } },
    idempotency_key: 'idem-envelope', expected_revision: 1,
  };
  const envelope = { schema_version: 'ams_harness_bridge_v1', call: checked, boundary: toBoundaryRequest(checked) };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  assert.ok(bytes > 64 * 1024);
  assert.ok(bytes < 192 * 1024);
});

test('tool bridge timeout stays below the hosted 150 second edge limit while covering P22', () => {
  const bridge = readFileSync(new URL('../supabase/functions/harness-tool-bridge/index.ts', import.meta.url), 'utf8');
  assert.match(bridge, /AbortSignal\.timeout\(140_000\)/);
});

test('gateway transport, task, queue and JWT windows are bounded without retaining queued credentials', () => {
  const edge = readFileSync(new URL('../supabase/functions/harness-command/index.ts', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../services/harness-gateway/server.mjs', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../services/harness-gateway/harness-runner.mjs', import.meta.url), 'utf8');
  assert.match(edge, /AbortSignal\.timeout\(20_000\)/);
  assert.match(server, /TASK_TIMEOUT_MS[^\n]+600_000/);
  assert.match(server, /TOOL_WINDOW_MS = 150_000/);
  assert.match(server, /QUEUE_CAPACITY = 2/);
  assert.match(runner, /HARNESS_TASK_TIMEOUT_MS \|\| 600_000/);
  assert.doesNotMatch(server, /refresh[_-]?token/i);
});
