import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { createConversationDeliveryQueue } from '../conversation-delivery-queue.mjs';
import { appendConversationEvent, loadConversationEvents } from '../conversation-event-store.mjs';
import { createConversationProjector } from '../conversation-projector.mjs';

const request = {
  schema_version: 1,
  thread_id: 'thr_00000000-0000-4000-8000-000000000201',
  native_session_id: 'session-00000000-0000-4000-8000-000000000201',
  generation_id: 'edge_request-1', request_id: 'request-1',
  workspace_id: 'ai-marketing-studio-staging', project_id: null, content: 'hello',
};
const userId = '00000000-0000-4000-8000-000000000101';
const settle = () => setImmediate();

test('delivery is durably accepted before async model execution and request replay is idempotent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    let calls = 0;
    const events = [];
    const queue = createConversationDeliveryQueue({ journalFile, onEvent: (event) => events.push(event), runner: {
      run: async (_request, _user, { onFrame }) => {
        calls += 1;
        onFrame({ type: 'session_event', event: { type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'ok' } } } });
        onFrame({ type: 'session_event', event: { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'ok' }] } } } });
        return { ok: true };
      },
    } });
    const accepted = queue.enqueue({ ...request, user_id: userId }, userId);
    assert.equal(accepted.accepted, true);
    assert.match(readFileSync(journalFile, 'utf8').split('\n')[0], /"state":"accepted"/);
    assert.equal(queue.enqueue({ ...request, user_id: userId }, userId).replayed, true);
    await settle(); await settle();
    assert.equal(calls, 1);
    assert.ok(events.some((event) => event.event_type === 'assistant_text_completed'));
    assert.ok(events.some((event) => event.event_type === 'generation_completed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('delivery passes transient authorization to Harness without persisting it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-runtime-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const runtimeContext = {
      delegatedAuthorization: 'Bearer delegated-token-must-not-persist',
      approval: { paid_external_calls: true, online_writes: true },
    };
    let observedRuntimeContext = null;
    const queue = createConversationDeliveryQueue({ journalFile, runner: {
      run: async (_request, _user, { runtimeContext: observed }) => {
        observedRuntimeContext = observed;
        return { ok: true };
      },
    } });
    queue.enqueue({ ...request, request_id: 'request-runtime', generation_id: 'edge_request-runtime' }, userId, runtimeContext);
    await settle(); await settle();
    assert.deepEqual(observedRuntimeContext, runtimeContext);
    assert.doesNotMatch(readFileSync(journalFile, 'utf8'), /delegated-token-must-not-persist|paid_external_calls|online_writes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accepted delivery without live delegated authorization fails closed after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-auth-expired-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const deliveryId = 'gdl_auth_expired_123456789012345678';
    writeFileSync(journalFile, `${JSON.stringify({ delivery_id: deliveryId, user_id: userId, state: 'accepted', request })}\n`);
    let calls = 0;
    const events = [];
    createConversationDeliveryQueue({ journalFile, onEvent: (event) => events.push(event), runner: {
      run: async () => { calls += 1; return { ok: true }; },
    } });
    await settle(); await settle();
    assert.equal(calls, 0);
    assert.equal(events.at(-1).event_type, 'generation_failed');
    assert.equal(events.at(-1).payload.code, 'DELEGATED_AUTHORIZATION_EXPIRED');
    assert.match(readFileSync(journalFile, 'utf8'), /"code":"DELEGATED_AUTHORIZATION_EXPIRED"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart fails an ambiguous running delivery closed and never calls the model twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-recovery-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const deliveryId = 'gdl_12345678901234567890123456789012';
    writeFileSync(journalFile, `${JSON.stringify({ delivery_id: deliveryId, user_id: userId, state: 'running', request })}\n`);
    let calls = 0;
    const events = [];
    createConversationDeliveryQueue({ journalFile, onEvent: (event) => events.push(event), runner: { run: async () => { calls += 1; return { ok: true }; } } });
    await settle();
    assert.equal(calls, 0);
    assert.equal(events.at(-1).event_type, 'generation_failed');
    assert.equal(events.at(-1).payload.code, 'GENERATION_RECOVERY_REQUIRED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stop at accepted state prevents model start and projects stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-stop-'));
  try {
    let calls = 0;
    const events = [];
    const queue = createConversationDeliveryQueue({ journalFile: join(dir, 'deliveries.jsonl'), onEvent: (event) => events.push(event), runner: {
      run: async () => { calls += 1; return { ok: true }; },
      stop: () => ({ ok: false }),
    } });
    queue.enqueue(request, userId);
    assert.equal(queue.stop(userId, request.thread_id).ok, true);
    await settle();
    assert.equal(calls, 0);
    assert.equal(events.at(-1).event_type, 'generation_stopped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native aborted completion maps to stopped and tool payloads are recursively redacted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-redact-'));
  try {
    const events = [];
    const queue = createConversationDeliveryQueue({ journalFile: join(dir, 'deliveries.jsonl'), onEvent: (event) => events.push(event), runner: {
      run: async (_request, _user, { onFrame }) => {
        onFrame({ type: 'session_event', event: { type: 'tool/call', seq: 1, data: { headers: { authorization: 'Bearer top-secret' }, api_key: 'secret-key', safe: 'visible' } } });
        onFrame({ type: 'conversation_completed', reason: { kind: 'aborted' } });
        return { ok: true };
      },
    } });
    queue.enqueue({ ...request, request_id: 'request-redact', generation_id: 'edge_request-redact' }, userId);
    await settle(); await settle();
    const tool = events.find((event) => event.event_type === 'tool_call_started');
    assert.equal(tool.payload.call.headers.authorization, '[REDACTED]');
    assert.equal(tool.payload.call.api_key, '[REDACTED]');
    assert.equal(tool.payload.call.safe, 'visible');
    assert.equal(events.at(-1).event_type, 'generation_stopped');
    assert.doesNotMatch(JSON.stringify(events), /top-secret|secret-key/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('native Agent tool calls stay in the Harness session and never create a deterministic plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-agent-tool-'));
  try {
    const events = [];
    const plans = [];
    const task = { id: 'ht-00000000-0000-4000-8000-000000000301', state: 'planned', request: { user_id: userId, project_id: null } };
    const queue = createConversationDeliveryQueue({
      journalFile: join(dir, 'deliveries.jsonl'),
      onEvent: (event) => events.push(event),
      planTask: async (record, proposal) => { plans.push({ record, proposal }); return { ok: true, task }; },
      runner: {
        run: async (_request, _user, { onFrame }) => {
          onFrame({ type: 'session_event', event: { type: 'tool/call', seq: 7, data: { callId: 'call-7', name: 'ams_call', arguments: '{"schema_version":"ams_harness_tool_v1","operation":"workspace.project.read","payload":{"project_id":"prj-123"},"idempotency_key":"idem-1"}' } } });
          onFrame({ type: 'session_event', event: { type: 'tool/result', seq: 8, data: { message: { source: { kind: 'tool', callId: 'call-7' }, content: [{ type: 'tool-result', toolCallId: 'call-7', content: [{ type: 'text', text: '{"ok":true}' }] }] } } } });
          return { ok: true };
        },
      },
    });
    queue.enqueue({ ...request, request_id: 'request-agent-plan', generation_id: 'edge_request-agent-plan' }, userId);
    await settle(); await settle();
    assert.equal(plans.length, 0);
    const toolCall = events.find((event) => event.event_type === 'tool_call_started');
    const toolResult = events.find((event) => event.event_type === 'tool_call_completed');
    assert.deepEqual({ name: toolCall.payload.name, operation: toolCall.payload.operation, status: toolCall.payload.status },
      { name: 'ams_call', operation: 'ams_call', status: 'started' });
    assert.deepEqual({ name: toolResult.payload.name, operation: toolResult.payload.operation, status: toolResult.payload.status },
      { name: 'ams_call', operation: 'ams_call', status: 'completed' });
    assert.equal(events.some((event) => event.event_type === 'agent_plan_created'), false);
    assert.equal(events.at(-1).event_type, 'generation_completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart resumes an idempotent in-flight Agent plan without rerunning the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-agent-plan-recovery-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const deliveryId = 'gdl_agent_plan_recovery_123456789';
    const planning = { delivery_id: deliveryId, user_id: userId, state: 'planning', request,
      plan_request: { intent: 'search five recent posts', nativeSeq: 7 }, result: { ok: true } };
    writeFileSync(journalFile, `${JSON.stringify(planning)}\n`);
    let modelCalls = 0;
    let planCalls = 0;
    const events = [];
    const task = { id: 'ht-00000000-0000-4000-8000-000000000302', state: 'planned', request: { user_id: userId, project_id: null } };
    createConversationDeliveryQueue({
      journalFile,
      onEvent: (event) => events.push(event),
      runner: { run: async () => { modelCalls += 1; return { ok: true }; } },
      planTask: async () => { planCalls += 1; return { ok: true, replayed: true, task }; },
    });
    await settle(); await settle();
    assert.equal(modelCalls, 0);
    assert.equal(planCalls, 1);
    assert.equal(events.find((event) => event.event_type === 'agent_plan_created').payload.task.id, task.id);
    assert.equal(events.at(-1).event_type, 'generation_completed');
    assert.match(readFileSync(journalFile, 'utf8'), /"state":"completed"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restart reprojects a durably planned Agent task without model or planner duplication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-agent-planned-recovery-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const task = { id: 'ht-00000000-0000-4000-8000-000000000303', state: 'planned', request: { user_id: userId, project_id: null } };
    const planned = { delivery_id: 'gdl_agent_planned_recovery_1234567', user_id: userId, state: 'planned', request,
      plan_request: { intent: 'search five recent posts', nativeSeq: 7 }, planned_task: task, result: { ok: true } };
    writeFileSync(journalFile, `${JSON.stringify(planned)}\n`);
    let modelCalls = 0;
    let planCalls = 0;
    const events = [];
    createConversationDeliveryQueue({
      journalFile,
      onEvent: (event) => events.push(event),
      runner: { run: async () => { modelCalls += 1; return { ok: true }; } },
      planTask: async () => { planCalls += 1; return { ok: true, task }; },
    });
    await settle(); await settle();
    assert.equal(modelCalls, 0);
    assert.equal(planCalls, 0);
    assert.equal(events[0].event_type, 'agent_plan_created');
    assert.equal(events.at(-1).event_type, 'generation_completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('terminal delivery journal reconstructs a missing terminal outbox event after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-delivery-terminal-'));
  try {
    const journalFile = join(dir, 'deliveries.jsonl');
    const deliveryId = 'gdl_terminal_recovery_1234567890';
    writeFileSync(journalFile, `${JSON.stringify({ delivery_id: deliveryId, user_id: userId, state: 'completed', request, result: { ok: true } })}\n`);
    const events = [];
    createConversationDeliveryQueue({ journalFile, onEvent: (event) => events.push(event), runner: { run: async () => { throw new Error('must not run'); } } });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'generation_completed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conversation outbox is durable and projector retries until signed callback acknowledgement', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-conversation-outbox-'));
  try {
    const eventFile = join(dir, 'events.jsonl');
    const ackFile = join(dir, 'acks.log');
    const event = { event_id: 'event-outbox-123456', user_id: userId, thread_id: request.thread_id,
      generation_id: request.generation_id, request_id: request.request_id, event_type: 'generation_completed', payload: {} };
    appendConversationEvent(eventFile, event);
    assert.deepEqual(loadConversationEvents(eventFile), [event]);
    let calls = 0;
    const projector = createConversationProjector({ callbackBase: 'https://staging.example.test', secret: 's'.repeat(32), ackFile,
      retryMs: 60_000, fetchImpl: async () => ({ ok: ++calls > 1 }) });
    projector.enqueue(event);
    await projector.drain();
    assert.equal(projector.pendingCount(), 1);
    await projector.drain();
    assert.equal(projector.pendingCount(), 0);
    assert.match(readFileSync(ackFile, 'utf8'), /event-outbox-123456/);
    projector.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
