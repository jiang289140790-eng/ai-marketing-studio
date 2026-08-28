/* global Buffer, fetch, URL */
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { signRequest } from './gateway-core.mjs';

const BOOTSTRAP_HEADER = 'x-ams-bootstrap';
const MAX_JSON_BODY = 2 * 1024 * 1024;

export const BOOTSTRAP_SCRIPT = `<script>(()=>{const k='ams_native_bootstrap_v1';const p=new URLSearchParams(location.hash.slice(1));const incoming=p.get('ams-bootstrap');if(incoming){sessionStorage.setItem(k,incoming);history.replaceState(null,'',location.pathname+location.search)}const original=globalThis.fetch.bind(globalThis);globalThis.fetch=(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return original(input,init);const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));const bootstrap=sessionStorage.getItem(k);if(bootstrap)headers.set('${BOOTSTRAP_HEADER}',bootstrap);return original(input,{...init,headers})}})()</script>`;

export function injectBootstrapScript(html) {
  const source = String(html || '');
  return source.includes('</head>') ? source.replace('</head>', `${BOOTSTRAP_SCRIPT}</head>`) : `${BOOTSTRAP_SCRIPT}${source}`;
}

export function requestSessionId(pathname, rawBody, responseBody = '') {
  try {
    const request = JSON.parse(rawBody || '{}');
    const direct = request?.payload?.sessionId;
    if (typeof direct === 'string' && direct) return direct;
    if (pathname === '/api/session.create' && responseBody) {
      const response = JSON.parse(responseBody);
      const created = response?.result?.value?.sessionId;
      if (typeof created === 'string' && created) return created;
    }
  } catch { /* malformed requests remain the upstream API's responsibility */ }
  return '';
}

function readBoundedBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(Object.assign(new Error('request too large'), { code: 'BODY_TOO_LARGE' }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolveBody(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function createWebAuthProxy({
  upstreamPort = 8793,
  gatewayUrl = 'http://127.0.0.1:8790',
  gatewaySecret,
} = {}) {
  const bound = new Set();

  async function bind(bootstrapId, sessionId) {
    if (!bootstrapId || !sessionId) return;
    const key = `${bootstrapId}:${sessionId}`;
    if (bound.has(key)) return;
    const path = '/v1/native-sessions/bind';
    const rawBody = JSON.stringify({ bootstrap_id: bootstrapId, session_id: sessionId });
    const userId = 'harness-web';
    const timestamp = String(Date.now());
    const signature = signRequest(gatewaySecret, { method: 'POST', path, userId, timestamp, rawBody });
    const response = await fetch(new URL(path, gatewayUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ams-user-id': userId,
        'x-ams-timestamp': timestamp,
        'x-ams-signature': signature,
      },
      body: rawBody,
      redirect: 'error',
    });
    if (!response.ok) throw Object.assign(new Error('native session binding failed'), { code: 'NATIVE_SESSION_BIND_FAILED' });
    bound.add(key);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const isJsonApi = request.method === 'POST' && url.pathname.startsWith('/api/')
      && String(request.headers['content-type'] || '').toLowerCase().includes('application/json');
    let requestBody = null;
    try {
      if (isJsonApi) requestBody = await readBoundedBody(request);
    } catch {
      response.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, code: 'BODY_TOO_LARGE' }));
      return;
    }

    const bootstrapId = String(request.headers[BOOTSTRAP_HEADER] || '').trim();
    const rawBody = requestBody?.toString('utf8') || '';
    const beforeSessionId = requestSessionId(url.pathname, rawBody);
    if (bootstrapId && beforeSessionId) {
      try { await bind(bootstrapId, beforeSessionId); } catch {
        response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: 'NATIVE_SESSION_BIND_FAILED' }));
        return;
      }
    }

    const headers = { ...request.headers, 'accept-encoding': 'identity' };
    delete headers[BOOTSTRAP_HEADER];
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers }, (upstreamResponse) => {
      const transformHtml = request.method === 'GET' && url.pathname === '/';
      const captureCreate = isJsonApi && url.pathname === '/api/session.create' && bootstrapId;
      if (!transformHtml && !captureCreate) {
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
        return;
      }
      const chunks = [];
      upstreamResponse.on('data', (chunk) => chunks.push(chunk));
      upstreamResponse.on('end', async () => {
        let body = Buffer.concat(chunks);
        if (transformHtml && (upstreamResponse.statusCode || 500) < 400) {
          body = Buffer.from(injectBootstrapScript(body.toString('utf8')), 'utf8');
        }
        if (captureCreate && (upstreamResponse.statusCode || 500) < 400) {
          const sessionId = requestSessionId(url.pathname, rawBody, body.toString('utf8'));
          try { await bind(bootstrapId, sessionId); } catch {
            response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ ok: false, code: 'NATIVE_SESSION_BIND_FAILED' }));
            return;
          }
        }
        const responseHeaders = { ...upstreamResponse.headers, 'content-length': String(body.length) };
        delete responseHeaders['content-encoding'];
        response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        response.end(body);
      });
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('Harness upstream unavailable.');
    });
    if (requestBody) upstream.end(requestBody);
    else request.pipe(upstream);
  });

  server.on('upgrade', (request, socket, head) => {
    const upstream = createConnection({ host: '127.0.0.1', port: upstreamPort }, () => {
      const headers = Object.entries(request.headers)
        .filter(([name]) => name.toLowerCase() !== BOOTSTRAP_HEADER)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
        .join('\r\n');
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
  });

  return server;
}

export function startWebAuthProxy() {
  const secretPath = process.env.AMS_GATEWAY_HMAC_SECRET_FILE || '';
  const gatewaySecret = secretPath ? readFileSync(secretPath, 'utf8').trim() : '';
  if (gatewaySecret.length < 32) throw new Error('AMS gateway signing secret is required.');
  const upstreamPort = Number(process.env.HARNESS_WEB_UPSTREAM_PORT || 8793);
  const listenPort = Number(process.env.HARNESS_WEB_PORT || 8792);
  const dshBin = '/app/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const child = spawn(process.execPath, [
    '--expose-internals', dshBin, 'web', '--host', '127.0.0.1', '--port', String(upstreamPort),
    '--no-open', '--trusted-host', 'harness-web.47-251-244-196.sslip.io',
  ], { stdio: 'inherit', env: process.env });
  child.once('exit', (code) => process.exit(code ?? 1));
  const server = createWebAuthProxy({ listenPort, upstreamPort, gatewaySecret });
  server.listen(listenPort, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close();
    child.kill(signal);
  });
  return { server, child };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) startWebAuthProxy();
