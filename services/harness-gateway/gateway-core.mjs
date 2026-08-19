/* global AbortController, Buffer, clearTimeout, queueMicrotask, setTimeout, structuredClone */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HARNESS_DIAGNOSTIC_CATEGORIES, HARNESS_DIAGNOSTIC_CODES, HARNESS_DIAGNOSTIC_STAGES, MAX_HARNESS_DIAGNOSTIC_SUMMARY, redactSensitive } from './harness-runner.mjs';
import { derivePresentation, normalizePresentation } from './presentation/presentation-contract.mjs';
import { validatePlanShape } from './planner.mjs';

export const GATEWAY_SCHEMA_VERSION = 'ams_harness_gateway_v1';

export async function runWithTaskTimeout({ signal, timeoutMs, run }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof run !== 'function') {
    throw Object.assign(new Error('Bounded task timeout configuration is invalid.'), { code: 'TASK_TIMEOUT_CONFIG_INVALID' });
  }
  const controller = new AbortController();
  const cancellationError = Object.assign(new Error('Deterministic task was cancelled.'), { code: 'CANCELLED' });
  let resolveCancellation;
  const cancellation = new Promise((resolve) => {
    resolveCancellation = resolve;
  });
  const forwardAbort = () => {
    controller.abort(cancellationError);
    resolveCancellation({ cancelled: true });
  };
  if (!signal?.aborted) signal?.addEventListener('abort', forwardAbort, { once: true });
  let timeoutId;
  const timeoutError = Object.assign(new Error('Deterministic task exceeded its bounded execution window.'), { code: 'TASK_TIMEOUT' });
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    if (signal?.aborted) throw cancellationError;
    const execution = Promise.resolve().then(() => run(controller.signal));
    const settled = execution.then(
      (value) => ({ timedOut: false, value }),
      (error) => ({ timedOut: false, error }),
    );
    const outcome = await Promise.race([settled, timeout, cancellation]);
    if (outcome.timedOut) {
      // Observe a late rejection without waiting for an uncooperative runner.
      // Deterministic execution uses an isolated task view (below), so work
      // settling after this boundary cannot mutate or emit into the terminal
      // durable task.
      execution.catch(() => undefined);
      throw timeoutError;
    }
    if (outcome.cancelled) {
      execution.catch(() => undefined);
      throw cancellationError;
    }
    if (outcome.error) throw outcome.error;
    return outcome.value;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function runWithIsolatedTaskView({ taskView, signal, emit, run }) {
  const isolatedTask = clone(taskView);
  const finalizeTimedOutStep = () => {
    if (signal?.reason?.code !== 'TASK_TIMEOUT') return;
    const snapshot = clone(isolatedTask.step_states || {});
    for (const [stepId, state] of Object.entries(snapshot)) {
      if (state?.state !== 'running') continue;
      const planStep = (taskView.plan?.steps || []).find((step) => step.step === stepId);
      snapshot[stepId] = {
        ...state,
        state: 'failed',
        failed_count: Math.max(1, Number(state.failed_count) || 0),
        finished_at: new Date().toISOString(),
        error: {
          code: 'TASK_TIMEOUT',
          ...(state.operation ? { operation: state.operation } : {}),
          message: 'Deterministic task exceeded its bounded execution window.',
          retry_unsafe: planStep?.cost === true,
        },
      };
    }
    taskView.step_states = snapshot;
  };
  signal?.addEventListener('abort', finalizeTimedOutStep, { once: true });
  const isolatedEmit = (detail) => {
    if (signal?.aborted) return;
    taskView.step_states = clone(isolatedTask.step_states || {});
    emit(detail);
  };
  try {
    if (signal?.aborted) finalizeTimedOutStep();
    const output = await run(isolatedTask, isolatedEmit);
    if (!signal?.aborted) taskView.step_states = clone(isolatedTask.step_states || {});
    return output;
  } finally {
    signal?.removeEventListener('abort', finalizeTimedOutStep);
  }
}
// planned: authoritative plan exists, awaiting the exact user confirmation;
// partial: some steps succeeded before the first necessary step failed and
// the eligible failed step may be explicitly retried.
export const TASK_STATES = Object.freeze(['planned', 'queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled']);
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
const HISTORY_PRUNABLE = new Set(TERMINAL);
const TASK_ID = /^ht-[0-9a-f-]{36}$/;
const MAX_PROMPT = 12_000;
const MAX_RESULT_BYTES = 12 * 1024;
const MAX_STRUCTURED_RESULT_BYTES = 64 * 1024;

// Allowlisted harness failure diagnostic shape, sourced from the same
// constants the classifier emits (a single source of truth so the producer
// and the persistence gate cannot drift). Every field has an explicit
// size/type boundary; anything outside this shape is rejected and replaced by
// the safe fallback below, never persisted.
const HARNESS_DIAGNOSTIC_KEYS = new Set(['code', 'category', 'stage', 'exit_code', 'summary', 'tool_code', 'operation']);
const SAFE_HARNESS_DIAGNOSTIC = Object.freeze({
  code: 'HARNESS_FAILED',
  category: 'harness_runtime_unknown',
  stage: 'unknown',
  exit_code: null,
  summary: 'Harness process failed without a valid diagnostic.',
});

/**
 * Fail-closed validation of a structured Harness failure diagnostic before
 * persistence. Returns null when the value is not exactly the allowlisted
 * shape (wrong keys, wrong types, unknown category/stage/code, out-of-range
 * exit code, empty or oversized summary). The persisted summary is passed
 * through redaction at this persistence boundary as a final guarantee.
 */
export function normalizeDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !HARNESS_DIAGNOSTIC_KEYS.has(key))) return null;
  const { code, category, stage, exit_code: exitCode, summary, tool_code: toolCode, operation } = value;
  if (typeof code !== 'string' || !HARNESS_DIAGNOSTIC_CODES.includes(code)) return null;
  if (typeof category !== 'string' || !HARNESS_DIAGNOSTIC_CATEGORIES.includes(category)) return null;
  if (typeof stage !== 'string' || !HARNESS_DIAGNOSTIC_STAGES.includes(stage)) return null;
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < -2_147_483_648 || exitCode > 2_147_483_647)) return null;
  if (typeof summary !== 'string' || !summary.trim() || summary.length > MAX_HARNESS_DIAGNOSTIC_SUMMARY) return null;
  const normalized = {
    code,
    category,
    stage,
    exit_code: exitCode,
    summary: redactSensitive(summary),
  };
  if (toolCode !== undefined) {
    if (typeof toolCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(toolCode)) return null;
    normalized.tool_code = toolCode;
  }
  if (operation !== undefined) {
    if (typeof operation !== 'string' || !/^[a-z0-9._-]{1,80}$/i.test(operation)) return null;
    normalized.operation = operation;
  }
  return normalized;
}

function boundedErrorView(error) {
  const view = { code: bounded(error?.code, 80) };
  if (typeof error?.category === 'string') view.category = bounded(error.category, 32);
  if (typeof error?.stage === 'string') view.stage = bounded(error.stage, 40);
  if (error?.exit_code != null) view.exit_code = Number.isSafeInteger(error.exit_code) ? error.exit_code : null;
  if (typeof error?.summary === 'string') view.summary = bounded(error.summary, 240);
  if (typeof error?.tool_code === 'string') view.tool_code = bounded(error.tool_code, 80);
  if (typeof error?.operation === 'string') view.operation = bounded(error.operation, 80);
  if (typeof error?.message === 'string') view.message = bounded(error.message, 240);
  return view;
}

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

function exactStructuredResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw Object.assign(new Error('Structured tool result is not serializable.'), { code: 'RESULT_DATA_INVALID' });
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STRUCTURED_RESULT_BYTES) {
    throw Object.assign(new Error('Structured tool result exceeds its bounded persistence envelope.'), { code: 'RESULT_DATA_TOO_LARGE' });
  }
  return clone(value);
}

function externalTask(task) {
  const copy = clone(task);
  for (const state of Object.values(copy?.step_states || {})) {
    if (state && typeof state === 'object') {
      delete state.resume_output;
      delete state.resume_ref;
    }
  }
  return copy;
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

export const PLAN_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
export const STEP_ID_PATTERN = /^st-\d+$/;

function fail(code, field = null) {
  return { ok: false, code, diagnostics: { field } };
}

/**
 * Fail-closed validation of a plan-only request. Identical to the task
 * request envelope except that no approval may be attached: the plan declares
 * its own required approval scopes, and approval happens only at confirm.
 */
export function validatePlanRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST');
  const allowed = new Set(['schema_version', 'request_id', 'user_id', 'project_id', 'intent']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return fail('UNKNOWN_FIELD');
  if (input.schema_version !== GATEWAY_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH');
  for (const key of ['request_id', 'user_id', 'intent']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) return fail(`${key.toUpperCase()}_INVALID`);
  }
  if (input.request_id.length > 200 || input.user_id.length > 200) return fail('IDENTITY_TOO_LONG');
  if (input.intent.length > MAX_PROMPT) return fail('INTENT_TOO_LONG');
  if (input.project_id != null && (typeof input.project_id !== 'string' || input.project_id.length > 200)) {
    return fail('PROJECT_ID_INVALID');
  }
  return {
    ok: true,
    value: {
      schema_version: GATEWAY_SCHEMA_VERSION,
      request_id: input.request_id.trim(),
      user_id: input.user_id.trim(),
      project_id: input.project_id?.trim() || null,
      intent: input.intent.trim(),
    },
  };
}

function validateApprovalShape(approval) {
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) return fail('APPROVAL_INVALID');
  const approvalAllowed = new Set(['paid_external_calls', 'online_writes', 'handoff_creation']);
  if (Object.keys(approval).some((key) => !approvalAllowed.has(key))) return fail('APPROVAL_UNKNOWN_FIELD');
  for (const key of approvalAllowed) {
    if (approval[key] != null && typeof approval[key] !== 'boolean') return fail('APPROVAL_INVALID');
  }
  return {
    ok: true,
    value: {
      paid_external_calls: approval.paid_external_calls === true,
      online_writes: approval.online_writes === true,
      handoff_creation: approval.handoff_creation === true,
    },
  };
}

/**
 * Fail-closed validation of a confirmation request. The confirmation must
 * carry the exact task id, the exact plan fingerprint and exactly the
 * approval scopes the plan declares. Anything stale, tampered or mismatched
 * fails closed here — zero tools execute.
 */
export function validateConfirmRequest(input, plan = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST');
  const allowed = new Set(['schema_version', 'task_id', 'plan_fingerprint', 'approval']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return fail('UNKNOWN_FIELD');
  if (input.schema_version !== GATEWAY_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH');
  if (!TASK_ID.test(String(input.task_id || ''))) return fail('TASK_ID_INVALID');
  if (typeof input.plan_fingerprint !== 'string' || !PLAN_FINGERPRINT_PATTERN.test(input.plan_fingerprint)) {
    return fail('PLAN_FINGERPRINT_INVALID');
  }
  const approval = validateApprovalShape(input.approval);
  if (!approval.ok) return approval;
  const value = { schema_version: GATEWAY_SCHEMA_VERSION, task_id: input.task_id, plan_fingerprint: input.plan_fingerprint, approval: approval.value };
  if (plan) {
    for (const scope of ['paid_external_calls', 'online_writes', 'handoff_creation']) {
      if (plan.approvals?.[scope] === true && value.approval[scope] !== true) return fail('CONFIRM_APPROVAL_MISMATCH', scope);
      if (plan.approvals?.[scope] === false && value.approval[scope] === true) return fail('CONFIRM_APPROVAL_MISMATCH', scope);
    }
  }
  return { ok: true, value };
}

/**
 * Fail-closed validation of a retry request: the exact failed step of the
 * same plan fingerprint, with the exact same approvals re-confirmed.
 */
export function validateRetryRequest(input, plan = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST');
  const allowed = new Set(['schema_version', 'task_id', 'plan_fingerprint', 'step_id', 'approval']);
  if (Object.keys(input).some((key) => !allowed.has(key))) return fail('UNKNOWN_FIELD');
  if (input.schema_version !== GATEWAY_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH');
  if (!TASK_ID.test(String(input.task_id || ''))) return fail('TASK_ID_INVALID');
  if (typeof input.plan_fingerprint !== 'string' || !PLAN_FINGERPRINT_PATTERN.test(input.plan_fingerprint)) {
    return fail('PLAN_FINGERPRINT_INVALID');
  }
  if (typeof input.step_id !== 'string' || !STEP_ID_PATTERN.test(input.step_id)) return fail('STEP_ID_INVALID');
  const approval = validateApprovalShape(input.approval);
  if (!approval.ok) return approval;
  const value = {
    schema_version: GATEWAY_SCHEMA_VERSION,
    task_id: input.task_id,
    plan_fingerprint: input.plan_fingerprint,
    step_id: input.step_id,
    approval: approval.value,
  };
  if (plan) {
    if (!plan.steps.some((step) => step.step === input.step_id)) return fail('STEP_NOT_IN_PLAN', input.step_id);
    for (const scope of ['paid_external_calls', 'online_writes', 'handoff_creation']) {
      if (plan.approvals?.[scope] === true && value.approval[scope] !== true) return fail('CONFIRM_APPROVAL_MISMATCH', scope);
      if (plan.approvals?.[scope] === false && value.approval[scope] === true) return fail('CONFIRM_APPROVAL_MISMATCH', scope);
    }
  }
  return { ok: true, value };
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
  #deterministicRunner;
  #planner;
  #capacity;
  #concurrency;
  #onEvent;
  #controllers = new Map();
  #runtimeContexts = new Map();
  #maxHistory;
  #plannedPerUserCapacity;
  #auditError = null;
  #validateRuntimeContext;
  // In-flight plan reservations keyed by trusted identity
  // (user_id + request_id). Two simultaneous plan requests with the same
  // identity serialize on this record: the second caller awaits the leader's
  // outcome instead of planning a second time, and a different normalized
  // request under the same identity fails closed immediately.
  #planReservations = new Map();

  constructor({ runner, deterministicRunner = null, planner = null, capacity = 10, plannedPerUserCapacity = capacity, concurrency = 1, maxHistory = 200, onEvent = () => {}, initialTasks = [], validateRuntimeContext = () => ({ ok: true }) }) {
    if (typeof runner !== 'function') throw new TypeError('runner is required');
    if (concurrency !== 1) throw new RangeError('initial gateway concurrency must equal one');
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    if (!Number.isSafeInteger(plannedPerUserCapacity) || plannedPerUserCapacity < 1 || plannedPerUserCapacity > capacity) {
      throw new RangeError('plannedPerUserCapacity must be a positive integer no greater than capacity');
    }
    this.#runner = runner;
    this.#deterministicRunner = deterministicRunner;
    this.#planner = planner;
    this.#capacity = capacity;
    this.#concurrency = concurrency;
    this.#maxHistory = maxHistory;
    this.#plannedPerUserCapacity = plannedPerUserCapacity;
    this.#onEvent = onEvent;
    this.#validateRuntimeContext = validateRuntimeContext;
    for (const candidate of initialTasks) {
      if (!candidate || !TASK_ID.test(candidate.id) || !TASK_STATES.includes(candidate.state)) continue;
      // A persisted task carrying an authoritative plan must reload its
      // request through the plan request normalizer: the legacy
      // immediate-execution normalizer would inject an approval envelope and
      // change the request fingerprint, breaking exact post-restart replays
      // of the original plan request (they would fail as conflicts). This
      // decision uses the original snapshot's plan field, so even a corrupted
      // plan still reloads with the plan-normalized request shape.
      const validated = candidate.plan ? validatePlanRequest(candidate.request) : validateTaskRequest(candidate.request);
      if (!validated.ok) continue;
      const task = clone({ ...candidate, request: validated.value });
      // A persisted snapshot's presentation is validated again at this
      // boundary; a tampered or legacy payload degrades to null and the
      // client re-derives structured blocks, never crashing the queue.
      if (task.result?.presentation) task.result.presentation = normalizePresentation(task.result.presentation);
      // Persisted snapshots may predate newly defaulted envelope fields. Never
      // trust a historical fingerprint after normalization: migrate it to the
      // exact current request shape so a post-upgrade exact replay stays valid.
      task.request_fingerprint = createHash('sha256').update(JSON.stringify(validated.value)).digest('hex');
      // Authoritative plans are re-validated at the persistence boundary; a
      // tampered or corrupted plan fails the task closed with zero execution.
      if (task.plan) {
        const planCheck = validatePlanShape(task.plan);
        const bound = planCheck.ok === true
          && task.plan.task_id === task.id
          && task.plan.user_id === task.request.user_id
          && task.plan.project_id === task.request.project_id
          && task.plan.intent === task.request.intent
          && task.plan.request_fingerprint === task.request_fingerprint;
        if (!bound) {
          task.plan = null;
          task.plan_fingerprint = null;
          task.state = 'failed';
          task.updated_at = new Date().toISOString();
          task.error = { code: 'PLAN_CORRUPTED', message: 'Persisted plan failed closed validation after restart.' };
        } else if (task.plan.fingerprint !== task.plan_fingerprint) {
          task.plan_fingerprint = task.plan.fingerprint;
        }
      }
      if (task.state === 'queued' || task.state === 'running') {
        if (task.pending_continuation === true) {
          // A durably parked nonterminal task (deterministic outcome
          // `running`) survives the restart with its job identity (the
          // submitted quote/job resume state) attached: an explicit
          // authenticated same-task continuation can still converge it
          // through an exact read-only generation.status — never a
          // resubmission. A transient queued/running task without the park
          // marker still fails closed as before.
          task.state = 'running';
          task.updated_at = new Date().toISOString();
        } else {
          task.state = 'failed';
          task.updated_at = new Date().toISOString();
          task.error = { code: 'GATEWAY_RESTARTED', message: 'Gateway restarted before the task reached a durable terminal state.' };
        }
      }
      if (task.state === 'planned') {
        const planned = [...this.#tasks.values()].filter((entry) => entry.state === 'planned');
        const plannedForUser = planned.filter((entry) => entry.request.user_id === task.request.user_id);
        if (planned.length >= this.#capacity || plannedForUser.length >= this.#plannedPerUserCapacity) {
          task.state = 'failed';
          task.updated_at = new Date().toISOString();
          task.error = { code: 'PLANNED_TASK_LIMIT_RESTORED', message: 'Unconfirmed plan exceeded the bounded restart admission limit.' };
        }
      }
      if (task.step_states == null || typeof task.step_states !== 'object' || Array.isArray(task.step_states)) task.step_states = {};
      this.#tasks.set(task.id, task);
      if (['GATEWAY_RESTARTED', 'PLAN_CORRUPTED', 'PLANNED_TASK_LIMIT_RESTORED'].includes(task.error?.code)) this.#emit(task, 'recovered_failed');
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
    const planned = [...this.#tasks.values()].filter((task) => task.state === 'planned').length;
    if (this.#pending.length + this.#active + planned + this.#planReservations.size >= this.#capacity) {
      return { ok: false, code: 'QUEUE_FULL' };
    }
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
    return { ok: true, replayed: false, task: externalTask(task) };
  }

  #findByRequestId(userId, requestId) {
    return [...this.#tasks.values()].find((task) => task.request.request_id === requestId && task.request.user_id === userId) || null;
  }

  #planAdmission(userId) {
    const plannedTasks = [...this.#tasks.values()].filter((task) => task.state === 'planned');
    const reserved = [...this.#planReservations.values()];
    const outstanding = this.#pending.length + this.#active + plannedTasks.length + reserved.length;
    if (outstanding >= this.#capacity) return { ok: false, code: 'QUEUE_FULL' };
    const userOutstanding = plannedTasks.filter((task) => task.request.user_id === userId).length
      + reserved.filter((reservation) => reservation.userId === userId).length;
    if (userOutstanding >= this.#plannedPerUserCapacity) return { ok: false, code: 'PLANNED_TASK_LIMIT' };
    return { ok: true };
  }

  /**
   * Plan action: produce and persist the authoritative plan only. Nothing
   * executes; the plan is immutable (SHA-256 fingerprint) and declares its
   * exact required approval scopes, cost/write indicators and ordered steps.
   *
   * The request identity is reserved before the planner is awaited: two
   * simultaneous requests with the same trusted user_id + request_id serialize
   * on one in-flight reservation, so exactly one planner invocation produces
   * one authoritative task/plan. A different normalized request under the same
   * identity fails closed with IDEMPOTENCY_CONFLICT while the leader is still
   * planning. Planner failure, plan validation failure and audit persistence
   * failure release the reservation durably (no task, no second executable
   * plan is left behind), so a later identical request may plan fresh.
   */
  async plan(input, _runtimeContext = null) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    if (!this.#planner) return { ok: false, code: 'PLANNER_UNAVAILABLE' };
    const validated = validatePlanRequest(input);
    if (!validated.ok) return validated;
    const requestFingerprint = createHash('sha256').update(JSON.stringify(validated.value)).digest('hex');
    const existing = this.#findByRequestId(validated.value.user_id, validated.value.request_id);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      if (existing.plan) return { ok: true, replayed: true, task: externalTask(existing) };
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
    }
    // Collision-safe identity key (JSON quoting prevents user/request-id
    // boundary confusion between identities).
    const reservationKey = JSON.stringify([validated.value.user_id, validated.value.request_id]);
    const reservation = this.#planReservations.get(reservationKey);
    if (reservation) {
      if (reservation.requestFingerprint !== requestFingerprint) return { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      // The leader owns the only authoritative plan for this identity; the
      // waiting caller replays it without invoking the planner again.
      const outcome = await reservation.promise;
      if (outcome.ok) return { ok: true, replayed: true, task: outcome.task };
      // Every waiter observes the same failed leader outcome. A later, fresh
      // external request may retry after release, but this waiter cohort must
      // never fan out into multiple new planning leaders.
      return outcome;
    }
    const admission = this.#planAdmission(validated.value.user_id);
    if (!admission.ok) return admission;
    const now = new Date().toISOString();
    const task = {
      id: `ht-${randomUUID()}`,
      state: 'planned',
      created_at: now,
      updated_at: now,
      request: validated.value,
      request_fingerprint: requestFingerprint,
      plan: null,
      plan_fingerprint: null,
      confirmation: null,
      retry_target: null,
      step_states: {},
      result: null,
      error: null,
    };
    const leader = (async () => {
      // Defer planner invocation until after the reservation is registered.
      // A synchronously throwing planner can then release the exact in-flight
      // reservation instead of leaving a permanently replayed failure.
      await Promise.resolve();
      try {
      let planResult;
      try {
        planResult = await this.#planner.plan({ taskId: task.id, request: { ...validated.value, request_fingerprint: requestFingerprint } });
      } catch {
        this.#planReservations.delete(reservationKey);
        return { ok: false, code: 'PLANNER_UNAVAILABLE' };
      }
      if (!planResult.ok) {
        // Planner rejection or plan validation failure: nothing was persisted
        // and the reservation is released so a fresh request may retry.
        this.#planReservations.delete(reservationKey);
        return planResult;
      }
      const planValidation = validatePlanShape(planResult.value);
      const plan = planResult.value;
      const bindingValid = planValidation.ok === true
        && plan.task_id === task.id
        && plan.user_id === validated.value.user_id
        && plan.project_id === validated.value.project_id
        && plan.intent === validated.value.intent
        && plan.request_fingerprint === requestFingerprint
        && typeof plan.fingerprint === 'string';
      if (!bindingValid) {
        this.#planReservations.delete(reservationKey);
        return { ok: false, code: 'PLANNER_OUTPUT_INVALID' };
      }
      task.plan = plan;
      task.plan_fingerprint = plan.fingerprint;
      this.#tasks.set(task.id, task);
      try {
        this.#emit(task, 'planned');
      } catch {
        // Audit persistence failure rolls the task back and releases the
        // reservation: no second executable plan is left behind.
        this.#tasks.delete(task.id);
        this.#planReservations.delete(reservationKey);
        return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
      }
      // The persisted task now answers identical replays through the
      // existing-task path; the in-flight reservation is released.
      this.#planReservations.delete(reservationKey);
      return { ok: true, replayed: false, task: externalTask(task) };
      } finally {
        this.#planReservations.delete(reservationKey);
      }
    })();
    this.#planReservations.set(reservationKey, { requestFingerprint, userId: validated.value.user_id, promise: leader });
    const outcome = await leader;
    if (!outcome.ok) return outcome;
    return { ok: true, replayed: false, task: clone(outcome.task) };
  }

  /**
   * Confirm action: validate the exact task id, plan fingerprint and approval
   * scopes, then enqueue the deterministic execution. Stale/tampered or
   * mismatched confirmations fail closed and execute zero tools.
   */
  confirm(input, userId = '', runtimeContext = null) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const found = this.read(String(input?.task_id || ''), String(userId || ''));
    const task = found.ok ? this.#tasks.get(found.task.id) : null;
    const validated = validateConfirmRequest(input, task?.plan || null);
    if (!validated.ok) return validated;
    if (!task) return found;
    if (!task.plan || !task.plan_fingerprint) return { ok: false, code: 'PLAN_REQUIRED' };
    if (typeof this.#deterministicRunner !== 'function') {
      return { ok: false, code: 'DETERMINISTIC_RUNNER_UNAVAILABLE' };
    }
    if (task.plan.fingerprint !== validated.value.plan_fingerprint) return { ok: false, code: 'PLAN_FINGERPRINT_MISMATCH' };
    // Durable nonterminal park (a deterministic `running` outcome): an
    // explicit authenticated same-task continuation schedules exactly one
    // bounded refresh round through the deterministic runner. The executor's
    // refresh path performs exactly one read-only generation.status and never
    // repeats quote, submit, provider, paid or completed write steps. Wrong
    // identity (read above), wrong fingerprint, mismatched approvals and
    // invalid delegated authorization all fail closed before any execution.
    // A task whose refresh round is already queued or executing is merged
    // idempotently through the replay branch below instead of being enqueued
    // a second time.
    if (task.state === 'running' && task.pending_continuation === true && !this.#controllers.has(task.id)) {
      const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'submit', position: this.#pending.length + this.#active });
      if (!runtimeCheck?.ok) return { ok: false, code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' };
      if (this.#pending.length + this.#active >= this.#capacity) return { ok: false, code: 'QUEUE_FULL' };
      task.confirmation = { approval: validated.value.approval, confirmed_at: new Date().toISOString() };
      // A continuation is a fresh confirmation: it must never replay an
      // explicit step retry target, so the executor's read-only refresh path
      // applies to the accepted submit step instead of re-invoking it.
      task.retry_target = null;
      this.#transition(task, 'queued');
      this.#pending.push(task.id);
      if (runtimeContext) this.#runtimeContexts.set(task.id, runtimeContext);
      queueMicrotask(() => this.#drain());
      return { ok: true, replayed: false, continued: true, task: externalTask(task) };
    }
    if (task.state === 'queued' || task.state === 'running' || TERMINAL.has(task.state)) {
      return { ok: true, replayed: true, task: externalTask(task) };
    }
    if (task.state !== 'planned') return { ok: false, code: 'TASK_STATE_INVALID' };
    const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'submit', position: this.#pending.length + this.#active });
    if (!runtimeCheck?.ok) return { ok: false, code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' };
    if (this.#pending.length + this.#active >= this.#capacity) return { ok: false, code: 'QUEUE_FULL' };
    task.confirmation = { approval: validated.value.approval, confirmed_at: new Date().toISOString() };
    task.retry_target = null;
    task.step_states = {};
    task.error = null;
    this.#transition(task, 'queued');
    this.#pending.push(task.id);
    if (runtimeContext) this.#runtimeContexts.set(task.id, runtimeContext);
    queueMicrotask(() => this.#drain());
    return { ok: true, replayed: false, task: externalTask(task) };
  }

  /**
   * Retry action: rerun only the exact failed step of the same plan
   * fingerprint. Completed/reused steps stay untouched; dependent steps
   * resume in order. Paid steps with an ambiguous earlier outcome fail
   * closed with RETRY_UNSAFE and require a fresh user-approved plan.
   */
  retry(input, userId = '', runtimeContext = null) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const found = this.read(String(input?.task_id || ''), String(userId || ''));
    const task = found.ok ? this.#tasks.get(found.task.id) : null;
    const validated = validateRetryRequest(input, task?.plan || null);
    if (!validated.ok) return validated;
    if (!task) return found;
    if (!task.plan || !task.plan_fingerprint) return { ok: false, code: 'PLAN_REQUIRED' };
    if (task.plan.fingerprint !== validated.value.plan_fingerprint) return { ok: false, code: 'PLAN_FINGERPRINT_MISMATCH' };
    if (task.retry_target?.step_id === validated.value.step_id
      && (task.retry_target.plan_fingerprint == null || task.retry_target.plan_fingerprint === validated.value.plan_fingerprint)) {
      return { ok: true, replayed: true, task: externalTask(task) };
    }
    if (task.state !== 'partial' && task.state !== 'failed') return { ok: false, code: 'TASK_STATE_INVALID' };
    const snapshot = task.step_states?.[validated.value.step_id];
    if (!snapshot || snapshot.state !== 'failed') return { ok: false, code: 'STEP_NOT_FAILED', diagnostics: { field: validated.value.step_id } };
    if (snapshot.error?.retry_unsafe === true || snapshot.retry_unsafe === true) {
      return { ok: false, code: 'RETRY_UNSAFE', diagnostics: { field: validated.value.step_id, message: '该付费步骤的先前结果不明确，重试可能产生重复费用；请重新创建并批准一份新计划。' } };
    }
    const runtimeCheck = this.#validateRuntimeContext(runtimeContext, { phase: 'submit', position: this.#pending.length + this.#active });
    if (!runtimeCheck?.ok) return { ok: false, code: runtimeCheck?.code || 'DELEGATED_AUTHORIZATION_INVALID' };
    if (this.#pending.length + this.#active >= this.#capacity) return { ok: false, code: 'QUEUE_FULL' };
    task.confirmation = { approval: validated.value.approval, confirmed_at: new Date().toISOString() };
    task.retry_target = { step_id: validated.value.step_id, plan_fingerprint: validated.value.plan_fingerprint, retried_at: new Date().toISOString() };
    task.error = null;
    // Reset only the failed target step and the steps it blocked; every
    // completed/reused step stays untouched.
    const targetSet = new Set([validated.value.step_id]);
    for (const step of task.plan.steps) {
      const state = task.step_states?.[step.step]?.state;
      const dependsOnRetriedStep = Array.isArray(step.depends_on)
        && step.depends_on.some((dependency) => targetSet.has(dependency));
      if (dependsOnRetriedStep && (state === 'blocked' || state === 'skipped' || state === 'failed' || state === 'running' || state === 'planned')) {
        targetSet.add(step.step);
      }
    }
    for (const stepId of targetSet) {
      task.step_states[stepId] = { ...(task.step_states[stepId] || {}), state: 'planned', error: null, started_at: undefined, finished_at: undefined };
    }
    this.#transition(task, 'queued');
    this.#pending.push(task.id);
    if (runtimeContext) this.#runtimeContexts.set(task.id, runtimeContext);
    queueMicrotask(() => this.#drain());
    return { ok: true, replayed: false, task: externalTask(task) };
  }

  read(taskId, userId) {
    if (!TASK_ID.test(taskId)) return { ok: false, code: 'TASK_ID_INVALID' };
    const task = this.#tasks.get(taskId);
    if (!task || task.request.user_id !== userId) return { ok: false, code: 'TASK_NOT_FOUND' };
    return { ok: true, task: externalTask(task) };
  }

  list(userId, limit = 50) {
    const safeLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    return [...this.#tasks.values()]
      .filter((task) => task.request.user_id === userId)
      .map(externalTask)
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
      plan: task.plan ? {
        workflow: task.plan.workflow,
        workflow_title: bounded(task.plan.workflow_title, 120),
        fingerprint: task.plan.fingerprint,
        approvals: task.plan.approvals,
        cost_indicators: task.plan.cost_indicators,
        step_count: task.plan.steps.length,
        step_states: Object.fromEntries(task.plan.steps.map((step) => [step.step, task.step_states?.[step.step]?.state || 'planned'])),
      } : null,
      result: task.result ? {
        artifact_refs: task.result.artifact_refs.slice(0, 10),
        partial_completion: task.result.partial_completion === true,
      } : null,
      error: task.error ? boundedErrorView(task.error) : null,
    }));
  }

  cancel(taskId, userId) {
    if (this.#auditError) return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    const found = this.read(taskId, userId);
    if (!found.ok) return found;
    const task = this.#tasks.get(taskId);
    if (TERMINAL.has(task.state)) return { ok: true, task: externalTask(task), unchanged: true };
    // Active execution is aborted through its controller. A durably parked
    // running task (pending continuation) has no controller and is cancelled
    // exactly like a queued task.
    const controller = this.#controllers.get(taskId);
    if (controller) {
      controller.abort();
      return { ok: true, task: externalTask(task), cancellation_requested: true };
    }
    try {
      this.#transition(task, 'cancelled');
    } catch {
      return { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' };
    }
    this.#pending = this.#pending.filter((id) => id !== taskId);
    this.#runtimeContexts.delete(taskId);
    return { ok: true, task: externalTask(task), unchanged: false };
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
      // A confirmed plan runs through the deterministic executor; legacy
      // submissions (historical clients/tests) run through the model runner.
      if (task.plan && typeof this.#deterministicRunner !== 'function') {
        throw Object.assign(new Error('Confirmed deterministic plan runner is unavailable.'), { code: 'DETERMINISTIC_RUNNER_UNAVAILABLE' });
      }
      const runner = task.plan ? this.#deterministicRunner : this.#runner;
      const output = await runner(clone(task.request), task.id, controller.signal, runtimeContext, task, (detail) => {
        this.#emit(task, detail?.event || 'step_state');
      });
      if (controller.signal.aborted) {
        this.#transition(task, 'cancelled');
        return;
      }
      task.result = {
        final_response: boundedUtf8(output?.final_response, MAX_RESULT_BYTES),
        artifact_refs: Array.isArray(output?.artifact_refs) ? output.artifact_refs.slice(0, 50).map((value) => bounded(value, 500)) : [],
        presentation: derivePresentation(output?.final_response, task),
      };
      if (output?.result_data && typeof output.result_data === 'object' && !Array.isArray(output.result_data)) {
        task.result.result_data = exactStructuredResult(output.result_data);
      }
      if (output?.partial_completion === true) task.result.partial_completion = true;
      if (output?.retry_unsafe_step) task.result.retry_unsafe_step = bounded(output.retry_unsafe_step, 40);
      if (output?.outcome === 'running') {
        // A deterministic `running` outcome is a durable nonterminal park,
        // never succeeded: the real asynchronous G1 job is still queued or
        // running and only an explicit authenticated same-task continuation
        // may converge the task. The park marker distinguishes this state
        // from a transient in-flight `running` task (active controller) and
        // makes it restart-safe.
        task.pending_continuation = true;
        this.#transition(task, 'running');
      } else {
        delete task.pending_continuation;
        if (output?.outcome === 'failed' && output?.needs_attention === true) {
          // Bounded queue-level signal for a needs_attention terminal job; the
          // exact bounded diagnostics live in the submit step snapshot and the
          // persisted generation_status result view.
          task.error = { code: 'G1_JOB_NEEDS_ATTENTION', message: '生成作业需要人工关注（详见作业诊断）。' };
        }
        this.#transition(task, output?.outcome === 'partial' ? 'partial' : output?.outcome === 'failed' ? 'failed' : 'succeeded');
      }
    } catch (error) {
      const taskFailure = controller.signal.aborted
        ? null
        : error?.diagnostic
          ? (normalizeDiagnostic(error.diagnostic) || SAFE_HARNESS_DIAGNOSTIC)
          : { code: bounded(error?.code || 'HARNESS_FAILED', 80), message: bounded(error?.message || 'Harness task failed.', 500) };
      if (error?.partialResult && !controller.signal.aborted) {
        task.result = {
          final_response: boundedUtf8(error.partialResult.final_response, MAX_RESULT_BYTES),
          artifact_refs: Array.isArray(error.partialResult.artifact_refs)
            ? error.partialResult.artifact_refs.slice(0, 50).map((value) => bounded(value, 500))
            : [],
          partial_completion: error.partialResult.partial_completion === true,
          // Failed/partial tasks need the bounded tool diagnostic inside the
          // persisted presentation too. Derive against an immutable view so
          // the task state machine and transition order stay unchanged.
          presentation: derivePresentation(error.partialResult.final_response, { ...task, error: taskFailure }),
        };
      }
      if (error?.code === 'AUDIT_PERSISTENCE_UNAVAILABLE') {
        task.result = null;
        task.state = 'failed';
        task.updated_at = new Date().toISOString();
        task.error = { code: 'AUDIT_PERSISTENCE_UNAVAILABLE', message: 'Task stopped because its audit state could not be persisted.' };
      } else {
        task.error = taskFailure;
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
      .filter((task) => HISTORY_PRUNABLE.has(task.state))
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
