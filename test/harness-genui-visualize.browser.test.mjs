// Harness GenUI/visualize 真实浏览器验收：使用完整生产构建（vite build →
// dist/ → vite preview），通过 Edge CDP 打开 #/dashboard AI 工作台路由。
// 所有 Supabase/Harness 网络调用由本机 mock 边界返回确定性 fixture；生产
// 组件、路由、事件处理与持久化链路真实执行。
//
// 验证：图表/流程图/表格/可视化片段/降级块在任务结果中安全渲染；历史重开
// 与整页刷新后仍然恢复；恶意 payload（script/onerror/javascript: 链接/超界
// mermaid/未知块类型/非有限数值）全部降级且不执行；无 persisted
// presentation 的旧任务按结构化结果派生；移动端无横向溢出；页面全部网络
// 请求只到达本地 mock 边界（no-action/no-network 边界）。
/* global Buffer, fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  EDGE, delay, freePort, waitFor, CdpClient, waitForSelector, click,
  captureDiagnostics, makeTempProfile, removeTempProfile, shutdownEdge,
  killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const AUTH_STORAGE_KEY = 'ai-marketing-studio-auth-session';
const PRESENTATION_VERSION = 'ams_harness_presentation_v1';

function json(response, status, body, origin = '') {
  response.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': origin || 'http://127.0.0.1',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function summary(id, intent) {
  return {
    id, state: 'succeeded', created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:01:00.000Z',
    request: { request_id: `web-${id}`, intent, project_id: null },
    result: null, error: null,
  };
}

const GOOD_TASK = {
  id: 'ht-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'succeeded',
  created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-08-15T00:01:00.000Z',
  request: {
    schema_version: 'ams_harness_gateway_v1', request_id: 'web-good', user_id: '11111111-1111-4111-8111-111111111111',
    project_id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', intent: '分析本周数据并画出图表和流程',
    approval: { paid_external_calls: true, online_writes: true, handoff_creation: false },
  },
  result: {
    final_response: '分析完成。',
    artifact_refs: ['prj-aaaaaaaaaaaaaaaaaaaaaaaa/evidence/ev-1', 'prj-aaaaaaaaaaaaaaaaaaaaaaaa/analysis/an-1'],
    presentation: {
      schema_version: PRESENTATION_VERSION,
      blocks: [
        { kind: 'chart', title: '本周互动', chart: 'bars', data: [{ label: '周一', value: 12 }, { label: '周二', value: 7 }, { label: '周三', value: 19 }, { label: '周四', value: 4 }, { label: '周五', value: 15 }] },
        { kind: 'flow', title: '采集流程', mermaid: 'flowchart LR\nA[采集]-->B[分析]\nB-->C([简报])' },
        { kind: 'table', title: '平台分布', columns: ['平台', '数量'], rows: [['X', '3'], ['Reddit', '5']] },
        { kind: 'fragment', title: '互动率卡片', html: '<div style="font-family:system-ui"><strong>互动率</strong><span> +12.4%</span></div>' },
        { kind: 'fallback', title: '原始组件', text: '不支持的组件类型：scene3d' },
      ],
    },
  },
  error: null,
};

const LEGACY_TASK = {
  ...GOOD_TASK,
  id: 'ht-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  request: { ...GOOD_TASK.request, request_id: 'web-legacy', intent: '旧任务：没有持久化 presentation' },
  result: { final_response: '旧任务回复。', artifact_refs: ['prj-aaaaaaaaaaaaaaaaaaaaaaaa/evidence/ev-2'] },
};

const HOSTILE_TASK = {
  ...GOOD_TASK,
  id: 'ht-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  request: { ...GOOD_TASK.request, request_id: 'web-hostile', intent: '对抗性任务：全部内容必须降级' },
  result: {
    final_response: '对抗任务。',
    artifact_refs: [],
    presentation: {
      schema_version: PRESENTATION_VERSION,
      blocks: [
        { kind: 'fragment', html: '<script>window.__pwned=1</script><div>x</div>' },
        { kind: 'fragment', html: '<div onclick="window.__pwned=2">click</div>' },
        { kind: 'fragment', html: '<a href="javascript:window.__pwned=3">link</a>' },
        { kind: 'flow', mermaid: 'sequenceDiagram\nA->>B: hi' },
        { kind: 'flow', mermaid: 'graph LR\nA-->B\nclick A "https://evil.example"' },
        { kind: 'chart', chart: 'bars', data: [{ label: '坏', value: Infinity }, { label: '也坏', value: NaN }] },
        { kind: 'xss-block', title: '未知', text: 'unknown kind must never render' },
      ],
    },
  },
};

function boundary() {
  const tasks = new Map([
    [GOOD_TASK.id, GOOD_TASK],
    [LEGACY_TASK.id, LEGACY_TASK],
    [HOSTILE_TASK.id, HOSTILE_TASK],
  ]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    requests.push({ method: request.method, url: request.url, host: request.headers.host });
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'genui-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'genui-browser' },
      }, origin);
    }
    if (request.url === '/functions/v1/harness-command' && request.method === 'POST') {
      const body = await readJson(request);
      if (body.action === 'list') {
        return json(response, 200, { ok: true, tasks: [...tasks.values()].map((task) => summary(task.id, task.request.intent)) }, origin);
      }
      if (body.action === 'read') {
        const task = tasks.get(body.task_id);
        if (!task) return json(response, 404, { ok: false, code: 'TASK_NOT_FOUND' }, origin);
        return json(response, 200, { ok: true, task }, origin);
      }
      return json(response, 200, { ok: true }, origin);
    }
    return json(response, 404, { ok: false, code: 'NOT_FOUND' }, origin);
  });
  return { server, requests };
}

async function waitForUrl(url, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if ((await globalThis.fetch(url)).ok) return; } catch { /* retry */ }
    await delay(200);
  }
  throw new Error(`preview did not start: ${url}`);
}

test('Harness GenUI/visualize real browser: bounded charts, flows, tables, fragments, adversarial fallbacks, refresh recovery, and no-network boundary', { timeout: 300_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');

  // 1) mock 边界先启动（构建时内联其 URL）
  const boundaryPort = await freePort();
  const previewPort = await freePort();
  const debugPort = await freePort();
  const { server, requests } = boundary();
  await new Promise((resolve) => server.listen(boundaryPort, '127.0.0.1', resolve));

  // 2) 真实构建：清理 dist（避免 Windows rolldown 存量崩溃）→ vite build → preview
  await rm(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'genui-browser-test-key',
    },
    timeout: 240_000,
  });
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`);

  const profile = await makeTempProfile('ams-p30-harness-genui-browser-');
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  let offNetwork = () => {};
  try {
    const baseUrl = `http://127.0.0.1:${previewPort}/ai-marketing-studio/`;
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find((item) => item.type === 'page');
    }, { label: 'Edge DevTools target' });
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 页面级网络审计：收集 CDP 看到的每一次请求，供 no-network 边界断言。
    const networkRequests = [];
    offNetwork = cdp.onMessage((message) => {
      if (message.method === 'Network.requestWillBeSent') {
        networkRequests.push({ url: message.params.request.url, method: message.params.request.method });
      }
    });
    await cdp.send('Network.enable');

    // 3) 会话引导：应用脚本执行前注入 localStorage（仅 hash 导航不重载页面，
    //    因此注入后显式 reload 让 AuthProvider 启动时恢复会话）。
    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7200,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.genui-browser`;
    const session = {
      access_token: token, token_type: 'bearer', expires_in: 7200,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'genui-browser-refresh',
      user: { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'genui-browser@example.invalid', user_metadata: { user_name: 'genui-browser' } },
    };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem(${JSON.stringify(AUTH_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))});`,
    });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/dashboard` });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'workspace route loaded' });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForSelector(cdp, '[data-testid="harness-ai-workspace"]', { label: 'AI workspace' });
    await waitForSelector(cdp, '.ai-task-list button', { label: 'task history' });

    // 4) 三个任务出现在历史记录里。
    assert.equal(await cdp.evaluate(`document.querySelectorAll('.ai-task-list button').length`), 3);

    // 5) 好任务：图表/流程图/表格/片段/降级块全部渲染。
    await click(cdp, { selector: '.ai-task-list button', index: 0, label: 'good task history entry' });
    await waitForSelector(cdp, '[data-testid="harness-presentation"]', { label: 'presentation panel' });
    await waitForSelector(cdp, '[data-testid="presentation-block-chart"]', { label: 'chart block' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-chart"] rect').length >= 1`), true, 'bars render as SVG rects');
    await waitForSelector(cdp, '[data-testid="presentation-block-flow"]', { label: 'flow block' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-flow"] .harp-flow-node').length`), 3, 'flow renders three nodes');
    await waitForSelector(cdp, '[data-testid="presentation-block-table"]', { label: 'table block' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-table"] td').length`), 4, 'table renders four cells');
    await waitForSelector(cdp, '[data-testid="presentation-block-fragment"]', { label: 'fragment block' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="presentation-block-fragment"] iframe')?.hasAttribute('sandbox')`), true, 'fragment renders inside a sandboxed iframe');
    await waitForSelector(cdp, '[data-testid="presentation-block-fallback"]', { label: 'fallback block' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('不支持的组件类型：scene3d')`), true);
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-result-summary"]') !== null`), true, 'terminal result exposes a readable summary');
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="harness-result-summary"] .secondary-button') !== null`), true, 'full response is available behind a readable report action');

    // 6) 刷新恢复：整页 reload 后历史重开仍渲染同一 presentation。
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitForSelector(cdp, '.ai-task-list button', { label: 'task history after reload' });
    await click(cdp, { selector: '.ai-task-list button', index: 0, label: 'good task history entry after reload' });
    await waitForSelector(cdp, '[data-testid="presentation-block-chart"]', { label: 'chart block after refresh' });
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-flow"] .harp-flow-node').length`), 3, 'flow survives refresh recovery');

    // 7) 旧任务（无 persisted presentation）：结构化结果派生仍渲染。
    await click(cdp, { selector: '.ai-task-list button', index: 1, label: 'legacy task history entry' });
    await waitForSelector(cdp, '[data-testid="presentation-block-summary"]', { label: 'derived structured summary' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('任务概况')`), true);
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('旧任务：没有持久化 presentation')`), true);
    await waitForSelector(cdp, '[data-testid="presentation-block-table"]', { label: 'derived artifacts table' });

    // 8) 对抗任务：所有恶意块降级，无脚本执行，页面不崩溃。
    await click(cdp, { selector: '.ai-task-list button', index: 2, label: 'hostile task history entry' });
    await waitForSelector(cdp, '[data-testid="harness-presentation"]', { label: 'hostile presentation panel' });
    await delay(500);
    assert.equal(await cdp.evaluate('window.__pwned === undefined'), true, 'hostile script payloads never execute');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-fragment"]').length`), 0, 'hostile fragments never render');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-chart"]').length`), 0, 'non-finite charts never render');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-flow"]').length`), 0, 'hostile flows never render');
    assert.equal(await cdp.evaluate(`document.querySelectorAll('[data-testid="presentation-block-fallback"]').length >= 1`), true, 'hostile payloads degrade to fallbacks');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('安全校验')`), true, 'rejected payload surfaces a bounded safety notice');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('未知的内容块类型') || document.body.innerText.includes('渲染失败') || document.body.innerText.includes('降级')`), true);
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('任务与成果')`), true, 'page stays alive after adversarial payloads');

    // 9) 移动端无横向溢出。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await waitFor(() => cdp.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), { label: 'mobile layout settle' });
    assert.equal(await cdp.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`), false, 'no horizontal overflow on mobile');

    // 10) no-action/no-network 边界：页面发起的每一次请求只到达本地边界
    //     （preview 静态资源 + mock Supabase 边界），绝不外发。
    assert.ok(networkRequests.length >= 2, 'expected at least app asset + harness calls');
    for (const entry of networkRequests) {
      assert.ok(
        entry.url.startsWith(`http://127.0.0.1:${previewPort}/`) || entry.url.startsWith(`http://127.0.0.1:${boundaryPort}/`),
        `unexpected network destination: ${entry.method} ${entry.url}`,
      );
    }
    assert.equal(networkRequests.some((entry) => /supabase|deepseek|openai|apify|vercel|github/i.test(entry.url)), false, 'no external service requests');
    assert.equal(networkRequests.some((entry) => entry.method === 'DELETE'), false, 'no destructive requests');
    assert.equal(requests.some((entry) => !['GET', 'POST', 'OPTIONS'].includes(entry.method)), false, 'mock boundary only receives read-shaped calls');
  } catch (error) {
    if (cdp) error.message += `\n${await captureDiagnostics(cdp, { label: 'genui-browser' })}`;
    throw error;
  } finally {
    offNetwork();
    if (cdp) cdp.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(preview);
    await removeTempProfile(profile);
    server.close();
  }
});
