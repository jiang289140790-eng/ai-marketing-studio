/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  waitForSelector, click, captureDiagnostics, makeTempProfile,
  removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const THREAD_ID = 'th-11111111-1111-4111-8111-111111111111';
const TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';

function fixtureSource() {
  return `(async () => {
    const ReactModule = await import('/ai-marketing-studio/@id/react');
    const React = ReactModule.default || ReactModule;
    const ReactDomModule = await import('/ai-marketing-studio/@id/react-dom/client');
    const createRoot = ReactDomModule.createRoot || ReactDomModule.default?.createRoot;
    const { AIWorkspacePage } = await import('/ai-marketing-studio/src/pages/AIWorkspacePage.jsx');
    const threadId = ${JSON.stringify(THREAD_ID)};
    const taskId = ${JSON.stringify(TASK_ID)};
    let cursor = 0;
    let sequence = 0;
    let eventSink;
    const pendingEvents = [];
    const calls = [];
    const messages = [];
    const threadState = { status: 'active', currentTaskId: null, stopGeneration: false };
    const append = (value) => messages.push({ sequence: ++sequence, status: 'completed', ...value });
    const emit = (type, payload = {}) => {
      const value = { type, cursor: ++cursor, event: { cursor, type, task_id: taskId, payload } };
      if (eventSink) eventSink(value); else pendingEvents.push(value);
    };
    const client = {
      async createThread(value) { calls.push({ method: 'createThread', value }); return { threadId, currentTaskId: null, eventCursor: cursor }; },
      async getThread() { return { thread: { id: threadId, status: threadState.status }, currentTaskId: threadState.currentTaskId, eventCursor: cursor, actions: { sendMessage: true, stopGeneration: threadState.stopGeneration } }; },
      async listMessages() { return { messages: structuredClone(messages) }; },
      async sendMessage(value) {
        calls.push({ method: 'sendMessage', value });
        append({ id: value.clientMessageId, thread_id: threadId, role: 'user', kind: 'text', content: value.content });
        if (value.content === '执行') {
          append({ id: 'progress', thread_id: threadId, task_id: taskId, role: 'system', kind: 'progress', content: '执行完成', structured_payload: { completed_steps: 3, total_steps: 3 } });
          append({ id: 'brief', thread_id: threadId, task_id: taskId, role: 'assistant', kind: 'brief', content: 'Brief 已生成，等待审核', structured_payload: { review_status: 'pending_review' } });
          threadState.status = 'executing';
          queueMicrotask(() => emit('task_progress', { completed_steps: 3 }));
          queueMicrotask(() => emit('brief_result', { review_status: 'pending_review' }));
          queueMicrotask(() => emit('task_completed', { state: 'succeeded' }));
        } else {
          append({ id: 'plan', thread_id: threadId, task_id: taskId, role: 'assistant', kind: 'plan', content: '已生成确定性计划，等待确认', structured_payload: {
            approvals: { paid_external_calls: true, online_writes: true },
            cost_indicators: { paid_calls: 2 },
            steps: [
              { step: 'st-1', label: '读取 Evidence', operation: 'workspace.evidence.list' },
              { step: 'st-2', label: '分析 Evidence', operation: 'research.analyze_persisted' },
              { step: 'st-3', label: '生成 Brief', operation: 'workspace.brief.assemble' },
            ],
          } });
          threadState.status = 'waiting_confirmation';
          threadState.currentTaskId = taskId;
          queueMicrotask(() => emit('plan_created', {}));
        }
        return { ok: true, accepted: true, messageId: messages.at(-1).id };
      },
      async streamThreadEvents({ onEvent, onStatus, signal }) {
        eventSink = onEvent;
        onStatus('connected');
        for (const value of pendingEvents.splice(0)) onEvent(value);
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      async uploadAttachment() { throw new Error('not used'); },
      async stopGeneration() { return { ok: true }; },
    };
    localStorage.clear();
    document.body.innerHTML = '<div id="root"></div>';
    createRoot(document.getElementById('root')).render(React.createElement(AIWorkspacePage, { harnessClient: client, onNavigate: () => {} }));
    globalThis.__setGenerationActive = (active) => {
      threadState.stopGeneration = active;
      threadState.status = active ? 'executing' : 'waiting_confirmation';
      emit(active ? 'task_progress' : 'plan_created', {});
    };
    globalThis.__fixture = { calls, messages, threadId, taskId };
    return true;
  })()`;
}

test('real browser: authoritative plan and confirmation remain in one server-backed thread', { timeout: 60_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-conversation-orchestrator-');
  const vite = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: ROOT, env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, stdio: 'ignore', windowsHide: true,
  });
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let tracker;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    tracker = createPageTracker(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate(`document.readyState === 'complete'`), { label: 'document ready' });
    await cdp.evaluate(fixtureSource());
    await waitForSelector(cdp, '[data-testid="harness-intent"]', { label: 'composer' });
    const intent = '分析当前项目的 2 条 Evidence，并生成待审核 Brief';
    await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="harness-intent"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(intent)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: 'send task intent' });
    await waitForSelector(cdp, '.conversation-card.kind-plan', { label: 'plan card' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.conversation-card.kind-plan li').length`), 3);
    assert.equal(await cdp.evaluate(`document.querySelector('.conversation-card.kind-plan').textContent.includes('2 次付费调用')`), true);
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-flow-execution"]').disabled`), false);
    const sendsBeforeActiveEnter = await cdp.evaluate(`globalThis.__fixture.calls.filter((call) => call.method === 'sendMessage').length`);
    await cdp.evaluate(`globalThis.__setGenerationActive(true)`);
    await waitForSelector(cdp, '.composer-stop', { label: 'authoritative stop action' });
    await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="harness-intent"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'must not send'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    assert.equal(await cdp.evaluate(`globalThis.__fixture.calls.filter((call) => call.method === 'sendMessage').length`), sendsBeforeActiveEnter, 'Enter cannot append an orphan message while generation is active');
    await cdp.evaluate(`globalThis.__setGenerationActive(false)`);
    await waitForSelector(cdp, '.conversation-card.kind-plan .primary', { label: 'plan confirmation restored' });
    await click(cdp, { selector: '.conversation-card.kind-plan .primary', label: 'confirm plan' });
    await waitForSelector(cdp, '.conversation-card.kind-brief', { label: 'Brief result' });
    assert.equal(await cdp.evaluate(`document.querySelector('.conversation-card.kind-progress') !== null`), true);
    const snapshot = await cdp.evaluate(`structuredClone(globalThis.__fixture)`);
    const sends = snapshot.calls.filter((call) => call.method === 'sendMessage');
    assert.equal(snapshot.calls.filter((call) => call.method === 'createThread').length, 1);
    assert.equal(sends.length, 2);
    assert.equal(sends.every((call) => call.value.threadId === THREAD_ID), true);
    assert.equal(new Set(sends.map((call) => call.value.requestId)).size, 2);
    assert.equal(snapshot.messages.filter((message) => message.task_id).every((message) => message.task_id === TASK_ID), true);
    assert.equal(tracker.state.exceptions, 0, tracker.state.lastException || 'browser exception');
  } catch (error) {
    if (cdp) error.message += `\n${await captureDiagnostics(cdp, { tracker })}`;
    throw error;
  } finally {
    tracker?.off();
    cdp?.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
