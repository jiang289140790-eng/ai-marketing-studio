/* global fetch */
// 三页任务架构：真实浏览器验收（fake 本地 harness edge）。
//
// - vite dev 以 VITE_HARNESS_EDGE_BASE_URL 指向本地 fake 前缀启动；
// - 页面内注入 fetch 拦截：/harness-fake/functions/v1/harness-command →
//   内存 fake edge（镜像真实 harness-command 契约：plan → confirm → 状态
//   推进 → 结果/产物；plan/confirm 的授权边界与真实一致）；
// - 真实点击创建任务 → 确认 → 跳转执行详情 → 跳转结果与审核 → 硬刷新恢复
//   → 失败状态 → 非法编号错误态 → 390px 响应式；
// - 生成 1440/1366/1024/768/390 px 截图到 acceptance-evidence/
//   ai-three-page-architecture-2026-08-23/ 并记录实际路由与数据来源；
// - 全程零真实 provider/付费调用：fake edge 只在页面内存推进状态。

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
// 仓库验收证据目录（tracked）。默认回归只写临时目录，绝不触碰仓库；
// 仅显式 A3P_CAPTURE=1 的确定性捕获模式才重新生成仓库证据。
const EVIDENCE_DIR = join(ROOT, 'acceptance-evidence', 'ai-three-page-architecture-2026-08-23');
const CAPTURE = process.env.A3P_CAPTURE === '1';

// 页面内 fake edge：镜像真实 harness-command 契约（有界校验 + 幂等 + 状态
// 推进）。任务持久化在 localStorage，硬刷新后状态保持（与真实 staging 一致）。
// 状态机：confirm → queued；首次 read → running（st-1 完成、st-2 执行中）；
// 再次 read → 终态：含「失败测试」意图的任务 failed（带诊断），否则
// succeeded（带结果与产物身份）。零 provider/网络调用。
const FAKE_EDGE_SCRIPT = `
(() => {
  // 确定性固定时钟：页面渲染的时间文本与 fake edge 数据完全可复现，
  // 连续两次运行产出逐字节一致（截图/README 不随运行时刻漂移）。
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

  // 确定性任务编号：第 1 次 plan 固定得到 ht-…001（成功任务），
  // 第 2 次 plan 固定得到 ht-…002（失败任务）。
  const FIXED_TASK_IDS = [
    'ht-00000000-0000-4000-8000-000000000001',
    'ht-00000000-0000-4000-8000-000000000002',
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
    approvals: { paid_external_calls: true, online_writes: true },
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
        'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
        'st-2': { state: 'running', failed_count: 0, started_at: nowIso(), finished_at: null, error: null },
      };
      task.updated_at = nowIso();
    } else if (task.state === 'running') {
      if (String(task.request.intent || '').includes('失败测试')) {
        task.state = 'failed';
        task.step_states = {
          'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
          'st-2': { state: 'failed', failed_count: 1, started_at: nowIso(), finished_at: nowIso(), error: { code: 'TOOL_FAILED', message: '采集工具返回失败，已阻断后续步骤。', retry_unsafe: false } },
        };
        task.error = { code: 'HARNESS_FAILED', message: '任务执行失败：st-2 采集工具返回失败。', category: 'tool', stage: 'run', operation: 'save_evidence' };
        task.updated_at = nowIso();
      } else {
        task.state = 'succeeded';
        task.step_states = {
          'st-1': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
          'st-2': { state: 'succeeded', failed_count: 0, started_at: nowIso(), finished_at: nowIso(), error: null },
        };
        task.result = {
          artifact_refs: [
            'ev-000000000000000000000001',
            'kc-000000000000000000000002',
            'brf-000000000000000000000003',
          ],
          final_response: '已完成：保存 1 条证据并生成 1 张知识卡，建议进入 Brief 审核。',
          result_data: { saved_evidence: 1, saved_knowledge: 1 },
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

test('三页任务架构 real browser: 创建 → 执行详情 → 结果与审核 → 刷新恢复 → 失败状态 → 响应式 + 五尺寸截图', { timeout: 360_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  // 证据目录：默认回归输出到临时目录（绝不修改仓库 tracked 证据，`npm test`
  // 不会弄脏 worktree）；仅 A3P_CAPTURE=1 的确定性捕获才写仓库验收证据目录
  // （精确路径，绝不触碰其他证据）。
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
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: '三页 Vite route' });
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

    // ---- 新任务首页：#/ai 创建任务（计划 → 人工确认）----
    await reloadAndWait(cdp, tracker, { label: 'seed workspace reload' });
    await cdp.evaluate(`location.href = ${JSON.stringify(`${baseUrl}#/ai`)}`);
    await waitForSelector(cdp, '[data-testid="ai-task-flow"]', { label: '三页任务流程条', timeout: 30_000 });
    const flowLabels = await cdp.evaluate(`Array.from(document.querySelectorAll('[data-testid="ai-task-flow"] button'), (item) => item.textContent)`);
    assert.match(flowLabels.join(''), /新任务/, '流程条必须包含新任务');
    assert.match(flowLabels.join(''), /执行详情/, '流程条必须包含执行详情');
    assert.match(flowLabels.join(''), /结果与审核/, '流程条必须包含结果与审核');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="ai-task-flow"] button').length`), 3);

    await setInput(cdp, '[data-testid="harness-intent"]', '搜索 X 上本周热门 AI 营销话题并保存证据');
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: '生成计划' });
    await waitForSelector(cdp, '[data-testid="harness-authoritative-plan"]', { label: '权威计划', timeout: 15_000 });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('此步骤只生成计划，不调用付费工具')`), true, '创建页必须保持 plan 不触发付费的边界');
    // 授权边界：付费/写入批准必须由人工勾选。
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-confirm"]').disabled`), true, '未勾选批准时确认按钮必须禁用');
    const taskId = await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')][0]?.dataset.testid.replace('ai-task-open-execution-', '') || ''`);
    assert.match(taskId, /^ht-[0-9a-f-]{36}$/, '必须拿到真实任务编号');

    // ---- 未确认任务的诚实空态：直接打开结果页，任务还在等待确认 ----
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-results/${taskId}` });
    await waitFor(() => cdp.evaluate(`location.hash === '#/ai-results/${taskId}'`), { label: '结果页直接打开路由' });
    await waitForSelector(cdp, '[data-testid="ai-task-results"]', { label: '结果页（未确认）' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-no-result"]') !== null`), { label: '未产生结果的诚实空态', timeout: 20_000 });
    const pendingResultText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-no-result"]').innerText`);
    assert.match(pendingResultText, /等待确认/, '未确认任务必须诚实显示尚未产生最终结果');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="ai-task-no-chain"]') !== null`), true, '无产物时必须显示诚实来源链空态');

    // ---- 回到首页：从历史记录恢复任务并确认（刷新恢复 + 人工授权）----
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai` });
    await waitForSelector(cdp, '[data-testid="ai-task-flow"]', { label: '首页恢复' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.ai-task-row-main strong')].some((item) => item.textContent.includes('搜索 X 上本周热门'))`), { label: '历史任务记录', timeout: 30_000 });
    await cdp.evaluate(`[...document.querySelectorAll('.ai-task-row-main')].find((item) => item.textContent.includes('搜索 X 上本周热门')).click()`);
    await waitForSelector(cdp, '[data-testid="harness-confirm"]', { label: '恢复后的确认面板', timeout: 15_000, enabled: false });
    await checkBox(cdp, '[data-testid="harness-paid-approval"]');
    await checkBox(cdp, '[data-testid="harness-write-approval"]');
    await click(cdp, { selector: '[data-testid="harness-confirm"]', label: '确认并开始执行' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')].length >= 1`), { label: '活动任务入口', timeout: 15_000 });

    // ---- 任务执行详情页：#/ai-execution/<taskId>（同一 taskId 跳转）----
    await cdp.evaluate(`document.querySelector('[data-testid^="ai-task-open-execution-"]').click()`);
    await waitFor(() => cdp.evaluate(`location.hash === '#/ai-execution/${taskId}'`), { label: '执行详情精确路由' });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '执行详情页' });
    await waitForSelector(cdp, '[data-testid="ai-task-plan"]', { label: '权威计划面板', timeout: 15_000 });
    const planText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-plan"]').innerText`);
    assert.match(planText, /研究分析闭环/, '执行详情必须展示权威计划标题');
    assert.match(planText, /搜索并采集帖子/, '执行详情必须展示计划步骤');
    assert.match(planText, /保存证据与知识/, '执行详情必须展示计划步骤');
    assert.match(planText, /需要授权：付费采集或模型分析/, '执行详情必须展示授权范围');
    assert.match(planText, /需要授权：保存产物到 staging/, '执行详情必须展示授权范围');
    // 轮询推进：任务最终到达终态（真实服务端状态推进，非静态）。
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '已完成'`), { label: '任务终态', timeout: 40_000 });
    const heroText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"]').innerText`);
    assert.match(heroText, new RegExp(taskId), '执行详情必须显示任务编号');
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'execution-detail', dir: evidenceDir });

    // ---- 任务结果与审核页：#/ai-results/<taskId>（同一 taskId 再跳转）----
    await cdp.evaluate(`document.querySelector('[data-testid="ai-task-open-results"]').click()`);
    await waitFor(() => cdp.evaluate(`location.hash === '#/ai-results/${taskId}'`), { label: '结果与审核精确路由' });
    await waitForSelector(cdp, '[data-testid="ai-task-results"]', { label: '结果与审核页' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"] h3')?.textContent.includes('1 条内容已保存为证据')`), { label: '结果标题', timeout: 20_000 });
    const reviewText = await cdp.evaluate(`document.querySelector('[data-testid="ai-review-details"]').innerText`);
    assert.match(reviewText, /已完成/, '审核状态必须显示真实任务状态');
    assert.match(reviewText, /付费采集或模型分析/, '审核状态必须显示已批准的人工范围');
    const resultText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"]').innerText`);
    assert.match(resultText, /已完成：保存 1 条证据并生成 1 张知识卡/, '结果页必须展示服务端 final_response');
    const chainText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-chain-list"]').innerText`);
    assert.match(chainText, /ev-000000000000000000000001/, '来源链必须展示证据身份');
    assert.match(chainText, /kc-000000000000000000000002/, '来源链必须展示知识卡身份');
    assert.match(chainText, /brf-000000000000000000000003/, '来源链必须展示 Brief 身份');
    assert.match(chainText, /证据/, '来源链必须分类标注');

    // ---- 直接打开 + 硬刷新恢复：同一 hash 恢复同一任务 ----
    await reloadAndWait(cdp, tracker, { label: '结果页硬刷新' });
    await waitFor(() => cdp.evaluate(`location.hash === '#/ai-results/${taskId}'`), { label: '刷新后路由保持' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"] h3')?.textContent.includes('1 条内容已保存为证据')`), { label: '刷新后结果恢复', timeout: 30_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-execution/${taskId}` });
    await waitForSelector(cdp, '[data-testid="ai-task-execution"]', { label: '直接打开执行详情' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '已完成'`), { label: '直接打开恢复终态', timeout: 30_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-results/${taskId}` });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-result"] h3')?.textContent.includes('1 条内容已保存为证据')`), { label: '结果页二次恢复', timeout: 30_000 });

    // ---- 五尺寸截图（结果页，最完整页面）----
    for (const width of [1440, 1366, 1024, 768, 390]) {
      const file = await captureScreenshot(cdp, { width, height: 1000, label: 'results', dir: evidenceDir });
      assert.equal(existsSync(file), true, `截图必须生成：${file}`);
    }
    // 390px 无横向溢出。
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: '移动端布局稳定' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false, '390px 页面不得横向溢出');
    // 首页截图需要回到 #/ai（结果页恢复后）。
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai` });
    await waitForSelector(cdp, '[data-testid="ai-task-flow"]', { label: '首页恢复' });
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'home', dir: evidenceDir });

    // ---- 失败状态：含「失败测试」的任务在执行详情展示真实失败 ----
    await cdp.evaluate(`document.querySelector('.ai-new-session')?.click()`);
    await setInput(cdp, '[data-testid="harness-intent"]', '失败测试：采集工具不可用');
    await click(cdp, { selector: '[data-testid="harness-submit"]', label: '生成失败任务计划' });
    await waitForSelector(cdp, '[data-testid="harness-confirm"]', { label: '失败任务确认面板', timeout: 15_000, enabled: false });
    await checkBox(cdp, '[data-testid="harness-paid-approval"]');
    await checkBox(cdp, '[data-testid="harness-write-approval"]');
    await click(cdp, { selector: '[data-testid="harness-confirm"]', label: '确认失败任务' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid^="ai-task-open-execution-"]') !== null`), { label: '失败任务活动入口', timeout: 15_000 });
    // 活动任务区先于历史渲染：第一个匹配即当前失败任务（意图含「失败测试」）。
    const failedTaskId = await cdp.evaluate(`(() => {
      const link = [...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')].find((item) => {
        const row = item.closest('.ai-active-task') || item.closest('[data-testid="harness-active-task"]');
        return row ? row.innerText.includes('失败测试') : false;
      }) || document.querySelector('[data-testid^="ai-task-open-execution-"]');
      return link?.dataset.testid.replace('ai-task-open-execution-', '') || '';
    })()`);
    assert.match(failedTaskId, /^ht-[0-9a-f-]{36}$/, '必须拿到失败任务编号');
    await cdp.evaluate(`[...document.querySelectorAll('[data-testid^="ai-task-open-execution-"]')].find((item) => item.dataset.testid === 'ai-task-open-execution-${failedTaskId}').click()`);
    await waitFor(() => cdp.evaluate(`location.hash === '#/ai-execution/${failedTaskId}'`), { label: '失败任务执行详情路由' });
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-testid="ai-task-hero"] .status-badge')?.textContent === '执行失败'`), { label: '失败任务终态', timeout: 40_000 });
    const failedText = await cdp.evaluate(`document.body.innerText`);
    assert.match(failedText, /TOOL_FAILED/, '失败任务必须展示有界错误代码');
    assert.match(failedText, /采集工具返回失败/, '失败任务必须展示错误消息');
    assert.match(failedText, /已尝试 2 次/, '失败步骤必须展示真实尝试次数（failed_count）');
    const failedErrorText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-error"]')?.innerText || ''`);
    assert.match(failedErrorText, /save_evidence|HARNESS_FAILED/, '任务级错误诊断必须展示');
    await captureScreenshot(cdp, { width: 1440, height: 1000, label: 'execution-failed', dir: evidenceDir });

    // ---- 非法任务编号：诚实错误态（不猜测、不伪造）----
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-execution/ht-not-a-valid-task` });
    await waitForSelector(cdp, '[data-testid="ai-task-invalid-id"]', { label: '非法编号错误态', timeout: 20_000 });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-results/ht-not-a-valid-task` });
    await waitForSelector(cdp, '[data-testid="ai-task-invalid-id"]', { label: '结果页非法编号错误态', timeout: 20_000 });

    // ---- 读取失败状态：合法格式但服务端不存在的任务 → 诚实读取错误 ----
    await cdp.send('Page.navigate', { url: `${baseUrl}#/ai-execution/ht-11111111-1111-4111-8111-111111111111` });
    await waitForSelector(cdp, '[data-testid="ai-task-read-error"]', { label: '读取失败错误态', timeout: 20_000 });
    const readErrorText = await cdp.evaluate(`document.querySelector('[data-testid="ai-task-read-error"]').innerText`);
    assert.match(readErrorText, /TASK_NOT_FOUND|任务不存在/, '读取失败必须展示有界错误文本');

    // ---- 零付费证明：fake edge 计数 + 无真实网络调用 ----
    const plans = await cdp.evaluate(`globalThis.__a3pFakeState?.plans?.() || 0`);
    const confirms = await cdp.evaluate(`globalThis.__a3pFakeState?.confirms?.() || 0`);
    assert.ok(plans >= 2, `必须经过两次真实 plan：${plans}`);
    assert.ok(confirms >= 2, `必须经过两次真实 confirm：${confirms}`);
    assert.equal(await cdp.evaluate(`globalThis.__a3pFakeState?.tasks?.().length`), 2, 'fake edge 只保留两条任务');

    // 记录真实路由与数据来源（验收证据说明）。
    const evidence = [
      '# 三页任务架构验收证据（真实浏览器）',
      '',
      `- 日期：2026-08-23；本地 dev server（vite）+ headless Edge（CDP）。`,
      `- 浏览器测试数据源/契约模拟（fake edge，非真实服务端）：`,
      `  1. 浏览器 → #/ai（新任务首页，本地 vite dev server）：harnessClient.plan/confirm → fake edge（镜像 harness-command 契约，仅本测试进程注入）→ 任务创建与人工确认；`,
      `  2. #/ai-execution/<taskId>（任务执行详情页）：harnessClient.read(<taskId>) → 任务/计划/step_states（进度、失败、attempts=failed_count）；`,
      `  3. #/ai-results/<taskId>（任务结果与审核页）：harnessClient.read(<taskId>) → result.final_response / artifact_refs（来源链）/ confirmation（审核范围）。`,
      `- 证明范围：UI、精确 taskId 路由、硬刷新恢复、失败态、非法/不存在编号错误态与响应式（390px 无横向溢出）。`,
      `- 真实运行时数据来源：Supabase harness-command（生产 edge）；真实服务端/线上验收仍待部署后验证，本证据不构成真实服务端成功证据。`,
      `- 演示任务编号：${taskId}（成功）、${failedTaskId}（失败）。`,
      `- 截图对应路由：execution-detail-1440 → #/ai-execution/${taskId}；results-* → #/ai-results/${taskId}；`,
      `  execution-failed-1440 → #/ai-execution/${failedTaskId}；home-1440 → #/ai。`,
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
