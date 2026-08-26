/* global ReadableStream, TextEncoder */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarnessClient, HARNESS_EDGE_SCHEMA_VERSION } from '../src/services/harness-client.js';
import { HARNESS_CAPABILITY_IDS } from '../src/services/harness-capability-map.js';
import { WORKFLOW_IDS } from '../services/harness-gateway/workflow-catalog.mjs';

const threadId = 'thr_11111111-1111-4111-8111-111111111111';

function authenticatedClient(invoke) {
  return {
    supabaseUrl: 'https://staging.example.test',
    supabaseKey: 'publishable-test-key',
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'user-jwt-value', user: { id: 'user-1' } } }, error: null }),
      refreshSession: async () => ({ data: { session: { access_token: 'user-jwt-value', user: { id: 'user-1' } } }, error: null }),
    },
    functions: { invoke },
    storage: { from: () => ({ upload: async () => ({ data: { path: 'stored' }, error: null }) }) },
  };
}

test('browser conversation client uses authenticated thread contracts and stable request fields', async () => {
  const calls = [];
  const client = authenticatedClient(async (name, options) => {
    calls.push({ name, options });
    return { data: { ok: true, threadId, messages: [], accepted: true }, error: null };
  });
  const harness = createHarnessClient({ client });
  await harness.createThread({ workspaceId: 'ai-marketing-studio-staging', projectId: null, requestId: 'request-thread' });
  await harness.getThread(threadId);
  await harness.sendMessage({ threadId, requestId: 'request-message', clientMessageId: 'client-message', content: '你能做什么？' });
  await harness.sendAgentMessage({ threadId, requestId: 'request-agent-message', clientMessageId: 'client-agent-message', content: 'follow up' });
  await harness.confirmThreadPlan({ taskId: 'ht-11111111-1111-4111-8111-111111111111', planFingerprint: 'a'.repeat(64), approval: { paid_external_calls: true } });
  await harness.listMessages(threadId, 7, 100);
  await harness.stopGeneration(threadId);
  assert.deepEqual(calls.map((entry) => entry.options.body.action), ['thread_create', 'thread_get', 'thread_send', 'thread_send_agent', 'confirm', 'thread_messages', 'thread_stop']);
  assert.equal(calls[0].options.body.schema_version, HARNESS_EDGE_SCHEMA_VERSION);
  assert.equal(calls[2].options.body.request_id, 'request-message');
  assert.equal(calls[2].options.body.client_message_id, 'client-message');
  assert.equal(calls[4].options.body.plan_fingerprint, 'a'.repeat(64));
  assert.deepEqual(calls[4].options.body.approval, { paid_external_calls: true });
  assert.equal(calls[5].options.body.cursor, '7');
  for (const call of calls) {
    assert.equal(call.name, 'harness-command');
    assert.doesNotMatch(JSON.stringify(call), /service[_-]?role|hmac.secret|database_url/i);
  }
});

test('attachment upload uses the private thread-owned bucket path', async () => {
  const uploads = [];
  const client = authenticatedClient(async () => ({ data: { ok: true }, error: null }));
  client.storage.from = (bucket) => ({ upload: async (path, file, options) => { uploads.push({ bucket, path, file, options }); return { data: { path }, error: null }; } });
  const harness = createHarnessClient({ client });
  const file = { name: 'brief notes.md', size: 123, type: 'text/markdown' };
  const result = await harness.uploadAttachment({ threadId, requestId: 'request-1', file });
  assert.equal(result.bucket, 'harness-thread-attachments');
  assert.match(result.path, new RegExp(`^user-1/${threadId}/request-1/brief_notes\\.md$`));
  assert.equal(result.mimeType, 'text/markdown');
  assert.equal(uploads[0].options.upsert, false);
});

test('attachment preview uses a short-lived authenticated URL and rejects foreign object paths', async () => {
  const signed = [];
  const client = authenticatedClient(async () => ({ data: { ok: true }, error: null }));
  client.storage.from = (bucket) => ({
    createSignedUrl: async (path, expiresIn, options) => {
      signed.push({ bucket, path, expiresIn, options });
      return { data: { signedUrl: 'https://staging.example.test/signed/private-object' }, error: null };
    },
  });
  const harness = createHarnessClient({ client });
  const ref = `harness-thread-attachments:user-1/${threadId}/request-1/source.png`;
  assert.deepEqual(await harness.createAttachmentPreview({ ref, name: 'source.png' }), {
    signedUrl: 'https://staging.example.test/signed/private-object',
    expiresIn: 300,
  });
  assert.deepEqual(signed[0], {
    bucket: 'harness-thread-attachments',
    path: `user-1/${threadId}/request-1/source.png`,
    expiresIn: 300,
    options: undefined,
  });
  await assert.rejects(
    harness.createAttachmentPreview({ ref: `harness-thread-attachments:other-user/${threadId}/request-1/source.png` }),
    (error) => error.code === 'ATTACHMENT_BINDING_MISMATCH',
  );
  await assert.rejects(
    harness.createAttachmentPreview({ ref: 'harness-thread-attachments:user-1/../source.png' }),
    (error) => error.code === 'ATTACHMENT_REF_INVALID',
  );
  assert.equal(signed.length, 1);
});

test('SSE client replays from cursor and advances only from server event ids', async () => {
  const encoder = new TextEncoder();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(url, /cursor=41/);
    return {
      ok: true,
      body: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('id: 42\nevent: assistant_text_delta\ndata: {"payload":{"delta":"真"}}\n\n')); controller.close(); } }),
    };
  };
  const controller = new globalThis.AbortController();
  const events = [];
  const client = authenticatedClient(async () => ({ data: { ok: true }, error: null }));
  const harness = createHarnessClient({ client, fetchImpl });
  const promise = harness.streamThreadEvents({ threadId, cursor: 41, signal: controller.signal, onEvent: (event) => { events.push(event); controller.abort(); } });
  assert.equal(await promise, 42);
  assert.equal(calls, 1);
  assert.equal(events[0].type, 'assistant_text_delta');
  assert.equal(events[0].event.payload.delta, '真');
});

test('conversation workspace renders transcript, structured cards, fixed composer and server recovery', async () => {
  const page = await readFile(new globalThis.URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  const client = await readFile(new globalThis.URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  const app = await readFile(new globalThis.URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(page, /data-testid="conversation-transcript"/);
  assert.match(page, /conversation-message/);
  assert.match(page, /conversation-card/);
  assert.match(page, /kind === 'plan'/);
  assert.match(page, /kind === 'tool_call'/);
  assert.match(page, /Evidence/);
  assert.match(page, /Knowledge/);
  assert.match(page, /Brief/);
  assert.match(page, /Artifact/);
  assert.match(page, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(page, /thread\?\.actions\?\.stopGeneration === true \|\| thread\?\.actions\?\.sendMessage === false/);
  assert.match(page, /acknowledgedClientIds\.has\(message\.id\)/);
  assert.match(page, /setMessages\(\(current\) => reconcileMessages\(current, response\.messages\)\)/);
  assert.match(page, /client\.stopGeneration\(thread\.id\)/);
  assert.match(page, /client\.getThread\(threadId\)/);
  assert.match(page, /client\.listMessages\(threadId, 0, 200\)/);
  assert.match(page, /ACTIVE_THREAD_KEY/);
  assert.match(page, /ACTIVE_AGENT_THREAD_KEY/);
  assert.match(page, /agentFirst \? ACTIVE_AGENT_THREAD_KEY : ACTIVE_THREAD_KEY/);
  assert.match(app, /key=\{routeParams\?\.legacy === '1' \? 'legacy' : 'harness-native'\}/);
  assert.match(page, /onNavigate\?\.\('ai-execution', currentTaskId\)/);
  assert.match(page, /onNavigate\?\.\('ai-results', currentTaskId\)/);
  assert.doesNotMatch(page, /随机|fake/i);
  assert.match(page, /attempt > 5/);
  assert.match(page, /Math\.min\(8_000/);
  assert.match(page, /globalThis\.setTimeout/);
  assert.match(page, /重新连接/);
  assert.match(page, /harness-active-project/);
  assert.match(page, /confirmThreadPlan/);
  assert.doesNotMatch(page, /send\(['"]执行['"]\)/);
  assert.match(client, /streamThreadEvents/);
  assert.match(client, /last-event-id|cursor=/i);
});

test('browser code has no legacy direct submit and no local completed fabrication', async () => {
  const client = await readFile(new globalThis.URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  const page = await readFile(new globalThis.URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /\bsubmit\s*\(/);
  assert.doesNotMatch(page, /harnessClient\.submit|state:\s*['"]completed['"]/);
  assert.match(page, /message\.status/);
});

test('official UI capability map exactly mirrors every approved workflow id', () => {
  assert.deepEqual([...HARNESS_CAPABILITY_IDS].sort(), [...WORKFLOW_IDS].sort());
  assert.equal(new Set(HARNESS_CAPABILITY_IDS).size, HARNESS_CAPABILITY_IDS.length);
});

test('task results bind generation job identity to signed preview, download, and version history', async () => {
  const page = await readFile(new globalThis.URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /g1j-\[0-9a-f\]\{24\}/);
  assert.match(page, /generationClient\.status\(\{ jobId: generationJobId \}\)/);
  assert.match(page, /data-testid="ai-task-generation-preview"/);
  assert.match(page, /GenerationArtifactViewer/);
  assert.match(page, /artifacts=\{generationJob\.artifacts \|\| \[\]\}/);
});

test('task results recover verified private attachments and create a guarded Brief reassembly plan', async () => {
  const page = await readFile(new globalThis.URL('../src/pages/TaskResultsPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /result_data\?\.attachment_pipeline/);
  assert.match(page, /createAttachmentPreview\(\{ ref: binding\.ref, name: binding\.name \}\)/);
  assert.match(page, /createAttachmentPreview\(\{ ref: binding\.ref, name: binding\.name, download: true \}\)/);
  assert.match(page, /data-testid="ai-task-attachment-preview"/);
  assert.match(page, /attachmentPipeline\.analysis\.result/);
  assert.match(page, /intent: '重新组装当前项目的待审核 Brief'/);
  assert.match(page, /newHarnessRequestId\(\)/);
  assert.match(page, /onNavigate\?\.\('ai-execution', nextTaskId\)/);
  assert.match(page, /旧版本会保留/);
});
