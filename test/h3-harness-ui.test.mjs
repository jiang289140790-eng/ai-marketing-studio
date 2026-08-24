/* global ReadableStream, TextEncoder */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarnessClient, HARNESS_EDGE_SCHEMA_VERSION } from '../src/services/harness-client.js';

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
  await harness.listMessages(threadId, 7, 100);
  await harness.stopGeneration(threadId);
  assert.deepEqual(calls.map((entry) => entry.options.body.action), ['thread_create', 'thread_get', 'thread_send', 'thread_send_agent', 'thread_messages', 'thread_stop']);
  assert.equal(calls[0].options.body.schema_version, HARNESS_EDGE_SCHEMA_VERSION);
  assert.equal(calls[2].options.body.request_id, 'request-message');
  assert.equal(calls[2].options.body.client_message_id, 'client-message');
  assert.equal(calls[4].options.body.cursor, '7');
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
  assert.equal(uploads[0].options.upsert, false);
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
  assert.match(app, /key=\{routeParams\?\.agent === '1' \? 'agent-first' : 'legacy'\}/);
  assert.match(page, /onNavigate\?\.\('ai-execution', currentTaskId\)/);
  assert.match(page, /onNavigate\?\.\('ai-results', currentTaskId\)/);
  assert.doesNotMatch(page, /setTimeout|随机|fake/i);
  assert.match(client, /streamThreadEvents/);
  assert.match(client, /last-event-id|cursor=/i);
});

test('browser code has no legacy direct submit and no local completed fabrication', async () => {
  const client = await readFile(new globalThis.URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  const page = await readFile(new globalThis.URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /\bsubmit\s*\(/);
  assert.doesNotMatch(page, /harnessClient\.submit|state:\s*['"]completed['"]|setTimeout/);
  assert.match(page, /message\.status/);
});
