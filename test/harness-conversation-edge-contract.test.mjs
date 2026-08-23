import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractAssistantTextDelta, isAcceptedMessageReplay, reduceGenerationOutcome, signGatewayRequest, validateEdgeRequest, verifyGatewayCallback, EDGE_SCHEMA_VERSION } from '../supabase/functions/harness-command/edge-core.mjs';

const userId = '00000000-0000-4000-8000-000000000101';
const threadId = 'thr_00000000-0000-4000-8000-000000000201';
const context = { userId, accessRole: 'operator' };

test('thread create and message envelopes are exact and idempotency-bound', () => {
  const created = validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'thread_create', workspace_id: 'ai-marketing-studio-staging', project_id: null, request_id: 'request-1', title: 'Thread' }, context);
  assert.equal(created.ok, true);
  assert.equal(created.contract, 'thread_create');
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'thread_create', workspace_id: 'another-workspace', project_id: null, request_id: 'request-cross-workspace' }, context).code, 'WORKSPACE_ACCESS_DENIED');
  const sent = validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'thread_send', thread_id: threadId, request_id: 'request-2', client_message_id: 'client-2', content: '你能做什么？', attachments: [] }, context);
  assert.equal(sent.ok, true);
  assert.equal(sent.contract, 'thread_send');
  assert.equal(sent.body.content, '你能做什么？');
  assert.equal(validateEdgeRequest({ ...sent.body, schema_version: EDGE_SCHEMA_VERSION, action: 'thread_send', extra: true }, context).code, 'UNKNOWN_FIELD');
});

test('attachments are private-bucket, user and thread path bound', () => {
  const base = { schema_version: EDGE_SCHEMA_VERSION, action: 'thread_send', thread_id: threadId, request_id: 'request-3', content: '附件', client_message_id: null };
  const good = { bucket: 'harness-thread-attachments', path: `${userId}/${threadId}/request-3/file.pdf`, name: 'file.pdf', size: 100, mimeType: 'application/pdf' };
  assert.equal(validateEdgeRequest({ ...base, attachments: [good] }, context).ok, true);
  assert.equal(validateEdgeRequest({ ...base, attachments: [{ ...good, path: `other/${threadId}/file.pdf` }] }, context).code, 'ATTACHMENT_INVALID');
  assert.equal(validateEdgeRequest({ ...base, attachments: [{ ...good, bucket: 'public' }] }, context).code, 'ATTACHMENT_INVALID');
});

test('history/event cursor and owner-bound thread actions fail closed', () => {
  for (const action of ['thread_get', 'thread_messages', 'thread_events', 'thread_stop']) {
    const result = validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action, thread_id: threadId, ...(action.includes('messages') || action.includes('events') ? { cursor: '42', limit: 100 } : {}) }, context);
    assert.equal(result.ok, true, action);
  }
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'thread_events', thread_id: '../escape', cursor: '0' }, context).code, 'THREAD_ID_INVALID');
  assert.equal(validateEdgeRequest({ schema_version: EDGE_SCHEMA_VERSION, action: 'thread_events', thread_id: threadId, cursor: '-1' }, context).code, 'CURSOR_INVALID');
});

test('Gateway task projection callback is HMAC-bound and rejects stale or altered bodies', async () => {
  const secret = 's'.repeat(32);
  const path = '/functions/v1/harness-command/internal/task-events';
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify({ schema_version: 1, event: { user_id: userId } });
  const { signature } = await signGatewayRequest(secret, { method: 'POST', path, userId, timestamp, rawBody, delegatedAuthorization: '' });
  assert.equal(await verifyGatewayCallback(secret, { method: 'POST', path, userId, timestamp, rawBody, signature }), true);
  assert.equal(await verifyGatewayCallback(secret, { method: 'POST', path, userId, timestamp, rawBody: `${rawBody} `, signature }), false);
  assert.equal(await verifyGatewayCallback(secret, { method: 'POST', path, userId, timestamp: String(Number(timestamp) - 120_000), rawBody, signature }), false);
});

test('native stop and Gateway failure produce distinct deterministic terminal outcomes', () => {
  const initial = { state: 'completed', code: null };
  assert.deepEqual(reduceGenerationOutcome(initial, { type: 'session_event', event: { type: 'conversation_completed', reason: { kind: 'aborted' } } }), { state: 'stopped', code: 'GENERATION_STOPPED' });
  assert.deepEqual(reduceGenerationOutcome(initial, { type: 'gateway_completed', ok: false, code: 'HARNESS_EXIT_FAILED' }), { state: 'failed', code: 'HARNESS_EXIT_FAILED' });
  assert.deepEqual(reduceGenerationOutcome(initial, { type: 'gateway_completed', ok: true }), initial);
});

test('only final assistant text is projected; private reasoning never becomes a chat message', () => {
  assert.equal(extractAssistantTextDelta({ type: 'text-delta', text: '真实回复' }), '真实回复');
  assert.equal(extractAssistantTextDelta({ type: 'reasoning-delta', text: 'internal chain of thought' }), '');
  assert.equal(extractAssistantTextDelta({ type: 'tool-call-delta', argumentsDelta: '{}' }), '');
});

test('same message request replay returns before confirmation processing in queued, running and terminal states', () => {
  const message = { id: 'msg-1', replayed: true };
  assert.equal(isAcceptedMessageReplay(message, { claimed: false, reason: 'generation_active', status: 'executing' }), true);
  for (const status of ['waiting_confirmation', 'executing', 'completed', 'failed', 'stopped']) {
    assert.equal(isAcceptedMessageReplay(message, { claimed: false, reason: 'generation_replayed', status }), true, status);
  }
  assert.equal(isAcceptedMessageReplay({ ...message, replayed: false }, { claimed: false, reason: 'generation_replayed', status: 'completed' }), false);
  assert.equal(isAcceptedMessageReplay(message, { claimed: true }), false);
});

test('Edge source implements real SSE replay, heartbeat and no simulated model streaming', async () => {
  const source = await readFile(new globalThis.URL('../supabase/functions/harness-command/index.ts', import.meta.url), 'utf8');
  const migration = await readFile(new globalThis.URL('../supabase/migrations/20260823032957_harness_conversation_contract_v1.sql', import.meta.url), 'utf8');
  const recoveryMigration = await readFile(new globalThis.URL('../supabase/migrations/20260824005728_harness_expired_generation_recovery.sql', import.meta.url), 'utf8');
  assert.match(source, /text\/event-stream/);
  assert.match(source, /last-event-id/);
  assert.match(source, /: heartbeat/);
  assert.match(source, /harness_list_events_v1/);
  assert.match(source, /EdgeRuntime\.waitUntil\(processGeneration\(\)\)/);
  assert.match(source, /PLANNER_UNRECOGNIZED/);
  assert.match(source, /\/v1\/tasks\/plan/);
  assert.match(source, /currentTaskId/);
  assert.match(source, /harness_claim_generation_v1/);
  assert.match(source, /harness_release_generation_v1/);
  assert.match(source, /generation_stopped/);
  assert.match(source, /gateway_completed/);
  assert.match(source, /tool_call_started/);
  assert.match(source, /tool_call_completed/);
  assert.match(migration, /approval_requested/);
  assert.match(migration, /harness_project_task_event_v1/);
  assert.match(source, /p_task_id: null/);
  assert.match(source, /internal\/task-events/);
  assert.doesNotMatch(source, /Task projection is pushed durably[\s\S]*\/v1\/tasks\/\$\{threadState\.currentTaskId\}/);
  assert.doesNotMatch(source, /setTimeout\([^,]+,\s*\d+\).*assistant_text_delta/s);
  assert.match(recoveryMigration, /active_generation_lease_until/);
  assert.match(recoveryMigration, /stopGeneration[\s\S]*active_generation_lease_until\s*>=\s*now\(\)/);
  const failureRelease = source.indexOf("p_status: 'failed'");
  const failureEvent = source.indexOf("appendEvent('error'", failureRelease);
  assert.ok(failureRelease >= 0 && failureEvent > failureRelease, 'failure lease must release before its terminal event');
});
