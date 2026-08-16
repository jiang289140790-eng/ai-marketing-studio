/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';
const PROJECT_ID = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
const PLAN_FINGERPRINT = 'a'.repeat(64);

function browserFixtureSource() {
  const taskId = JSON.stringify(TASK_ID);
  const projectId = JSON.stringify(PROJECT_ID);
  const fingerprint = JSON.stringify(PLAN_FINGERPRINT);
  return `(async () => {
    const ReactModule = await import('/ai-marketing-studio/@id/react');
    const React = ReactModule.default || ReactModule;
    const ReactDomModule = await import('/ai-marketing-studio/@id/react-dom/client');
    const createRoot = ReactDomModule.createRoot || ReactDomModule.default?.createRoot;
    const { AIWorkspacePage } = await import('/ai-marketing-studio/src/pages/AIWorkspacePage.jsx');
    const taskId = ${taskId};
    const projectId = ${projectId};
    const fingerprint = ${fingerprint};
    const intent = '分析当前项目中的 2 条 Evidence，复用已有分析和知识卡，并生成待审核 Brief';
    const steps = [
      { step: 'st-0', label: '读取当前项目', operation: 'workspace.project.read', depends_on: [], reuse: false, cost: false, write: false },
      { step: 'st-1', label: '复用证据 1', operation: 'workspace.evidence.create', depends_on: ['st-0'], reuse: true, cost: false, write: true },
      { step: 'st-2', label: '复用证据 2', operation: 'workspace.evidence.create', depends_on: ['st-0'], reuse: true, cost: false, write: true },
      { step: 'st-3', label: '分析 Evidence 1', operation: 'research.analyze_persisted', depends_on: ['st-1'], reuse: true, cost: true, write: false },
      { step: 'st-4', label: '保存分析 1', operation: 'workspace.analysis.create', depends_on: ['st-3'], reuse: true, cost: false, write: true },
      { step: 'st-5', label: '分析 Evidence 2', operation: 'research.analyze_persisted', depends_on: ['st-2'], reuse: true, cost: true, write: false },
      { step: 'st-6', label: '保存分析 2', operation: 'workspace.analysis.create', depends_on: ['st-5'], reuse: true, cost: false, write: true },
      { step: 'st-7', label: '组装待审核 Brief', operation: 'workspace.brief.assemble', depends_on: ['st-4', 'st-6'], reuse: true, cost: false, write: true },
    ];
    const plan = {
      schema_version: 'ams_harness_plan_v1', fingerprint, workflow: 'multi_evidence_to_brief',
      workflow_title: '多 Evidence 复用并生成待审核 Brief', approvals: {
        paid_external_calls: true, online_writes: true, handoff_creation: false,
      },
      slots: { evidence_ids: ['ev-' + '1'.repeat(24), 'ev-' + '2'.repeat(24)] }, steps,
    };
    const base = {
      id: taskId, schema_version: 'ams_harness_task_v1', state: 'planned',
      request: { request_id: 'web-11111111-1111-4111-8111-111111111111', project_id: projectId, intent },
      plan, plan_fingerprint: fingerprint, step_states: Object.fromEntries(steps.map((step) => [step.step, { state: 'planned' }])),
      created_at: '2026-08-16T00:00:00.000Z', updated_at: '2026-08-16T00:00:00.000Z',
    };
    const alternateTaskId = 'ht-22222222-2222-4222-8222-222222222222';
    const alternateFingerprint = 'e'.repeat(64);
    const alternateIntent = 'alternate authoritative paid plan';
    const alternatePlan = { ...structuredClone(plan), task_id: alternateTaskId, fingerprint: alternateFingerprint, intent: alternateIntent };
    const alternate = {
      ...structuredClone(base), id: alternateTaskId,
      request: { request_id: 'web-22222222-2222-4222-8222-222222222222', project_id: projectId, intent: alternateIntent },
      plan: alternatePlan, plan_fingerprint: alternateFingerprint,
    };
    const calls = [];
    let current = null;
    let phase = 'empty';
    const record = (method, value = {}) => calls.push({ method, ...structuredClone(value) });
    const partial = () => ({
      ...structuredClone(base), state: 'partial',
      confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false }, confirmed_at: '2026-08-16T00:00:01.000Z' },
      step_states: {
        'st-0': { state: 'succeeded' }, 'st-1': { state: 'reused', reused_count: 1, artifact_refs: ['ev-' + '1'.repeat(24)] },
        'st-2': { state: 'reused', reused_count: 1, artifact_refs: ['ev-' + '2'.repeat(24)] },
        'st-3': { state: 'reused', reused_count: 1, artifact_refs: ['an-' + '1'.repeat(24)] },
        'st-4': { state: 'reused', reused_count: 1, artifact_refs: ['an-' + '1'.repeat(24)] },
        'st-5': { state: 'failed', error: { code: 'MODEL_OUTPUT_INVALID', message: '模型结果未通过有界结构校验。', retry_unsafe: false } },
        'st-6': { state: 'blocked', error: { code: 'DEPENDENCY_FAILED', message: '前置步骤失败。' } },
        'st-7': { state: 'blocked', error: { code: 'DEPENDENCY_FAILED', message: '前置步骤失败。' } },
      },
      result: { final_response: '一条分析精确复用；第二条分析失败，Brief 尚未生成。', artifact_refs: ['ev-' + '1'.repeat(24), 'ev-' + '2'.repeat(24), 'an-' + '1'.repeat(24)] },
      updated_at: '2026-08-16T00:00:02.000Z',
    });
    const succeeded = () => ({
      ...structuredClone(base), state: 'succeeded',
      confirmation: { approval: { paid_external_calls: true, online_writes: true, handoff_creation: false }, confirmed_at: '2026-08-16T00:00:01.000Z' },
      step_states: {
        'st-0': { state: 'succeeded' }, 'st-1': { state: 'reused', reused_count: 1 },
        'st-2': { state: 'reused', reused_count: 1 }, 'st-3': { state: 'reused', reused_count: 1 },
        'st-4': { state: 'reused', reused_count: 1 }, 'st-5': { state: 'succeeded', artifact_refs: ['an-' + '2'.repeat(24)] },
        'st-6': { state: 'succeeded', artifact_refs: ['an-' + '2'.repeat(24)] },
        'st-7': { state: 'succeeded', artifact_refs: ['brief-' + '3'.repeat(24)] },
      },
      result: { final_response: '两条 Evidence 已按顺序处理，已有产物被精确复用，pending_review Brief v2 已生成。', artifact_refs: ['brief-' + '3'.repeat(24)] },
      updated_at: '2026-08-16T00:00:04.000Z',
    });
    // Populated after the mocked render below: the visible preset set must be
    // read from the exact UI the fixture drives, never from the pre-render DOM.
    let presets = [];
    const presetPlan = () => ({
      schema_version: 'ams_harness_plan_v1', fingerprint, workflow: 'preset_task',
      workflow_title: '预设任务', approvals: { paid_external_calls: false, online_writes: false, handoff_creation: false },
      slots: {}, steps: [{ step: 'st-0', label: '读取当前项目', operation: 'workspace.project.read', depends_on: [], cost: false, write: false }],
    });
    const client = {
      async list(limit) { record('list', { limit }); return { ok: true, tasks: current ? [structuredClone(current), structuredClone(alternate)] : [structuredClone(alternate)] }; },
      async plan(value) {
        record('plan', value);
        if (value.projectId !== projectId) throw new Error('fixture binding mismatch');
        if (value.intent === intent) { phase = 'planned'; current = structuredClone(base); return { ok: true, task: structuredClone(current) }; }
        presets = [...document.querySelectorAll('.ai-suggestions button')].map((button) => button.textContent);
        if (presets.includes(value.intent)) {
          // A visible preset must be sent verbatim and must produce an
          // authoritative plan — never a client-side plan and never a
          // post-submission slot error.
          phase = 'planned'; current = { ...structuredClone(base), plan: presetPlan(), plan_fingerprint: fingerprint, step_states: { 'st-0': { state: 'planned' } } };
          return { ok: true, task: structuredClone(current) };
        }
        throw new Error('fixture received an intent that is not a visible preset or the fixture intent');
      },
      async confirm(value) {
        record('confirm', value);
        if (value.taskId !== taskId || value.planFingerprint !== fingerprint) throw new Error('confirmation binding mismatch');
        if (JSON.stringify(value.approval) !== JSON.stringify(plan.approvals)) throw new Error('approval mismatch');
        phase = 'confirmed'; current = { ...structuredClone(base), state: 'queued', confirmation: { approval: structuredClone(value.approval) } };
        return { ok: true, task: structuredClone(current) };
      },
      async read(value) {
        record('read', { taskId: value });
        if (value === alternateTaskId) return { ok: true, task: structuredClone(alternate) };
        if (phase === 'confirmed') { phase = 'partial'; current = partial(); }
        else if (phase === 'retried') { phase = 'succeeded'; current = succeeded(); }
        return { ok: true, task: structuredClone(current) };
      },
      async retryFailedStep(value) {
        record('retry_failed_step', value);
        if (value.taskId !== taskId || value.planFingerprint !== fingerprint || value.stepId !== 'st-5') throw new Error('retry binding mismatch');
        phase = 'retried'; current = { ...partial(), state: 'queued', step_states: { ...partial().step_states, 'st-5': { state: 'queued' } } };
        return { ok: true, task: structuredClone(current) };
      },
      async cancel(value) { record('cancel', { taskId: value }); return { ok: true, task: structuredClone(current) }; },
    };
    localStorage.clear();
    localStorage.setItem('p19_active_project_v1', projectId);
    document.body.innerHTML = '<div id="root"></div>';
    createRoot(document.getElementById('root')).render(React.createElement(AIWorkspacePage, { harnessClient: client, onNavigate: () => {} }));
    globalThis.__harnessFixture = { calls, get phase() { return phase; }, taskId, projectId, fingerprint, intent, alternateTaskId, alternateFingerprint, alternateIntent, presets };
    return true;
  })()`;
}

test('real browser: natural language becomes an authoritative plan, exact approvals, partial truth, failed-step-only retry and pending Brief', { timeout: 90_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-p30-harness-orchestrator-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT, env: { ...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' }, stdio: 'ignore', windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let tracker;
  const networkUrls = [];
  const consoleLines = [];
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'orchestrator Vite route' });
    const target = await waitForPageTarget(debugPort);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    tracker = createPageTracker(cdp);
    cdp.onMessage((message) => {
      if (message.method === 'Network.requestWillBeSent') networkUrls.push(message.params.request.url);
      if (message.method === 'Runtime.consoleAPICalled') consoleLines.push(message.params.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' '));
    });
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate(`document.readyState === 'complete'`), { label: 'orchestrator document' });
    await cdp.evaluate(browserFixtureSource());
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'mocked Harness workspace' });

    // Every visible preset must be truthful: clicking a preset fills exactly
    // its displayed text, submitting it produces an authoritative plan (never
    // a client-side plan and never a post-submission PLANNER_SLOT_REQUIRED
    // error), and the two-phase plan flow stays intact for each preset.
    const presetCount = await cdp.evaluate(`document.querySelectorAll('.ai-suggestions button').length`);
    assert.equal(presetCount, 4, 'exactly the bounded preset set is advertised');
    for (let index = 0; index < presetCount; index += 1) {
      await click(cdp, { selector: '.ai-suggestions button', index, label: `visible preset ${index}` });
      const displayed = await cdp.evaluate(`document.querySelector('.ai-suggestions button:nth-child(${index + 1})')?.textContent`);
      await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-intent"]').value === ${JSON.stringify(displayed)}`), { label: `preset ${index} fills exactly its displayed text` });
      const callsBefore = await cdp.evaluate(`globalThis.__harnessFixture.calls.filter((call) => call.method === 'plan').length`);
      await click(cdp, { selector: '[data-testid="harness-submit"]', label: `submit preset ${index}` });
      await waitFor(() => cdp.evaluate(`globalThis.__harnessFixture.calls.filter((call) => call.method === 'plan').length === ${callsBefore + 1}`), { label: `preset ${index} plan request recorded` });
      await waitForSelector(cdp, '[data-testid="harness-authoritative-plan"]', { label: `authoritative plan for preset ${index}` });
      assert.equal(await cdp.evaluate(`document.querySelector('.notice.error') === null`), true, `preset ${index} must never fail after submission`);
    }
    assert.equal(await cdp.evaluate(`globalThis.__harnessFixture.calls.filter((call) => call.method === 'plan').length`), presetCount, 'each preset submits exactly one plan request');

    await cdp.evaluate(`(() => { const input = document.querySelector('[data-testid="harness-intent"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, globalThis.__harnessFixture.intent); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-submit"]')?.disabled === false`), { label: 'plan button enabled' });
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: 'request authoritative plan' });
    await waitForSelector(cdp, '[data-testid="harness-authoritative-plan"]', { label: 'authoritative plan' });

    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-authoritative-plan"] code').title`), PLAN_FINGERPRINT);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-plan-steps > li').length`), 8, 'all ordered server steps are visible');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled`), true, 'execution is blocked before exact approvals');
    assert.equal(await cdp.evaluate(`globalThis.__harnessFixture.calls.filter((call) => call.method === 'plan').length`), presetCount + 1, 'planning is a distinct first phase after the preset sweep');
    assert.equal(await cdp.evaluate(`globalThis.__harnessFixture.calls.some((call) => call.method === 'confirm' || call.method === 'retry_failed_step')`), false);

    await click(cdp, { selector: '[data-testid="harness-paid-approval"]', label: 'paid scope approval before history switch' });
    await click(cdp, { selector: '[data-testid="harness-write-approval"]', label: 'write scope approval before history switch' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled === false`), { label: 'first plan approvals ready' });
    await cdp.evaluate(`([...document.querySelectorAll('.ai-task-list button')].find((button) => button.textContent.includes(globalThis.__harnessFixture.alternateIntent))).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-authoritative-plan"] code')?.title === globalThis.__harnessFixture.alternateFingerprint`), { label: 'alternate historical plan active' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-paid-approval"]').checked`), false, 'paid approval never crosses plan identity');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-write-approval"]').checked`), false, 'write approval never crosses plan identity');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled`), true, 'alternate plan requires fresh exact approval');
    await cdp.evaluate(`([...document.querySelectorAll('.ai-task-list button')].find((button) => button.textContent.includes(globalThis.__harnessFixture.intent))).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-authoritative-plan"] code')?.title === globalThis.__harnessFixture.fingerprint`), { label: 'original historical plan active again' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-paid-approval"]').checked`), false, 'returning to a prior plan does not resurrect old consent');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-write-approval"]').checked`), false, 'returning write consent stays cleared');
    await click(cdp, { selector: '[data-testid="harness-paid-approval"]', label: 'fresh paid scope approval' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled`), true, 'one missing required approval still blocks confirmation');
    await click(cdp, { selector: '[data-testid="harness-write-approval"]', label: 'fresh write scope approval' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled === false`), { label: 'exact approvals ready' });
    await click(cdp, { selector: '[data-testid="harness-confirm"]', label: 'confirm exact plan' });

    await waitFor(() => cdp.evaluate(`document.querySelector('.ai-section-heading h2')?.textContent === '部分完成'`), { timeout: 15_000, label: 'truthful partial state' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-step-st-1"]').dataset.state`), 'reused');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-step-st-5"]').dataset.state`), 'failed');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-step-st-7"]').dataset.state`), 'blocked');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid^="harness-retry-"]').length`), 1, 'only the eligible failed step can be retried');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-retry-st-5"]') !== null`), true);

    await click(cdp, { selector: '[data-testid="harness-retry-st-5"]', label: 'retry exact failed step' });
    await waitFor(() => cdp.evaluate(`document.querySelector('.ai-section-heading h2')?.textContent === '已完成'`), { timeout: 15_000, label: 'successful resumed task' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-step-st-1"]').dataset.state`), 'reused', 'completed/reused steps remain untouched');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-step-st-5"]').dataset.state`), 'succeeded');
    assert.equal(await cdp.evaluate(`document.querySelector('.ai-raw-response .ai-result-copy')?.textContent.includes('pending_review Brief v2 已生成') === true`), true);
    assert.equal(await cdp.evaluate(`document.body.textContent.includes(${JSON.stringify('brief-' + '3'.repeat(24))})`), true);

    const calls = await cdp.evaluate(`structuredClone(globalThis.__harnessFixture.calls)`);
    const planCall = calls.find((call) => call.method === 'plan');
    const confirmCall = calls.find((call) => call.method === 'confirm');
    const retryCall = calls.find((call) => call.method === 'retry_failed_step');
    assert.equal(planCall.projectId, PROJECT_ID);
    assert.equal(confirmCall.planFingerprint, PLAN_FINGERPRINT);
    assert.deepEqual(confirmCall.approval, { paid_external_calls: true, online_writes: true, handoff_creation: false });
    assert.equal(retryCall.stepId, 'st-5');
    assert.equal(retryCall.planFingerprint, PLAN_FINGERPRINT);
    assert.equal(calls.filter((call) => call.method === 'retry_failed_step').length, 1);

    const securitySnapshot = await cdp.evaluate(`({ body: document.body.innerText, storage: Object.fromEntries(Object.entries(localStorage)), calls: globalThis.__harnessFixture.calls })`);
    const serialized = JSON.stringify(securitySnapshot) + consoleLines.join('\n');
    for (const forbidden of ['service_role', 'Authorization', 'Bearer ', 'DASHSCOPE_API_KEY', 'APIFY_TOKEN', 'sk-']) {
      assert.equal(serialized.includes(forbidden), false, `browser evidence must not expose ${forbidden}`);
    }
    const external = networkUrls.filter((url) => !url.startsWith(`http://127.0.0.1:${vitePort}/`) && !url.startsWith('data:') && !url.startsWith('blob:'));
    assert.deepEqual(external, [], `all browser requests must stay on loopback: ${external.join(', ')}`);
  } catch (error) {
    if (cdp) error.message += `\n${await captureDiagnostics(cdp, { tracker })}`;
    throw error;
  } finally {
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
  }
});
