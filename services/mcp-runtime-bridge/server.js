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

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, await health(request));
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
      setImmediate(() => executeAction(body));
      return sendJson(response, 202, { ok: true, status: 'queued', progress: 5, bridge_run_id: bridgeRunId });
    }

    return sendJson(response, 404, { ok: false, code: 'RESOURCE_NOT_FOUND', message: '接口不存在。' });
  } catch (error) {
    return sendJson(response, 500, { ok: false, code: 'MCP_UNAVAILABLE', message: sanitizeError(error), retryable: true });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI Marketing Studio MCP Runtime Bridge listening on http://${HOST}:${PORT}`);
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
