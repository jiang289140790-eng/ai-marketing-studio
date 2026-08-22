/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHarnessClient, HARNESS_ACTIVE_PROJECT_KEY, HARNESS_EDGE_SCHEMA_VERSION, normalizeHarnessIntent, readHarnessActiveProject } from '../src/services/harness-client.js';

const taskId = 'ht-11111111-1111-4111-8111-111111111111';
const fingerprint = 'a'.repeat(64);
const approval = { paid_external_calls: true, online_writes: false, handoff_creation: false };

test('browser Harness client plans, confirms and retries only through the authenticated Edge contract', async () => {
  const calls = [];
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'stale-user-jwt' } }, error: null }),
      refreshSession: async () => ({ data: { session: { access_token: 'user-jwt-value' } }, error: null }),
    },
    functions: { invoke: async (name, options) => { calls.push({ name, options }); return { data: { ok: true, task: { id: taskId, state: 'planned' } }, error: null }; } },
  };
  const harness = createHarnessClient({ client });
  await harness.plan({ requestId: 'web-request-1', intent: 'Analyze the current research project.' });
  await harness.confirm({ taskId, planFingerprint: fingerprint, approval });
  await harness.retryFailedStep({ taskId, planFingerprint: fingerprint, stepId: 'st-2', approval });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].options.body, {
    schema_version: HARNESS_EDGE_SCHEMA_VERSION,
    action: 'plan',
    request_id: 'web-request-1',
    project_id: null,
    intent: 'Analyze the current research project.',
  });
  assert.equal(calls[1].options.body.action, 'confirm');
  assert.equal(calls[1].options.body.plan_fingerprint, fingerprint);
  assert.equal(calls[2].options.body.action, 'retry_failed_step');
  assert.equal(calls[2].options.body.step_id, 'st-2');
  for (const call of calls) {
    assert.equal(call.name, 'harness-command');
    assert.equal(call.options.headers.Authorization, 'Bearer user-jwt-value');
    assert.doesNotMatch(JSON.stringify(call), /service[_-]?role|hmac.secret|database_url/i);
  }
});

test('browser Harness client fails closed without a signed-in session', async () => {
  const harness = createHarnessClient({ client: { auth: { getSession: async () => ({ data: { session: null }, error: null }) }, functions: { invoke: async () => assert.fail('Edge must not be called without auth') } } });
  await assert.rejects(() => harness.list(), (error) => error.code === 'AUTH_REQUIRED');
});

test('natural Chinese capability questions map to the fixed read-only capability workflow intent', async () => {
  assert.equal(normalizeHarnessIntent('你现在能做哪些事情'), '能力：你现在能做哪些事情');
  assert.equal(normalizeHarnessIntent('目前可以完成什么任务？'), '能力：目前可以完成什么任务？');
  assert.equal(normalizeHarnessIntent('分析这个 X 帖子'), '分析这个 X 帖子');
  const { createPlanner } = await import('../services/harness-gateway/planner.mjs');
  const verdict = await createPlanner().plan({
    taskId,
    request: {
      user_id: 'user-a',
      project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
      intent: normalizeHarnessIntent('你现在能做哪些事情'),
      request_fingerprint: 'a'.repeat(64),
    },
  });
  assert.equal(verdict.ok, true, verdict.code);
  assert.equal(verdict.value.workflow, 'read_capability');
  assert.equal(verdict.value.cost_indicators.paid_calls, 0);
  assert.equal(verdict.value.cost_indicators.online_writes, 0);
});

test('browser Harness client preserves bounded Edge diagnostics instead of masking a rejected plan as unavailable', async () => {
  const client = {
    auth: { refreshSession: async () => ({ data: { session: { access_token: 'user-jwt-value' } }, error: null }) },
    functions: { invoke: async () => ({
      data: null,
      error: { context: { code: 'PLANNER_UNRECOGNIZED', message: '无法识别该任务目标。' } },
    }) },
  };
  const harness = createHarnessClient({ client });
  await assert.rejects(
    () => harness.plan({ requestId: 'diagnostic-1', intent: 'unsupported' }),
    (error) => error.code === 'PLANNER_UNRECOGNIZED' && error.message === '无法识别该任务目标。',
  );
});

test('Harness plan/confirm/retry refresh delegated sessions but read-only polling does not', async () => {
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
  await harness.plan({ requestId: 'refresh-1', intent: 'read project' });
  await harness.confirm({ taskId, planFingerprint: fingerprint, approval: { paid_external_calls: false, online_writes: false, handoff_creation: false } });
  await harness.retryFailedStep({ taskId, planFingerprint: fingerprint, stepId: 'st-1', approval: { paid_external_calls: false, online_writes: false, handoff_creation: false } });
  await harness.list();
  assert.equal(refreshes, 3);
  assert.equal(reads, 1);
});

test('AI workspace binds plans to the exact selected P19 project and preserves request identity until accepted', async () => {
  const exact = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(readHarnessActiveProject({ getItem: (key) => key === HARNESS_ACTIVE_PROJECT_KEY ? exact : null }), exact);
  assert.equal(readHarnessActiveProject({ getItem: () => 'prj-not-valid' }), null);
  assert.equal(readHarnessActiveProject({ getItem: () => { throw new Error('storage denied'); } }), null);
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /const projectId = readHarnessActiveProject\(\)/);
  assert.match(page, /const submissionKey = JSON\.stringify\(\[projectId, normalizedIntent\]\)/);
  assert.match(page, /harnessClient\.plan\(\{[\s\S]*requestId: pendingSubmission\.current\.requestId,[\s\S]*projectId,[\s\S]*intent: normalizedIntent/);
  assert.match(page, /generation !== pollGeneration\.current/);
  assert.match(page, /if \(pollInFlight\.current\) return/);
  assert.match(page, /const pendingSubmission = useRef\(null\)/);
  assert.ok(page.indexOf('pendingSubmission.current = null') > page.indexOf("if (!task) throw new Error('计划入口没有返回任务记录。')"));
});

test('AI workspace renders the immutable server plan, exact approvals, truthful step states and failed-step retry', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../src/components/Sidebar.jsx', import.meta.url), 'utf8');
  assert.match(page, /今天想完成什么？/);
  assert.match(page, /高级研究模式/);
  assert.match(page, /此步骤只生成计划，不调用付费工具，也不写入数据/);
  assert.match(page, /data-testid="ai-command-center"/);
  assert.match(page, /按需展开 5 个常用模板/);
  assert.match(page, /const businessPlugins = \[/);
  for (const plugin of ['研究工作台', 'Evidence', 'Knowledge', 'Brief 审核', '生成中心', '成品库']) {
    assert.match(page, new RegExp(plugin), `Harness business plugin ${plugin} remains discoverable`);
  }
  assert.match(page, /onNavigate\?\.\(plugin\.route \|\| plugin\.id, '', plugin\.routeParams \|\| \{\}\)/);
  assert.match(page, /routeParams: \{ focus: 'collect' \}[\s\S]*label: 'Evidence'/);
  assert.match(page, /routeParams: \{ focus: 'outputs' \}[\s\S]*label: 'Brief 审核'/);
  assert.match(page, /data-testid=\{`harness-plugin-\$\{plugin\.id\}`\}/);
  assert.match(page, /最近任务与成果/);
  assert.match(page, /默认收起/);
  assert.match(page, /history\.slice\(0, 6\)/);
  assert.match(page, /ai-message ai-message-user/);
  assert.match(page, /ai-message ai-message-assistant/);
  assert.match(page, /data-testid="harness-authoritative-plan"/);
  assert.match(page, /authoritativePlan\.fingerprint/);
  assert.match(page, /requiredApprovals\.paid_external_calls/);
  assert.match(page, /requiredApprovals\.online_writes/);
  assert.match(page, /requiredApprovals\.handoff_creation/);
  assert.match(page, /data-testid="harness-confirm"/);
  assert.match(page, /harnessClient\.retryFailedStep/);
  assert.match(page, /snapshot\?\.error\?\.retry_unsafe !== true/);
  assert.match(page, /partial: '部分完成'/);
  assert.match(app, /default:\s*return <AIWorkspacePage/);
  assert.match(app, /sidebarCollapsed/);
  assert.match(app, /ams-sidebar-collapsed/);
  assert.match(app, /onCollapsedChange=\{updateSidebarCollapsed\}/);
  assert.doesNotMatch(sidebar, /PRIMARY_NAV_IDS/);
  assert.match(sidebar, /navigationSections\.map/);
  assert.match(sidebar, /aria-expanded=\{expanded\}/);
  assert.match(sidebar, /activeSectionLabel/);
  assert.match(sidebar, /sidebar-collapse-toggle/);
  assert.match(sidebar, /collapsed \? '展开侧栏' : '收起侧栏'/);
  assert.match(sidebar, /hidden=\{!expanded && !collapsed\}/);
  assert.match(sidebar, /Staging 智能工作台/);
});

test('AI workspace exposes structured terminal tool results', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /activeTask\.result\?\.result_data/);
  assert.match(page, /data-testid="harness-result-summary"/);
  assert.match(page, /查看 \{evidenceCount\} 条证据/);
  assert.match(page, /查看执行报告/);
  assert.match(page, /onNavigate\?\.\('research'\)/);
  assert.match(page, /<summary>技术详情<\/summary>/);
});

test('generation workspace hands exact bounded context to the AI Harness workspace', async () => {
  const page = await readFile(new URL('../src/pages/GenerationTasksPage.jsx', import.meta.url), 'utf8');
  assert.match(page, /buildHarnessContextParams\(\{/);
  assert.match(page, /source: 'generation'/);
  assert.match(page, /entity: 'generation-workspace'/);
  assert.match(page, /交给 AI 编排/);
  assert.match(page, /onNavigate\?\.\('ai'/);
  assert.match(page, /先展示报价，等待我确认后再执行/);
});

test('browser code never submits legacy direct tasks: every submission is plan then confirm', async () => {
  const client = await readFile(new URL('../src/services/harness-client.js', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  // The browser client must not expose a direct submit action (legacy
  // /v1/tasks); planning and confirming are the only submission paths.
  assert.doesNotMatch(client, /\bsubmit\s*\(/, 'harness-client exposes no legacy submit method');
  assert.doesNotMatch(page, /harnessClient\.submit|action:\s*'submit'|action:\s*"submit"/, 'the workspace never calls a direct submit action');
  assert.match(page, /harnessClient\.plan\(/);
  assert.match(page, /harnessClient\.confirm\(/);
  assert.match(page, /确认计划后才会执行/);
  // The exact requested comparison metric is surfaced on the authoritative plan.
  assert.match(page, /data-testid="harness-metric-slot"/);
  assert.match(page, /比较指标：\{compareMetricLabels\[authoritativePlan\.slots\.metric\]/);
  assert.match(page, /views: '展现量（views，涵盖浏览量\/播放量\/曝光量）'/);
  assert.match(page, /engagement: '互动（engagement）'/);
});

test('the metric compare preset maps to the exact views metric plan', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /分析下近期展现量最高的 X 帖子，比较后提炼可复用的内容规律/);
  const { createPlanner } = await import('../services/harness-gateway/planner.mjs');
  const planner = createPlanner();
  const verdict = await planner.plan({
    taskId: 'ht-11111111-1111-4111-8111-111111111111',
    request: {
      user_id: 'user-a',
      project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa',
      intent: '分析下近期展现量最高的 X 帖子，比较后提炼可复用的内容规律',
      request_fingerprint: 'a'.repeat(64),
    },
  });
  assert.equal(verdict.ok, true, verdict.code);
  assert.equal(verdict.value.workflow, 'compare_project');
  assert.equal(verdict.value.slots.metric, 'views');
  assert.equal(verdict.value.slots.persist, false);
  assert.equal(verdict.value.cost_indicators.paid_calls, 0);
  assert.equal(verdict.value.cost_indicators.online_writes, 0);
  assert.equal(verdict.value.approvals.online_writes, false);
});

test('every visible AI workspace preset is a valid authoritative plan request exactly as displayed', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  const match = /const suggestions = \[([\s\S]*?)\];/.exec(page);
  assert.ok(match, 'the suggestions array is present and readable');
  const presets = [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
  assert.ok(presets.length >= 3, `at least three visible presets exist (${presets.length})`);
  // Each preset must contain its own bounded keyword when it searches, and
  // must never rely on a hidden Evidence/Analysis identity.
  for (const preset of presets) {
    assert.doesNotMatch(preset, /\bev-[0-9a-f]{24}\b|\ban-[0-9a-f]{24}\b/, 'no preset may hide an exact identity inside its text');
  }
  // The real server planner must accept every visible preset verbatim: no
  // preset may fail only after submission with PLAN_SLOT_REQUIRED /
  // PLANNER_SLOT_REQUIRED.
  const { createPlanner } = await import('../services/harness-gateway/planner.mjs');
  const planner = createPlanner();
  const taskId = 'ht-11111111-1111-4111-8111-111111111111';
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  for (const preset of presets) {
    const verdict = await planner.plan({
      taskId,
      request: { user_id: 'user-a', project_id: projectId, intent: preset, request_fingerprint: 'a'.repeat(64) },
    });
    assert.equal(verdict.ok, true, `visible preset "${preset}" must create an authoritative plan (${verdict.code})`);
    assert.equal(verdict.value.user_id, 'user-a');
    assert.equal(verdict.value.project_id, projectId);
    assert.ok(verdict.value.steps.length > 0, `preset "${preset}" produces ordered steps`);
  }
});

test('planned tasks expose cancellation so unconfirmed plans can release capacity', async () => {
  const page = await readFile(new URL('../src/pages/AIWorkspacePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /\['planned', 'queued', 'running'\]\.includes\(activeTask\.state\)/);
  assert.match(page, />取消任务<\/button>/);
});
