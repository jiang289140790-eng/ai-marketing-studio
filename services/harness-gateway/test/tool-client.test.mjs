/* global Response, URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createToolClient, verifyBridgeSignature } from '../tool-client.mjs';
import { TOOL_SCHEMA_VERSION, validateToolCall } from '../tool-contract.mjs';

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

test('the single canonical contract: the internally enriched executor value fails closed before any network request', async () => {
  // The previous double-validation failure: the executor forwarded the value
  // enriched by validateToolCall (task_id/user_id/project_id on the envelope)
  // into the client, which re-validated it as an external call and failed
  // with UNKNOWN_FIELD on task_id. The client must keep failing closed on
  // that shape with the exact offending field — only the canonical external
  // call ever crosses this boundary.
  const enriched = validateToolCall(
    { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.read', payload: { project_id: context.project_id }, idempotency_key: 'idem-enriched' },
    context,
  );
  assert.equal(enriched.ok, true);
  assert.ok(Object.hasOwn(enriched.value, 'task_id'), 'the enriched value carries internal trusted fields');
  let calls = 0;
  const client = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  const result = await client(enriched.value, context);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_FIELD');
  assert.equal(result.diagnostics.field, 'task_id', 'the exact offending internal field is reported');
  assert.equal(calls, 0, 'zero network requests for a rejected shape');
});

test('caller-supplied envelope extras fail closed with the exact offending field', async () => {
  let calls = 0;
  const client = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  const base = { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.read', payload: { project_id: context.project_id }, idempotency_key: 'idem-extra' };
  const extras = {
    task_id: 'ht-22222222-2222-4222-8222-222222222222',
    user_id: 'user-b',
    project_id: 'prj-bbbbbbbbbbbbbbbbbbbbbbbb',
    admin: true,
  };
  for (const [field, value] of Object.entries(extras)) {
    const result = await client({ ...base, [field]: value }, context);
    assert.equal(result.ok, false, field);
    assert.equal(result.code, 'UNKNOWN_FIELD', field);
    assert.equal(result.diagnostics.field, field, `the exact offending envelope field ${field} is reported`);
  }
  assert.equal(calls, 0, 'envelope extras never reach the network');
});

test('payload extras fail closed with the exact operation and offending field and never leak the value', async () => {
  let calls = 0;
  const client = createToolClient({ bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization, fetchImpl: async () => { calls += 1; return new Response('{}'); } });
  const result = await client(
    { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.read', payload: { project_id: context.project_id, sql: 'select 1' }, idempotency_key: 'idem-payload-extra' },
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_PAYLOAD_FIELD');
  assert.equal(result.diagnostics.operation, 'workspace.project.read', 'diagnostics carry the exact operation');
  assert.equal(result.diagnostics.field, 'sql', 'diagnostics carry the exact offending payload field');
  assert.equal(calls, 0, 'payload extras never reach the network');
  assert.doesNotMatch(JSON.stringify(result), /select 1|Bearer|token|secret/i, 'bounded diagnostics never leak the offending value');
});

test('workspace.project.read crosses the bridge as the exact P19 boundary request', async () => {
  let observed;
  const client = createToolClient({
    bridgeUrl: 'https://staging.example.test/functions/v1/harness-tool-bridge',
    bridgeSecret: secret,
    delegatedAuthorization,
    fetchImpl: async (_url, init) => {
      observed = init;
      return new Response(JSON.stringify({ ok: true, code: 'OK', data: { project: { id: context.project_id } } }), { status: 200 });
    },
  });
  const result = await client(
    { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.read', payload: { project_id: context.project_id }, idempotency_key: 'idem-read' },
    context,
  );
  assert.equal(result.ok, true);
  const envelope = JSON.parse(observed.body);
  assert.deepEqual(
    envelope.call.payload,
    { project_id: context.project_id },
    'the call payload never gains internal trusted fields',
  );
  assert.equal(envelope.call.task_id, context.task_id, 'the signed envelope identity is derived from the trusted context, never the caller');
  assert.deepEqual(envelope.boundary, {
    endpoint: 'p19-workspace-command',
    body: {
      schema_version: 'p19_command_contract_v1',
      command: 'project.read',
      idempotency_key: `h-${createHash('sha256').update(`${context.task_id}\0idem-read`, 'utf8').digest('hex')}`,
      payload: { project_id: context.project_id },
    },
  }, 'the downstream P19 body is exactly {schema_version, command, idempotency_key, payload:{project_id}}');
});

test('tool/bridge failures retain exact bounded diagnostics (code, operation, field) through the client', async () => {
  const client = createToolClient({
    bridgeUrl: 'https://example.test/tool', bridgeSecret: secret, delegatedAuthorization,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: false,
      code: 'P19_PROJECT_NOT_FOUND',
      diagnostics: { field: 'project_id', operation: 'project.read', issues: ['项目不存在'] },
    }), { status: 200 }),
  });
  const result = await client(
    { schema_version: TOOL_SCHEMA_VERSION, operation: 'workspace.project.read', payload: { project_id: context.project_id }, idempotency_key: 'idem-fail' },
    context,
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'P19_PROJECT_NOT_FOUND');
  assert.equal(result.diagnostics.operation, 'project.read', 'the exact boundary operation survives');
  assert.equal(result.diagnostics.field, 'project_id', 'the exact offending field survives');
  assert.deepEqual(result.diagnostics.issues, ['项目不存在']);
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
