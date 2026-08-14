/* global Buffer, setTimeout, URL */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { HarnessTaskQueue, verifySignedRequest } from './gateway-core.mjs';
import { createHarnessRunner, harnessReadiness } from './harness-runner.mjs';
import { appendTaskEvent, loadTaskSnapshots } from './state-store.mjs';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.AMS_GATEWAY_HMAC_SECRET_FILE
  ? readFileSync(process.env.AMS_GATEWAY_HMAC_SECRET_FILE, 'utf8').trim()
  : '';
const EVENT_FILE = process.env.HARNESS_EVENT_FILE || '/data/gateway/events.jsonl';
const MAX_BODY = 64 * 1024;

const initialTasks = await loadTaskSnapshots(EVENT_FILE);
const queue = new HarnessTaskQueue({
  runner: createHarnessRunner(),
  initialTasks,
  onEvent: (event) => appendTaskEvent(EVENT_FILE, event),
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
  if (request.method === 'GET' && url.pathname === '/healthz') return send(response, 200, { ok: true, service: 'ams-harness-gateway', queue: queue.status() });
  if (request.method === 'GET' && url.pathname === '/readyz') {
    const readiness = harnessReadiness();
    const queueStatus = queue.status();
    const ready = SECRET.length >= 32 && readiness.executable_configured && readiness.workspace_configured && queueStatus.audit_healthy;
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
  const signed = verifySignedRequest({
    secret: SECRET,
    method: request.method,
    path: url.pathname,
    userId,
    timestamp: String(request.headers['x-ams-timestamp'] || ''),
    signature: String(request.headers['x-ams-signature'] || ''),
    rawBody,
  });
  if (!signed) return send(response, 401, { ok: false, code: 'UNAUTHORIZED' });
  if (request.method === 'POST' && url.pathname === '/v1/tasks') {
    let body;
    try { body = JSON.parse(rawBody); } catch { return send(response, 400, { ok: false, code: 'INVALID_JSON' }); }
    if (body.user_id !== userId) return send(response, 403, { ok: false, code: 'USER_BINDING_MISMATCH' });
    let result;
    try { result = queue.submit(body); } catch { return send(response, 503, { ok: false, code: 'AUDIT_PERSISTENCE_UNAVAILABLE' }); }
    return send(response, result.ok ? (result.replayed ? 200 : 202) : result.code === 'QUEUE_FULL' ? 429 : result.code === 'AUDIT_PERSISTENCE_UNAVAILABLE' ? 503 : 400, result);
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
    return send(response, 200, { ok: true, tasks: queue.list(userId, limit) });
  }
  return send(response, 404, { ok: false, code: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => process.stderr.write(`ams-harness-gateway listening on ${HOST}:${PORT}\n`));

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    queue.shutdown();
    server.close(async () => {
      await Promise.race([queue.whenIdle(), new Promise((resolve) => setTimeout(resolve, 7_000))]);
      process.exit(0);
    });
  });
}
