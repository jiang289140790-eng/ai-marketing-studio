/* global Buffer, structuredClone */

import { createHash } from 'node:crypto';

export const TOOL_SCHEMA_VERSION = 'ams_harness_tool_v1';
export const TOOL_RESULT_SCHEMA_VERSION = 'ams_harness_tool_result_v1';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROJECT_ID = /^prj-[0-9a-f]{24}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024 + 64 * 1024;

const definitions = {
  'workspace.project.list': { endpoint: 'p19-workspace-command', command: 'project.list', fields: [], approval: [] },
  'workspace.project.read': { endpoint: 'p19-workspace-command', command: 'project.read', fields: ['project_id'], approval: [] },
  'workspace.lineage.audit': { endpoint: 'p19-workspace-command', command: 'lineage.audit', fields: ['project_id'], approval: [] },
  'workspace.project.create': { endpoint: 'p19-workspace-command', command: 'project.create', fields: ['project'], approval: ['online_writes'] },
  'workspace.project.update': { endpoint: 'p19-workspace-command', command: 'project.update', fields: ['project_id', 'patch'], approval: ['online_writes'], requiresRevision: true },
  'workspace.evidence.create': { endpoint: 'p19-workspace-command', command: 'evidence.create', fields: ['project_id', 'evidence'], approval: ['online_writes'], requiresRevision: true },
  'workspace.analysis.create': { endpoint: 'p19-workspace-command', command: 'analysis.create', fields: ['project_id', 'expected_fingerprint', 'analysis'], approval: ['online_writes'], requiresRevision: true },
  'workspace.card.create': { endpoint: 'p19-workspace-command', command: 'card.create', fields: ['project_id', 'expected_fingerprint', 'card'], approval: ['online_writes'], requiresRevision: true },
  'workspace.brief.assemble': { endpoint: 'p19-workspace-command', command: 'brief.assemble', fields: ['project_id', 'expected_fingerprint', 'brief'], approval: ['online_writes'], requiresRevision: true },
  'workspace.handoff.create': { endpoint: 'p19-workspace-command', command: 'handoff.create', fields: ['project_id', 'expected_fingerprint', 'handoff'], approval: ['online_writes', 'handoff_creation'], requiresRevision: true },
  // The model may echo the already trusted project binding while asking for
  // a global P22 research operation. Accept only that exact trusted project
  // id, then strip it before crossing the P22 boundary (whose public request
  // contracts intentionally contain no project field for these operations).
  'research.status': { endpoint: 'p22-research-assist', action: 'status', fields: ['project_id'], optional: ['project_id'], approval: [], stripProjectId: true },
  'research.collect_url': { endpoint: 'p22-research-assist', action: 'collect_url', fields: ['url', 'project_id'], optional: ['project_id'], approval: ['paid_external_calls'], stripProjectId: true },
  'research.search_x': { endpoint: 'p22-research-assist', action: 'search', fields: ['keyword', 'count', 'sort', 'project_id'], optional: ['count', 'sort', 'project_id'], approval: ['paid_external_calls'], stripProjectId: true },
  'research.search_reddit': { endpoint: 'p22-research-assist', action: 'search_reddit', fields: ['keyword', 'count', 'sort', 'subreddit', 'time_filter', 'project_id'], optional: ['count', 'sort', 'subreddit', 'time_filter', 'project_id'], approval: ['paid_external_calls'], stripProjectId: true },
  'research.analyze_persisted': { endpoint: 'p22-research-assist', action: 'analyze_persisted', fields: ['project_id', 'evidence_id'], approval: ['paid_external_calls'] },
  'research.generate_similar': { endpoint: 'p22-research-assist', action: 'generate_similar', fields: ['project_id', 'evidence_id', 'analysis_id'], approval: ['paid_external_calls'] },
};

export const TOOL_DEFINITIONS = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([operation, value]) => [operation, Object.freeze({
    ...value,
    fields: Object.freeze([...value.fields]),
    optional: Object.freeze([...(value.optional || [])]),
    approval: Object.freeze([...value.approval]),
    requiresRevision: value.requiresRevision === true,
  })]),
));

function fail(code, field = null, extra = {}) {
  // Diagnostics carry only bounded identity labels — the exact operation and
  // the offending field — never payload values, tokens, headers or secrets.
  return { ok: false, code, diagnostics: { ...(field == null ? {} : { field }), ...extra } };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonSize(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

export function validateToolCall(input, trustedContext) {
  if (!plainObject(input)) return fail('INVALID_TOOL_CALL');
  const allowedEnvelope = new Set(['schema_version', 'operation', 'payload', 'idempotency_key', 'expected_revision']);
  const unknownEnvelope = Object.keys(input).find((key) => !allowedEnvelope.has(key));
  if (unknownEnvelope) return fail('UNKNOWN_FIELD', unknownEnvelope);
  if (input.schema_version !== TOOL_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH', 'schema_version');
  const definition = TOOL_DEFINITIONS[input.operation];
  if (!definition) return fail('OPERATION_DENIED', 'operation');
  if (!plainObject(input.payload)) return fail('PAYLOAD_INVALID', 'payload');
  if (jsonSize(input.payload) > MAX_PAYLOAD_BYTES) return fail('PAYLOAD_TOO_LARGE', 'payload');
  const optional = new Set(definition.optional);
  const allowedPayload = new Set(definition.fields);
  const unknownPayload = Object.keys(input.payload).find((key) => !allowedPayload.has(key));
  if (unknownPayload) return fail('UNKNOWN_PAYLOAD_FIELD', unknownPayload, { operation: input.operation });
  const missing = definition.fields.find((key) => !optional.has(key) && !Object.hasOwn(input.payload, key));
  if (missing) return fail('PAYLOAD_FIELD_REQUIRED', missing, { operation: input.operation });
  if (Object.hasOwn(input.payload, 'project_id') && !PROJECT_ID.test(String(input.payload.project_id || ''))) {
    return fail('PROJECT_ID_INVALID', 'project_id');
  }
  if (!trustedContext || !IDENTIFIER.test(String(trustedContext.task_id || ''))
    || !IDENTIFIER.test(String(trustedContext.user_id || ''))) return fail('TRUSTED_CONTEXT_INVALID');
  if (trustedContext.project_id && !PROJECT_ID.test(String(trustedContext.project_id))) return fail('TRUSTED_PROJECT_INVALID');
  if (input.payload.project_id && trustedContext.project_id && input.payload.project_id !== trustedContext.project_id) {
    return fail('PROJECT_BINDING_MISMATCH', 'project_id');
  }
  // Project creation derives a new ID at the P19 boundary. A task submitted
  // for an existing project must never escape that trusted project scope.
  if (input.operation === 'workspace.project.create' && trustedContext.project_id) {
    return fail('PROJECT_BINDING_MISMATCH', 'project');
  }
  if (typeof input.idempotency_key !== 'string' || !IDENTIFIER.test(input.idempotency_key)) {
    return fail('IDEMPOTENCY_KEY_INVALID', 'idempotency_key');
  }
  if (input.expected_revision != null && (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1)) {
    return fail('EXPECTED_REVISION_INVALID', 'expected_revision');
  }
  if (definition.requiresRevision && input.expected_revision == null) {
    return fail('EXPECTED_REVISION_REQUIRED', 'expected_revision');
  }
  for (const scope of definition.approval) {
    if (trustedContext.approval?.[scope] !== true) return fail('APPROVAL_REQUIRED', scope);
  }
  return {
    ok: true,
    value: {
      schema_version: TOOL_SCHEMA_VERSION,
      task_id: trustedContext.task_id,
      user_id: trustedContext.user_id,
      project_id: trustedContext.project_id || input.payload.project_id || null,
      operation: input.operation,
      payload: structuredClone(input.payload),
      idempotency_key: input.idempotency_key,
      expected_revision: input.expected_revision ?? null,
    },
    definition,
  };
}

export function toBoundaryRequest(validated) {
  const definition = TOOL_DEFINITIONS[validated.operation];
  if (!definition) throw Object.assign(new Error('Operation is not allowlisted.'), { code: 'OPERATION_DENIED' });
  // Model-provided keys are only unique within one trusted Harness task. The
  // downstream ledgers are user-global, so bind the key to the trusted task ID
  // before crossing that boundary. Exact retries in one task still replay,
  // while independent tasks cannot collide even if the model repeats a key.
  const boundaryIdempotencyKey = `h-${createHash('sha256')
    .update(`${validated.task_id}\0${validated.idempotency_key}`, 'utf8')
    .digest('hex')}`;
  if (definition.endpoint === 'p19-workspace-command') {
    return {
      endpoint: definition.endpoint,
      body: {
        schema_version: 'p19_command_contract_v1',
        command: definition.command,
        idempotency_key: boundaryIdempotencyKey,
        payload: {
          ...structuredClone(validated.payload),
          ...(validated.expected_revision == null ? {} : { expected_revision: validated.expected_revision }),
        },
      },
    };
  }
  if (definition.stripProjectId === true) {
    const payload = structuredClone(validated.payload);
    delete payload.project_id;
    return {
      endpoint: definition.endpoint,
      body: {
        action: definition.action,
        ...payload,
        idempotency_key: boundaryIdempotencyKey,
      },
    };
  }
  return {
    endpoint: definition.endpoint,
    body: {
      action: definition.action,
      ...structuredClone(validated.payload),
      idempotency_key: boundaryIdempotencyKey,
    },
  };
}

const RESULT_DATA_FIELDS = Object.freeze([
  'capabilities', 'limits', 'cost_tracking', 'execution_flags', 'items', 'analyses',
  'usage', 'draft', 'project_id', 'search_batch_id', 'platform', 'keyword', 'count',
  'sort_intent', 'time_filter', 'subreddit', 'collected_at', 'harness_summary',
]);

function normalizedData(source) {
  if (Object.hasOwn(source, 'data')) return structuredClone(source.data);
  const data = {};
  for (const field of RESULT_DATA_FIELDS) {
    if (Object.hasOwn(source, field)) data[field] = structuredClone(source[field]);
  }
  return Object.keys(data).length > 0 ? data : null;
}

function normalizedArtifactRefs(source) {
  const refs = Array.isArray(source.artifact_refs) ? [...source.artifact_refs] : [];
  if (plainObject(source.entity) && source.entity.id != null) refs.push(source.entity.id);
  return [...new Set(refs.map((value) => String(value).slice(0, 500)).filter(Boolean))].slice(0, 50);
}

export function normalizeToolResult(call, response) {
  const source = plainObject(response) ? response : {};
  const diagnostics = plainObject(source.diagnostics) ? source.diagnostics : { issues: [] };
  const body = {
    schema_version: TOOL_RESULT_SCHEMA_VERSION,
    ok: source.ok === true,
    code: String(source.code || (source.ok === true ? 'OK' : 'BOUNDARY_FAILED')).slice(0, 80),
    task_id: call.task_id,
    operation: call.operation,
    artifact_refs: source.ok === true ? normalizedArtifactRefs(source) : [],
    cost: plainObject(source.cost) ? structuredClone(source.cost) : null,
    diagnostics: structuredClone(diagnostics),
    data: source.ok === true ? normalizedData(source) : null,
    entity: source.ok === true && plainObject(source.entity) ? structuredClone(source.entity) : null,
  };
  if (jsonSize(body) > MAX_RESULT_BYTES) {
    return { ...body, ok: false, code: 'TOOL_RESULT_TOO_LARGE', data: null, entity: null, diagnostics: { issues: ['Tool result exceeded the bounded response limit.'] } };
  }
  return body;
}
