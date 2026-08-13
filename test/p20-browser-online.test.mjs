/* global fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  EDGE, freePort, waitFor, waitForPageTarget, CdpClient, createPageTracker,
  navigateAndWait, reloadAndWait, waitForSelector, click, captureDiagnostics,
  makeTempProfile, removeTempProfile, shutdownEdge, killProcessTree,
} from './helpers/cdp-browser-harness.mjs';

const ROOT = join(import.meta.dirname, '..');

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

function makeProject(raw, id = 'prj-0123456789abcdef01234567') {
  const now = '2026-08-11T12:00:00.000Z';
  return {
    schema_version: 'p19_research_project_v1',
    id,
    version: 1,
    status: 'active',
    topic: raw.topic,
    objective: raw.objective,
    audience: raw.audience,
    channel: raw.channel,
    constraints: raw.constraints || [],
    execution_flags: {
      generation_executed: false,
      routing_executed: false,
      network_executed: false,
      publish_executed: false,
    },
    created_at: now,
    updated_at: now,
    evidence: [],
    analyses: [],
    knowledge_cards: [],
    brief: null,
    handoff: null,
    handoffs: [],
    lineage: null,
    fingerprint: 'a'.repeat(64),
  };
}

function createBoundary() {
  let project = null;
  let nextFailure = null;
  const requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'p20-browser@example.invalid',
        aud: 'authenticated',
        role: 'authenticated',
        user_metadata: { user_name: 'p20-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) {
      return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ authorization: request.headers.authorization || '', body });
      if (!/^Bearer\s+[^\s]+$/.test(request.headers.authorization || '')) {
        return json(response, 401, { ok: false, code: 'AUTH_REQUIRED', message: '登录已过期。' }, origin);
      }
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        return json(response, failure.status, { ok: false, code: failure.code, message: failure.message }, origin);
      }
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') {
        return json(response, 200, { ...envelope, read_only: true, data: { projects: project ? [{ id: project.id, topic: project.topic, status: project.status }] : [] } }, origin);
      }
      if (body.command === 'project.read') {
        if (!project || body.payload?.project_id !== project.id) {
          return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在。' }, origin);
        }
        return json(response, 200, { ...envelope, read_only: true, data: { project } }, origin);
      }
      if (body.command === 'project.create') {
        project = makeProject(body.payload.project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id: project.id } }, origin);
      }
      if (body.command === 'project.update') {
        project = { ...project, ...body.payload.patch, version: project.version + 1, updated_at: '2026-08-11T12:01:00.000Z' };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id: project.id } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_COMMAND', message: '测试边界拒绝未知命令。' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return {
    server,
    requests,
    failNext(code, message, status = 409) { nextFailure = { code, message, status }; },
  };
}

test('real production route persists online create across reload and surfaces a bounded conflict', { timeout: 75_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');
  const boundaryPort = await freePort();
  const vitePort = await freePort();
  const debugPort = await freePort();
  const boundary = createBoundary();
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));
  const profile = await makeTempProfile('ams-p20-browser-');

  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p20-public-browser-test-key',
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
    await navigateAndWait(cdp, tracker, baseUrl, { label: 'base page' });

    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p20`;
    const authResult = await cdp.evaluate(`(async () => {
      const { supabase } = await import('/ai-marketing-studio/src/services/supabase-client.js');
      const { data, error } = await supabase.auth.setSession({
        access_token: ${JSON.stringify(token)},
        refresh_token: 'p20-browser-refresh'
      });
      return { ok: !error && Boolean(data?.session?.user?.id), error: error?.message || null };
    })()`);
    assert.deepEqual(authResult, { ok: true, error: null });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    try {
      await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated online mode' });
    } catch (error) {
      const diagnostic = await cdp.evaluate(`({ body: document.body.innerText.slice(0, 1200), stored: Boolean(localStorage.getItem('ai-marketing-studio-auth-session')) })`);
      throw new Error(`${error.message}; browser=${JSON.stringify(diagnostic)}`);
    }

    await click(cdp, { text: '新建项目', label: 'new project button' });
    await waitForSelector(cdp, '.p19-create-panel form', { label: 'new project form' });
    const values = ['P20 跨浏览器研究', '验证在线保存与重新读取', '运营团队', 'GitHub Pages', '只读来源'];
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ${JSON.stringify(values)};
      fields.forEach((field, index) => {
        const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, values[index]);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()`);
    await waitForSelector(cdp, '.p19-create-panel button[type="submit"]', { enabled: true, label: 'valid project form' });
    await click(cdp, { selector: '.p19-create-panel button[type="submit"]', label: 'submit new project' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('项目已保存到在线工作区')`), { label: 'online save confirmation' });
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('P20 跨浏览器研究')`), true);

    await reloadAndWait(cdp, tracker, { label: 'hard refresh' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步') && document.body.innerText.includes('P20 跨浏览器研究')`), { label: 'server project after reload' });
    // P36 渐进式重设计：项目档案位于「更多」菜单的抽屉中，先打开抽屉。
    // 菜单按钮可见后才点击（details 打开即渲染为可见），无需固定 sleep。
    await click(cdp, { selector: '.p36-more summary', text: '更多', label: 'more menu' });
    await click(cdp, { selector: '.p36-more-menu button', text: '项目档案', label: 'project profile entry' });
    await waitForSelector(cdp, '.p36-settings-drawer .p19-form button[type="submit"]', { enabled: false, label: 'project profile form after reload' });

    // 未修改的档案是明确 no-op：按钮禁用并显示原因，不生成空 project.update，
    // 更不能落入 ONLINE_COMMAND_MISSING 的误报。
    const noChangeState = await cdp.evaluate(`(() => {
      const button = document.querySelector('.p36-settings-drawer .p19-form button[type="submit"]');
      return { disabled: button.disabled, text: button.textContent, title: button.title };
    })()`);
    assert.deepEqual(noChangeState, {
      disabled: true,
      text: '没有修改',
      title: '当前档案没有需要保存的修改',
    });
    assert.equal(boundary.requests.filter((item) => item.body.command === 'project.update').length, 0);

    // 真实字段修改必须映射到唯一 project.update，保存成功后以服务端权威修订重置表单。
    await cdp.evaluate(`(() => {
      const field = document.querySelector('.p36-settings-drawer .p19-form textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, '验证在线保存、刷新读取和无修改 no-op');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitForSelector(cdp, '.p36-settings-drawer .p19-form button[type="submit"]', { enabled: true, label: 'project profile dirty' });
    await click(cdp, { selector: '.p36-settings-drawer .p19-form button[type="submit"]', label: 'save project profile' });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('项目档案已保存')`), { label: 'project update saved' });
    assert.equal(boundary.requests.filter((item) => item.body.command === 'project.update').length, 1);
    assert.equal(await cdp.evaluate(`document.querySelector('.p36-settings-drawer .p19-form textarea').value`), '验证在线保存、刷新读取和无修改 no-op');
    assert.equal(await cdp.evaluate(`document.querySelector('.p36-settings-drawer .p19-form button[type="submit"]').disabled`), true);
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('无法将本次修改绑定到唯一在线命令')`), false);

    boundary.failNext('PROJECT_REVISION_STALE', '项目已被另一会话更新，请刷新后重试。');
    await cdp.evaluate(`(() => {
      const field = document.querySelector('.p36-settings-drawer .p19-form input[type="text"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '冲突更新');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.closest('form').querySelector('button[type="submit"]').click();
    })()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('项目已被另一会话更新')`), { label: 'bounded conflict UI' });

    assert.ok(boundary.requests.some((item) => item.body.command === 'project.create'));
    assert.ok(boundary.requests.filter((item) => item.body.command === 'project.read').length >= 2);
    for (const request of boundary.requests) {
      assert.match(request.authorization, /^Bearer\s+[^\s]+$/);
      assert.equal(Object.hasOwn(request.body, 'user_id'), false);
      assert.equal(Object.hasOwn(request.body, 'service_role'), false);
    }
  } catch (error) {
    if (cdp) {
      const extra = await captureDiagnostics(cdp, { tracker });
      if (!String(error.message).includes('诊断快照')) error.message += `\n${extra}`;
    }
    throw error;
  } finally {
    cdp?.close();
    await shutdownEdge(edge, profile);
    await killProcessTree(vite);
    await new Promise((resolve) => boundary.server.close(resolve));
    await removeTempProfile(profile);
  }
});
