/* global Buffer, fetch, URL */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const ALLOWED_PATHS = new Set(['/chat/completions', '/v1/chat/completions']);

export function validateProxyRequest({ method, pathname, search, contentType }) {
  if (method !== 'POST') return { ok: false, status: 405, code: 'METHOD_NOT_ALLOWED' };
  if (!ALLOWED_PATHS.has(pathname) || search) return { ok: false, status: 404, code: 'ENDPOINT_NOT_ALLOWED' };
  if (!String(contentType || '').toLowerCase().startsWith('application/json')) return { ok: false, status: 415, code: 'CONTENT_TYPE_INVALID' };
  return { ok: true };
}

function sendJson(response, status, code) {
  const body = JSON.stringify({ error: { code, message: 'Model gateway request failed.' } });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBoundedBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('Request too large.'), { code: 'REQUEST_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createModelProxy({ apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 16) throw new Error('DeepSeek credential is unavailable.');
  return createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://model-proxy.internal');
    const validated = validateProxyRequest({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      contentType: request.headers['content-type'],
    });
    if (!validated.ok) return sendJson(response, validated.status, validated.code);
    let body;
    try {
      body = await readBoundedBody(request);
      JSON.parse(body.toString('utf8'));
    } catch (error) {
      return sendJson(response, error?.code === 'REQUEST_TOO_LARGE' ? 413 : 400, error?.code || 'INVALID_JSON');
    }
    let upstream;
    try {
      upstream = await fetchImpl(`https://api.deepseek.com${url.pathname}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      });
    } catch {
      return sendJson(response, 502, 'MODEL_UPSTREAM_UNAVAILABLE');
    }
    if (!upstream.ok || !upstream.body) return sendJson(response, 502, 'MODEL_UPSTREAM_REJECTED');
    response.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
    });
    let size = 0;
    try {
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Response too large.');
        response.write(chunk);
      }
      response.end();
    } catch {
      response.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secretPath = process.env.DEEPSEEK_API_KEY_FILE || '';
  const apiKey = secretPath ? readFileSync(secretPath, 'utf8').trim() : '';
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.MODEL_PROXY_PORT || 8791);
  createModelProxy({ apiKey }).listen(port, host, () => process.stderr.write(`ams-harness-model-proxy listening on ${host}:${port}\n`));
}
