/* global AbortSignal, TextEncoder, URL, fetch */
import { createHash } from 'node:crypto';
import { buildCapabilityManifest, validateCapabilityManifest } from './capability-registry.mjs';
import { memoryForPlanner } from './project-task-memory.mjs';
import { WORKFLOW_IDS } from './workflow-catalog.mjs';

export const SEMANTIC_PLANNER_SCHEMA_VERSION = 'ams_harness_semantic_planner_v1';
export const MAX_SEMANTIC_RESPONSE_BYTES = 64 * 1024;
export const MAX_CLARIFICATION_QUESTIONS = 3;
export const SEMANTIC_PLANNER_VERSION = 'h1_semantic_planner_v1';
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_MODEL_ID_LENGTH = 120;

const QUESTION_ID = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fail(code, diagnostics = {}) {
  return { ok: false, code, diagnostics };
}

export function semanticPlannerSystemPrompt(capabilityManifest = buildCapabilityManifest()) {
  const checked = validateCapabilityManifest(capabilityManifest);
  if (!checked.ok) throw Object.assign(new Error('Capability manifest is invalid.'), { code: checked.code });
  return [
    'You are the bounded semantic planner for AI Marketing Studio Harness.',
    'Interpret the user intent, but NEVER execute tools, invent workflows, providers, models, prices, approvals, identities, or payload fields.',
    'Return exactly one JSON object and no prose.',
    `schema_version must be ${SEMANTIC_PLANNER_SCHEMA_VERSION}.`,
    'For an executable request return: {"schema_version":"...","kind":"plan","workflow":"catalog id","slots":{...}}.',
    'If a required fact is missing or the requested behavior is unsupported/ambiguous, return: {"schema_version":"...","kind":"clarification","questions":[{"id":"...","field":"...","prompt":"...","options":["...","..."]}]}.',
    'Ask at most three concise questions. Omit options for a free-text question; when options are present they must contain 2 to 4 unique non-empty choices.',
    'Distinguish reuse from collection: when the user asks to inspect, rank, compare, or find the best item in the current project or its existing/saved evidence, use compare_project. Do not ask for a search keyword, do not select a search workflow, and do not invent a save/write.',
    'For compare_project, map impressions/views/plays/exposure to metric=views and engagement/interactions to metric=engagement. Existing/saved evidence is input state, not a request to persist the comparison.',
    'Only for a request that actually collects/searches new X/Twitter content: never silently map hottest/most popular to latest. X search currently supports latest only; ask whether latest is acceptable or whether the user wants Reddit hot/top.',
    'A request to collect/save N results means save_count=N when online saving is clearly requested; otherwise do not invent a write.',
    `Reviewed capability registry (${checked.value.registry_version}, ${checked.value.fingerprint}): ${JSON.stringify(checked.value.capabilities)}`,
  ].join('\n');
}

function normalizeQuestion(value) {
  if (!plainObject(value)) return null;
  const allowed = new Set(['id', 'field', 'prompt', 'options']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (typeof value.id !== 'string' || !QUESTION_ID.test(value.id)) return null;
  if (typeof value.field !== 'string' || !FIELD_NAME.test(value.field)) return null;
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 240) return null;
  const question = { id: value.id, field: value.field, prompt: value.prompt.trim() };
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > 4) return null;
    // An empty options array carries the same bounded meaning as omitting the
    // optional field: the user must answer in free text. Normalize it away
    // instead of rejecting an otherwise valid clarification. A single option
    // remains invalid because it presents no real choice.
    if (value.options.length === 0) return question;
    if (value.options.length < 2) return null;
    const options = value.options.map((entry) => typeof entry === 'string' ? entry.trim() : '');
    if (options.some((entry) => !entry || entry.length > 80) || new Set(options).size !== options.length) return null;
    question.options = options;
  }
  return question;
}

export function normalizeSemanticPlannerOutput(value) {
  if (!plainObject(value)) return fail('PLANNER_OUTPUT_INVALID');
  if (value.schema_version !== SEMANTIC_PLANNER_SCHEMA_VERSION) return fail('PLANNER_OUTPUT_SCHEMA_MISMATCH');
  if (value.kind === 'plan') {
    const allowed = new Set(['schema_version', 'kind', 'workflow', 'slots']);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) return fail('PLANNER_OUTPUT_UNKNOWN_FIELD', { field: unknown });
    if (typeof value.workflow !== 'string' || !WORKFLOW_IDS.includes(value.workflow)) {
      return fail('PLANNER_OUTPUT_WORKFLOW_INVALID', { field: 'workflow' });
    }
    if (!plainObject(value.slots)) return fail('PLANNER_OUTPUT_INVALID', { field: 'slots' });
    return { ok: true, value: { kind: 'plan', workflow: value.workflow, slots: value.slots } };
  }
  if (value.kind === 'clarification') {
    const allowed = new Set(['schema_version', 'kind', 'questions']);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown) return fail('PLANNER_OUTPUT_UNKNOWN_FIELD', { field: unknown });
    if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > MAX_CLARIFICATION_QUESTIONS) {
      return fail('PLANNER_OUTPUT_INVALID', { field: 'questions' });
    }
    const questions = value.questions.map(normalizeQuestion);
    if (questions.some((entry) => !entry) || new Set(questions.map((entry) => entry.id)).size !== questions.length) {
      return fail('PLANNER_OUTPUT_INVALID', { field: 'questions' });
    }
    return { ok: true, value: { kind: 'clarification', questions } };
  }
  return fail('PLANNER_OUTPUT_INVALID', { field: 'kind' });
}

function extractContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('Semantic response is empty.'), { code: 'PLANNER_OUTPUT_INVALID' });
  if (content.length > MAX_SEMANTIC_RESPONSE_BYTES) throw Object.assign(new Error('Semantic response is too large.'), { code: 'PLANNER_OUTPUT_TOO_LARGE' });
  try {
    return JSON.parse(content);
  } catch {
    throw Object.assign(new Error('Semantic response is not strict JSON.'), { code: 'PLANNER_OUTPUT_INVALID' });
  }
}

export function createDeepSeekSemanticPlanner({
  endpoint = 'http://127.0.0.1:8791/v1/chat/completions',
  model = 'deepseek-chat',
  timeoutMs = 20_000,
  fetchImpl = fetch,
} = {}) {
  const parsed = new URL(endpoint);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Semantic planner endpoint must use HTTP(S).');
  if (typeof model !== 'string' || !model.trim() || model.length > MAX_MODEL_ID_LENGTH) {
    throw new TypeError('Semantic planner model identity is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('Semantic planner timeout is invalid.');
  }
  const promptSchemaFingerprint = createHash('sha256')
    .update(semanticPlannerSystemPrompt() + '\n' + SEMANTIC_PLANNER_SCHEMA_VERSION, 'utf8')
    .digest('hex');
  const semanticPlan = async function semanticPlan(intent, context = {}) {
    const capabilityManifest = context.capability_manifest || buildCapabilityManifest();
    const checkedManifest = validateCapabilityManifest(capabilityManifest);
    if (!checkedManifest.ok) throw Object.assign(new Error('Capability manifest is invalid.'), { code: checkedManifest.code });
    const memory = memoryForPlanner(context.project_memory);
    const systemPrompt = semanticPlannerSystemPrompt(checkedManifest.value);
    let response;
    try {
      response = await fetchImpl(parsed, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          model: model.trim(),
          temperature: 0,
          max_tokens: 1200,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'system', content: `Bounded same-project task memory (never approvals or payloads): ${JSON.stringify(memory)}` },
            { role: 'user', content: String(intent ?? '') },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw Object.assign(new Error('Semantic planner is unavailable.'), { code: 'PLANNER_UNAVAILABLE' });
    }
    if (!response.ok) throw Object.assign(new Error('Semantic planner is unavailable.'), { code: 'PLANNER_UNAVAILABLE' });
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SEMANTIC_RESPONSE_BYTES) {
      throw Object.assign(new Error('Semantic response is too large.'), { code: 'PLANNER_OUTPUT_TOO_LARGE' });
    }
    let payload;
    try { payload = JSON.parse(text); } catch { throw Object.assign(new Error('Semantic response envelope is invalid.'), { code: 'PLANNER_OUTPUT_INVALID' }); }
    const normalized = normalizeSemanticPlannerOutput(extractContent(payload));
    if (!normalized.ok) throw Object.assign(new Error(normalized.code), normalized);
    return normalized.value;
  };
  Object.defineProperty(semanticPlan, 'audit', {
    value: Object.freeze({
      provider: 'deepseek-compatible',
      model: model.trim(),
      planner_version: SEMANTIC_PLANNER_VERSION,
      prompt_schema_fingerprint: promptSchemaFingerprint,
    }),
    enumerable: false,
    writable: false,
  });
  return semanticPlan;
}
