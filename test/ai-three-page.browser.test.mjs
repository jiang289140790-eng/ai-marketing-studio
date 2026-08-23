/* global fetch */
// 任务信息架构与真实状态统一：真实浏览器验收（fake 本地 harness edge）。
//
// - vite dev 以 VITE_HARNESS_EDGE_BASE_URL 指向本地 fake 前缀启动；
// - 页面内注入 fetch 拦截：/harness-fake/functions/v1/harness-command →
//   内存 fake edge（镜像真实 harness-command 契约：plan → confirm → 状态
//   推进 → 结果/产物；plan/confirm 的授权边界与真实一致）；
// - 测试使用三个规范路由路径（/tasks/new、/tasks/<taskId>、
//   /tasks/<taskId>/results），验证应用内跳转与硬刷新保持同一 taskId、
//   新任务空状态、能力任务不自动成为当前任务、执行详情步骤/工具调用/
//   时间/错误的真实来源与明确空态、结果页五分类真实来源与逐类空态、
//   导航 DOM 唯一性契约；
// - 生成 1440px 截图（新任务、执行详情、结果页）到
//   acceptance-evidence/task-ia-real-state-2026-08-23/；
// - 全程零真实 provider/付费调用：fake edge 只在页面内存推进状态。
// - 契约测试声明：所有“成功”证据来自注入的 fake edge 契约模拟，
//   不构成线上真实服务端成功证据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  navigateAndWait, reloadAndWait, waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree, delay,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
// 本轮新验收证据目录（tracked）。默认回归只写临时目录，绝不触碰仓库；
// 仅显式 A3P_CAPTURE=1 的确定性捕获模式才重新生成仓库证据。
const EVIDENCE_DIR = join(ROOT, 'acceptance-evidence', 'task-ia-real-state-2026-08-23');
const CAPTURE = process.env.A3P_CAPTURE === '1';

// 页面内 fake edge：镜像真实 harness-command 契约（有界校验 + 幂等 + 状态
// 推进）。任务持久化在 localStorage，硬刷新后状态保持（与真实 staging 一致）。
// 状态机：confirm → queued；首次 read → running（st-1 完成、st-2 执行中）；
// 再次 read → 终态：含「失败测试」意图的任务 failed（带诊断），否则
// succeeded（带结果、产物身份、逐步工具调用与 result_data 分析）。
// 「能力：」意图的任务（read_capability 只读查询）无付费/写入授权。
// 零 provider/网络调用。
const FAKE_EDGE_SCRIPT = `
(() => {
  // 确定性固定时钟：页面渲染的时间文本与 fake edge 数据完全可复现。
  const FIXED_NOW_MS = Date.parse('2026-08-23T02:00:00.000Z');
  const RealDate = globalThis.Date;
  const FixedDate = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED_NOW_MS);
      else super(...args);
    }
    static now() { return FIXED_NOW_MS; }
  };
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;

  // 确定性任务编号：plan 依次得到 ht-…001（成功）、ht-…002（失败）、
  // ht-…002（能力查询）、ht-…003（失败）。
  const FIXED_TASK_IDS = [
    'ht-00000000-0000-4000-8000-000000000001',
    'ht-00000000-0000-4000-8000-000000000002',
    'ht-00000000-0000-4000-8000-000000000003',
  ];

  const EDGE_SCHEMA = 'ams_harness_edge_v1';
  const TASK_ID_RE = /^ht-[0-9a-f-]{36}$/;
  const readMap = (key) => {
    try { return new Map(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Map(); }
  };
  const writeMap = (key, map) => localStorage.setItem(key, JSON.stringify([...map.entries()]));
  const tasks = readMap('a3p_fake_tasks_v1');
  let planCount = Number(localStorage.getItem('a3p_fake_plans_v1') || 0);
  let confirmCount = Number(localStorage.getItem('a3p_fake_confirms_v1') || 0);
  const save = () => {
    writeMap('a3p_fake_tasks_v1', tasks);
    localStorage.setItem('a3p_fake_plans_v1', String(planCount));
    localStorage.setItem('a3p_fake_confirms_v1', String(confirmCount));
  };
  const ok = (payload, extra = {}) => ({ ok: true, schema_version: EDGE_SCHEMA, ...payload, ...extra });
  const fail = (code, message) => ({ ok: false, code, message });
  const nowIso = () => new Date().toISOString();
  const makePlan = (intent) => ({
    fingerprint: 'a'.repeat(64),
    workflow_title: '研究分析闭环',
    steps: [
      { step: 'st-1', label: '搜索并采集帖子', operation: 'search', depends_on: [], reuse: false, cost: true, write: false },
      { step: 'st-2', label: '保存证据与知识', operation: 'save_evidence', depends_on: ['st-1'], reuse: false, cost: false, write: true },
    ],
    approvals: String(intent || '').includes('能力：') ? {} : { paid_external_calls: true, online_writes: true },
    slots: { metric: 'views' },
  });
  // 镜像真实 gateway：plan/confirm/read 返回完整任务快照（含 plan.steps），
  // list 只返回摘要。
  const summarize = (task) => ({
    id: task.id,
    state: task.state,
    created_at: task.created_at,
    updated_at: task.updated_at,
    request: { request_id: task.request.request_id, intent: task.request.intent, project_id: task.request.project_id },
    plan: task.plan ? { workflow_title: task.plan.workflow_title, fingerprint: task.plan.fingerprint, approvals: task.plan.approvals } : null,
  });
  const fullTask = (task) => JSON.parse(JSON.stringify(task));
  const advanceRead = (task) => {
    task.reads = Number(task.reads || 0) + 1;
    if (task.state === 'queued') {
      task.state = 'running';
      task.step_states = {
        'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null, tool_calls: [{ tool: 'search', operation: 'web_search', status: 'succeeded', started_at: nowIso(), finished_at: nowIso(), error: null }] },
        'st-2': { state: 'running', failed_count: 0, started_at: nowIso(), finished_at: null, error: null },
      };
      task.updated_at = nowIso();
    } else if (task.state === 'running') {
      if (String(task.request.intent || '').includes('失败测试')) {
        task.state = 'failed';
        task.step_states = {
          'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null, tool_calls: [{ tool: 'search', operation: 'web_search', status: 'succeeded', started_at: nowIso(), finished_at: nowIso(), error: null }] },
          'st-2': { state: 'failed', failed_count: 1, started_at: nowIso(), finished_at: nowIso(), error: { code: 'TOOL_FAILED', message: '采集工具返回失败，已阻断后续步骤。', retry_unsafe: false } },
        };
        task.error = { code: 'HARNESS_FAILED', message: '任务执行失败：st-2 采集工具返回失败。', category: 'tool', stage: 'run', operation: 'save_evidence' };
        task.updated_at = nowIso();
      } else if (String(task.request.intent || '').includes('能力：')) {
        task.state = 'succeeded';
        task.step_states = {
          'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
          'st-2': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
        };
        task.result = {
          artifact_refs: [],
          final_response: '我可以完成研究、分析、知识沉淀、内容策划与生成；每次执行都会先经过你的确认。',
          result_data: { capabilities: ['research', 'analysis', 'knowledge', 'generation'] },
        };
        task.updated_at = nowIso();
      } else {
        task.state = 'succeeded';
        task.step_states = {
          'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null, tool_calls: [{ tool: 'search', operation: 'web_search', status: 'succeeded', started_at: nowIso(), finished_at: nowIso(), error: null }] },
          'st-2': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null, tool_calls: [{ tool: 'save', operation: 'save_evidence', status: 'succeeded', started_at: nowIso(), finished_at: nowIso(), error: null }] },
        };
        task.result = {
          artifact_refs: [
            'ev-000000000000000000000001',
            'an-000000000000000000000007',
            'kc-000000000000000000000002',
            'brf-000000000000000000000003',
            'g1x-000000000000000000000005',
          ],
          final_response: '已完成：保存 1 条证据并生成 1 张知识卡，建议进入 Brief 审核。',
          result_data: {
            saved_evidence: 1,
            saved_knowledge: 1,
            analyses: [{ id: 'an-000000000000000000000008', summary: '多模态分析' }],
            artifacts: [{ id: 'g1x-000000000000000000000005', name: '主视觉' }],
          },
        };
        task.updated_at = nowIso();
      }
    }
    return task;
  };
  globalThis.__a3pFakeState = {
    plans: () => planCount,
    confirms: () => confirmCount,
    tasks: () => [...tasks.values()].map((task) => task.id),
  };

  window.fetch = new Proxy(window.fetch, {
    apply(target, thisArg, args) {
      const url = String(args[0] || '');
      if (!url.includes('/harness-fake/functions/v1/harness-command')) {
        return Reflect.apply(target, thisArg, args);
      }
      return (async () => {
        const body = JSON.parse(String(args[1]?.body || '{}'));
        const send = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
        if (body.schema_version !== EDGE_SCHEMA) return send(fail('SCHEMA_VERSION_MISMATCH', 'schema 版本不匹配。'), 400);
        if (body.action === 'plan') {
          const intent = String(body.intent || '').trim();
          if (!intent) return send(fail('INTENT_INVALID', '任务目标不能为空。'), 400);
          planCount += 1;
          save();
          const now = nowIso();
          const task = {
            id: FIXED_TASK_IDS[planCount - 1] || 'ht-00000000-0000-4000-8000-000000000099',
            state: 'planned',
            created_at: now,
            updated_at: now,
            request: { user_id: 'demo-user', request_id: body.request_id, project_id: body.project_id || 'prj-000000000000000000000001', intent },
            request_fingerprint: 'b'.repeat(64),
            plan: makePlan(intent),
            plan_fingerprint: 'a'.repeat(64),
            confirmation: null,
            retry_target: null,
            step_states: {},
            result: null,
            error: null,
            reads: 0,
          };
          tasks.set(task.id, task);
          save();
          return send(ok({ action: 'plan', task: fullTask(task) }));
        }
        if (body.action === 'confirm') {
          const task = tasks.get(body.task_id);
          if (!task) return send(fail('TASK_NOT_FOUND', '任务不存在。'), 404);
          confirmCount += 1;
          task.confirmation = { approval: { paid_external_calls: body.approval?.paid_external_calls === true, online_writes: body.approval?.online_writes === true, handoff_creation: body.approval?.handoff_creation === true } };
          task.state = 'queued';
          task.updated_at = nowIso();
          save();
          return send(ok({ action: 'confirm', task: fullTask(task) }));
        }
        if (body.action === 'read') {
          const task = tasks.get(body.task_id);
          if (!task) return send(fail('TASK_NOT_FOUND', '任务不存在。'), 404);
          const advanced = advanceRead(task);
          save();
          return send(ok({ action: 'read', task: advanced }));
        }
        if (body.action === 'list') {
          const list = [...tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Number(body.limit) || 30).map((task) => summarize(task));
          return send(ok({ action: 'list', tasks: list }));
        }
        if (body.action === 'cancel') {
          const task = tasks.get(body.task_id);
          if (!task) return send(fail('TASK_NOT_FOUND', '任务不存在。'), 404);
          if (!['succeeded', 'partial', 'failed', 'cancelled'].includes(task.state)) {
            task.state = 'cancelled';
            task.updated_at = nowIso();
          }
          save();
          return send(ok({ action: 'cancel', task: fullTask(task) }));
        }
        if (body.action === 'retry_failed_step') {
          const task = tasks.get(body.task_id);
          if (!task) return send(fail('TASK_NOT_FOUND', '任务不存在。'), 404);
          task.state = 'running';
          task.step_states = {
            'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
            'st-2': { state: 'running', failed_count: 1, started_at: nowIso(), finished_at: null, error: null },
          };
          task.error = null;
          task.updated_at = nowIso();
          save();
          return send(ok({ action: 'retry_failed_step', task: fullTask(task) }));
        }
        return send(fail('ACTION_DENIED', '动作未实现。'), 400);
      })();
    },
  });
})();`;

const SEED_SCRIPT = `
(() => {
  localStorage.clear();
  localStorage.setItem('ams_harness_demo_user_v1', '11111111-1111-4111-8111-111111111111');
  return true;
})()`;

async function captureScreenshot(cdp, { width, height, label, dir }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  await delay(700);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = join(dir, `${label}-${width}.png`);
  writeFileSync(file, Uint8Array.from(globalThis.atob(shot.data), (character) => character.charCodeAt(0)));
  return file;
}

function setInput(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

function checkBox(cdp, selector) {
  return cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (input && !input.checked) input.click();
  })()`);
}

test('任务 IA real browser: 规范路由创建 → 执行 → 结果 → 刷新恢复 → 能力任务 → 失败态 → 截图', { timeout: 420_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  // 证据目录：默认回归输出到临时目录（绝不修改仓库 tracked 证据，`npm test`
  // 不会弄脏 worktree）；仅 A3P_CAPTURE=1 的确定性捕获才写仓库验收证据目录。
  const evidenceDir = CAPTURE
    ? EVIDENCE_DIR
    : await mkdtemp(join(tmpdir(), 'ams-a3p-evidence-'));
  rmSync(evidenceDir, { recursive: true, force: true });
  mkdirSync(evidenceDir, { recursive: true });

  const vitePort = await freePort();
  const debugPort = await freePort();
  const profile = await makeTempProfile('ams-a3p-browser-');
  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HARNESS_EDGE_BASE_URL: `http://127.0.0.1:${vitePort}/harness-fake`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_EDGE_SCRIPT });
    await navigateAndWait(cdp, tracker, baseUrl, { label: 'base page' });
    await cdp.evaluate(SEED_SCRIPT);

    // ---- 规范路由 1：#/tasks/new 新任务页（真实空状态 + 导航唯一性契约）----
    await reloadAndWait(cdp, tracker, { label: 'seed workspace reload' });
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/new')`), { label: '规范路径 /tasks/new' });
    await waitForSelector(cdp, '[data-testid="ai-task-flow"]', { label: '三页任务流程条', timeout: 30_000 });
    // 无 taskId：当前任务必须为 null，显示真实空状态。
    await waitForSelector(cdp, '[data-testid="ai-no-current-task"]', { label: '新任务真实空状态' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-flow-execution"]').disabled`), true, '无当前任务时执行详情必须禁用');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-flow-results"]').disabled`), true, '无当前任务时结果页必须禁用');
    // 导航 DOM 唯一性契约：同一可见菜单标签只出现一次，无重复注册。
    const navLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('.nav-item .nav-label'), (item) => item.textContent).filter(Boolean)`);
    assert.equal(new Set(navLabels).size, navLabels.length, `导航标签不得重复：${navLabels.join(',')}`);
    for (const label of ['账号矩阵', '角色库', '提示词库', '数据分析']) {
      assert.equal(navLabels.filter((entry) => entry === label).length, 1, `“${label}”只能出现一次`);
    }
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-plugin-rail').length`), 0, '页面内不得再有重复插件菜单');
    const flowLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="ai-task-flow"] button'), (item) => item.textContent)`);
    assert.match(flowLabels.join(''), /新任务/);
    assert.match(flowLabels.join(''), /执行详情/);
    assert.match(flowLabels.join(''), /结果与审核/);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="ai-task-flow"] button').length`), 3);
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'task-new', dir: evidenceDir });

    // ---- 创建成功任务（计划 → 人工确认，仅在工作台会话内）----
    await setInput(cdp, '[data-testid="harness-intent"]', '搜索 X 上本周热门 AI 营销话题并保存证据');
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: '生成计划' });
    await waitForSelector(cdp, '[data-testid="harness-authoritative-plan"]', { label: '权威计划', timeout: 15_000 });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled`), true, '未勾选批准时确认按钮必须禁用');
    const taskId = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')][0]?.dataset.testid.replace('ai-task-open-execution-', '') || ''`);
    assert.match(taskId, /^ht-[0-9a-f-]{36}$/, '必须拿到真实任务编号');
    await checkBox(cdp, '[data-testid="harness-paid-approval"]');
    await checkBox(cdp, '[data-testid="harness-write-approval"]');
    await click(cdp, { selector: '[data-testid="harness-confirm"]', label: '确认并开始执行' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="harness-active-task"]')?.innerText.includes('正在执行') || document.querySelector('[data-testid="harness-active-task"]')?.innerText.includes('已完成')`), { label: '活动任务推进', timeout: 20_000 });

    // ---- 规范路由 2：/tasks/<taskId> 执行详情（同一 taskId 应用内跳转）----
    await click(cdp, { selector: '[data-testid="ai-task-flow-execution"]', label: '流程条执行详情' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/${taskId}')`), { label: '规范路径 /tasks/<taskId>' });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '执行详情页' });
    await waitForSelector(cdp, '[data-testid="ai-task-plan"]', { label: '权威计划面板', timeout: 15_000 });
    const planText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-plan"]').innerText`);
    assert.match(planText, /研究分析闭环/, '执行详情必须展示权威计划标题');
    assert.match(planText, /搜索并采集帖子/, '执行详情必须展示计划步骤');
    assert.match(planText, /保存证据与知识/, '执行详情必须展示计划步骤');
    // 真实步骤状态与时间/错误全部来自 snapshot（轮询推进到终态）。
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '已完成'`), { label: '任务终态', timeout: 40_000 });
    // 工具调用：真实 snapshot 记录渲染为列表。
    await waitForSelector(cdp, '[data-testid="ai-task-tool-call-list"]', { label: '真实工具调用列表', timeout: 15_000 });
    const toolText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-tool-call-list"]').innerText`);
    assert.match(toolText, /search/, '工具调用必须展示真实 tool 名称');
    assert.match(toolText, /save/, '工具调用必须展示真实 save 调用');
    assert.match(toolText, /succeeded/, '工具调用必须展示真实状态');
    assert.match(toolText, /st-1|st-2/, '工具调用必须带步骤归属');
    // 技术详情默认折叠：task_id/project_id/指纹/审批字段不在普通视图。
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-technical-details"]').open`), false, '技术详情必须默认折叠');
    const heroText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"]').innerText`);
    assert.doesNotMatch(heroText, new RegExp(taskId), '普通视图不得直接展示内部 task_id');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('流程 研究分析闭环')`), true, '普通视图展示用户友好的流程名');
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'task-execution', dir: evidenceDir });

    // ---- 规范路由 3：/tasks/<taskId>/results 结果页（同一 taskId 再跳转）----
    await click(cdp, { selector: '[data-testid="ai-task-open-results"]', label: '结果与审核' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/${taskId}/results')`), { label: '规范路径 /tasks/<taskId>/results' });
    await waitForSelector(cdp, '[data-testid="ai-task-results"]', { label: '结果页' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"] h3')?.textContent.includes('1 条内容已保存为证据')`), { label: '结果标题', timeout: 20_000 });
    const reviewText = await cdp.evaluate(`document.querySelector('[data-testid="ai-review-details"]').innerText`);
    assert.match(reviewText, /已完成/, '审核状态必须显示真实任务状态');
    // 结果五分类：Evidence / Analysis / Knowledge / Brief / Artifact 全部来自真实 snapshot。
    for (const key of ['evidence', 'analysis', 'knowledge', 'brief', 'artifact']) {
      await waitForSelector(cdp, `[data-testid="ai-task-${key}-items"]`, { label: `${key} 分类真实数据`, timeout: 15_000 });
    }
    const evidenceText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-evidence-items"]').innerText`);
    assert.match(evidenceText, /ev-000000000000000000000001/, 'Evidence 必须来自 artifact_refs 分类');
    const analysisText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-analysis-items"]').innerText`);
    assert.match(analysisText, /an-000000000000000000000007/, 'Analysis 必须来自 an- 身份引用');
    assert.match(analysisText, /多模态分析/, 'Analysis 必须来自 result_data.analyses');
    const artifactText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-artifact-items"]').innerText`);
    assert.match(artifactText, /g1x-000000000000000000000005/, 'Artifact 必须来自 g1x- 身份引用');
    assert.match(artifactText, /主视觉/, 'Artifact 必须来自 result_data.artifacts');
    const chainText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-chain-list"]').innerText`);
    assert.match(chainText, /ev-000000000000000000000001/, '来源链必须展示证据身份');
    assert.match(chainText, /kc-000000000000000000000002/, '来源链必须展示知识卡身份');
    assert.match(chainText, /brf-000000000000000000000003/, '来源链必须展示 Brief 身份');
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'task-results', dir: evidenceDir });

    // ---- 硬刷新恢复：同一规范路径 + 同一 taskId，从服务端重新读取 ----
    await reloadAndWait(cdp, tracker, { label: '结果页硬刷新' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/${taskId}/results')`), { label: '刷新后规范路径保持' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"] h3')?.textContent.includes('1 条内容已保存为证据')`), { label: '刷新后结果恢复', timeout: 30_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/${taskId}` });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '直接打开执行详情' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/${taskId}')`), { label: '直接打开规范路径' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '已完成'`), { label: '直接打开恢复终态', timeout: 30_000 });

    // ---- 能力任务：/tasks/new 无 taskId 时当前任务为 null，能力任务不自动成为当前 ----
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitForSelector(cdp, '[data-testid="ai-no-current-task"]', { label: '空状态恢复' });
    await setInput(cdp, '[data-testid="harness-intent"]', '你能干什么');
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: '生成能力查询计划' });
    // 能力任务绝不设为当前任务：页面直接进入该任务的只读执行详情。
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/ht-00000000-0000-4000-8000-000000000002')`), { label: '能力任务执行详情路由', timeout: 20_000 });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '能力任务执行详情页' });
    // 无付费/写入授权 → 确认按钮直接可用，从执行页确认。
    await waitForSelector(cdp, '[data-testid="ai-task-confirm-zone"]', { label: '执行页确认区', timeout: 15_000 });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-confirm"]').disabled`), false, '能力任务无授权要求，确认可直接执行');
    await click(cdp, { selector: '[data-testid="ai-task-confirm"]', label: '确认能力任务' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '已完成'`), { label: '能力任务终态', timeout: 40_000 });
    // 回新任务页：能力任务仍只在历史列表，不自动成为当前任务。
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitForSelector(cdp, '[data-testid="ai-no-current-task"]', { label: '能力任务后空状态仍在' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-active-task"]') === null`), true, '能力任务不得成为当前任务');
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.ai-task-row strong')].some((item) => item.textContent.includes('能力：你能干什么'))`), { label: '能力任务在历史列表', timeout: 30_000 });
    // 点击历史中的能力任务 → 进入其执行详情页（只读），不激活为当前任务。
    await cdp.evaluate(`[...document.querySelectorAll('.ai-task-row-main')].find((item) => item.textContent.includes('能力：你能干什么')).click()`);
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/ht-00000000-0000-4000-8000-000000000002')`), { label: '历史能力任务进入执行详情', timeout: 20_000 });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '历史能力任务只读详情' });

    // ---- 失败状态：真实失败 + 工具调用明确空态（失败步骤无工具调用记录）----
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitForSelector(cdp, '[data-testid="ai-no-current-task"]', { label: '失败任务前空状态' });
    await setInput(cdp, '[data-testid="harness-intent"]', '失败测试：采集工具不可用');
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: '生成失败任务计划' });
    await waitForSelector(cdp, '[data-testid="harness-authoritative-plan"]', { label: '失败任务计划', timeout: 15_000 });
    await checkBox(cdp, '[data-testid="harness-paid-approval"]');
    await checkBox(cdp, '[data-testid="harness-write-approval"]');
    await click(cdp, { selector: '[data-testid="harness-confirm"]', label: '确认失败任务' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')].length >= 1`), { label: '失败任务入口', timeout: 15_000 });
    await click(cdp, { selector: '[data-testid="ai-task-flow-execution"]', label: '失败任务执行详情' });
    await waitFor(() => cdp.evaluate(`location.pathname.endsWith('/tasks/ht-00000000-0000-4000-8000-000000000003')`), { label: '失败任务规范路径' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '执行失败'`), { label: '失败任务终态', timeout: 40_000 });
    const failedText = await cdp.evaluate(`document.body.innerText`);
    assert.match(failedText, /TOOL_FAILED/, '失败任务必须展示有界错误代码');
    assert.match(failedText, /采集工具返回失败/, '失败任务必须展示错误消息');
    assert.match(failedText, /已尝试 2 次/, '失败步骤必须展示真实尝试次数（failed_count）');
    // 失败任务仍真实展示成功步骤留下的工具调用（st-1 真实调用记录）。
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-no-tool-calls"]') === null`), true, '有真实工具调用记录时不得显示空态');
    assert.match(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-tool-call-list"]')?.innerText || ''`), /search/, '失败任务必须展示 st-1 的真实工具调用');
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'task-execution-failed', dir: evidenceDir });

    // ---- 工具调用明确空态：能力任务没有任何工具调用记录（不得从计划步骤伪造）----
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/ht-00000000-0000-4000-8000-000000000002` });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '能力任务执行页（空工具调用）' });
    await waitForSelector(cdp, '[data-testid="ai-task-no-tool-calls"]', { label: '工具调用明确空态', timeout: 15_000 });
    assert.match(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-no-tool-calls"]').innerText`), /服务端没有该任务的工具调用记录/, '工具调用空态必须明确');

    // ---- 结果页逐类空态：能力任务（无产物身份）----
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/ht-00000000-0000-4000-8000-000000000002/results` });
    await waitForSelector(cdp, '[data-testid="ai-task-results"]', { label: '能力任务结果页' });
    for (const key of ['evidence', 'analysis', 'knowledge', 'brief', 'artifact']) {
      await waitForSelector(cdp, `[data-testid="ai-task-no-${key}"]`, { label: `${key} 逐类空态`, timeout: 20_000 });
    }

    // ---- 非法编号与读取失败：诚实错误态 ----
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/ht-not-a-valid-task` });
    await waitForSelector(cdp, '[data-testid="ai-task-invalid-id"]', { label: '非法编号错误态', timeout: 20_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/ht-11111111-1111-4111-8111-111111111111` });
    await waitForSelector(cdp, '[data-testid="ai-task-read-error"]', { label: '读取失败错误态', timeout: 20_000 });
    const readErrorText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-read-error"]').innerText`);
    assert.match(readErrorText, /TASK_NOT_FOUND|任务不存在/, '读取失败必须展示有界错误文本');

    // ---- 移动端无横向溢出 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `${baseUrl}tasks/new` });
    await waitForSelector(cdp, '[data-testid="ai-task-flow"]', { label: '移动端新任务页' });
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: '移动端布局稳定' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false, '390px 页面不得横向溢出');

    // ---- 零付费证明：fake edge 计数 ----
    const plans = await cdp.evaluate(`globalThis.__a3pFakeState?.plans?.() || 0`);
    const confirms = await cdp.evaluate(`globalThis.__a3pFakeState?.confirms?.() || 0`);
    assert.ok(plans >= 3, `必须经过三次真实 plan：${plans}`);
    assert.ok(confirms >= 3, `必须经过三次真实 confirm：${confirms}`);

    // 记录真实路由与数据来源（验收证据说明；契约测试，非线上成功证据）。
    const evidence = [
      '# 任务信息架构与真实状态统一验收证据（真实浏览器，契约测试）',
      '',
      `- 日期：2026-08-23；本地 dev server（vite）+ headless Edge（CDP）。`,
      `- 浏览器测试数据源/契约模拟（fake edge，非真实服务端）：`,
      `  1. 浏览器 → /tasks/new（新任务页，本地 vite dev server）：harnessClient.plan/confirm → fake edge（镜像 harness-command 契约，仅本测试进程注入）→ 任务创建与人工确认；`,
      `  2. /tasks/<taskId>（任务执行详情页）：harnessClient.read(<taskId>) → 任务/计划/step_states（进度、失败、attempts=failed_count、真实 tool_calls）；`,
      `  3. /tasks/<taskId>/results（任务结果与审核页）：harnessClient.read(<taskId>) → result.final_response / artifact_refs（五分类来源链）/ result_data.analyses+artifacts / confirmation（审核范围）。`,
      `- 证明范围：三个规范路由应用内跳转与硬刷新恢复（同一 taskId）、新任务真实空状态、`,
      `  能力任务不自动成为当前任务、执行详情步骤/工具调用/时间/错误的真实来源与明确空态、`,
      `  结果页五分类（Evidence/Analysis/Knowledge/Brief/Artifact）真实来源与逐类空态、`,
      `  导航 DOM 唯一性契约、非法/不存在编号错误态、390px 无横向溢出。`,
      `- 真实运行时数据来源：Supabase harness-command（生产 edge）；真实服务端/线上验收仍待部署后验证，`,
      `  本证据是注入 fake edge 的契约测试，不构成真实服务端成功证据。`,
      `- 演示任务编号：ht-00000000-0000-4000-8000-000000000001（成功）、ht-00000000-0000-4000-8000-000000000002（能力查询）、`,
      `  ht-00000000-0000-4000-8000-000000000003（失败）。`,
      `- 截图对应规范路由：task-new-1440 → /tasks/new；task-execution-1440 → /tasks/ht-…001；`,
      `  task-results-1440 → /tasks/ht-…001/results；task-execution-failed-1440 → /tasks/ht-…002。`,
      `- 零付费证明：fake edge 只做内存状态推进（plan×${plans} / confirm×${confirms}），全程零真实 Provider/付费调用、零 production 访问、零 Secret 输出。`,
      `- 无新增 mock 进入产品运行时：fake edge 仅在本浏览器测试进程注入，产品代码只走真实 harness-command 读取适配。`,
      '',
    ].join('\n');
    writeFileSync(join(evidenceDir, 'README.md'), evidence, 'utf8');
  } catch (error) {
    if (cdp) {
      const extra = await captureDiagnostics(cdp, { tracker });
      if (!String(error.message).includes('诊断快照')) error.message += `\n${extra}`;
    }
    throw error;
  } finally {
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await removeTempProfile(profile);
    // 非捕获模式：清理本次临时证据目录（只删除本测试 mkdtemp 创建的路径）。
    if (!CAPTURE) rmSync(evidenceDir, { recursive: true, force: true });
  }
});
