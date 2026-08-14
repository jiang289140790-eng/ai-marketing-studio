import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appendTaskEvent, loadTaskSnapshots } from '../state-store.mjs';

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
