import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationRunner } from '../conversation-runner.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-conversation-child.mjs', import.meta.url));
const threadId = 'thr_00000000-0000-4000-8000-000000000201';
const sessionId = 'session-00000000-0000-4000-8000-000000000201';
const userId = '00000000-0000-4000-8000-000000000101';

function request(content, requestId = 'request-1') {
  return {
    schema_version: 1,
    thread_id: threadId,
    native_session_id: sessionId,
    request_id: requestId,
    workspace_id: 'ai-marketing-studio-staging',
    content,
  };
}

test('exports native session frames without synthesizing text', async () => {
  const frames = [];
  const runner = createConversationRunner({ executable: process.execPath, profileArgs: [fixture], workspace: process.cwd(), timeoutMs: 2_000 });
  const result = await runner.run(request('question'), userId, { onFrame: (frame) => frames.push(frame) });
  assert.equal(result.ok, true);
  assert.equal(frames[0].type, 'generation_started');
  assert.equal(frames[1].type, 'session_resumed');
  assert.equal(frames[2].event.type, 'assistant/chunk');
  assert.equal(frames.at(-1).reason.kind, 'completed');
});

test('deduplicates concurrent generation and stop is independent of task cancel', async () => {
  const runner = createConversationRunner({ executable: process.execPath, profileArgs: [fixture], workspace: process.cwd(), timeoutMs: 2_000 });
  const frames = [];
  const running = runner.run(request('wait-for-stop', 'request-stop'), userId, { onFrame: (frame) => frames.push(frame) });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  const duplicate = await runner.run(request('question', 'request-duplicate'), userId);
  assert.deepEqual(duplicate, { ok: false, code: 'GENERATION_ALREADY_ACTIVE' });
  const stopped = runner.stop(userId, threadId);
  assert.equal(stopped.ok, true);
  assert.equal((await running).ok, true);
  assert.equal(frames.at(-1).reason.kind, 'aborted');
  assert.equal(runner.hasActive(userId, threadId), false);
});

test('rejects malformed thread/session/request binding before spawn', async () => {
  const runner = createConversationRunner({ executable: process.execPath, profileArgs: [fixture], workspace: process.cwd() });
  await assert.rejects(() => runner.run({ ...request('x'), thread_id: '../escape' }, userId), { code: 'CONVERSATION_REQUEST_INVALID' });
  await assert.rejects(() => runner.run({ ...request('x'), workspace_id: 'other' }, userId), { code: 'CONVERSATION_REQUEST_INVALID' });
  await assert.rejects(() => runner.run({ ...request('x'), attachments: [{ ref: 'public:file.pdf', name: 'file.pdf', size: 100, mime_type: 'application/pdf' }] }, userId), { code: 'CONVERSATION_REQUEST_INVALID' });
});

test('accepts only bounded private attachment identity in native conversation context', async () => {
  const runner = createConversationRunner({ executable: process.execPath, profileArgs: [fixture], workspace: process.cwd(), timeoutMs: 2_000 });
  const attachment = {
    ref: `harness-thread-attachments:${userId}/${threadId}/request-attachment/brief.pdf`,
    name: 'brief.pdf',
    size: 1024,
    mime_type: 'application/pdf',
  };
  const result = await runner.run({ ...request('summarize attachment', 'request-attachment'), attachments: [attachment] }, userId);
  assert.equal(result.ok, true);
});

test('completed request replays persisted native frames after restart without another model process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ams-conversation-journal-'));
  const journalFile = join(directory, 'conversation.jsonl');
  try {
    const first = createConversationRunner({ executable: process.execPath, profileArgs: [fixture], workspace: process.cwd(), journalFile });
    const firstFrames = [];
    assert.equal((await first.run(request('question', 'durable-request'), userId, { onFrame: (frame) => firstFrames.push(frame) })).ok, true);
    const restarted = createConversationRunner({ executable: 'missing-executable-must-not-spawn', workspace: process.cwd(), journalFile });
    const replayFrames = [];
    const replay = await restarted.run(request('question', 'durable-request'), userId, { onFrame: (frame) => replayFrames.push(frame) });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replayFrames, firstFrames.slice(1), 'native persisted frames replay; synthetic process-start metadata is not duplicated');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('ambiguous interrupted request fails closed after restart and never starts a duplicate model call', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ams-conversation-interrupted-'));
  const journalFile = join(directory, 'conversation.jsonl');
  const requestKey = `${userId}:${threadId}:interrupted-request`;
  try {
    appendFileSync(journalFile, `${JSON.stringify({ key: requestKey, state: 'started' })}\n`);
    const restarted = createConversationRunner({ executable: 'missing-executable-must-not-spawn', workspace: process.cwd(), journalFile });
    assert.deepEqual(await restarted.run(request('question', 'interrupted-request'), userId), { ok: false, code: 'GENERATION_RECOVERY_REQUIRED', replayed: true });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
