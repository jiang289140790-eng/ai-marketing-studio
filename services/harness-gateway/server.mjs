/* global Buffer, setTimeout, URL */
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HarnessTaskQueue, runWithIsolatedTaskView, runWithTaskTimeout, validateDelegatedAuthorization, verifySignedRequest } from './gateway-core.mjs';
import { createHarnessRunner, harnessReadiness } from './harness-runner.mjs';
import { appendTaskEvent, loadTaskEvents, loadTaskSnapshots } from './state-store.mjs';
import { createPlanner } from './planner.mjs';
import { createDeepSeekSemanticPlanner } from './semantic-planner.mjs';
import { createBridgeStateReader, executeConfirmedPlan } from './deterministic-executor.mjs';
import { createToolClient } from './tool-client.mjs';
import { createConversationRunner } from './conversation-runner.mjs';
import { createTaskProjector } from './task-projector.mjs';
import { createConversationProjector } from './conversation-projector.mjs';
import { createConversationDeliveryQueue } from './conversation-delivery-queue.mjs';
import { appendConversationEvent, loadConversationEvents } from './conversation-event-store.mjs';
import { buildCapabilityManifest } from './capability-registry.mjs';
import { createNativeSessionRegistry } from './native-session-registry.mjs';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.AMS_GATEWAY_HMAC_SECRET_FILE
  ? readFileSync(process.env.AMS_GATEWAY_HMAC_SECRET_FILE, 'utf8').trim()
  : '';
const BRIDGE_SECRET = process.env.AMS_TOOL_BRIDGE_SECRET_FILE
  ? readFileSync(process.env.AMS_TOOL_BRIDGE_SECRET_FILE, 'utf8').trim()
  : '';
const EVENT_FILE = process.env.HARNESS_EVENT_FILE || '/data/gateway/events.jsonl';
const PROJECTOR_ACK_FILE = process.env.HARNESS_PROJECTOR_ACK_FILE || '/data/gateway/projected-events.log';
const CONVERSATION_PROJECTOR_ACK_FILE = process.env.HARNESS_CONVERSATION_PROJECTOR_ACK_FILE || '/data/gateway/projected-conversation-events.log';
const CONVERSATION_DELIVERY_FILE = process.env.HARNESS_CONVERSATION_DELIVERY_FILE || '/data/gateway/conversation-deliveries.jsonl';
const CONVERSATION_EVENT_FILE = process.env.HARNESS_CONVERSATION_EVENT_FILE || '/data/gateway/conversation-events.jsonl';
const MAX_BODY = 64 * 1024;
const TASK_TIMEOUT_MS = Number(process.env.HARNESS_TASK_TIMEOUT_MS || 600_000);
const TOOL_WINDOW_MS = 150_000;
const QUEUE_CAPACITY = 2;
const nativeSessions = createNativeSessionRegistry();
const semanticPlanner = createDeepSeekSemanticPlanner({
  endpoint: process.env.AMS_MODEL_PROXY_URL || 'http://127.0.0.1:8791/v1/chat/completions',
  model: process.env.HARNESS_PLANNER_MODEL || 'deepseek-chat',
  timeoutMs: Number(process.env.HARNESS_PLANNER_TIMEOUT_MS || 20_000),
});

// The deterministic executor is the only code that turns a confirmed plan
// into tool calls. Planning uses the deterministic intent classifier (the
// configured model is never asked to author workflows or payloads); a
// model-based slot extractor may be injected later through the same
// fail-closed planner contract.
function createDeterministicRunner() {
  return async (request, taskId, signal, runtimeContext, taskView, emit) => {
    const toolClient = createToolClient({
      bridgeUrl: process.env.AMS_TOOL_BRIDGE_URL || '',
      bridgeSecret: BRIDGE_SECRET,
      allowInternalHttp: true,
      delegatedAuthorization: runtimeContext?.delegatedAuthorization || '',
    });
    const stateReader = createBridgeStateReader(toolClient);
    return runWithTaskTimeout({
      signal,
      timeoutMs: TASK_TIMEOUT_MS,
      run: (taskSignal) => runWithIsolatedTaskView({
        taskView,
        signal: taskSignal,
        emit,
        run: (isolatedTask, isolatedEmit) => executeConfirmedPlan({
          taskView: isolatedTask,
          plan: isolatedTask.plan,
          signal: taskSignal,
          emit: isolatedEmit,
          toolClient,
          stateReader,
        }),
      }),
    });
  };
}

const initialTasks = await loadTaskSnapshots(EVENT_FILE);
const unacknowledgedCandidates = await loadTaskEvents(EVENT_FILE);
const taskProjector = createTaskProjector({
  callbackBase: process.env.AMS_CONVERSATION_CALLBACK_URL || '',
  secret: SECRET,
  ackFile: PROJECTOR_ACK_FILE,
});
for (const event of unacknowledgedCandidates) taskProjector.enqueue(event);
const queue = new HarnessTaskQueue({
  runner: createHarnessRunner(),
  deterministicRunner: createDeterministicRunner(),
  planner: createPlanner({ modelPlanner: semanticPlanner }),
  capacity: QUEUE_CAPACITY,
  initialTasks,
  onEvent: (event) => {
    const durableEvent = { ...event, event_id: `gev_${randomUUID()}` };
    appendTaskEvent(EVENT_FILE, durableEvent);
    taskProjector.enqueue(durableEvent);
  },
  validateRuntimeContext: (runtimeContext, context) => validateDelegatedAuthorization(runtimeContext, {
    minimumValidityMs: context.phase === 'submit'
      ? ((context.position + 1) * TASK_TIMEOUT_MS) + TOOL_WINDOW_MS
      : TASK_TIMEOUT_MS + TOOL_WINDOW_MS,
  }),
});
const capabilityManifest = buildCapabilityManifest();
const conversations = createConversationRunner({
  timeoutMs: TASK_TIMEOUT_MS,
  journalFile: process.env.HARNESS_CONVERSATION_JOURNAL || '/data/gateway/conversations.jsonl',
  capabilityManifest: capabilityManifest.capabilities,
});
const conversationProjector = createConversationProjector({
  callbackBase: process.env.AMS_CONVERSATION_CALLBACK_URL || '',
  secret: SECRET,
  ackFile: CONVERSATION_PROJECTOR_ACK_FILE,
});
for (const event of loadConversationEvents(CONVERSATION_EVENT_FILE)) conversationProjector.enqueue(event);
const conversationDeliveries = createConversationDeliveryQueue({
  journalFile: CONVERSATION_DELIVERY_FILE,
  runner: conversations,
  planTask: (record, proposal) => queue.plan({
    schema_version: 'ams_harness_gateway_v1',
    request_id: `${record.request.request_id}:agent-plan`,
    user_id: record.user_id,
    project_id: record.request.project_id || null,
    intent: proposal.intent,
  }),
  onEvent: (event) => {
    if (event.event_type === 'agent_plan_created' && event.payload?.task?.id) {
      taskProjector.bindTask(event.payload.task.id, {
        user_id: event.user_id,
        thread_id: event.thread_id,
        project_id: event.payload.task.request?.project_id ?? null,
      });
    }
    appendConversationEvent(CONVERSATION_EVENT_FILE, event);
    conversationProjector.enqueue(event);
  },
});

function send(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  response.end(text);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large.'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true, service: 'ams-harness-gateway', queue: queue.status(), native_sessions: nativeSessions.counts() });
  if (request.method === 'GET' && url.pathname === '/readyz') {
    const readiness = harnessReadiness();
    const queueStatus = queue.status();
    const ready = SECRET.length >= 32 && /^https:\/\//.test(process.env.AMS_CONVERSATION_CALLBACK_URL || '')
      && readiness.executable_configured && readiness.model_credential_configured && readiness.workspace_configured
      && readiness.tool_bridge_configured && queueStatus.audit_healthy;
    return send(response, ready ? 200 : 503, { ok: ready, service: 'ams-harness-gateway', readiness, model_ready: readiness.model_credential_configured });
  }
  let rawBody = '';
  try {
    rawBody = await readBody(request);
  } catch (error) {
    return send(response, 413, { ok: false, code: error.code });
  }
  const userId = String(request.headers['x-ams-user-id'] || '').trim();
  if (!userId) return send(response, 401, { ok: false, code: 'USER_ID_REQUIRED' });
  const delegatedAuthorization = String(request.headers['x-ams-delegated-authorization'] || '').trim();
  const authorizationDigest = delegatedAuthorization
    ? createHash('sha256').update(delegatedAuthorization).digest('hex')
    : '';
  const signed = verifySignedRequest({
    secret: SECRET,
    method: request.method,
    path: url.pathname,
    userId,
    timestamp: String(request.headers['x-ams-timestamp'] || ''),
    signature: String(request.headers['x-ams-signature'] || ''),
    authorizationDigest,
    rawBody,
  });
  if (!signed) return send(response, 401, { ok: false, code: 'UNAUTHORIZED' });
  if (request.method === 'POST' && url.pathname === '/v1/native-bootstrap') {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    if (body.project_id != null && !/^prj-[0-9a-f]{24}$/.test(String(body.project_id))) {
      return send(response, 400, { ok: false, code: 'PROJECT_ID_INVALID' });
    }
    const created = nativeSessions.create({ delegatedAuthorization, userId, projectId: body.project_id ?? null });
    return send(response, created.ok ? 201 : 401, created.ok
      ? { ok: true, bootstrap_id: created.bootstrapId, expires_in: created.expiresIn }
      : created);
  }
  if (request.method === 'POST' && url.pathname === '/v1/native-sessions/bind') {
    if (userId !== 'harness-web') return send(response, 403, { ok: false, code: 'SERVICE_BINDING_MISMATCH' });
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    const bound = nativeSessions.bind(body.bootstrap_id, body.session_id);
    return send(response, bound.ok ? 200 : 409, bound.ok
      ? { ok: true, user_id: bound.userId, project_id: bound.projectId, expires_at: new Date(bound.expiresAt).toISOString() }
      : bound);
  }
  if (request.method === 'POST' && url.pathname === '/v1/native-sessions/context') {
    if (userId !== 'ams-tools') return send(response, 403, { ok: false, code: 'SERVICE_BINDING_MISMATCH' });
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    const context = nativeSessions.read(body.session_id);
    return send(response, context.ok ? 200 : 401, context.ok ? {
      ok: true,
      user_id: context.userId,
      project_id: context.projectId,
      delegated_authorization: context.delegatedAuthorization,
      approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
    } : context);
  }
  if (request.method === 'POST' && url.pathname === '/v1/native-sessions/current') {
    if (userId !== 'ams-tools') return send(response, 403, { ok: false, code: 'SERVICE_BINDING_MISMATCH' });
    let body;
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body && Object.keys(body).length > 0) return send(response, 400, { ok: false, code: 'NATIVE_SESSION_CURRENT_BODY_INVALID' });
    const context = nativeSessions.current();
    return send(response, context.ok ? 200 : 401, context.ok ? {
      ok: true,
      user_id: context.userId,
      project_id: context.projectId,
      delegated_authorization: context.delegatedAuthorization,
      approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
    } : context);
  }
  const messageMatch = url.pathname.match(/^\/v1\/threads\/(thr_[0-9a-f-]{36})\/messages$/);
  if (request.method === 'POST' && messageMatch) {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    if (body.thread_id !== messageMatch[1]) return send(response, 409, { ok: false, code: 'THREAD_BINDING_MISMATCH' });
    response.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    const result = await conversations.run(body, userId, {
      runtimeContext: {
        delegatedAuthorization,
        approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
      },
      onFrame: (frame) => response.write(`${JSON.stringify(frame)}\n`),
    });
    response.end(`${JSON.stringify({ type: 'gateway_completed', ...result })}\n`);
    return;
  }
  const deliveryMatch = url.pathname.match(/^\/v1\/threads\/(thr_[0-9a-f-]{36})\/deliveries$/);
  if (request.method === 'POST' && deliveryMatch) {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    if (body.thread_id !== deliveryMatch[1]) return send(response, 409, { ok: false, code: 'THREAD_BINDING_MISMATCH' });
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(body.generation_id || ''))) {
      return send(response, 400, { ok: false, code: 'GENERATION_ID_INVALID' });
    }
    let result;
    try {
      result = conversationDeliveries.enqueue(body, userId, {
        delegatedAuthorization,
        approval: { paid_external_calls: false, online_writes: false, handoff_creation: false },
      });
    }
    catch { return send(response, 503, { ok: false, code: 'DELIVERY_PERSISTENCE_FAILED' }); }
    return send(response, result.replayed ? 200 : 202, result);
  }
  const stopMatch = url.pathname.match(/^\/v1\/threads\/(thr_[0-9a-f-]{36})\/stop$/);
  if (request.method === 'POST' && stopMatch) {
    const result = conversationDeliveries.stop(userId, stopMatch[1]);
    return send(response, result.ok ? 202 : 409, result);
  }
  if (request.method === 'POST' && url.pathname === '/v1/tasks') {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    let result;
    try { result = queue.submit(body, { delegatedAuthorization }); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? (result.replayed ? 200 : 202) : result.code === 'QUEUE_FULL' ? 429 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 400, result);
  }
  if (request.method === 'POST' && url.pathname === '/v1/tasks/plan') {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    let result;
    try { result = await queue.plan(body, { delegatedAuthorization }); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? (result.replayed ? 200 : 202) : result.code === 'QUEUE_FULL' ? 429 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 400, result);
  }
  const confirmMatch = url.pathname.match(/^\/v1\/tasks\/(ht-[0-9a-f-]{36})\/confirm$/);
  if (request.method === 'POST' && confirmMatch) {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.task_id !== confirmMatch[1]) return send(response, 409, { ok: false, code: 'TASK_BINDING_MISMATCH' });
    let result;
    try { result = queue.confirm(body, userId, { delegatedAuthorization }); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? (result.replayed ? 200 : 202) : result.code === 'TASK_NOT_FOUND' ? 404 : result.code === 'QUEUE_FULL' ? 429 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 409, result);
  }
  const retryMatch = url.pathname.match(/^\/v1\/tasks\/(ht-[0-9a-f-]{36})\/retry$/);
  if (request.method === 'POST' && retryMatch) {
    if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) {
      return send(response, 401, { ok: false, code: 'DELEGATED_AUTHORIZATION_REQUIRED' });
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.task_id !== retryMatch[1]) return send(response, 409, { ok: false, code: 'TASK_BINDING_MISMATCH' });
    let result;
    try { result = queue.retry(body, userId, { delegatedAuthorization }); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? (result.replayed ? 200 : 202) : result.code === 'TASK_NOT_FOUND' ? 404 : result.code === 'QUEUE_FULL' ? 429 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 409, result);
  }
  const taskMatch = url.pathname.match(/^\/v1\/tasks\/(ht-[0-9a-f-]{36})$/);
  if (request.method === 'GET' && taskMatch) {
    const result = queue.read(taskMatch[1], userId);
    return send(response, result.ok ? 200 : 404, result);
  }
  const cancelMatch = url.pathname.match(/^\/v1\/tasks\/(ht-[0-9a-f-]{36})\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    let result;
    try { result = queue.cancel(cancelMatch[1], userId); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? 202 : result.code === 'TASK_NOT_FOUND' ? 404 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 409, result);
  }
  if (request.method === 'GET' && url.pathname === '/v1/tasks') {
    const limit = Number(url.searchParams.get('limit') || 50);
    return send(response, 200, { ok: true, tasks: queue.listSummaries(userId, limit) });
  }
  return send(response, 404, { ok: false, code: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => process.stderr.write(`ams-harness-gateway listening on ${HOST}:${PORT}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    taskProjector.close();
    conversationProjector.close();
    conversationDeliveries.close();
    queue.shutdown();
    server.close(async () => {
      await Promise.race([queue.whenIdle(), new Promise((resolve) => setTimeout(resolve, 7_000))]);
      process.exit(0);
    });
  });
}
