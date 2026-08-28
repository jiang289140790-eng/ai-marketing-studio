import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import test from 'node:test';
import { GATEWAY_SCHEMA_VERSION, HarnessTaskQueue, normalizeDiagnostic } from '../gateway-core.mjs';
import { classifyHarnessExit, createHarnessRunner, redactSensitive } from '../harness-runner.mjs';

const SYNTHETIC_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6MTc4NjY4NjAwMH0.abcdefghijklmnopqrstuvwxyz1234567890';
const TASK_ID = 'ht-00000000-0000-4000-8000-000000000001';

function harnessRequest(overrides = {}) {
  return {
    schema_version: GATEWAY_SCHEMA_VERSION,
    request_id: 'diagnostic-1',
    user_id: 'user-a',
    project_id: 'project-a',
    intent: 'Inspect the current project and propose the next safe step.',
    approval: { paid_external_calls: true, online_writes: false, handoff_creation: false },
    ...overrides,
  };
}

function failingRunner(diagnostic) {
  return async () => {
    throw Object.assign(new Error('Harness process failed.'), { code: 'HARNESS_EXIT_FAILED', diagnostic });
  };
}

test('classifies a model upstream failure with its HTTP status', () => {
  assert.deepEqual(classifyHarnessExit({ exitCode: 1, stderr: 'MODEL_UPSTREAM_REJECTED: api.deepseek.com HTTP 429\n' }), {
    code: 'HARNESS_EXIT_FAILED',
    category: 'model_upstream',
    stage: 'model_call',
    exit_code: 1,
    summary: 'Model upstream (DeepSeek proxy) rejected the request (HTTP 429).',
  });
  assert.deepEqual(classifyHarnessExit({ exitCode: 2, stderr: 'DeepSeek API: insufficient balance (HTTP 402)' }).summary, 'Model upstream (DeepSeek proxy) rejected the request (HTTP 402).');
  assert.deepEqual(classifyHarnessExit({ exitCode: 1, stderr: 'Invalid API key from upstream proxy' }).summary, 'Model upstream (DeepSeek proxy) rejected the request.');
});

test('classifies AMS tool/plugin, tool bridge, and delegated auth failures', () => {
  const plugin = classifyHarnessExit({ exitCode: 1, stderr: 'ams_call plugin failed: TOOL_CALL_FAILED operation=post_tweet\n' });
  assert.deepEqual(plugin, { code: 'HARNESS_EXIT_FAILED', category: 'ams_tool_plugin', stage: 'tool_call', exit_code: 1, summary: 'AMS tool or plugin execution failed.' });
  const bridge = classifyHarnessExit({ exitCode: 1, stderr: 'fetch failed ECONNREFUSED https://amsstagingexample.supabase.co/functions/v1/harness-tool-bridge\n' });
  assert.equal(bridge.category, 'ams_tool_bridge');
  assert.equal(bridge.stage, 'bridge_request');
  assert.equal(bridge.summary, 'AMS tool bridge request failed.');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: 'TOOL_BRIDGE_HTTP_ERROR HTTP 502' }).summary, 'AMS tool bridge request failed (HTTP 502).');
  const auth = classifyHarnessExit({ exitCode: 1, stderr: 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON: bearer token expired\n' });
  assert.equal(auth.category, 'delegated_auth');
  assert.equal(auth.stage, 'authorization');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: '401 Unauthorized' }).category, 'delegated_auth');
});

test('classifies timeout and external process termination', () => {
  assert.deepEqual(classifyHarnessExit({ timedOut: true, stderr: 'anything at all' }), {
    code: 'HARNESS_TIMEOUT',
    category: 'timeout_termination',
    stage: 'timeout',
    exit_code: null,
    summary: 'Harness process exceeded its allowed time budget and was terminated.',
  });
  assert.deepEqual(classifyHarnessExit({ exitCode: null, stderr: 'x' }), {
    code: 'HARNESS_TIMEOUT',
    category: 'timeout_termination',
    stage: 'terminated',
    exit_code: null,
    summary: 'Harness process was terminated before completing.',
  });
});

test('classifies an unrecognized exit as an unknown Harness runtime failure', () => {
  assert.deepEqual(classifyHarnessExit({ exitCode: 137, stderr: 'something completely opaque happened here\n' }), {
    code: 'HARNESS_EXIT_FAILED',
    category: 'harness_runtime_unknown',
    stage: 'unknown',
    exit_code: 137,
    summary: 'Harness process failed with an unrecognized runtime error.',
  });
});

test('marker precedence is deterministic: auth over bridge over plugin over model, bare 4xx to model', () => {
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: 'fetch failed: bearer token rejected' }).category, 'delegated_auth');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: 'ams_call tool failed: TOOL_BRIDGE_UNAVAILABLE' }).category, 'ams_tool_bridge');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: 'plugin crash before bridge' }).category, 'ams_tool_plugin');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: 'request returned 401' }).category, 'model_upstream');
});

test('oversized and multibyte stderr is sliced to a deterministic bound before classification', () => {
  const huge = `${'a'.repeat(9_999_999)}MODEL_UPSTREAM_REJECTED`;
  const diagnostic = classifyHarnessExit({ exitCode: 1, stderr: huge });
  assert.equal(diagnostic.category, 'harness_runtime_unknown', 'markers beyond the window are ignored');
  assert.ok(diagnostic.summary.length <= 240);
  const multibyte = `${'中'.repeat(100)}TOOL_BRIDGE_UNAVAILABLE${'中'.repeat(50_000)}`;
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: multibyte }).category, 'ams_tool_bridge', 'markers within the window are seen after multibyte content');
  assert.equal(classifyHarnessExit({ exitCode: 1, stderr: '中'.repeat(1_000_000) }).category, 'harness_runtime_unknown');
});

test('redacts Bearer and Authorization credentials', () => {
  const token = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
  const redacted = redactSensitive(`Authorization: Bearer ${token} failed`);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes('[REDACTED]'), true);
  assert.equal(redacted.includes('failed'), true);
});

test('redacts JWT-like strings, API keys, and provider key formats', () => {
  const secrets = [
    `token=${SYNTHETIC_JWT}`,
    'sk-abcdefghijklmnop1234567890',
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-'),
    'AIzaSyA1234567890abcdefghijklmnopqrs',
    'api_key = "supersecretvalue1234567890"',
    'password: hunter2secretvalue',
  ];
  const redacted = redactSensitive(secrets.join(' '));
  for (const secret of secrets) assert.equal(redacted.includes(secret), false, `must redact ${secret.slice(0, 24)}`);
  assert.equal(redacted.includes('[REDACTED]'), true);
});

test('redacts URL query credentials and cookies without touching benign text', () => {
  const url = redactSensitive('https://example.test/run?api_key=supersecretvalue123&foo=bar');
  assert.equal(url.includes('supersecretvalue123'), false);
  assert.equal(url.includes('foo=bar'), true);
  assert.equal(url.includes('https://example.test/run'), true);
  const cookie = redactSensitive('Cookie: sessionid=abc123def456ghi; Path=/');
  assert.equal(cookie.includes('abc123def456ghi'), false);
  assert.equal(cookie.includes('[REDACTED]'), true);
  const benign = 'ERROR: model upstream rejected (HTTP 429)';
  assert.equal(redactSensitive(benign), benign);
  const bridgeUrl = 'https://amsstagingexample.supabase.co/functions/v1/harness-tool-bridge';
  assert.equal(redactSensitive(bridgeUrl), bridgeUrl);
});

test('redacts every Authorization scheme: Basic, Digest, ApiKey, and synthetic unknown schemes', () => {
  const payloads = ['dXNlcjpwYXNzd29yZA==', 'studio-key-1234567890abcdef', 'my-secret-credential-value-9876543210', 'fedcba9876543210'];
  const headers = [
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'Authorization: Digest username="admin", realm="studio", nonce="abc123", uri="/run", response="fedcba9876543210"',
    'Authorization: ApiKey studio-key-1234567890abcdef',
    'Authorization: X-Studio-Custom my-secret-credential-value-9876543210',
    'Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==',
  ];
  for (const header of headers) {
    const redacted = redactSensitive(header);
    for (const payload of payloads) {
      assert.equal(redacted.includes(payload), false, `no credential fragment may survive in: ${header}`);
    }
    assert.equal(redacted, '[REDACTED]', `only the fixed safe marker may survive for: ${header}`);
  }
  // Inline in prose: the credential is redacted, benign same-line trailing
  // words are preserved.
  assert.equal(redactSensitive('Authorization: Basic dXNlcjpwYXNzd29yZA== failed'), '[REDACTED] failed');
  assert.equal(redactSensitive('note Authorization: Digest username="admin" later'), 'note [REDACTED] later');
});

test('redacts complete multi-pair Cookie and Set-Cookie values through the line boundary', () => {
  const cookie = redactSensitive('Cookie: sessionid=abc123def456ghi; theme=dark; Path=/');
  assert.equal(cookie, '[REDACTED]');
  assert.equal(cookie.includes('theme=dark'), false);
  const setCookie = redactSensitive('Set-Cookie: session=abc123def456ghi; Max-Age=3600; HttpOnly; SameSite=Lax');
  assert.equal(setCookie, '[REDACTED]', 'Set-Cookie must be replaced whole, leaving no "Set-" fragment');
  assert.equal(setCookie.includes('HttpOnly'), false);
  assert.equal(setCookie.includes('Set-'), false);
});

test('redaction stops at LF and CRLF line boundaries and never consumes the following line', () => {
  assert.equal(redactSensitive('Authorization: Basic dXNlcjpwYXNzd29yZA==\nbenign next line stays'), '[REDACTED]\nbenign next line stays');
  assert.equal(redactSensitive('Cookie: a=secret1; b=secret2\r\nall good here'), '[REDACTED]\r\nall good here');
  assert.equal(redactSensitive('Set-Cookie: s=secret3\r\n\r\nkeep this'), '[REDACTED]\r\n\r\nkeep this');
  assert.equal(redactSensitive('first line intact\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nthird line intact'), 'first line intact\n[REDACTED]\nthird line intact');
});

test('redacts oversized credential values completely, leaving no fragment', () => {
  assert.equal(redactSensitive(`Authorization: Basic ${'A'.repeat(50_000)}`), '[REDACTED]');
  assert.equal(redactSensitive(`Cookie: session=${'A'.repeat(20_000)}; other=${'B'.repeat(20_000)}`), '[REDACTED]');
  // Oversized stderr is bounded before classification; the summary template
  // still never carries the credential.
  const diagnostic = classifyHarnessExit({ exitCode: 1, stderr: `${'x'.repeat(3_000)} Authorization: Basic dXNlcjpwYXNzd29yZA==` });
  assert.equal(diagnostic.category, 'delegated_auth', 'the "authorization" word inside the window still classifies');
  assert.equal(JSON.stringify(diagnostic).includes('dXNlcjpwYXNzd29yZA=='), false);
});

test('a classified diagnostic never persists stderr content or embedded credentials', () => {
  // No literal "Bearer" word here: the word itself is an auth marker, and this
  // fixture must stay within the bridge failure category.
  const secrets = ['sk-abcdefghijklmnopqrstuvwxyz1234567890', SYNTHETIC_JWT, 'api_key=supersecretvalue123', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'];
  const stderr = `fetch failed ECONNREFUSED: ${secrets.join(' ')} raw stderr dump line`;
  const diagnostic = classifyHarnessExit({ exitCode: 1, stderr });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(diagnostic.category, 'ams_tool_bridge');
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `diagnostic must not contain ${secret.slice(0, 24)}`);
  assert.equal(serialized.includes('raw stderr dump line'), false);
  assert.equal(serialized.includes('ECONNREFUSED'), false);
});

test('normalizeDiagnostic accepts exactly the allowlisted shape', () => {
  const valid = classifyHarnessExit({ exitCode: 1, stderr: 'MODEL_UPSTREAM_REJECTED' });
  assert.deepEqual(normalizeDiagnostic(valid), valid);
  const minimal = normalizeDiagnostic({ code: 'HARNESS_TIMEOUT', category: 'timeout_termination', stage: 'timeout', exit_code: null, summary: 'x' });
  assert.deepEqual(minimal, { code: 'HARNESS_TIMEOUT', category: 'timeout_termination', stage: 'timeout', exit_code: null, summary: 'x' });
});

test('normalizeDiagnostic rejects any shape outside the allowlist', () => {
  const invalid = [
    null,
    'not-an-object',
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: 'ok', raw_stderr: 'SECRET' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: 'ok', message: 'extra' },
    { code: 'INVENTED_CODE', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'made_up_category', stage: 'model_call', exit_code: 1, summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'made_up_stage', exit_code: 1, summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1.5, summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: '1', summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 2 ** 40, summary: 'ok' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: '' },
    { code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: 'x'.repeat(241) },
  ];
  for (const value of invalid) assert.equal(normalizeDiagnostic(value), null, JSON.stringify(value));
});

test('normalizeDiagnostic rejects whitespace-only summaries fail-closed', () => {
  for (const summary of ['', '   ', '\t\r\n ', ' \t ', ' ']) {
    assert.equal(normalizeDiagnostic({ code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary }), null, JSON.stringify(summary));
  }
});

test('a durable task persists exactly the allowlisted diagnostic for a runner failure', async () => {
  const diagnostic = classifyHarnessExit({ exitCode: 1, stderr: 'MODEL_UPSTREAM_REJECTED api.deepseek.com HTTP 429' });
  const queue = new HarnessTaskQueue({ runner: failingRunner(diagnostic) });
  const submitted = queue.submit(harnessRequest());
  assert.equal(submitted.ok, true);
  await queue.whenIdle();
  const task = queue.read(submitted.task.id, 'user-a').task;
  assert.equal(task.state, 'failed');
  assert.deepEqual(task.error, diagnostic);
  assert.deepEqual(Object.keys(task.error).sort(), ['category', 'code', 'exit_code', 'stage', 'summary']);
  assert.equal(Object.hasOwn(task.error, 'message'), false);
  const serialized = JSON.stringify(task);
  assert.equal(serialized.includes('MODEL_UPSTREAM_REJECTED'), false);
  assert.equal(serialized.includes('api.deepseek.com'), false);
});

test('adversarial: credentials smuggled into a diagnostic summary are redacted before persistence', async () => {
  const smuggled = 'Bearer hunter2secretphrase12345 failed';
  const queue = new HarnessTaskQueue({ runner: failingRunner({ code: 'HARNESS_EXIT_FAILED', category: 'delegated_auth', stage: 'authorization', exit_code: 1, summary: smuggled }) });
  const submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  const task = queue.read(submitted.task.id, 'user-a').task;
  assert.equal(task.error.summary, '[REDACTED] failed');
  assert.equal(JSON.stringify(task).includes('hunter2secretphrase12345'), false);
});

test('a whitespace-only summary is replaced by the safe fallback before persistence', async () => {
  const queue = new HarnessTaskQueue({ runner: failingRunner({ code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: '   ' }) });
  const submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  assert.deepEqual(queue.read(submitted.task.id, 'user-a').task.error, { code: 'HARNESS_FAILED', category: 'harness_runtime_unknown', stage: 'unknown', exit_code: null, summary: 'Harness process failed without a valid diagnostic.' });
});

test('adversarial: Basic credentials in a summary are redacted before persistence', async () => {
  const smuggled = 'Authorization: Basic dXNlcjpwYXNzd29yZA== failed';
  const queue = new HarnessTaskQueue({ runner: failingRunner({ code: 'HARNESS_EXIT_FAILED', category: 'delegated_auth', stage: 'authorization', exit_code: 1, summary: smuggled }) });
  const submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  const task = queue.read(submitted.task.id, 'user-a').task;
  assert.equal(task.error.summary, '[REDACTED] failed');
  assert.equal(JSON.stringify(task).includes('dXNlcjpwYXNzd29yZA=='), false);
});

test('fail-closed: an invalid diagnostic is replaced by the safe fallback, never persisted', async () => {
  const queue = new HarnessTaskQueue({ runner: failingRunner({ code: 'HARNESS_EXIT_FAILED', category: 'model_upstream', stage: 'model_call', exit_code: 1, summary: 'ok', raw_stderr: 'Bearer hunter2secretphrase12345' }) });
  const submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  const task = queue.read(submitted.task.id, 'user-a').task;
  assert.deepEqual(task.error, { code: 'HARNESS_FAILED', category: 'harness_runtime_unknown', stage: 'unknown', exit_code: null, summary: 'Harness process failed without a valid diagnostic.' });
  assert.equal(JSON.stringify(task).includes('hunter2secretphrase12345'), false);
});

test('the polling response exposes no raw stderr from a runner failure', async () => {
  const stderrLine = 'MODEL_UPSTREAM_REJECTED api.deepseek.com raw stderr dump with hunter2secretphrase12345';
  const queue = new HarnessTaskQueue({
    runner: async () => {
      throw Object.assign(new Error('Harness process failed.'), { code: 'HARNESS_EXIT_FAILED', diagnostic: classifyHarnessExit({ exitCode: 1, stderr: stderrLine }) });
    },
  });
  const submitted = queue.submit(harnessRequest({ intent: 'secret user prompt text' }));
  await queue.whenIdle();
  const serialized = JSON.stringify(queue.read(submitted.task.id, 'user-a'));
  assert.equal(serialized.includes(stderrLine), false);
  assert.equal(serialized.includes('raw stderr dump'), false);
  assert.equal(serialized.includes('hunter2secretphrase12345'), false);
  assert.equal(serialized.includes('MODEL_UPSTREAM_REJECTED'), false);
});

test('non-runner failures keep the existing code/message error shape', async () => {
  const queue = new HarnessTaskQueue({
    runner: async () => { throw Object.assign(new Error('Delegated authorization is not valid for the bounded task window.'), { code: 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON' }); },
  });
  const submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  assert.deepEqual(queue.read(submitted.task.id, 'user-a').task.error, {
    code: 'DELEGATED_AUTHORIZATION_EXPIRES_TOO_SOON',
    message: 'Delegated authorization is not valid for the bounded task window.',
  });
});

test('list summaries expose the diagnostic fields bounded', async () => {
  const diagnostic = classifyHarnessExit({ exitCode: 1, stderr: 'TOOL_BRIDGE_HTTP_ERROR HTTP 502' });
  const queue = new HarnessTaskQueue({ runner: failingRunner(diagnostic) });
  const _submitted = queue.submit(harnessRequest());
  await queue.whenIdle();
  const [summary] = queue.listSummaries('user-a');
  assert.deepEqual(summary.error, diagnostic);
  const internal = new HarnessTaskQueue({ runner: async () => { throw Object.assign(new Error('internal'), { code: 'INTERNAL_CODE' }); } });
  internal.submit(harnessRequest({ request_id: 'diagnostic-2' }));
  await internal.whenIdle();
  assert.deepEqual(internal.listSummaries('user-a')[0].error, { code: 'INTERNAL_CODE', message: 'internal' });
});

test('a real child failure surfaces as the allowlisted diagnostic on the durable task', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-harness-run-'));
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = dir;
  try {
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, 'process.stdout.write("secret model output line\\n");\nprocess.stderr.write("ams_call plugin failed: TOOL_CALL_FAILED\\n");\nprocess.exit(3);\n', 'utf8');
    const queue = new HarnessTaskQueue({
      runner: createHarnessRunner({ executable: process.execPath, profileArgs: [worker], workspace: dir, timeoutMs: 5_000 }),
    });
    const submitted = queue.submit(harnessRequest());
    assert.equal(submitted.ok, true);
    await queue.whenIdle();
    const task = queue.read(submitted.task.id, 'user-a').task;
    assert.equal(task.state, 'failed');
    assert.deepEqual(task.error, { code: 'HARNESS_EXIT_FAILED', category: 'ams_tool_plugin', stage: 'tool_call', exit_code: 3, summary: 'AMS tool or plugin execution failed.' });
    const serialized = JSON.stringify(task);
    assert.equal(serialized.includes('TOOL_CALL_FAILED'), false);
    assert.equal(serialized.includes('secret model output line'), false);
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a zero-exit child with a required tool failure is failed and keeps successful artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-harness-required-failure-'));
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = dir;
  try {
    const worker = join(dir, 'worker.mjs');
    const markerModule = new URL('../plugins/ams-tools/required-failure-journal.mjs', import.meta.url).href;
    const artifactModule = new URL('../plugins/ams-tools/artifact-journal.mjs', import.meta.url).href;
    writeFileSync(worker, `import { writeRequiredFailure } from ${JSON.stringify(markerModule)};\nimport { appendTaskArtifactRefs } from ${JSON.stringify(artifactModule)};\nappendTaskArtifactRefs(process.env.DSH_HOME, process.env.AMS_TASK_ID, { artifact_refs: ['ev-preserved', 'kc-preserved'] });\nwriteRequiredFailure(process.env.DSH_HOME, process.env.AMS_TASK_ID, { code: 'ENTITY_REVISION_STALE', operation: 'workspace.brief.assemble' });\nprocess.stdout.write('partial work completed\\n');\n`, 'utf8');
    const run = createHarnessRunner({ executable: process.execPath, profileArgs: [worker], workspace: dir, timeoutMs: 5_000 });
    await assert.rejects(
      () => run(harnessRequest(), TASK_ID, null),
      (error) => error.code === 'ENTITY_REVISION_STALE'
        && error.diagnostic?.tool_code === 'ENTITY_REVISION_STALE'
        && error.diagnostic?.operation === 'workspace.brief.assemble'
        && error.partialResult?.partial_completion === true
        && error.partialResult?.artifact_refs?.length === 2,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real runner timeout produces a timeout diagnostic even when the OS reports an arbitrary exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-harness-timeout-'));
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = dir;
  try {
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, 'setInterval(() => {}, 1000);\n', 'utf8');
    const run = createHarnessRunner({ executable: process.execPath, profileArgs: [worker], workspace: dir, timeoutMs: 150 });
    await assert.rejects(
      () => run(harnessRequest(), TASK_ID, null),
      (error) => error.code === 'HARNESS_TIMEOUT'
        && error.diagnostic?.category === 'timeout_termination'
        && error.diagnostic?.stage === 'timeout'
        && error.diagnostic?.exit_code === null,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real spawn failure produces a spawn diagnostic without the OS error message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-harness-spawn-'));
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = dir;
  try {
    const run = createHarnessRunner({ executable: join(dir, 'does-not-exist'), workspace: dir, timeoutMs: 5_000 });
    await assert.rejects(
      () => run(harnessRequest(), TASK_ID, null),
      (error) => error.code === 'HARNESS_SPAWN_FAILED'
        && error.diagnostic?.category === 'harness_runtime_unknown'
        && error.diagnostic?.stage === 'spawn'
        && error.diagnostic?.exit_code === null
        && error.diagnostic?.summary === 'Harness executable could not be started.'
        && JSON.stringify(error.diagnostic).includes('does-not-exist') === false,
    );
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real successful child keeps the pre-existing success contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ams-harness-ok-'));
  const previousHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = dir;
  try {
    const worker = join(dir, 'worker.mjs');
    writeFileSync(worker, 'process.stdout.write("durable final response\\n");\nprocess.exit(0);\n', 'utf8');
    const run = createHarnessRunner({ executable: process.execPath, profileArgs: [worker], workspace: dir, timeoutMs: 5_000 });
    const output = await run(harnessRequest(), TASK_ID, null);
    assert.deepEqual(output, { final_response: 'durable final response', artifact_refs: [] });
  } finally {
    if (previousHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
