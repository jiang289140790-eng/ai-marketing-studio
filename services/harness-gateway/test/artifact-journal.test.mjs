import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendTaskArtifactRefs, clearTaskArtifactRefs, consumeTaskArtifactRefs } from '../plugins/ams-tools/artifact-journal.mjs';

const taskId = 'ht-11111111-1111-4111-8111-111111111111';

test('tool artifact refs are task-bound, deduplicated, bounded and consumed without persistence', () => {
  const home = mkdtempSync(join(tmpdir(), 'ams-artifacts-'));
  try {
    appendTaskArtifactRefs(home, taskId, { artifact_refs: ['card-1', 'card-1', 'brief-1'] });
    appendTaskArtifactRefs(home, taskId, { artifact_refs: ['handoff-1'] });
    assert.deepEqual(consumeTaskArtifactRefs(home, taskId), ['card-1', 'brief-1', 'handoff-1']);
    assert.deepEqual(consumeTaskArtifactRefs(home, taskId), []);
    assert.throws(() => appendTaskArtifactRefs(home, '../escape', { artifact_refs: ['x'] }), (error) => error.code === 'TASK_ID_INVALID');
    clearTaskArtifactRefs(home, taskId);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('artifact journal contains only structured refs and no delegated credential', () => {
  const home = mkdtempSync(join(tmpdir(), 'ams-artifacts-'));
  try {
    appendTaskArtifactRefs(home, taskId, { artifact_refs: ['entity-1'], delegatedAuthorization: 'Bearer forbidden' });
    const raw = readFileSync(join(home, 'task-artifacts', `${taskId}.jsonl`), 'utf8');
    assert.equal(raw.includes('Bearer forbidden'), false);
    assert.deepEqual(consumeTaskArtifactRefs(home, taskId), ['entity-1']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
