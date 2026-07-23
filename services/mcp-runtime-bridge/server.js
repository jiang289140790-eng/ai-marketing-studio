import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { verifyGatewaySignature, sanitizeError } from './auth.js';
import { validateActionRequest } from './schemas.js';
import { listMcpTools } from './mcp-client.js';
import { executeAction, getRun } from './worker.js';

const PORT = Number(process.env.MCP_RUNTIME_BRIDGE_PORT || 8787);
const HOST = process.env.MCP_RUNTIME_BRIDGE_HOST || '0.0.0.0';
const BRIDGE_SECRET = process.env.OPS_MCP_BRIDGE_SECRET || '';
const REQUEST_TIMEOUT_MS = Number(process.env.BRIDGE_REQUEST_TIMEOUT_MS || 60_000);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      const result = await health(request);
      audit('health', { ok: result.ok, mcp: result.mcp });
      return sendJson(response, result.ok ? 200 : 503, result);
    }

    if (request.method === 'GET' && request.url?.startsWith('/v1/runs/')) {
      const probe = request.headers['x-ops-probe'] || '{}';
      if (!verifyGatewaySignature({ body: String(probe), signature: request.headers['x-ops-signature'], secret: BRIDGE_SECRET })) {
        return sendJson(response, 401, { ok: false, code: 'AUTH_REQUIRED', message: 'Bridge 签名验证失败。' });
      }
      const runId = decodeURIComponent(request.url.split('/').pop() || '');
      return sendJson(response, 200, await getRun(runId));
    }

    if (request.method === 'POST' && request.url === '/v1/actions') {
      const rawBody = await readBody(request, 64 * 1024);
      if (!verifyGatewaySignature({ body: rawBody, signature: request.headers['x-ops-signature'], secret: BRIDGE_SECRET })) {
        return sendJson(response, 401, { ok: false, code: 'AUTH_REQUIRED', message: 'Bridge 签名验证失败。' });
      }
      const body = validateActionRequest(JSON.parse(rawBody));
      const bridgeRunId = randomUUID();
      audit('action_accepted', { action: body.action, run_id: body.run_id, bridge_run_id: bridgeRunId, resource_type: body.resource_type || null });
      setImmediate(() => executeAction(body));
      return sendJson(response, 202, { ok: true, status: 'queued', progress: 5, bridge_run_id: bridgeRunId });
    }

    return sendJson(response, 404, { ok: false, code: 'RESOURCE_NOT_FOUND', message: '接口不存在。' });
  } catch (error) {
    audit('request_failed', { method: request.method, path: request.url, error: sanitizeError(error) });
    return sendJson(response, 500, { ok: false, code: 'MCP_UNAVAILABLE', message: sanitizeError(error), retryable: true });
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 30_000);

server.listen(PORT, HOST, () => {
  audit('bridge_started', { host: HOST, port: PORT });
});

async function health(request) {
  const probe = request.headers['x-ops-probe'] || '{}';
  if (!verifyGatewaySignature({ body: String(probe), signature: request.headers['x-ops-signature'], secret: BRIDGE_SECRET })) {
    return { ok: false, bridge: true, mcp: false, error: 'Bridge health signature invalid.' };
  }
  try {
    const tools = await listMcpTools();
    return {
      ok: true,
      bridge: true,
      mcp: tools.length > 0,
      tools: tools.map((tool) => tool.name).slice(0, 50),
      x_mcp: process.env.X_MCP_ENABLED ? 'configured' : 'unknown',
      autodl: process.env.AUTODL_BASE_URL ? 'configured' : 'unknown',
      comfyui: process.env.COMFYUI_BASE_URL ? 'configured' : 'unknown',
      publish_adapter: 'dry-run-required',
    };
  } catch (error) {
    return { ok: false, bridge: true, mcp: false, error: sanitizeError(error) };
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        request.destroy();
        reject(new Error('请求体过大。'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function audit(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: 'mcp-runtime-bridge', event, ...details }));
}
