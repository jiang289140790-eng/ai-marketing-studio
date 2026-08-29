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
const SESSION_ID_MAX = 192;

export const BOOTSTRAP_SCRIPT = `<script>(()=>{const k='ams_native_bootstrap_v1';const sk='ams_native_session_id_v1';const bk='ams_native_bootstrap_bound_v1';const ck='ams_native_session_created_v1';const rk='ams_native_session_ready_v1';const p=new URLSearchParams(location.hash.slice(1));const incoming=p.get('ams-bootstrap');function clearHarnessSessionSelection(){const re=/(^|[-_.:])(session|conversation|thread|agent)([-_.:]|$)|current.*session|active.*session|selected.*session/i;for(const store of [sessionStorage,localStorage]){try{for(let i=store.length-1;i>=0;i--){const key=store.key(i)||'';if(key.startsWith('ams_native_'))continue;if(re.test(key))store.removeItem(key)}}catch{}}}function cleanHash(){try{history.replaceState(null,'',location.pathname+location.search)}catch{}}function makeSessionId(){return 'session-'+(crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+Math.random().toString(36).slice(2))}function rememberSelection(sessionId){try{localStorage.setItem('dsh.sessions.current',JSON.stringify({sessionId}))}catch{}try{sessionStorage.setItem(sk,sessionId)}catch{}}function forceSessionPayload(value,sessionId){if(!value||typeof value!=='object')return value;if(value.payload&&typeof value.payload==='object'){value.payload.sessionId=sessionId;value.payload.id=sessionId;value.payload.agentId=sessionId}if(value.params&&typeof value.params==='object'){value.params.sessionId=sessionId;value.params.id=sessionId;value.params.agentId=sessionId}if('sessionId'in value)value.sessionId=sessionId;if(value.session&&typeof value.session==='object')value.session.id=sessionId;if('agentId'in value)value.agentId=sessionId;if(value.agent&&typeof value.agent==='object')value.agent.id=sessionId;return value}function forceSessionBody(method,body,sessionId){if(typeof body!=='string'||!body.trim())return body;try{const value=JSON.parse(body);if(value&&typeof value==='object'&&String(method||'').startsWith('session.')){const payload=value.payload&&typeof value.payload==='object'?value.payload:{};value.payload={...payload,sessionId};if(value.payload.id)value.payload.id=sessionId;if(value.payload.agentId)value.payload.agentId=sessionId;return JSON.stringify(value)}return JSON.stringify(forceSessionPayload(value,sessionId))}catch{return body}}if(incoming){try{sessionStorage.removeItem(k);sessionStorage.removeItem(bk);sessionStorage.removeItem(sk);sessionStorage.removeItem(ck);sessionStorage.removeItem(rk);clearHarnessSessionSelection()}catch{}try{sessionStorage.setItem(k,incoming)}catch{}cleanHash()}let sid=sessionStorage.getItem(sk);if(!sid){sid=makeSessionId();rememberSelection(sid)}else rememberSelection(sid);const original=globalThis.fetch.bind(globalThis);globalThis.fetch=(input,init={})=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))return original(input,init);const headers=new Headers(init.headers||(input instanceof Request?input.headers:undefined));const bootstrap=sessionStorage.getItem(k);let nextInit={...init,headers};if(bootstrap){headers.set('${BOOTSTRAP_HEADER}',bootstrap);headers.set('x-ams-native-session-id',sid);const contentType=String(headers.get('content-type')||'').toLowerCase();const originalBody=init.body||(input instanceof Request?input.body:undefined);if(typeof originalBody==='string'&&contentType.includes('application/json')){const method=url.pathname.replace(/^\\/api\\//,'');nextInit={...nextInit,body:forceSessionBody(method,originalBody,sid)}}}return original(input,nextInit)};async function api(method,payload){const rpcId='ams-native-'+Date.now()+'-'+Math.random().toString(36).slice(2);const r=await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{...payload,sessionId:sid}}),redirect:'error'});return await r.json()}async function bindNow(){const bootstrap=sessionStorage.getItem(k);if(!bootstrap||sessionStorage.getItem(bk)===bootstrap+':'+sid)return false;const r=await fetch('/ams/native-bootstrap/bind',{method:'POST',headers:{'content-type':'application/json','${BOOTSTRAP_HEADER}':bootstrap},body:JSON.stringify({session_id:sid}),redirect:'error'});if(r.ok){sessionStorage.setItem(bk,bootstrap+':'+sid);return true}return false}async function ensureNativeSession(){const bootstrap=sessionStorage.getItem(k);if(!bootstrap)return;rememberSelection(sid);if(sessionStorage.getItem(ck)!==bootstrap+':'+sid){const listed=await api('workspace.list',{});const workspaces=listed&&listed.result&&listed.result.ok&&listed.result.value&&Array.isArray(listed.result.value.items)?listed.result.value.items:[];const workspace=workspaces.find((item)=>item&&item.title==='AI Marketing Studio')||workspaces[0];if(!workspace||!workspace.workspaceId)return;const created=await api('session.create',{workspaceId:workspace.workspaceId,sessionId:sid,id:sid,agentId:sid});if(created&&created.result&&created.result.ok)sessionStorage.setItem(ck,bootstrap+':'+sid)}const bound=await bindNow();rememberSelection(sid);if(bound&&sessionStorage.getItem(rk)!==bootstrap+':'+sid){sessionStorage.setItem(rk,bootstrap+':'+sid);location.replace(location.pathname+location.search)}}void ensureNativeSession().catch(()=>{})})()</script>`;

export function injectBootstrapScript(html) {
  const source = String(html || '');
  return source.includes('</head>') ? source.replace('</head>', `${BOOTSTRAP_SCRIPT}</head>`) : `${BOOTSTRAP_SCRIPT}${source}`;
}

function stableSessionId(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > SESSION_ID_MAX) return '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmed)) return '';
  return trimmed;
}

function explicitSessionId(value) {
  if (!value || typeof value !== 'object') return '';
  const candidates = [
    value?.payload?.sessionId,
    value?.payload?.id,
    value?.payload?.agentId,
    value?.params?.sessionId,
    value?.params?.id,
    value?.params?.agentId,
    value?.sessionId,
    value?.session?.id,
    value?.agentId,
    value?.agent?.id,
    value?.result?.value?.sessionId,
    value?.result?.value?.id,
    value?.result?.value?.agentId,
    value?.result?.sessionId,
    value?.result?.id,
    value?.data?.sessionId,
    value?.data?.id,
  ];
  for (const candidate of candidates) {
    const sessionId = stableSessionId(candidate);
    if (sessionId) return sessionId;
  }
  return '';
}

function forceSessionPayload(value, sessionId) {
  const stable = stableSessionId(sessionId);
  if (!stable || !value || typeof value !== 'object') return value;
  if (value.payload && typeof value.payload === 'object') {
    value.payload.sessionId = stable;
    if ('id' in value.payload) value.payload.id = stable;
    if ('agentId' in value.payload) value.payload.agentId = stable;
  }
  if (value.params && typeof value.params === 'object') {
    value.params.sessionId = stable;
    if ('id' in value.params) value.params.id = stable;
    if ('agentId' in value.params) value.params.agentId = stable;
  }
  if ('sessionId' in value) value.sessionId = stable;
  if (value.session && typeof value.session === 'object') value.session.id = stable;
  if ('agentId' in value) value.agentId = stable;
  if (value.agent && typeof value.agent === 'object') value.agent.id = stable;
  return value;
}

export function forceApiSessionBody(pathname, rawBody = '', sessionId = '') {
  const stable = stableSessionId(sessionId);
  if (!stable || typeof rawBody !== 'string' || !rawBody.trim()) return rawBody;
  const method = String(pathname || '').replace(/^\/api\//, '');
  if (!method.startsWith('session.')) return rawBody;
  try {
    return JSON.stringify(forceSessionPayload(JSON.parse(rawBody), stable));
  } catch {
    return rawBody;
  }
}

export function requestSessionId(pathname, rawBody, responseBody = '') {
  try {
    const request = JSON.parse(rawBody || '{}');
    const direct = explicitSessionId(request);
    if (direct) return direct;
    if (pathname === '/api/session.create' && responseBody) {
      const response = JSON.parse(responseBody);
      const created = explicitSessionId(response);
      if (created) return created;
    }
  } catch { /* malformed requests remain the upstream API's responsibility */ }
  return '';
}

export function pinSessionListCurrent(rawBody = '', sessionId = '') {
  const stable = stableSessionId(sessionId);
  if (!stable) return Buffer.from(String(rawBody || ''), 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(String(rawBody || '{}'));
  } catch {
    return Buffer.from(String(rawBody || ''), 'utf8');
  }
  const value = parsed?.result?.value;
  if (!parsed?.result?.ok || !value || typeof value !== 'object') return Buffer.from(String(rawBody || ''), 'utf8');
  const ids = Array.isArray(value.ids) ? value.ids : [];
  const byId = value.byId && typeof value.byId === 'object' ? value.byId : {};
  const present = ids.includes(stable) || Boolean(byId[stable]);
  if (!present) return Buffer.from(String(rawBody || ''), 'utf8');
  value.current = stable;
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

export function bootstrapBindSessionId(rawBody = '') {
  try {
    const request = JSON.parse(rawBody || '{}');
    return stableSessionId(request?.session_id);
  } catch { /* malformed bind requests are rejected by caller */ }
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
    if (!response.ok) {
      let code = 'NATIVE_SESSION_BIND_FAILED';
      try {
        const body = await response.json();
        if (body?.code) code = String(body.code);
      } catch { /* keep bounded fallback */ }
      throw Object.assign(new Error('native session binding failed'), { code });
    }
    bound.add(key);
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    const isGatewayNativeBootstrap = request.method === 'POST' && url.pathname === '/v1/native-bootstrap';
    const isBootstrapBind = request.method === 'POST' && url.pathname === '/ams/native-bootstrap/bind';
    const isJsonApi = request.method === 'POST' && url.pathname.startsWith('/api/')
      && String(request.headers['content-type'] || '').toLowerCase().includes('application/json');
    const shouldReadJson = isJsonApi || isBootstrapBind || isGatewayNativeBootstrap;
    let requestBody = null;
    try {
      if (shouldReadJson) requestBody = await readBoundedBody(request);
    } catch {
      response.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: false, code: 'BODY_TOO_LARGE' }));
      return;
    }

    const bootstrapId = String(request.headers[BOOTSTRAP_HEADER] || '').trim();
    const nativeSessionId = stableSessionId(String(request.headers['x-ams-native-session-id'] || ''));
    let rawBody = requestBody?.toString('utf8') || '';
    if (isJsonApi && bootstrapId && nativeSessionId) {
      rawBody = forceApiSessionBody(url.pathname, rawBody, nativeSessionId);
      requestBody = Buffer.from(rawBody, 'utf8');
    }
    if (isGatewayNativeBootstrap) {
      try {
        const forwardHeaders = {
          'content-type': 'application/json',
          'x-ams-user-id': String(request.headers['x-ams-user-id'] || ''),
          'x-ams-timestamp': String(request.headers['x-ams-timestamp'] || ''),
          'x-ams-signature': String(request.headers['x-ams-signature'] || ''),
          'x-ams-delegated-authorization': String(request.headers['x-ams-delegated-authorization'] || ''),
        };
        const gatewayResponse = await fetch(new URL(url.pathname, gatewayUrl), {
          method: 'POST',
          headers: forwardHeaders,
          body: rawBody,
          redirect: 'error',
        });
        const body = Buffer.from(await gatewayResponse.text(), 'utf8');
        response.writeHead(gatewayResponse.status, {
          'content-type': gatewayResponse.headers.get('content-type') || 'application/json',
          'content-length': String(body.length),
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch {
        response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: 'HARNESS_GATEWAY_UNAVAILABLE' }));
      }
      return;
    }
    if (isBootstrapBind) {
      const sessionId = bootstrapBindSessionId(rawBody);
      if (!bootstrapId || !sessionId) {
        response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: 'NATIVE_BOOTSTRAP_BIND_INVALID' }));
        return;
      }
      try {
        await bind(bootstrapId, sessionId);
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: error?.code || 'NATIVE_SESSION_BIND_FAILED' }));
      }
      return;
    }

    const beforeSessionId = requestSessionId(url.pathname, rawBody);
    if (bootstrapId && beforeSessionId) {
      try { await bind(bootstrapId, beforeSessionId); } catch (error) {
        response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: error?.code || 'NATIVE_SESSION_BIND_FAILED' }));
        return;
      }
    }

    const headers = { ...request.headers, 'accept-encoding': 'identity' };
    delete headers[BOOTSTRAP_HEADER];
    delete headers['x-ams-native-session-id'];
    const upstream = httpRequest({ hostname: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers }, (upstreamResponse) => {
      const transformHtml = request.method === 'GET' && url.pathname === '/';
      const captureCreate = isJsonApi && url.pathname === '/api/session.create' && bootstrapId;
      const pinSessionList = isJsonApi && url.pathname === '/api/session.list' && bootstrapId && nativeSessionId;
      if (!transformHtml && !captureCreate && !pinSessionList) {
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
          try { await bind(bootstrapId, sessionId); } catch (error) {
            response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ ok: false, code: error?.code || 'NATIVE_SESSION_BIND_FAILED' }));
            return;
          }
        }
        if (pinSessionList && (upstreamResponse.statusCode || 500) < 400) {
          body = pinSessionListCurrent(body.toString('utf8'), nativeSessionId);
        }
        const responseHeaders = { ...upstreamResponse.headers, 'content-length': String(body.length) };
        if (transformHtml) responseHeaders['cache-control'] = 'no-store';
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
  const gatewayUrl = String(process.env.AMS_NATIVE_SESSION_GATEWAY_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
  const dshBin = '/app/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const child = spawn(process.execPath, [
    '--expose-internals', dshBin, 'web', '--host', '127.0.0.1', '--port', String(upstreamPort),
    '--no-open', '--trusted-host', 'harness-web.47-251-244-196.sslip.io',
  ], { stdio: 'inherit', env: process.env });
  child.once('exit', (code) => process.exit(code ?? 1));
  const server = createWebAuthProxy({ listenPort, upstreamPort, gatewaySecret, gatewayUrl });
  server.listen(listenPort, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close();
    child.kill(signal);
  });
  return { server, child };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) startWebAuthProxy();
