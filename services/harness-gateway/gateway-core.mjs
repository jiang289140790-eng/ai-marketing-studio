/* global AbortController, Buffer, queueMicrotask, setTimeout, structuredClone */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const GATEWAY_SCHEMA_VERSION = 'ams_harness_gateway_v1';
export const TASK_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const TASK_ID = /^ht-[0-9a-f-]{36}$/;
const MAX_PROMPT = 12_000;
const MAX_RESULT_BYTES = 12 * 1024;

function boundedUtf8(value, maxBytes) {
  const text = String(value ?? '');
  const source = Buffer.from(text, 'utf8');
  if (source.length <= maxBytes) return text;
  return source.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '');
}

export function validateDelegatedAuthorization(runtimeContext, { now = Date.now(), minimumValidityMs = 0 } = {}) {
  const authorization = runtimeContext?.delegatedAuthorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' };
  const token = authorization.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, code: 'DELEGATED_AUTHORIZATION_INVALID' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const expiresAt = Number(payload?.exp) * 1000;
    if (!Number.isSafeInteger(expiresAt)) return { ok: false, code: 'DELEGATED_AUTHORIZATION_INVALID' };
    if (expiresAt - now < minimumValidityMs) return { ok: false, code: 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON' };
    return { ok: true, expires_at: expiresAt };
  } catch {
    return { ok: false, code: 'DELEGATED_AUTHORIZATION_INVALID' };
  }
}

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
  const approvalAllowed = new Set(['paid_external_calls', 'online_writes', 'handoff_creation']);
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
        handoff_creation: approval.handoff_creation === true,
      },
    },
  };
}

export function signRequest(secret, { method, path, userId, timestamp, rawBody, authorizationDigest = '' }) {
  return createHmac('sha256', secret)
    .update(`${String(method).toUpperCase()}\n${path}\n${userId}\n${timestamp}\n${authorizationDigest}\n${rawBody}`)
    .digest('hex');
}

export function verifySignedRequest({ secret, method, path, userId, timestamp, signature, rawBody, authorizationDigest = '', now = Date.now(), maxSkewMs = 60_000 }) {
  if (typeof secret !== 'string' || secret.length < 32 || !method || !path || !userId || typeof timestamp !== 'string' || !/^\d{13}$/.test(timestamp) || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) return false;
  if (authorizationDigest && !/^[0-9a-f]{64}$/.test(authorizationDigest)) return false;
  const expected = signRequest(secret, { method, path, userId, timestamp, rawBody, authorizationDigest });
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
  #runtimeContexts = new Map();
  #maxHistory;
  #auditError = null;
  #validateRuntimeContext;

  constructor({ runner, capacity = 10, concurrency = 1, maxHistory = 200, onEvent = () => {}, initialTasks = [], validateRuntimeContext = () => ({ ok: true }) }) {
    if (typeof runner !== 'function') throw new TypeError('runner is required');
    if (concurrency !== 1) throw new RangeError('initial gateway concurrency must equal one');
    this.#runner = runner;
    this.#capacity = capacity;
    this.#concurrency = concurrency;
    this.#maxHistory = maxHistory;
    this.#onEvent = onEvent;
    this.#validateRuntimeContext = validateRuntimeContext;
    for (const candidate of initialTasks) {
      if (!candidate || !TASK_ID.test(candidate.id) || !TASK_STATES.includes(candidate.state)) continue;
      const validated = validateTaskRequest(candidate.request);
      if (!validated.ok) continue;
      const task = clone({ ...candidate, request: validated.value });
      // Persisted snapshots may predate newly defaulted envelope fields. Never
      // trust a historical fingerprint after normalization: migrate it to the
      // exact current request shape so a post-upgrade exact replay stays valid.
      task.request_fingerprint = createHash('sha256').update(JSON.stringify(validated.value)).digest('hex');
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

  submit(request, runtimeContext = null) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const validated = validateTaskRequest(request);
    if (!validated.ok) return validated;
    const existing = [...this.#tasks.values()].find((task) => task.request.request_id === validated.value.request_id && task.request.user_id === validated.value.user_id);
    const requestFingerprint = createHash('sha256').update(JSON.stringify(validated.value)).digest('hex');
    if (existing) {
      const existingFingerprint = existing.request_fingerprint || createHash('sha256').update(JSON.stringify(existing.request)).digest('hex');
      if (existingFingerprint !== requestFingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      // A terminal replay performs no delegated operation and therefore does
      // not require a fresh full execution window. The authenticated envelope
      // identity and exact request fingerprint are still validated above.
      if (TERMINAL.has(existing.state)) return { ok: true, replayed: true, task: clone(existing) };
      const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'submit', position: this.#pending.length + this.#active });
      if (!runtimeCheck?.ok) return { ok: false, code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' };
      if (!TERMINAL.has(existing.state) && runtimeContext) this.#runtimeContexts.set(existing.id, runtimeContext);
      return { ok: true, replayed: true, task: clone(existing) };
    }
    const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'submit', position: this.#pending.length + this.#active });
    if (!runtimeCheck?.ok) return { ok: false, code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' };
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
    if (runtimeContext) this.#runtimeContexts.set(task.id, runtimeContext);
    this.#pending.push(task.id);
    try {
      this.#emit(task, 'queued');
    } catch {
      this.#tasks.delete(task.id);
      this.#runtimeContexts.delete(task.id);
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

  listSummaries(userId, limit = 30) {
    return this.list(userId, Math.min(30, limit)).map((task) => ({
      id: task.id,
      state: task.state,
      created_at: task.created_at,
      updated_at: task.updated_at,
      request: {
        request_id: bounded(task.request?.request_id, 200),
        intent: bounded(task.request?.intent, 500),
        project_id: task.request?.project_id || null,
      },
      result: task.result ? { artifact_refs: task.result.artifact_refs.slice(0, 10) } : null,
      error: task.error ? { code: bounded(task.error.code, 80), message: bounded(task.error.message, 240) } : null,
    }));
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
    this.#runtimeContexts.delete(taskId);
    return { ok: true, task: clone(task), unchanged: false };
  }

  status() {
    return { active: this.#active, queued: this.#pending.length, capacity: this.#capacity, concurrency: this.#concurrency, delegated_contexts: this.#runtimeContexts.size, audit_healthy: !this.#auditError };
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
        this.#runtimeContexts.delete(taskId);
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
      const runtimeContext = this.#runtimeContexts.get(task.id) || null;
      const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'execution', position: 0 });
      if (!runtimeCheck?.ok) throw Object.assign(new Error('Delegated authorization is not valid for the bounded task window.'), { code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' });
      const output = await this.#runner(clone(task.request), task.id, controller.signal, runtimeContext);
      if (controller.signal.aborted) {
        this.#transition(task, 'cancelled');
        return;
      }
      task.result = {
        final_response: boundedUtf8(output?.final_response, MAX_RESULT_BYTES),
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
      this.#runtimeContexts.delete(task.id);
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
      this.#runtimeContexts.delete(task.id);
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
