/* global ReadableStream, Request, TextEncoder */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_SCHEMA_VERSION, fixedGatewayBase, signGatewayRequest, validateEdgeRequest } from '../supabase/functions/harness-command/edge-core.mjs';
import { OPERATIONS, readBoundedText, sha256Hex, summarizeBridgeResponse, validateBridgeEnvelope, verifyToolBridgeSignature } from '../supabase/functions/harness-tool-bridge/bridge-core.mjs';
import { signRequest, verifySignedRequest } from '../services/harness-gateway/gateway-core.mjs';
import { TOOL_DEFINITIONS, TOOL_SCHEMA_VERSION, toBoundaryRequest } from '../services/harness-gateway/tool-contract.mjs';
import { executeCommand, parseCommandRequest } from '../supabase/functions/p19-workspace-command/command-core.mjs';
import { parseP22Request } from '../supabase/functions/p22-research-assist/assist-core.mjs';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const userId = '11111111-1111-4111-8111-111111111111';
const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';

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

test('Harness P22 boundary durably replays duplicate paid execution', () => {
  assert.equal(parseP22Request({ action: 'collect_url', url: 'https://x.com/a/status/123', idempotency_key: 'harness-paid-1' }).idempotency_key, 'harness-paid-1');
  assert.equal(parseP22Request({ action: 'status' }).idempotency_key, undefined);
  const edge = readFileSync(new URL('../supabase/functions/p22-research-assist/index.ts', import.meta.url), 'utf8');
  assert.match(edge, /sha256\(`\$\{userId\}\\n\$\{provider\}\\n\$\{operation\}\\n\$\{idempotencyKey\}\\n\$\{sequence\}`\)/);
  assert.match(edge, /recordProviderCost\(db,userId,'apify',input\.action,/);
  assert.match(edge, /recordProviderCost\(db,userId,'qwen',operation,/);
  assert.match(edge, /recordProviderCost\(db,userId,'qwen',input\.action,/);
  assert.match(edge, /\['already_completed','already_claimed'\]\.includes\(claimOutcome\)[\s\S]+readPaidReplay/);
  assert.ok(
    edge.indexOf("['already_completed','already_claimed'].includes(claimOutcome)") < edge.indexOf("rpc('p22_reserve_daily_budget'"),
    'completed durable receipts must be read before the UTC-day-scoped cost reservation path',
  );
  assert.match(edge, /allocatePaidAttemptBudgetReservationId\(id,idempotencyKey,claimOutcome\)/, 'each real paid attempt must receive an accounting identity independent of the durable replay identity');
  assert.match(edge, /p_reservation_id:budgetId/, 'the budget RPC must use the day-scoped reservation identity');
  assert.match(edge, /reservation_id:id,budget_reservation_id:budgetId/, 'the response must preserve both paid-operation and accounting identities');
  assert.match(edge, /refreshCollectionReplayReceipt\(proofSecret,userId,costRecord\.replay\)/, 'collection receipt replay must refresh expiring proofs');
  const reserveFailure = edge.slice(edge.indexOf("rpc('p22_reserve_daily_budget'"), edge.indexOf('async function costStatus'));
  assert.match(reserveFailure, /if \(error\)[\s\S]+rpc\('p22_fail_paid_operation_replay'/);
  assert.match(reserveFailure, /p_failure_code:'COST_RECORDING_FAILED'/);
  assert.match(reserveFailure, /releaseError\|\|released!=='failed'/);
  assert.match(edge, /canonicalJson\(requestBinding\)/);
  assert.match(edge, /p22_claim_paid_operation_replay/);
  assert.match(edge, /p22_complete_paid_operation_replay/);
  assert.match(edge, /p22_fail_paid_operation_replay/);
  assert.match(edge, /if\(costRecord\.replay\) return costRecord\.replay/);
  assert.doesNotMatch(edge, /IDEMPOTENT_REPLAY_BLOCKED/);
  const migration = readFileSync(new URL('../supabase/migrations/20260814094040_harness_atomic_project_revision_guard.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists ams_private\.p22_paid_operation_replays_v1/i);
  assert.match(migration, /request_sha256 text not null/i);
  assert.match(migration, /p22_claim_paid_operation_replay[\s\S]+P22_PAID_REPLAY_IDENTITY_CONFLICT/i);
  assert.match(migration, /state text not null default 'claimed'[\s\S]+lease_expires_at/i);
  assert.match(migration, /p22_fail_paid_operation_replay[\s\S]+state = 'failed'/i);
  assert.match(migration, /force row level security/i);
  assert.match(migration, /p22_get_paid_operation_replay[\s\S]+p22_complete_paid_operation_replay/i);
  assert.match(migration, /revoke all on function api\.p22_get_paid_operation_replay[\s\S]+from public, anon, authenticated/i);
});

test('durable paid receipt storage covers every accepted P22 response envelope', () => {
  const migration = readFileSync('supabase/migrations/20260814094040_harness_atomic_project_revision_guard.sql', 'utf8');
  assert.match(migration, /result_json::text\) <= 2097152/);
  assert.match(migration, /octet_length\(p_result_json::text\) > 2097152/);
  assert.doesNotMatch(migration, /result_json::text\) <= 1048576|p_result_json::text\) > 1048576/);
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
