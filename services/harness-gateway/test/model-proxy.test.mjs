/* global Buffer, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createModelProxy, validateProxyRequest } from '../model-proxy.mjs';

test('model proxy accepts only fixed DeepSeek chat endpoints', () => {
  assert.deepEqual(validateProxyRequest({ method: 'POST', pathname: '/chat/completions', search: '', contentType: 'application/json' }), { ok: true });
  assert.deepEqual(validateProxyRequest({ method: 'POST', pathname: '/v1/chat/completions', search: '', contentType: 'application/json; charset=utf-8' }), { ok: true });
  assert.equal(validateProxyRequest({ method: 'GET', pathname: '/chat/completions', search: '', contentType: 'application/json' }).code, 'METHOD_NOT_ALLOWED');
  assert.equal(validateProxyRequest({ method: 'POST', pathname: '/models', search: '', contentType: 'application/json' }).code, 'ENDPOINT_NOT_ALLOWED');
  assert.equal(validateProxyRequest({ method: 'POST', pathname: '/chat/completions', search: '?target=other', contentType: 'application/json' }).code, 'ENDPOINT_NOT_ALLOWED');
  assert.equal(validateProxyRequest({ method: 'POST', pathname: '/chat/completions', search: '', contentType: 'text/plain' }).code, 'CONTENT_TYPE_INVALID');
});

test('model proxy forwards only to the fixed DeepSeek origin and never returns the credential', async (context) => {
  let captured;
  const apiKey = 'secret-value-that-must-not-leak';
  const server = createModelProxy({
    apiKey,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const body = await new Promise((resolve, reject) => {
    const outbound = request({ hostname: '127.0.0.1', port: address.port, path: '/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    outbound.on('error', reject);
    outbound.end(JSON.stringify({ model: 'deepseek-chat', messages: [] }));
  });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(body, JSON.stringify({ ok: true }));
  assert.equal(body.includes(apiKey), false);
});
