/* global AbortController, Buffer, queueMicrotask, setTimeout, structuredClone */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const GATEWAY_SCHEMA_VERSION = 'ams_harness_gateway_v1';
export const TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const TASK_ID = /^ht-[0-9a-f-]{36}$/;
const MAX_PROMPT = 12_000;
const MAX_RESULT = 32_000;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function bounded(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function validateTaskRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, code: 'INVALID_REQUEST' };
  const allowed = new Set(['schema_version', 'request_id', 'user_id', 'project_id', 'intent', 'approval']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return { ok: false, code: 'UNKNOWN_FIELD' };
  if (input.schema_version !== GATEWAY_SCHEMA_VERSION) return { ok: false, code: 'SCHEMA_VERSION_MISMATCH' };
  for (const key of ['request_id', 'user_id', 'intent']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) return { ok: false, code: `${key.toUpperCase()}_INVALID` };
  }
  if (input.request_id.length > 200 || input.user_id.length > 200) return { ok: false, code: 'IDENTITY_TOO_LONG' };
  if (input.intent.length > MAX_PROMPT) return { ok: false, code: 'INTENT_TOO_LONG' };
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.length > 200)) {
    return { ok: false, code: 'PROJECT_ID_INVALID' };
  }
  const approval = input.approval == null ? { paid_external_calls: false, online_writes: false } : input.approval;
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return { ok: false, code: 'APPROVAL_INVALID' };
  const approvalAllowed = new Set(['paid_external_calls', 'online_writes']);
  if (Object.keys(approval).some((key) => !approvalAllowed.has(key))) return { ok: false, code: 'APPROVAL_UNKNOWN_FIELD' };
  for (const key of approvalAllowed) if (approval[key] != null && typeof approval[key] !== 'boolean') return { ok: false, code: 'APPROVAL_INVALID' };
  return {
    ok: true,
    value: {
      schema_version: GATEWAY_SCHEMA_VERSION,
      request_id: input.request_id.trim(),
      user_id: input.user_id.trim(),
      project_id: input.project_id?.trim() || null,
      intent: input.intent.trim(),
      approval: {
        paid_external_calls: approval.paid_external_calls === true,
        online_writes: approval.online_writes === true,
      },
    },
  };
}

export function signRequest(secret, { method, path, userId, timestamp, rawBody }) {
  return createHmac('sha256', secret)
    .update(`${String(method).toUpperCase()}\n${path}\n${userId}\n${timestamp}\n${rawBody}`)
    .digest('hex');
}

export function verifySignedRequest({ secret, method, path, userId, timestamp, signature, rawBody, now = Date.now(), maxSkewMs = 60_000 }) {
  if (typeof secret !== 'string' || secret.length < 32 || !method || !path || !userId || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) return false;
  const expected = signRequest(secret, { method, path, userId, timestamp, rawBody });
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export class HarnessTaskQueue {
  #tasks = new Map();
  #pending = [];
  #active = 0;
  #runner;
  #capacity;
  #concurrency;
  #onEvent;
  #controllers = new Map();
  #maxHistory;
  #auditError = null;

  constructor({ runner, capacity = 10, concurrency = 1, maxHistory = 200, onEvent = () => {}, initialTasks = [] }) {
    if (typeof runner !== 'function') throw new TypeError('runner is required');
    if (concurrency !== 1) throw new RangeError('initial gateway concurrency must equal one');
    this.#runner = runner;
    this.#capacity = capacity;
    this.#concurrency = concurrency;
    this.#maxHistory = maxHistory;
    this.#onEvent = onEvent;
    for (const candidate of initialTasks) {
      if (!candidate || !TASK_ID.test(candidate.id) || !TASK_STATES.includes(candidate.state)) continue;
      const validated = validateTaskRequest(candidate.request);
      if (!validated.ok) continue;
      const task = clone({ ...candidate, request: validated.value });
      if (task.state === 'queued' || task.state === 'running') {
        task.state = 'failed';
        task.updated_at = new Date().toISOString();
        task.error = { code: 'GATEWAY_RESTARTED', message: 'Gateway restarted before the task reached a durable terminal state.' };
      }
      this.#tasks.set(task.id, task);
      if (task.error?.code === 'GATEWAY_RESTARTED') this.#emit(task, 'recovered_failed');
    }
    this.#pruneHistory();
  }

  submit(request) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const validated = validateTaskRequest(request);
    if (!validated.ok) return validated;
    const existing = [...this.#tasks.values()].find((task) => task.request.request_id === validated.value.request_id && task.request.user_id === validated.value.user_id);
    const requestFingerprint = createHash('sha256').update(JSON.stringify(validated.value)).digest('hex');
    if (existing) {
      const existingFingerprint = existing.request_fingerprint || createHash('sha256').update(JSON.stringify(existing.request)).digest('hex');
      if (existingFingerprint !== requestFingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      return { ok: true, replayed: true, task: clone(existing) };
    }
    if (this.#pending.length + this.#active >= this.#capacity) return { ok: false, code: 'QUEUE_FULL' };
    const now = new Date().toISOString();
    const task = {
      id: `ht-${randomUUID()}`,
      state: 'queued',
      created_at: now,
      updated_at: now,
      request: validated.value,
      request_fingerprint: requestFingerprint,
      result: null,
      error: null,
    };
    this.#tasks.set(task.id, task);
    this.#pending.push(task.id);
    try {
      this.#emit(task, 'queued');
    } catch {
      this.#tasks.delete(task.id);
      this.#pending = this.#pending.filter((id) => id !== task.id);
      return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    }
    queueMicrotask(() => this.#drain());
    return { ok: true, replayed: false, task: clone(task) };
  }

  read(taskId, userId) {
    if (!TASK_ID.test(taskId)) return { ok: false, code: 'TASK_ID_INVALID' };
    const task = this.#tasks.get(taskId);
    if (!task || task.request.user_id !== userId) return { ok: false, code: 'TASK_NOT_FOUND' };
    return { ok: true, task: clone(task) };
  }

  list(userId, limit = 50) {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    return [...this.#tasks.values()]
      .filter((task) => task.request.user_id === userId)
      .map(clone)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, safeLimit);
  }

  cancel(taskId, userId) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const found = this.read(taskId, userId);
    if (!found.ok) return found;
    const task = this.#tasks.get(taskId);
    if (TERMINAL.has(task.state)) return { ok: true, task: clone(task), unchanged: true };
    if (task.state === 'running') {
      const controller = this.#controllers.get(taskId);
      if (!controller) return { ok: false, code: 'ACTIVE_CANCEL_UNAVAILABLE' };
      controller.abort();
      return { ok: true, task: clone(task), cancellation_requested: true };
    }
    try {
      this.#transition(task, 'cancelled');
    } catch {
      return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    }
    this.#pending = this.#pending.filter((id) => id !== taskId);
    return { ok: true, task: clone(task), unchanged: false };
  }

  status() {
    return { active: this.#active, queued: this.#pending.length, capacity: this.#capacity, concurrency: this.#concurrency, audit_healthy: !this.#auditError };
  }

  shutdown() {
    for (const taskId of [...this.#pending]) {
      const task = this.#tasks.get(taskId);
      if (task?.state === 'queued') {
        try {
          this.#transition(task, 'cancelled');
        } catch {
          task.state = 'cancelled';
          task.updated_at = new Date().toISOString();
          task.error = { code: 'AUDIT_PERSISTENCE_UNAVAILABLE', message: 'Gateway stopped after audit persistence became unavailable.' };
        }
      }
    }
    this.#pending = [];
    for (const controller of this.#controllers.values()) controller.abort();
  }

  async whenIdle() {
    while (this.#active > 0 || this.#pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  async #drain() {
    if (this.#active >= this.#concurrency) return;
    const taskId = this.#pending.shift();
    if (!taskId) return;
    const task = this.#tasks.get(taskId);
    if (!task || task.state !== 'queued') return this.#drain();
    this.#active += 1;
    const controller = new AbortController();
    this.#controllers.set(task.id, controller);
    try {
      this.#transition(task, 'running');
      const output = await this.#runner(clone(task.request), task.id, controller.signal);
      if (controller.signal.aborted) {
        this.#transition(task, 'cancelled');
        return;
      }
      task.result = {
        final_response: bounded(output?.final_response, MAX_RESULT),
        artifact_refs: Array.isArray(output?.artifact_refs) ? output.artifact_refs.slice(0, 50).map((value) => bounded(value, 500)) : [],
      };
      this.#transition(task, 'succeeded');
    } catch (error) {
      if (error?.code === 'AUDIT_PERSISTENCE_UNAVAILABLE') {
        task.result = null;
        task.state = 'failed';
        task.updated_at = new Date().toISOString();
        task.error = { code: 'AUDIT_PERSISTENCE_UNAVAILABLE', message: 'Task stopped because its audit state could not be persisted.' };
      } else {
        task.error = controller.signal.aborted
          ? null
          : { code: bounded(error?.code || 'HARNESS_FAILED', 80), message: bounded(error?.message || 'Harness task failed.', 500) };
        try {
          this.#transition(task, controller.signal.aborted ? 'cancelled' : 'failed');
        } catch {
          task.result = null;
          task.state = 'failed';
          task.updated_at = new Date().toISOString();
          task.error = { code: 'AUDIT_PERSISTENCE_UNAVAILABLE', message: 'Task stopped because its terminal audit state could not be persisted.' };
        }
      }
    } finally {
      this.#controllers.delete(task.id);
      this.#active -= 1;
      this.#pruneHistory();
      if (!this.#auditError) queueMicrotask(() => this.#drain());
    }
  }

  #transition(task, state) {
    const previous = clone(task);
    task.state = state;
    task.updated_at = new Date().toISOString();
    try {
      this.#emit(task, state);
    } catch (error) {
      Object.assign(task, previous);
      throw error;
    }
  }

  #emit(task, event) {
    try {
      this.#onEvent({ schema_version: GATEWAY_SCHEMA_VERSION, event, task_id: task.id, state: task.state, at: task.updated_at, user_id: task.request.user_id, request_id: task.request.request_id, task: clone(task) });
    } catch (cause) {
      this.#auditError = cause;
      throw Object.assign(new Error('Audit persistence is unavailable.'), { code: 'AUDIT_PERSISTENCE_UNAVAILABLE', cause });
    }
  }

  #pruneHistory() {
    const terminal = [...this.#tasks.values()]
      .filter((task) => TERMINAL.has(task.state))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    for (const task of terminal.slice(this.#maxHistory)) {
      this.#tasks.delete(task.id);
      try {
        this.#onEvent({ schema_version: GATEWAY_SCHEMA_VERSION, event: 'pruned', task_id: task.id, state: task.state, at: new Date().toISOString(), user_id: task.request.user_id, request_id: task.request.request_id, task: null });
      } catch (cause) {
        this.#tasks.set(task.id, task);
        this.#auditError = cause;
        break;
      }
    }
  }
}
