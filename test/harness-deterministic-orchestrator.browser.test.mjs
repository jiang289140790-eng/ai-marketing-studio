/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const SCREENSHOT_DIR = join(ROOT, 'acceptance-evidence', 'harness-conversation-20260823');

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
    const navigations = [];
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
        append({ id: 'plan', thread_id: threadId, task_id: taskId, role: 'assistant', kind: 'plan', content: '已生成确定性计划，等待确认', structured_payload: {
          fingerprint: '${'a'.repeat(64)}',
          approvals: { paid_external_calls: true, online_writes: true },
          cost_indicators: { paid_calls: 2, online_writes: 1 },
          steps: [
            { step: 'st-1', label: '读取 Evidence', operation: 'workspace.evidence.list' },
            { step: 'st-2', label: '分析 Evidence', operation: 'research.analyze_persisted' },
            { step: 'st-3', label: '生成 Brief', operation: 'workspace.brief.assemble' },
          ],
        } });
        append({ id: 'tool', thread_id: threadId, task_id: taskId, role: 'tool', kind: 'tool_call', content: '准备读取项目上下文', structured_payload: { tool: 'workspace.evidence.list', project_id: 'project-safe', API_KEY: 'must-never-render', authorization: 'must-never-render', nested: { password: 'must-never-render' } } });
        append({ id: 'evidence', thread_id: threadId, task_id: taskId, role: 'assistant', kind: 'evidence', content: '已找到可复用 Evidence', structured_payload: { count: 2, source: '当前项目', credential: 'must-never-render', Cookie: 'must-never-render' } });
        append({ id: 'historical', thread_id: threadId, task_id: 'ht-22222222-2222-4222-8222-222222222222', role: 'assistant', kind: 'artifact', content: '{"auth":"must-never-render"}', structured_payload: { signed_url: 'must-never-render', signature: 'must-never-render', title: '历史成品' } });
        append({ id: 'unsafe-text', thread_id: threadId, role: 'assistant', kind: 'text', content: '{"bearer":"must-never-render"}' });
        threadState.status = 'waiting_confirmation';
        threadState.currentTaskId = taskId;
        queueMicrotask(() => emit('plan_created', {}));
        return { ok: true, accepted: true, messageId: messages.at(-1).id };
      },
      async confirmThreadPlan(value) {
        calls.push({ method: 'confirmThreadPlan', value });
        append({ id: 'progress', thread_id: threadId, task_id: taskId, role: 'system', kind: 'progress', content: '执行完成', structured_payload: { completed_steps: 3, total_steps: 3 } });
        append({ id: 'brief', thread_id: threadId, task_id: taskId, role: 'assistant', kind: 'brief', content: 'Brief 已生成，等待审核', structured_payload: { review_status: 'pending_review' } });
        threadState.status = 'executing';
        queueMicrotask(() => emit('task_progress', { completed_steps: 3 }));
        queueMicrotask(() => emit('brief_result', { review_status: 'pending_review' }));
        queueMicrotask(() => emit('task_completed', { state: 'succeeded' }));
        return { ok: true, accepted: true };
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
    createRoot(document.getElementById('root')).render(React.createElement(AIWorkspacePage, { harnessClient: client, onNavigate: (page, id) => navigations.push({ page, id }) }));
    globalThis.__setGenerationActive = (active) => {
      threadState.stopGeneration = active;
      threadState.status = active ? 'executing' : 'waiting_confirmation';
      emit(active ? 'task_progress' : 'plan_created', {});
    };
    globalThis.__fixture = { calls, messages, navigations, threadId, taskId };
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
    await click(cdp, { selector: '[data-testid="ai-task-flow-execution"]', label: 'task flow execution link' });
    await click(cdp, { selector: '[data-testid="ai-task-flow-results"]', label: 'task flow results link' });
    await click(cdp, { selector: '.conversation-toolbar button:first-of-type', label: 'conversation toolbar execution link' });
    await click(cdp, { selector: '.conversation-toolbar button:last-of-type', label: 'conversation toolbar results link' });
    await click(cdp, { selector: '.conversation-card.kind-plan footer button:not(.primary)', label: 'plan execution link' });
    await click(cdp, { selector: '.conversation-card.kind-plan footer button:last-child', label: 'plan results link' });
    const navigationSnapshot = await cdp.evaluate(`structuredClone(globalThis.__fixture.navigations)`);
    assert.deepEqual(navigationSnapshot, [
      { page: 'ai-execution', id: TASK_ID },
      { page: 'ai-results', id: TASK_ID },
      { page: 'ai-execution', id: TASK_ID },
      { page: 'ai-results', id: TASK_ID },
      { page: 'ai-execution', id: TASK_ID },
      { page: 'ai-results', id: TASK_ID },
    ], 'all visible task links preserve the authoritative taskId');
    for (const [width, height] of [[1440, 1000], [1366, 900], [1024, 850], [768, 900], [390, 844]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      const state = await cdp.evaluate(`(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        plan: Boolean(document.querySelector('.kind-plan')),
        tool: Boolean(document.querySelector('.kind-tool_call details')),
        result: Boolean(document.querySelector('.kind-evidence .conversation-summary-grid')),
        taskButtons: Array.from(document.querySelectorAll('.conversation-toolbar button')).every((button) => button.getBoundingClientRect().right <= innerWidth + 1),
        hasPre: Boolean(document.querySelector('.conversation-workspace pre')),
        leaked: document.querySelector('.conversation-workspace').innerText.includes('must-never-render'),
        historicalActions: document.querySelectorAll('.kind-artifact footer button').length,
      }))()`);
      assert.deepEqual(state, { overflow: false, plan: true, tool: true, result: true, taskButtons: true, hasPre: false, leaked: false, historicalActions: 0 }, `${width}px structured conversation remains safe and reachable`);
      if (process.env.AMS_CAPTURE_ACCEPTANCE_SCREENSHOTS === '1') {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        writeFileSync(join(SCREENSHOT_DIR, `tasks-new-conversation-${width}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
    const sendsBeforeActiveEnter = await cdp.evaluate(`globalThis.__fixture.calls.filter((call) => call.method === 'sendMessage').length`);
    await cdp.evaluate(`globalThis.__setGenerationActive(true)`);
    await waitForSelector(cdp, '.composer-stop', { label: 'authoritative stop action' });
    await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="harness-intent"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'must not send'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    assert.equal(await cdp.evaluate(`globalThis.__fixture.calls.filter((call) => call.method === 'sendMessage').length`), sendsBeforeActiveEnter, 'Enter cannot append an orphan message while generation is active');
    await cdp.evaluate(`globalThis.__setGenerationActive(false)`);
    await waitForSelector(cdp, '.conversation-approval-scopes', { label: 'plan approval scopes restored' });
    await cdp.evaluate(`document.querySelectorAll('.conversation-approval-scopes input:not(:disabled)').forEach((input) => input.click())`);
    await waitForSelector(cdp, '.conversation-card.kind-plan .primary', { label: 'plan confirmation enabled after exact approvals' });
    await click(cdp, { selector: '.conversation-card.kind-plan .primary', label: 'confirm plan' });
    await waitForSelector(cdp, '.conversation-card.kind-brief', { label: 'Brief result' });
    assert.equal(await cdp.evaluate(`document.querySelector('.conversation-card.kind-progress') !== null`), true);
    const snapshot = await cdp.evaluate(`structuredClone(globalThis.__fixture)`);
    const sends = snapshot.calls.filter((call) => call.method === 'sendMessage');
    const confirmations = snapshot.calls.filter((call) => call.method === 'confirmThreadPlan');
    assert.equal(snapshot.calls.filter((call) => call.method === 'createThread').length, 1);
    assert.equal(sends.length, 1);
    assert.equal(sends.every((call) => call.value.threadId === THREAD_ID), true);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].value.planFingerprint, 'a'.repeat(64));
    assert.deepEqual(confirmations[0].value.approval, { paid_external_calls: true, online_writes: true, handoff_creation: false });
    assert.equal(snapshot.messages.filter((message) => message.id !== 'historical' && message.task_id).every((message) => message.task_id === TASK_ID), true);
    assert.equal(snapshot.messages.find((message) => message.id === 'historical')?.task_id, 'ht-22222222-2222-4222-8222-222222222222');
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
