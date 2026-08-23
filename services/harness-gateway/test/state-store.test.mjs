import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendTaskEvent, loadTaskEvents, loadTaskSnapshots } from '../state-store.mjs';

test('durable event log reloads every unacknowledged projection candidate after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-event-replay-'));
  const file = join(directory, 'events.jsonl');
  try {
    const base = { task_id: 'ht-00000000-0000-4000-8000-000000000099', user_id: 'user-a', request_id: 'request-a' };
    appendTaskEvent(file, { ...base, event: 'planned', at: '2026-08-23T10:00:00Z', task: { id: base.task_id, state: 'planned' } });
    appendTaskEvent(file, { ...base, event: 'step_state', at: '2026-08-23T10:00:01Z', task: { id: base.task_id, state: 'running' } });
    assert.deepEqual((await loadTaskEvents(file)).map((event) => event.event), ['planned', 'step_state']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('append-only snapshots recover the latest complete task state and ignore a torn tail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-state-'));
  const file = join(directory, 'events.jsonl');
  try {
    const task = { id: 'ht-00000000-0000-4000-8000-000000000003', state: 'queued' };
    appendTaskEvent(file, { task_id: task.id, task });
    appendTaskEvent(file, { task_id: task.id, task: { ...task, state: 'succeeded', result: { final_response: 'done' } } });
    appendTaskEvent(file, { event: 'pruned', task_id: 'ht-absent', task: null });
    const current = await readFile(file, 'utf8');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(file, `${current}{"torn":`, 'utf8'));
    const recovered = await loadTaskSnapshots(file);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, 'succeeded');
    assert.equal(recovered[0].result.final_response, 'done');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a durable prune tombstone removes the recovered task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-prune-'));
  const file = join(directory, 'events.jsonl');
  try {
    const task = { id: 'ht-00000000-0000-4000-8000-000000000004', state: 'succeeded' };
    appendTaskEvent(file, { task_id: task.id, task });
    appendTaskEvent(file, { event: 'pruned', task_id: task.id, task: null });
    assert.deepEqual(await loadTaskSnapshots(file), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('large bounded retry outputs are externalized below the audit line limit and restored exactly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-resume-'));
  const file = join(directory, 'events.jsonl');
  try {
    const task = {
      id: 'ht-00000000-0000-4000-8000-000000000005',
      state: 'partial',
      step_states: {
        'st-search-x': {
          state: 'succeeded',
          resume_output: { search_x_items: [{ content_text: 'x'.repeat(90 * 1024) }] },
        },
        'st-search-reddit': {
          state: 'succeeded',
          resume_output: { search_reddit_items: [{ content_text: 'r'.repeat(90 * 1024) }] },
        },
        'st-save': { state: 'failed', error: { code: 'ENTITY_REVISION_STALE' } },
      },
    };
    appendTaskEvent(file, { task_id: task.id, task });
    const persistedLine = (await readFile(file, 'utf8')).trim();
    assert.ok(Buffer.byteLength(persistedLine) < 512 * 1024, 'the audit event remains inside the exact 512 KiB line bound');
    assert.equal(persistedLine.includes('x'.repeat(1024)), false, 'large retry bodies are not duplicated into the audit log');
    const [recovered] = await loadTaskSnapshots(file);
    assert.deepEqual(recovered.step_states['st-search-x'].resume_output, task.step_states['st-search-x'].resume_output);
    assert.deepEqual(recovered.step_states['st-search-reddit'].resume_output, task.step_states['st-search-reddit'].resume_output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a maximum bounded multilingual intent and structured result persist without poisoning the audit log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-valid-large-event-'));
  const file = join(directory, 'events.jsonl');
  try {
    const intent = '汉'.repeat(12_000);
    const task = {
      id: 'ht-00000000-0000-4000-8000-000000000007',
      state: 'succeeded',
      request: { request_id: 'large-valid', user_id: 'user-a', project_id: null, intent },
      plan: { intent, steps: [], slots: {}, fingerprint: 'a'.repeat(64) },
      step_states: {},
      result: {
        final_response: '完成',
        artifact_refs: [],
        presentation: null,
        result_data: { payload: 'x'.repeat(64 * 1024) },
      },
    };
    appendTaskEvent(file, { event: 'succeeded', task_id: task.id, task });
    const persistedLine = (await readFile(file, 'utf8')).trim();
    assert.ok(Buffer.byteLength(persistedLine) > 128 * 1024, 'the regression fixture crosses the obsolete 128 KiB ceiling');
    assert.ok(Buffer.byteLength(persistedLine) < 512 * 1024, 'the complete valid snapshot remains bounded');
    const [recovered] = await loadTaskSnapshots(file);
    assert.equal(recovered.id, task.id);
    assert.equal(recovered.result.result_data.payload.length, 64 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('audit events above the finite 512 KiB ceiling still fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-oversized-event-'));
  const file = join(directory, 'events.jsonl');
  try {
    const task = {
      id: 'ht-00000000-0000-4000-8000-000000000008',
      state: 'succeeded',
      result: { result_data: { payload: 'x'.repeat(513 * 1024) } },
    };
    assert.throws(
      () => appendTaskEvent(file, { event: 'succeeded', task_id: task.id, task }),
      (error) => error?.code === 'EVENT_TOO_LARGE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('append-only audit retains every transition beyond the former 8 MiB compaction boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-long-audit-'));
  const file = join(directory, 'events.jsonl');
  try {
    const payload = 'x'.repeat(400 * 1024);
    for (let index = 0; index < 22; index += 1) {
      const task = { id: 'ht-00000000-0000-4000-8000-000000000009', state: 'running', sequence: index, result: { result_data: { payload } } };
      appendTaskEvent(file, { event: `step-${index}`, task_id: task.id, user_id: 'user-a', at: `2026-08-23T10:00:${String(index).padStart(2, '0')}.000Z`, task });
    }
    const events = await loadTaskEvents(file);
    assert.equal(events.length, 22);
    assert.deepEqual(events.map((item) => item.event), Array.from({ length: 22 }, (_, index) => `step-${index}`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing retry sidecar fails closed and disables retry instead of losing a paid result silently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ams-harness-resume-missing-'));
  const file = join(directory, 'events.jsonl');
  try {
    const task = {
      id: 'ht-00000000-0000-4000-8000-000000000006',
      state: 'partial',
      step_states: {
        paid: { state: 'succeeded', resume_output: { items: [{ content_text: 'paid result' }] } },
        write: { state: 'failed', error: { code: 'ENTITY_REVISION_STALE' } },
      },
    };
    appendTaskEvent(file, { task_id: task.id, task });
    await rm(`${file}.resume`, { recursive: true, force: true });
    const [recovered] = await loadTaskSnapshots(file);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.error.code, 'RETRY_CONTEXT_UNAVAILABLE');
    assert.equal(recovered.error.retry_unsafe, true);
    assert.equal(recovered.step_states.write.error.retry_unsafe, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
