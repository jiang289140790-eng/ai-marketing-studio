/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarnessClient, HARNESS_ACTIVE_PROJECT_KEY, HARNESS_EDGE_SCHEMA_VERSION, readHarnessActiveProject } from '../src/services/harness-client.js';

test('browser Harness client forwards only the authenticated Edge contract and never a service credential', async () => {
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'stale-user-jwt' } }, error: null }),
      refreshSession: async () => ({ data: { session: { access_token: 'user-jwt-value' } }, error: null }),
    },
    functions: {
      invoke: async (name, options) => {
        calls.push({ name, options });
        return { data: { ok: true, task: { id: 'ht-11111111-1111-4111-8111-111111111111', state: 'queued' } }, error: null };
      },
    },
  };
  const harness = createHarnessClient({ client });
  await harness.submit({
    requestId: 'web-request-1',
    intent: 'Analyze the current research project.',
    approval: { paid_external_calls: true, online_writes: false, handoff_creation: false },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'harness-command');
  assert.deepEqual(calls[0].options.body, {
    schema_version: HARNESS_EDGE_SCHEMA_VERSION,
    action: 'submit',
    request_id: 'web-request-1',
    project_id: null,
    intent: 'Analyze the current research project.',
    approval: { paid_external_calls: true, online_writes: false, handoff_creation: false },
  });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer user-jwt-value');
  assert.doesNotMatch(JSON.stringify(calls[0]), /service[_-]?role|hmac.secret|database_url/i);
});

test('browser Harness client fails closed without a signed-in session', async () => {
  const harness = createHarnessClient({
    client: {
      auth: { getSession: async () => ({ data: { session: null }, error: null }) },
      functions: { invoke: async () => assert.fail('Edge must not be called without auth') },
    },
  });
  await assert.rejects(() => harness.list(), (error) => error.code === 'AUTH_REQUIRED');
});

test('Harness submit proactively refreshes the delegated session but read-only polling does not', async () => {
  let refreshes = 0;
  let reads = 0;
  const client = {
    auth: {
      refreshSession: async () => { refreshes += 1; return { data: { session: { access_token: 'fresh' } }, error: null }; },
      getSession: async () => { reads += 1; return { data: { session: { access_token: 'current' } }, error: null }; },
    },
    functions: { invoke: async () => ({ data: { ok: true, tasks: [] }, error: null }) },
  };
  const harness = createHarnessClient({ client });
  await harness.submit({ requestId: 'refresh-1', intent: 'read project', approval: {} });
  await harness.list();
  assert.equal(refreshes, 1);
  assert.equal(reads, 1);
});

test('AI workspace binds submissions to the exact selected P19 project and rejects malformed local state', async () => {
  const exact = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(readHarnessActiveProject({ getItem: (key) => key === HARNESS_ACTIVE_PROJECT_KEY ? exact : null }), exact);
  assert.equal(readHarnessActiveProject({ getItem: () => 'prj-not-valid' }), null);
  assert.equal(readHarnessActiveProject({ getItem: () => { throw new Error('storage denied'); } }), null);
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /const projectId = readHarnessActiveProject\(\)/);
  assert.match(page, /const submissionKey = JSON\.stringify\(\[projectId, normalizedIntent, approval\]\)/);
  assert.match(page, /requestId: pendingSubmission\.current\.requestId,[\s\S]*projectId,[\s\S]*intent: normalizedIntent/);
  assert.match(page, /generation !== pollGeneration\.current/);
  assert.match(page, /catch \(caught\) \{\s*if \(generation !== pollGeneration\.current\) return;\s*setError/);
  assert.match(page, /pollGeneration\.current \+= 1/);
  assert.match(page, /if \(pollInFlight\.current\) return/);
  assert.match(page, /pollInFlight\.current = true/);
  assert.match(page, /finally \{[\s\S]*pollInFlight\.current = false/);
  assert.match(page, /const pendingSubmission = useRef\(null\)/);
  assert.match(page, /pendingSubmission\.current\?\.key !== submissionKey/);
  assert.match(page, /requestId: pendingSubmission\.current\.requestId/);
  assert.ok(
    page.indexOf('pendingSubmission.current = null') > page.indexOf('if (!task) throw new Error'),
    'request identity must rotate only after the server confirms a task record',
  );
});

test('default AI workspace is concise and keeps existing research as advanced mode', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  assert.match(page, /告诉我你想完成什么/);
  assert.match(page, /进入高级研究模式/);
  assert.match(page, /不会删除数据、修改权限、自动发布或访问 production/);
  assert.match(page, /paid_external_calls: allowPaid/);
  assert.match(page, /disabled=\{!intent\.trim\(\) \|\| !allowPaid/);
  assert.match(page, /online_writes: allowWrites/);
  assert.match(page, /handoff_creation: needsHandoff && allowHandoff/);
  assert.match(page, /data-testid="harness-handoff-approval"/);
  assert.match(page, /needsHandoff && \(!allowWrites \|\| !allowHandoff\)/);
  assert.match(page, /setAllowPaid\(false\)/);
  assert.match(page, /setAllowWrites\(false\)/);
  assert.match(page, /setAllowHandoff\(false\)/);
  assert.match(app, /default:\s*return <AIWorkspacePage/);
  assert.match(sidebar, /new Set\(\['ai', 'research', 'knowledge', 'connections'\]\)/);
});
