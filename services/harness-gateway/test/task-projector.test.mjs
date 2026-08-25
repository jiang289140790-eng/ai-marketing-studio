/* global setTimeout */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskProjector } from '../task-projector.mjs';

const secret = 's'.repeat(32);
const event = {
  event_id: 'gev_00000000-0000-4000-8000-000000000001',
  task_id: 'ht-00000000-0000-4000-8000-000000000201', user_id: '00000000-0000-4000-8000-000000000101',
  at: '2026-08-23T10:00:00.000Z', event: 'succeeded',
  task: { id: 'ht-00000000-0000-4000-8000-000000000201', state: 'succeeded', request: { project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa' } },
};
const binding = {
  user_id: event.user_id,
  thread_id: 'thr_00000000-0000-4000-8000-000000000301',
  project_id: event.task.request.project_id,
};

test('durable projector retries a failed callback and acknowledges exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ams-projector-'));
  const ackFile = join(directory, 'acks.log');
  let calls = 0;
  try {
    const projector = createTaskProjector({
      callbackBase: 'https://staging.example.test', secret, ackFile, retryMs: 5,
      fetchImpl: async (_url, options) => {
        calls += 1;
        assert.equal(options.headers['x-ams-user-id'], event.user_id);
        assert.match(options.headers['x-ams-signature'], /^[0-9a-f]{64}$/);
        return { ok: calls > 1 };
      },
    });
    projector.enqueue(event);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(projector.pendingCount(), 0);
    assert.equal(calls, 2);
    assert.equal(readFileSync(ackFile, 'utf8').trim().split('\n').length, 1);
    projector.close();

    const restarted = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, ackFile, fetchImpl: async () => { calls += 1; return { ok: true }; } });
    assert.equal(restarted.enqueue(event), false, 'restart reloads the durable acknowledgement');
    await restarted.drain();
    assert.equal(calls, 2, 'acknowledged event is never projected twice after restart');
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('different task transitions remain distinct but duplicate enqueue is coalesced', async () => {
  let calls = 0;
  const projector = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, fetchImpl: async () => { calls += 1; return { ok: true }; } });
  assert.equal(projector.enqueue(event), true);
  assert.equal(projector.enqueue(event), false);
  assert.equal(projector.enqueue({ ...event, event_id: 'gev_00000000-0000-4000-8000-000000000002', event: 'step_state' }), true);
  await projector.drain();
  assert.equal(calls, 2);
  projector.close();
});

test('an unacknowledged durable event is replayed after process restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ams-projector-restart-'));
  const ackFile = join(directory, 'acks.log');
  let calls = 0;
  try {
    const first = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, ackFile, retryMs: 60_000, fetchImpl: async () => { calls += 1; return { ok: false }; } });
    first.enqueue(event);
    await first.drain();
    assert.equal(first.pendingCount(), 1);
    first.close();

    const restarted = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, ackFile, fetchImpl: async () => { calls += 1; return { ok: true }; } });
    assert.equal(restarted.enqueue(event), true, 'server replays the durable Gateway event log on restart');
    await restarted.drain();
    assert.equal(restarted.pendingCount(), 0);
    assert.equal(calls, 2);
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('same-millisecond step transitions keep distinct durable ACK identities across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ams-projector-same-ms-'));
  const ackFile = join(directory, 'acks.log');
  const firstStep = { ...event, event_id: 'gev_00000000-0000-4000-8000-000000000011', event: 'step_state', task: { ...event.task, step: 'st-1' } };
  const secondStep = { ...event, event_id: 'gev_00000000-0000-4000-8000-000000000012', event: 'step_state', task: { ...event.task, step: 'st-2' } };
  const projected = [];
  try {
    const first = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, ackFile, fetchImpl: async (_url, options) => { projected.push(JSON.parse(options.body).event.event_id); return { ok: projected.length === 1 }; } });
    first.enqueue(firstStep);
    first.enqueue(secondStep);
    await first.drain();
    assert.equal(first.pendingCount(), 1);
    first.close();

    const restarted = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, ackFile, fetchImpl: async (_url, options) => { projected.push(JSON.parse(options.body).event.event_id); return { ok: true }; } });
    assert.equal(restarted.enqueue(firstStep), false);
    assert.equal(restarted.enqueue(secondStep), true);
    await restarted.drain();
    assert.deepEqual(projected, [firstStep.event_id, secondStep.event_id, secondStep.event_id]);
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('conversation task projection carries one immutable user/thread/task/project binding', async () => {
  const bodies = [];
  const projector = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return { ok: true };
  } });
  assert.equal(projector.enqueue(event), true);
  assert.equal(projector.bindTask(event.task_id, binding), true);
  assert.equal(projector.bindTask(event.task_id, binding), true, 'an exact replay is idempotent');
  assert.equal(projector.bindTask(event.task_id, { ...binding, thread_id: 'thr_00000000-0000-4000-8000-000000000302' }), false, 'identity mutation fails closed');
  await projector.drain();
  assert.deepEqual(bodies[0].binding, { ...binding, task_id: event.task_id });
  assert.equal(bodies[0].event.task.request.project_id, binding.project_id);
  projector.close();
});

test('terminal thread binding rejection is acknowledged once and cannot create a 409 retry storm', async () => {
  let calls = 0;
  const projector = createTaskProjector({ callbackBase: 'https://staging.example.test', secret, retryMs: 5, fetchImpl: async () => {
    calls += 1;
    return { ok: false, status: 409, json: async () => ({ ok: false, code: 'THREAD_NOT_BOUND' }) };
  } });
  projector.bindTask(event.task_id, binding);
  assert.equal(projector.enqueue(event), true);
  await projector.drain();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(projector.pendingCount(), 0);
  assert.equal(calls, 1);
  assert.equal(projector.enqueue(event), false, 'duplicate delivery remains acknowledged');
  projector.close();
});
