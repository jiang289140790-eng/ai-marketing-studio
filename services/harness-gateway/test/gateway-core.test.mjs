import assert from 'node:assert/strict';
/* global Buffer, setImmediate, setTimeout */
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GATEWAY_SCHEMA_VERSION, HarnessTaskQueue, signRequest, validateDelegatedAuthorization, validateTaskRequest, verifySignedRequest } from '../gateway-core.mjs';

function request(overrides = {}) {
  return {
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: 'request-1',
    user_id: 'user-a',
    project_id: 'project-a',
    intent: 'Inspect the current project and propose the next safe step.',
    approval: { paid_external_calls: false, online_writes: false },
    ...overrides,
  };
}

test('strict task envelope rejects unknown fields and invented identity', () => {
  assert.equal(validateTaskRequest({ ...request(), sql: 'select 1' }).code, 'UNKNOWN_FIELD');
  assert.equal(validateTaskRequest({ ...request(), user_id: '' }).code, 'USER_ID_INVALID');
  assert.equal(validateTaskRequest({ ...request(), approval: { admin: true } }).code, 'APPROVAL_UNKNOWN_FIELD');
});

test('HMAC is body-bound, timestamp-bound, and time-bounded', () => {
  const secret = 'x'.repeat(32);
  const timestamp = '1786686000000';
  const body = JSON.stringify(request());
  const envelope = { method: 'POST', path: '/v1/tasks', userId: 'user-a', timestamp, rawBody: body };
  envelope.authorizationDigest = 'a'.repeat(64);
  const signature = signRequest(secret, envelope);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, now: 1786686000000 }), true);
  const weakSecret = 'weak';
  const weakSignature = signRequest(weakSecret, envelope);
  assert.equal(verifySignedRequest({ secret: weakSecret, signature: weakSignature, ...envelope, now: 1786686000000 }), false);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, userId: 'user-b', now: 1786686000000 }), false);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, path: '/v1/tasks/other', now: 1786686000000 }), false);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, rawBody: `${body} `, now: 1786686000000 }), false);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, authorizationDigest: 'b'.repeat(64), now: 1786686000000 }), false);
  assert.equal(verifySignedRequest({ secret, signature, ...envelope, now: 1786686200000 }), false);
});

test('queue is single-concurrency and preserves FIFO order', async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const queue = new HarnessTaskQueue({
    runner: async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(input.request_id);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { final_response: input.intent };
    },
  });
  const first = queue.submit(request());
  const second = queue.submit(request({ request_id: 'request-2' }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  await queue.whenIdle();
  assert.equal(maximum, 1);
  assert.deepEqual(order, ['request-1', 'request-2']);
  assert.equal(queue.read(first.task.id, 'user-a').task.state, 'succeeded');
  assert.equal(queue.read(second.task.id, 'user-a').task.state, 'succeeded');
});

test('idempotent request replay never launches a duplicate task', async () => {
  let calls = 0;
  const queue = new HarnessTaskQueue({ runner: async () => { calls += 1; return { final_response: 'ok' }; } });
  const first = queue.submit(request());
  const replay = queue.submit(request());
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  await queue.whenIdle();
  assert.equal(calls, 1);
  assert.equal(queue.submit(request({ intent: 'different intent' })).code, 'IDEMPOTENCY_CONFLICT');
});

test('terminal idempotent replay does not require a new execution-lifetime window', async () => {
  let runs = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { runs += 1; return { final_response: 'durable result' }; },
    validateRuntimeContext: (context) => context?.fullWindow === true
      ? { ok: true }
      : { ok: false, code: 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON' },
  });
  const input = request({ request_id: 'terminal-replay' });
  const first = queue.submit(input, { fullWindow: true });
  assert.equal(first.ok, true);
  await queue.whenIdle();
  assert.equal(runs, 1);

  const replay = queue.submit(input, { fullWindow: false });
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.state, 'succeeded');
  assert.equal(replay.task.result.final_response, 'durable result');
  assert.equal(runs, 1);
});

test('idempotent replay wins over queue saturation', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new HarnessTaskQueue({ runner: async () => { await gate; return { final_response: 'ok' }; }, capacity: 1 });
  const first = queue.submit(request());
  await new Promise((resolve) => setImmediate(resolve));
  const replay = queue.submit(request());
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  release();
  await queue.whenIdle();
});

test('tasks are isolated by verified user identity', async () => {
  const queue = new HarnessTaskQueue({ runner: async () => ({ final_response: 'ok' }) });
  const submitted = queue.submit(request());
  assert.equal(queue.read(submitted.task.id, 'user-b').code, 'TASK_NOT_FOUND');
  assert.deepEqual(queue.list('user-b'), []);
  await queue.whenIdle();
});

test('delegated authorization is delivered only as ephemeral runner context and never persisted', async () => {
  const events = [];
  let observedContext;
  const delegatedAuthorization = `Bearer ${'z'.repeat(48)}`;
  const queue = new HarnessTaskQueue({
    runner: async (_input, _taskId, _signal, runtimeContext) => {
      observedContext = runtimeContext;
      return { final_response: 'ok' };
    },
    onEvent: (event) => events.push(event),
  });
  const submitted = queue.submit(request({ request_id: 'runtime-context-only' }), { delegatedAuthorization });
  assert.equal(JSON.stringify(submitted).includes(delegatedAuthorization), false);
  await queue.whenIdle();
  assert.deepEqual(observedContext, { delegatedAuthorization });
  assert.equal(JSON.stringify(events).includes(delegatedAuthorization), false);
  assert.equal(JSON.stringify(queue.read(submitted.task.id, 'user-a')).includes(delegatedAuthorization), false);
});

test('queued execution validates delegated JWT lifetime without persisting refresh credentials', async () => {
  const jwt = (expiresAt) => `Bearer a.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString('base64url')}.signature`;
  const now = 1786686000000;
  assert.equal(validateDelegatedAuthorization({ delegatedAuthorization: jwt(now + 800_000) }, { now, minimumValidityMs: 750_000 }).ok, true);
  assert.equal(validateDelegatedAuthorization({ delegatedAuthorization: jwt(now + 700_000) }, { now, minimumValidityMs: 750_000 }).code, 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON');
  assert.equal(validateDelegatedAuthorization({ delegatedAuthorization: 'Bearer opaque' }, { now }).code, 'DELEGATED_AUTHORIZATION_INVALID');

  let runs = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { runs += 1; return { final_response: 'ok' }; },
    validateRuntimeContext: (context) => validateDelegatedAuthorization(context, { now, minimumValidityMs: 750_000 }),
  });
  const rejected = queue.submit(request({ request_id: 'expiring-jwt' }), { delegatedAuthorization: jwt(now + 700_000) });
  assert.equal(rejected.code, 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON');
  assert.equal(runs, 0);
  assert.deepEqual(queue.list('user-a'), []);
});

test('queue rejects overflow and permits exact queued cancellation', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = new HarnessTaskQueue({ runner: async () => { await gate; return { final_response: 'ok' }; }, capacity: 2 });
  const active = queue.submit(request(), { delegatedAuthorization: 'Bearer active' });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = queue.submit(request({ request_id: 'request-2' }), { delegatedAuthorization: 'Bearer queued' });
  assert.equal(queue.status().delegated_contexts, 2);
  assert.equal(queue.submit(request({ request_id: 'request-3' })).code, 'QUEUE_FULL');
  const cancelled = queue.cancel(queued.task.id, 'user-a');
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(queue.status().delegated_contexts, 1, 'queued cancellation must erase its delegated credential immediately');
  const requested = queue.cancel(active.task.id, 'user-a');
  assert.equal(requested.cancellation_requested, true);
  release();
  await queue.whenIdle();
  assert.equal(queue.read(active.task.id, 'user-a').task.state, 'cancelled');
  assert.equal(queue.status().delegated_contexts, 0);
});

test('restart recovery fails interrupted tasks closed and preserves terminal results', async () => {
  const events = [];
  const base = request();
  const queue = new HarnessTaskQueue({
    runner: async () => ({ final_response: 'unused' }),
    onEvent: (event) => events.push(event),
    initialTasks: [
      { id: 'ht-00000000-0000-4000-8000-000000000001', state: 'running', created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:01.000Z', request: base, result: null, error: null },
      { id: 'ht-00000000-0000-4000-8000-000000000002', state: 'succeeded', created_at: '2026-08-14T00:00:00.000Z', updated_at: '2026-08-14T00:00:01.000Z', request: { ...base, request_id: 'request-2' }, result: { final_response: 'kept', artifact_refs: [] }, error: null },
    ],
  });
  const interrupted = queue.read('ht-00000000-0000-4000-8000-000000000001', 'user-a');
  const completed = queue.read('ht-00000000-0000-4000-8000-000000000002', 'user-a');
  assert.equal(interrupted.task.state, 'failed');
  assert.equal(interrupted.task.error.code, 'GATEWAY_RESTARTED');
  assert.equal(completed.task.state, 'succeeded');
  assert.equal(completed.task.result.final_response, 'kept');
  assert.equal(events.some((event) => event.event === 'recovered_failed' && event.task_id === interrupted.task.id), true);
});

test('restart recovery migrates legacy approval fingerprints before exact replay', () => {
  const legacyRequest = request({
    request_id: 'legacy-approval-fingerprint',
    approval: { paid_external_calls: false, online_writes: false },
  });
  const queue = new HarnessTaskQueue({
    runner: async () => ({ final_response: 'must not rerun' }),
    initialTasks: [{
      id: 'ht-00000000-0000-4000-8000-000000000003',
      state: 'succeeded',
      created_at: '2026-08-14T00:00:00.000Z',
      updated_at: '2026-08-14T00:00:01.000Z',
      request: legacyRequest,
      request_fingerprint: createHash('sha256').update(JSON.stringify(legacyRequest)).digest('hex'),
      result: { final_response: 'legacy durable result', artifact_refs: [] },
      error: null,
    }],
  });
  const replay = queue.submit(legacyRequest);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.result.final_response, 'legacy durable result');
  assert.deepEqual(replay.task.request.approval, {
    paid_external_calls: false,
    online_writes: false,
    handoff_creation: false,
  });
});

test('history and list results remain bounded', async () => {
  const events = [];
  const queue = new HarnessTaskQueue({ runner: async () => ({ final_response: 'ok' }), maxHistory: 2, onEvent: (event) => events.push(event) });
  for (let index = 0; index < 4; index += 1) {
    queue.submit(request({ request_id: `bounded-${index}` }));
    await queue.whenIdle();
  }
  assert.equal(queue.list('user-a', 100).length, 2);
  assert.equal(events.filter((event) => event.event === 'pruned').length, 2);
  assert.equal(queue.list('user-a', 1).length, 1);
  const summaries = queue.listSummaries('user-a', 100);
  assert.equal(summaries.length, 2);
  assert.equal(Object.hasOwn(summaries[0].result || {}, 'final_response'), false);
});

test('terminal responses are bounded by UTF-8 bytes for the Edge envelope', async () => {
  const queue = new HarnessTaskQueue({ runner: async () => ({ final_response: '中'.repeat(32_000) }) });
  const submitted = queue.submit(request({ request_id: 'utf8-result' }));
  assert.equal(submitted.ok, true);
  await queue.whenIdle();
  const completed = queue.read(submitted.task.id, submitted.task.request.user_id);
  assert.equal(completed.ok, true);
  assert.ok(Buffer.byteLength(completed.task.result.final_response, 'utf8') <= 12 * 1024);
  assert.doesNotMatch(completed.task.result.final_response, /\uFFFD/u);
});

test('audit persistence failure rejects submission without leaving an orphan task', () => {
  const queue = new HarnessTaskQueue({
    runner: async () => ({ final_response: 'never' }),
    onEvent: () => { throw new Error('disk unavailable'); },
  });
  const result = queue.submit(request({ request_id: 'audit-failure' }));
  assert.deepEqual(result, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' });
  assert.equal(queue.status().audit_healthy, false);
  assert.equal(queue.status().queued, 0);
  assert.deepEqual(queue.list('user-a'), []);
});

test('audit failure on running transition fails closed and stops queue execution', async () => {
  let eventCount = 0;
  let runs = 0;
  const queue = new HarnessTaskQueue({
    runner: async () => { runs += 1; return { final_response: 'must not run' }; },
    onEvent: () => {
      eventCount += 1;
      if (eventCount === 2) throw new Error('disk unavailable');
    },
  });
  const submitted = queue.submit(request({ request_id: 'running-audit-failure' }));
  assert.equal(submitted.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 0);
  assert.equal(queue.status().audit_healthy, false);
  const persistedFailure = queue.read(submitted.task.id, 'user-a').task;
  assert.equal(persistedFailure.state, 'failed');
  assert.equal(persistedFailure.error.code, 'AUDIT_PERSISTENCE_UNAVAILABLE');
});
