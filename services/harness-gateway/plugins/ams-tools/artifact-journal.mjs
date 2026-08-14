import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { resolve, sep } from 'node:path';

const TASK_ID = /^ht-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 32 * 1024;
const MAX_REFS = 50;

function journalPath(home, taskId) {
  if (!TASK_ID.test(String(taskId || ''))) throw Object.assign(new Error('Task identity is invalid.'), { code: 'TASK_ID_INVALID' });
  const root = resolve(String(home || ''), 'task-artifacts');
  const file = resolve(root, `${taskId}.jsonl`);
  if (!file.startsWith(`${root}${sep}`)) throw Object.assign(new Error('Artifact path escaped its root.'), { code: 'ARTIFACT_PATH_INVALID' });
  return { root, file };
}

function boundedRefs(result) {
  return [...new Set((Array.isArray(result?.artifact_refs) ? result.artifact_refs : [])
    .map((value) => String(value || '').trim().slice(0, 500))
    .filter(Boolean))].slice(0, MAX_REFS);
}

export function appendTaskArtifactRefs(home, taskId, result) {
  const refs = boundedRefs(result);
  if (refs.length === 0) return;
  const { root, file } = journalPath(home, taskId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const current = (() => { try { return statSync(file).size; } catch { return 0; } })();
  const line = `${JSON.stringify({ artifact_refs: refs })}\n`;
  if (current + Buffer.byteLength(line, 'utf8') > MAX_BYTES) {
    throw Object.assign(new Error('Artifact journal exceeded its bounded size.'), { code: 'ARTIFACT_JOURNAL_TOO_LARGE' });
  }
  appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
}

export function consumeTaskArtifactRefs(home, taskId) {
  const { file } = journalPath(home, taskId);
  let raw = '';
  try {
    if (statSync(file).size > MAX_BYTES) throw Object.assign(new Error('Artifact journal exceeded its bounded size.'), { code: 'ARTIFACT_JOURNAL_TOO_LARGE' });
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  } finally {
    rmSync(file, { force: true });
  }
  const refs = [];
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const parsed = JSON.parse(line);
    refs.push(...boundedRefs(parsed));
  }
  return [...new Set(refs)].slice(0, MAX_REFS);
}

export function clearTaskArtifactRefs(home, taskId) {
  const { file } = journalPath(home, taskId);
  rmSync(file, { force: true });
}
