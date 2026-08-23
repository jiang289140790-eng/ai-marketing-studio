/* global Buffer, structuredClone */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// A task snapshot can legitimately carry the bounded 12k-character intent in
// both request and plan, plus a bounded 64 KiB structured result and its
// presentation. Keep one hard, finite audit-line ceiling that covers that
// complete valid envelope without turning the append log into an unbounded
// persistence channel.
const MAX_LINE_BYTES = 512 * 1024;
const MAX_RESUME_FILE_BYTES = 2 * 1024 * 1024;
const RESUME_SCHEMA_VERSION = 'ams_harness_resume_store_v1';
const RESUME_REF_SCHEMA_VERSION = 'ams_harness_resume_ref_v1';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resumeDirectory(path) {
  return `${path}.resume`;
}

function resumeTaskDirectory(path, taskId) {
  return join(resumeDirectory(path), sha256(String(taskId)));
}

function resumePath(path, taskId, storeHash) {
  return join(resumeTaskDirectory(path, taskId), `${storeHash}.json`);
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function writeResumeStore(path, taskId, entries) {
  const body = JSON.stringify({ schema_version: RESUME_SCHEMA_VERSION, task_id: taskId, entries });
  const bytes = Buffer.byteLength(body);
  if (bytes > MAX_RESUME_FILE_BYTES) {
    throw Object.assign(new Error('Task retry context exceeds the persistence bound.'), { code: 'RETRY_CONTEXT_TOO_LARGE' });
  }
  const storeHash = sha256(body);
  const directory = resumeTaskDirectory(path, taskId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = resumePath(path, taskId, storeHash);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, body, { encoding: 'utf8', flush: true, mode: 0o600 });
  renameSync(temporary, target);
  return storeHash;
}

function externalizeResumeOutputs(path, event) {
  if (!isObject(event?.task) || !isObject(event.task.step_states)) return { event, storeHash: null };
  const persisted = structuredClone(event);
  const entries = {};
  for (const [stepId, state] of Object.entries(persisted.task.step_states)) {
    if (!isObject(state) || !isObject(state.resume_output)) continue;
    entries[stepId] = state.resume_output;
  }
  if (Object.keys(entries).length === 0) return { event: persisted, storeHash: null };
  const storeHash = writeResumeStore(path, persisted.task.id, entries);
  for (const [stepId, state] of Object.entries(persisted.task.step_states)) {
    if (!isObject(state) || !isObject(state.resume_output)) continue;
    const body = JSON.stringify(state.resume_output);
    const bytes = Buffer.byteLength(body);
    const digest = sha256(body);
    delete state.resume_output;
    state.resume_ref = {
      schema_version: RESUME_REF_SCHEMA_VERSION,
      task_id: persisted.task.id,
      step_id: stepId,
      store_sha256: storeHash,
      sha256: digest,
      bytes,
    };
  }
  return { event: persisted, storeHash };
}

function markResumeContextUnavailable(task) {
  if (!isObject(task)) return task;
  task.state = 'failed';
  task.error = {
    code: 'RETRY_CONTEXT_UNAVAILABLE',
    message: 'A persisted paid-step result could not be restored safely; retry is disabled to prevent duplicate cost.',
    retry_unsafe: true,
  };
  for (const state of Object.values(task.step_states || {})) {
    if (isObject(state) && state.state === 'failed') {
      state.error = { ...(isObject(state.error) ? state.error : {}), code: 'RETRY_CONTEXT_UNAVAILABLE', retry_unsafe: true };
    }
  }
  return task;
}

function hydrateResumeOutputs(path, task) {
  const refs = Object.entries(task?.step_states || {}).filter(([, state]) => isObject(state?.resume_ref));
  if (refs.length === 0) return task;
  try {
    const storeHashes = new Set(refs.map(([, state]) => state.resume_ref.store_sha256));
    if (storeHashes.size !== 1 || !/^[a-f0-9]{64}$/.test([...storeHashes][0] || '')) return markResumeContextUnavailable(task);
    const storeHash = [...storeHashes][0];
    const target = resumePath(path, task.id, storeHash);
    const raw = readFileSync(target, 'utf8');
    if (Buffer.byteLength(raw) > MAX_RESUME_FILE_BYTES) return markResumeContextUnavailable(task);
    if (sha256(raw) !== storeHash) return markResumeContextUnavailable(task);
    const store = JSON.parse(raw);
    if (store?.schema_version !== RESUME_SCHEMA_VERSION || store?.task_id !== task.id || !isObject(store.entries)) {
      return markResumeContextUnavailable(task);
    }
    for (const [stepId, state] of refs) {
      const ref = state.resume_ref;
      const output = store.entries[stepId];
      if (ref.schema_version !== RESUME_REF_SCHEMA_VERSION || ref.task_id !== task.id || ref.step_id !== stepId || !isObject(output)) {
        return markResumeContextUnavailable(task);
      }
      const body = JSON.stringify(output);
      if (Buffer.byteLength(body) !== ref.bytes || sha256(body) !== ref.sha256) return markResumeContextUnavailable(task);
      state.resume_output = output;
      delete state.resume_ref;
    }
    return task;
  } catch {
    return markResumeContextUnavailable(task);
  }
}

export async function loadTaskSnapshots(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const latest = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
    try {
      const event = JSON.parse(line);
      if (event?.event === 'pruned' && event.task_id) latest.delete(event.task_id);
      else if (event?.task?.id && event.task_id === event.task.id) latest.set(event.task.id, event.task);
    } catch {
      // A torn final append is ignored; previous complete snapshots remain authoritative.
    }
  }
  return [...latest.values()].map((task) => hydrateResumeOutputs(path, task));
}

export async function loadTaskEvents(path) {
  if (!existsSync(path)) return [];
  const events = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.task_id && event?.at && event?.user_id && event?.task) events.push(event);
    } catch {
      // Ignore only a torn final record; appendTaskEvent writes one bounded line atomically.
    }
  }
  return events;
}

export function appendTaskEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const externalized = externalizeResumeOutputs(path, event);
  const line = JSON.stringify(externalized.event);
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw Object.assign(new Error('Task event exceeds the persistence bound.'), { code: 'EVENT_TOO_LARGE' });
  appendFileSync(path, `${line}\n`, { encoding: 'utf8', flush: true });
  if (event?.event === 'pruned' && event.task_id) {
    try {
      rmSync(resumeTaskDirectory(path, event.task_id), { recursive: true, force: true });
    } catch {
      // The prune tombstone is authoritative; stale local retry blobs are inert.
    }
  } else if (externalized.storeHash && event?.task?.id) {
    try {
      const directory = resumeTaskDirectory(path, event.task.id);
      for (const name of readdirSync(directory)) {
        if (name !== `${externalized.storeHash}.json`) unlinkSync(join(directory, name));
      }
    } catch {
      // Cleanup is best-effort after the authoritative event is durable.
    }
  }
}
