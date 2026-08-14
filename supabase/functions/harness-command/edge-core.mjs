/* global TextEncoder, URL */
const TASK_ID = /^ht-[0-9a-f-]{36}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROJECT_ID = /^prj-[0-9a-f]{24}$/;
const MAX_INTENT = 12_000;
const ROLE_RANK = Object.freeze({ viewer: 0, reviewer: 1, operator: 2, admin: 3 });

export const EDGE_SCHEMA_VERSION = 'ams_harness_edge_v1';

export function fixedGatewayBase(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) throw new Error('GATEWAY_URL_INVALID');
  return url;
}

function fail(code, field = null) {
  return { ok: false, code, diagnostics: { field } };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateEdgeRequest(input, { userId, accessRole } = {}) {
  if (!plainObject(input)) return fail('INVALID_REQUEST');
  const allowed = new Set(['schema_version', 'action', 'request_id', 'project_id', 'intent', 'approval', 'task_id', 'limit']);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return fail('UNKNOWN_FIELD', unknown);
  if (input.schema_version !== EDGE_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH', 'schema_version');
  if (typeof userId !== 'string' || !userId) return fail('AUTH_REQUIRED');
  if (!Object.hasOwn(ROLE_RANK, accessRole)) return fail('STAGING_ROLE_DENIED');
  if (!['submit', 'read', 'list', 'cancel'].includes(input.action)) return fail('ACTION_DENIED', 'action');
  if (input.action === 'submit') {
    if (ROLE_RANK[accessRole] < ROLE_RANK.operator) return fail('OPERATOR_REQUIRED');
    if (!REQUEST_ID.test(String(input.request_id || ''))) return fail('REQUEST_ID_INVALID', 'request_id');
    if (input.project_id != null && !PROJECT_ID.test(String(input.project_id))) return fail('PROJECT_ID_INVALID', 'project_id');
    if (typeof input.intent !== 'string' || !input.intent.trim() || input.intent.length > MAX_INTENT) return fail('INTENT_INVALID', 'intent');
    const approval = input.approval ?? {};
    if (!plainObject(approval)) return fail('APPROVAL_INVALID', 'approval');
    const approvalKeys = new Set(['paid_external_calls', 'online_writes', 'handoff_creation']);
    const unknownApproval = Object.keys(approval).find((key) => !approvalKeys.has(key));
    if (unknownApproval) return fail('APPROVAL_UNKNOWN_FIELD', unknownApproval);
    for (const key of approvalKeys) if (approval[key] != null && typeof approval[key] !== 'boolean') return fail('APPROVAL_INVALID', key);
    return {
      ok: true,
      method: 'POST',
      path: '/v1/tasks',
      body: {
        schema_version: 'ams_harness_gateway_v1',
        request_id: input.request_id,
        user_id: userId,
        project_id: input.project_id ?? null,
        intent: input.intent.trim(),
        approval: Object.fromEntries([...approvalKeys].map((key) => [key, approval[key] === true])),
      },
    };
  }
  if (input.action === 'list') {
    const limit = input.limit == null ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail('LIMIT_INVALID', 'limit');
    return { ok: true, method: 'GET', path: `/v1/tasks?limit=${limit}`, body: null };
  }
  if (!TASK_ID.test(String(input.task_id || ''))) return fail('TASK_ID_INVALID', 'task_id');
  if (input.action === 'cancel' && ROLE_RANK[accessRole] < ROLE_RANK.operator) return fail('OPERATOR_REQUIRED');
  return {
    ok: true,
    method: input.action === 'cancel' ? 'POST' : 'GET',
    path: `/v1/tasks/${input.task_id}${input.action === 'cancel' ? '/cancel' : ''}`,
    body: input.action === 'cancel' ? {} : null,
  };
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function signGatewayRequest(secret, { method, path, userId, timestamp, rawBody, delegatedAuthorization }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('GATEWAY_SECRET_INVALID');
  const authorizationDigest = delegatedAuthorization ? await sha256Hex(delegatedAuthorization) : '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const message = `${method.toUpperCase()}\n${path.split('?')[0]}\n${userId}\n${timestamp}\n${authorizationDigest}\n${rawBody}`;
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)))].map((value) => value.toString(16).padStart(2, '0')).join('');
  return { signature, authorizationDigest };
}
