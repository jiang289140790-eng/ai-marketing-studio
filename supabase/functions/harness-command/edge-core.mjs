/* global TextEncoder, URL */
const TASK_ID = /^ht-[0-9a-f-]{36}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PROJECT_ID = /^prj-[0-9a-f]{24}$/;
const THREAD_ID = /^thr_[0-9a-f-]{36}$/;
const MESSAGE_CURSOR = /^\d{1,19}$/;
const MAX_INTENT = 12_000;
const ROLE_RANK = Object.freeze({ viewer: 0, reviewer: 1, operator: 2, admin: 3 });

export const EDGE_SCHEMA_VERSION = 'ams_harness_edge_v1';

const DEFINITIVE_DELIVERY_REJECTIONS = new Set([
  'INVALID_JSON', 'DELEGATED_AUTHORIZATION_REQUIRED', 'USER_BINDING_MISMATCH',
  'THREAD_BINDING_MISMATCH', 'GENERATION_ID_INVALID',
]);

export function classifyDeliveryResponse(status, payload) {
  if (status >= 200 && status < 300 && payload?.accepted === true && typeof payload?.deliveryId === 'string') return 'accepted';
  if (status >= 400 && status < 500 && payload?.ok === false && DEFINITIVE_DELIVERY_REJECTIONS.has(payload.code)) return 'rejected';
  return 'confirmation_unknown';
}

export function isOrdinaryConversationIntent(content) {
  const normalized = String(content || '').trim().replace(/[？?。!！]+$/u, '');
  if (!normalized) return false;
  if (/^(?:你|您)?(?:能|可以|会)(?:做|干|帮我做)(?:什么|哪些|啥)$/u.test(normalized)) return true;
  return /^(?:你是谁|怎么使用|如何使用|还有呢|还有什么|其他呢|其他的呢|别的呢|还有其他的吗)$/u.test(normalized);
}

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
  const allowed = new Set(['schema_version', 'action', 'request_id', 'project_id', 'workspace_id', 'title', 'thread_id', 'content', 'attachments', 'client_message_id', 'cursor', 'intent', 'approval', 'task_id', 'plan_fingerprint', 'step_id', 'limit']);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) return fail('UNKNOWN_FIELD', unknown);
  if (input.schema_version !== EDGE_SCHEMA_VERSION) return fail('SCHEMA_VERSION_MISMATCH', 'schema_version');
  if (typeof userId !== 'string' || !userId) return fail('AUTH_REQUIRED');
  if (!Object.hasOwn(ROLE_RANK, accessRole)) return fail('STAGING_ROLE_DENIED');
  const threadActions = new Set(['thread_create', 'thread_get', 'thread_send', 'thread_send_agent', 'thread_messages', 'thread_events', 'thread_stop']);
  if (threadActions.has(input.action)) {
    if (input.action === 'thread_create') {
      if (ROLE_RANK[accessRole] < ROLE_RANK.operator) return fail('OPERATOR_REQUIRED');
      if (!REQUEST_ID.test(String(input.request_id || ''))) return fail('REQUEST_ID_INVALID', 'request_id');
      if (input.workspace_id !== 'ai-marketing-studio-staging') return fail('WORKSPACE_ACCESS_DENIED', 'workspace_id');
      if (input.project_id != null && !PROJECT_ID.test(String(input.project_id))) return fail('PROJECT_ID_INVALID', 'project_id');
      if (input.title != null && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)) return fail('TITLE_INVALID', 'title');
      return { ok: true, contract: 'thread_create', body: { request_id: input.request_id, workspace_id: input.workspace_id, project_id: input.project_id ?? null, title: input.title?.trim() || null } };
    }
    if (!THREAD_ID.test(String(input.thread_id || ''))) return fail('THREAD_ID_INVALID', 'thread_id');
    if (input.action === 'thread_send' || input.action === 'thread_send_agent') {
      if (ROLE_RANK[accessRole] < ROLE_RANK.operator) return fail('OPERATOR_REQUIRED');
      if (!REQUEST_ID.test(String(input.request_id || ''))) return fail('REQUEST_ID_INVALID', 'request_id');
      if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 32_000) return fail('CONTENT_INVALID', 'content');
      if (input.client_message_id != null && !REQUEST_ID.test(String(input.client_message_id))) return fail('CLIENT_MESSAGE_ID_INVALID', 'client_message_id');
      if (!Array.isArray(input.attachments ?? []) || (input.attachments ?? []).length > 10) return fail('ATTACHMENTS_INVALID', 'attachments');
      for (const attachment of input.attachments ?? []) {
        if (!plainObject(attachment) || attachment.bucket !== 'harness-thread-attachments'
          || typeof attachment.path !== 'string' || !attachment.path.startsWith(`${userId}/${input.thread_id}/`)
          || typeof attachment.name !== 'string' || !attachment.name || attachment.name.length > 200
          || !Number.isSafeInteger(attachment.size) || attachment.size < 1 || attachment.size > 25 * 1024 * 1024) return fail('ATTACHMENT_INVALID', 'attachments');
      }
      return { ok: true, contract: input.action, body: { thread_id: input.thread_id, request_id: input.request_id, content: input.content.trim(), attachments: input.attachments ?? [], client_message_id: input.client_message_id ?? null } };
    }
    if (input.cursor != null && !MESSAGE_CURSOR.test(String(input.cursor))) return fail('CURSOR_INVALID', 'cursor');
    const limit = input.limit == null ? 100 : input.limit;
    if ((input.action === 'thread_messages' || input.action === 'thread_events') && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) return fail('LIMIT_INVALID', 'limit');
    return { ok: true, contract: input.action, body: { thread_id: input.thread_id, cursor: Number(input.cursor || 0), limit } };
  }
  if (!['submit', 'plan', 'confirm', 'retry_failed_step', 'read', 'list', 'cancel'].includes(input.action)) return fail('ACTION_DENIED', 'action');
  if (input.action === 'submit' || input.action === 'plan') {
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
    if (input.action === 'plan' && Object.keys(approval).length > 0) return fail('PLAN_APPROVAL_FORBIDDEN', 'approval');
    return {
      ok: true,
      method: 'POST',
      path: input.action === 'plan' ? '/v1/tasks/plan' : '/v1/tasks',
      body: {
        schema_version: 'ams_harness_gateway_v1',
        request_id: input.request_id,
        user_id: userId,
        project_id: input.project_id ?? null,
        intent: input.intent.trim(),
        ...(input.action === 'submit' ? { approval: Object.fromEntries([...approvalKeys].map((key) => [key, approval[key] === true])) } : {}),
      },
    };
  }
  if (input.action === 'list') {
    const limit = input.limit == null ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail('LIMIT_INVALID', 'limit');
    return { ok: true, method: 'GET', path: `/v1/tasks?limit=${limit}`, body: null };
  }
  if (!TASK_ID.test(String(input.task_id || ''))) return fail('TASK_ID_INVALID', 'task_id');
  if (input.action === 'confirm' || input.action === 'retry_failed_step') {
    if (ROLE_RANK[accessRole] < ROLE_RANK.operator) return fail('OPERATOR_REQUIRED');
    if (typeof input.plan_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(input.plan_fingerprint)) return fail('PLAN_FINGERPRINT_INVALID', 'plan_fingerprint');
    const approval = input.approval ?? {};
    if (!plainObject(approval)) return fail('APPROVAL_INVALID', 'approval');
    const approvalKeys = new Set(['paid_external_calls', 'online_writes', 'handoff_creation']);
    const unknownApproval = Object.keys(approval).find((key) => !approvalKeys.has(key));
    if (unknownApproval) return fail('APPROVAL_UNKNOWN_FIELD', unknownApproval);
    for (const key of approvalKeys) if (typeof approval[key] !== 'boolean') return fail('APPROVAL_INVALID', key);
    if (input.action === 'retry_failed_step' && !/^st-\d+$/.test(String(input.step_id || ''))) return fail('STEP_ID_INVALID', 'step_id');
    return {
      ok: true,
      method: 'POST',
      path: `/v1/tasks/${input.task_id}/${input.action === 'confirm' ? 'confirm' : 'retry'}`,
      body: {
        schema_version: 'ams_harness_gateway_v1',
        task_id: input.task_id,
        plan_fingerprint: input.plan_fingerprint,
        ...(input.action === 'retry_failed_step' ? { step_id: input.step_id } : {}),
        approval: Object.fromEntries([...approvalKeys].map((key) => [key, approval[key] === true])),
      },
    };
  }
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

export async function verifyGatewayCallback(secret, { method, path, userId, timestamp, rawBody, signature, now = Date.now() }) {
  if (!/^\d{13}$/.test(String(timestamp || '')) || Math.abs(now - Number(timestamp)) > 60_000
    || !/^[0-9a-f]{64}$/.test(String(signature || ''))) return false;
  const expected = await signGatewayRequest(secret, { method, path, userId, timestamp, rawBody, delegatedAuthorization: '' });
  const left = new TextEncoder().encode(expected.signature);
  const right = new TextEncoder().encode(signature);
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function reduceGenerationOutcome(current, frame) {
  const outcome = current || { state: 'completed', code: null };
  if (frame?.type === 'gateway_completed' && frame.ok === false) return { state: 'failed', code: frame.code || 'GENERATION_FAILED' };
  if (frame?.type === 'conversation_completed' || (frame?.type === 'session_event' && frame.event?.type === 'conversation_completed')) {
    const completed = frame.type === 'conversation_completed' ? frame : frame.event;
    const reason = completed?.data?.reason?.kind || completed?.data?.reason || completed?.reason?.kind || completed?.reason;
    if (['aborted', 'stopped', 'cancelled'].includes(reason)) return { state: 'stopped', code: 'GENERATION_STOPPED' };
  }
  return outcome;
}

export function extractAssistantTextDelta(chunk) {
  if (chunk?.type !== 'text-delta') return '';
  return typeof chunk.text === 'string' ? chunk.text
    : typeof chunk.delta === 'string' ? chunk.delta
      : typeof chunk.delta?.text === 'string' ? chunk.delta.text : '';
}

export function isAcceptedMessageReplay(message, claim) {
  return message?.replayed === true && claim?.claimed === false
    && ['generation_active', 'generation_replayed'].includes(claim?.reason);
}
