/* global Response, URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolClient, verifyBridgeSignature } from '../tool-client.mjs';
import { TOOL_SCHEMA_VERSION } from '../tool-contract.mjs';

const secret = 's'.repeat(32);
const delegatedAuthorization = `Bearer ${'a'.repeat(40)}`;
const context = { task_id: 'ht-11111111-1111-4111-8111-111111111111', user_id: 'user-1', project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', approval: {} };

test('tool client sends only to fixed HTTPS bridge with signed trusted envelope', async () => {
  let observed;
  const client = createToolClient({
    bridgeUrl: 'https://staging.example.test/functions/v1/harness-tool-bridge',
    bridgeSecret: secret,
    delegatedAuthorization,
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return new Response(JSON.stringify({ ok: true, code: 'OK', data: { projects: [] } }), { status: 200, headers: { 'content-length': '52' } });
    },
  });
  const result = await client({ schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.list', payload: {}, idempotency_key: 'idem-1' }, context);
  assert.equal(result.ok, true);
  assert.equal(observed.url, 'https://staging.example.test/functions/v1/harness-tool-bridge');
  const timestamp = observed.init.headers['x-ams-bridge-timestamp'];
  assert.equal(observed.init.headers.authorization, delegatedAuthorization);
  assert.equal(verifyBridgeSignature(secret, timestamp, observed.init.headers['x-ams-authorization-sha256'], observed.init.body, observed.init.headers['x-ams-bridge-signature']), true);
  const envelope = JSON.parse(observed.init.body);
  assert.equal(envelope.call.user_id, context.user_id);
  assert.equal(envelope.boundary.body.command, 'project.list');
});

test('tool client refuses unsafe bridge URLs and never follows redirects', async () => {
  assert.throws(() => createToolClient({ bridgeUrl: 'http://example.test/tool', bridgeSecret: secret, delegatedAuthorization }), /HTTPS/);
  assert.throws(() => createToolClient({ bridgeUrl: 'https://user:pass@example.test/tool', bridgeSecret: secret, delegatedAuthorization }), /credentials/);
  assert.throws(() => createToolClient({ bridgeUrl: 'http://attacker.test/tool', bridgeSecret: secret, allowInternalHttp: true, delegatedAuthorization }), /HTTPS/);
  assert.throws(() => createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret }), /delegated/);
  assert.doesNotThrow(() => createToolClient({ bridgeUrl: 'http://tool-proxy:8792/tool', bridgeSecret: secret, allowInternalHttp: true, delegatedAuthorization }));
  let redirect;
  const client = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async (_url, init) => {
    redirect = init.redirect;
    return new Response('{}', { status: 502 });
  } });
  const result = await client({ schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.list', payload: {}, idempotency_key: 'idem-2' }, context);
  assert.equal(redirect, 'error');
  assert.equal(result.ok, false);
});

test('invalid model-proposed calls are rejected before any network request', async () => {
  let calls = 0;
  const client = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  const result = await client({ schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.evidence.remove', payload: {}, idempotency_key: 'idem-3' }, context);
  assert.equal(result.code, 'OPERATION_DENIED');
  assert.equal(calls, 0);
});

test('oversized and malformed responses fail closed with bounded diagnostics', async () => {
  const call = { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.list', payload: {}, idempotency_key: 'idem-4' };
  const huge = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } }) });
  assert.equal((await huge(call, context)).code, 'TOOL_RESPONSE_TOO_LARGE');
  const malformed = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => new Response('not json') });
  assert.equal((await malformed(call, context)).code, 'TOOL_RESPONSE_INVALID');
});

test('tool timeout covers the bounded 120 second paid operation window', async () => {
  let signal;
  const client = createToolClient({
    bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization,
    fetchImpl: async (_url, init) => { signal = init.signal; return new Response(JSON.stringify({ ok: true, data: {} })); },
  });
  await client({ schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.list', payload: {}, idempotency_key: 'idem-timeout' }, context);
  assert.equal(signal.aborted, false);
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../tool-client.mjs', import.meta.url), 'utf8'));
  assert.match(source, /timeoutMs = 145_000/);
});
