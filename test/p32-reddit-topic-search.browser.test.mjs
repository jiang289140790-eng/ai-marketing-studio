/* global WebSocket, fetch */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const AUTH_STORAGE_KEY = 'ai-marketing-studio-auth-session';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const delay = (ms) => sleep(ms);

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, { timeout = 30_000, interval = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

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

function projectFixture(id, topic) {
  return {
    schema_version: 'p19_research_project_v1', id, version: 1, status: 'active',
    topic, objective: '验证 Reddit 主题搜索与同项目证据导入', audience: '研究团队', channel: 'Reddit', constraints: [],
    execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
    created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    evidence: [], analyses: [], knowledge_cards: [], brief: null, handoff: null, handoffs: [], lineage: null,
    fingerprint: 'a'.repeat(64),
  };
}

const REDDIT_ROWS = [
  { id: 't3_alpha', title: 'Reddit 高分案例', body: '一个具有明确来源和高分互动的公开讨论。', author: 'alpha_author', subreddit: 'marketing', score: 980, comments: 42, created: '2026-08-13T03:00:00.000Z' },
  { id: 't3_beta', title: 'Reddit 高评论案例', body: '评论很多、适合研究受众争议点的公开讨论。', author: 'beta_author', subreddit: 'marketing', score: 210, comments: 388, created: '2026-08-13T02:00:00.000Z' },
  { id: 't3_gamma', title: 'Reddit 指标缺失案例', body: '缺失快照指标时必须显示不可用而不是伪造零。', author: 'gamma_author', subreddit: 'marketing', score: null, comments: null, created: '2026-08-13T01:00:00.000Z' },
];

function redditItem(row, runId = 'reddit-run-browser-p32d') {
  const contentText = `${row.title}\n\n${row.body}`;
  const digest = sha256(contentText);
  return {
    id: `p22-${digest.slice(0, 24)}`,
    source_url: `https://www.reddit.com/r/${row.subreddit}/comments/${row.id.slice(3)}/topic/`,
    label: row.title,
    platform: 'reddit',
    content_text: contentText,
    external_id: row.id,
    content_sha256: digest,
    source_metadata: {
      author: { name: row.author, handle: row.author, user_id: null },
      community: row.subreddit,
      published_at: row.created,
      engagement: { reddit_score: row.score, reddit_comments: row.comments, reddit_upvote_ratio: null },
    },
    media_assets: [],
    provenance: {
      schema_version: 'p22_collected_source_v1', provider: 'apify:endspec/reddit-instant-search-scraper',
      run_id: runId, collected_at: '2026-08-13T04:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: '44444444-aaaa-4bbb-8ccc-444444444444',
    },
    collection_proof: `1999999999.${'b'.repeat(64)}`,
  };
}

function redditBatchId({ keyword, subreddit, count, sort, timeFilter, runId, collectedAt, items }) {
  const identities = items.map((item) => `${item.source_url}|${item.external_id}|${item.content_sha256}`).join(';');
  const value = `p32-reddit-search-batch\0${keyword}\0${subreddit}\0${count}\0${sort}\0${timeFilter}\0${runId}\0${collectedAt}\0${identities}`;
  return `p32-reddit-search-${sha256(value).slice(0, 24)}`;
}

function createBoundary() {
  const projectA = projectFixture(`prj-${sha256('p32d-a').slice(0, 24)}`, 'P32-D Reddit 项目 A');
  const projectB = projectFixture(`prj-${sha256('p32d-b').slice(0, 24)}`, 'P32-D Reddit 项目 B');
  const projects = new Map([[projectA.id, projectA], [projectB.id, projectB]]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, { id: USER_ID, email: 'p32d-browser@example.invalid', aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p32d-browser' } }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) return json(response, 200, [], origin);
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'p22', body });
      const flags = { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false };
      if (body.action === 'status') {
        return json(response, 200, { ok: true, schema_version: 'p22_research_assist_v1', role: 'operator', capabilities: { apify_configured: true, qwen_configured: true }, cost_tracking: { daily_cap_enabled: false, apify: { recorded_cny: 0 }, qwen: { recorded_cny: 0 } }, execution_flags: flags }, origin);
      }
      if (body.action === 'search_reddit') {
        if (body.keyword === '触发失败') {
          return json(response, 422, { ok: false, code: 'REDDIT_NO_RESULTS', message: '没有返回可验证的 Reddit 公开帖子。', execution_flags: flags }, origin);
        }
        const items = REDDIT_ROWS.slice(0, body.count).map((row) => redditItem(row));
        const collectedAt = '2026-08-13T04:00:00.000Z';
        return json(response, 200, {
          ok: true, schema_version: 'p22_research_assist_v1', role: 'operator', action: 'search_reddit', platform: 'reddit',
          keyword: body.keyword, subreddit: body.subreddit, count: body.count, sort_intent: body.sort, time_filter: body.time_filter,
          collected_at: collectedAt, items,
          search_batch_id: redditBatchId({ keyword: body.keyword, subreddit: body.subreddit, count: body.count, sort: body.sort, timeFilter: body.time_filter, runId: 'reddit-run-browser-p32d', collectedAt, items }),
          cost: { recorded_cny: 1, actual_cny: 0.02 }, execution_flags: flags,
        }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNEXPECTED_ACTION', message: 'Unexpected action' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'command', body });
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1' };
      if (body.command === 'project.list') return json(response, 200, { ...envelope, data: { projects: [...projects.values()] } }, origin);
      if (body.command === 'project.read') return json(response, 200, { ...envelope, data: { project: projects.get(body.payload.project_id) } }, origin);
      if (body.command === 'evidence.create') {
        const project = projects.get(body.payload.project_id);
        project.evidence = [...project.evidence.filter((item) => item.id !== body.payload.evidence.id), body.payload.evidence];
        project.version += 1;
        projects.set(project.id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'evidence', id: body.payload.evidence.id } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNEXPECTED_COMMAND', message: 'Unexpected command' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return { server, projects, requests, projectA, projectB };
}

class CdpClient {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Browser evaluation failed');
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => killer.once('close', resolve));
  await delay(150);
}

async function waitForUrl(url) {
  await waitFor(async () => {
    try { return (await fetch(url)).ok; } catch { return false; }
  }, { label: `preview ${url}` });
}

test('P32-D real browser: Reddit search, real metrics, deterministic sorting, same-project import and project isolation', { timeout: 240_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required');
  const boundaryPort = await freePort();
  const previewPort = await freePort();
  const debugPort = await freePort();
  const boundary = createBoundary();
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));

  await rm(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT, stdio: 'ignore', timeout: 180_000,
    env: { ...process.env, VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`, VITE_SUPABASE_ANON_KEY: 'p32d-public-browser-key' },
  });
  const preview = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`);
  const profile = await mkdtemp(join(tmpdir(), 'ams-p32d-browser-'));
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find((item) => item.type === 'page');
    }, { label: 'Edge CDP target' });
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const payload = Buffer.from(JSON.stringify({ sub: USER_ID, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7200 })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p32d-browser`;
    const session = { access_token: token, token_type: 'bearer', expires_in: 7200, expires_at: Math.floor(Date.now() / 1000) + 7200, refresh_token: 'p32d-refresh', user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'p32d-browser@example.invalid', user_metadata: { user_name: 'p32d-browser' } } };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem(${JSON.stringify(AUTH_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))});` });
    const baseUrl = `http://127.0.0.1:${previewPort}/ai-marketing-studio/`;
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'research route' });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P32-D Reddit 项目 A')`), { label: 'online project A' });

    // P36 渐进式重设计：热门主题搜索是「采集」目的地的次级工具，先展开 details。
    await cdp.evaluate(`[...document.querySelectorAll('.p36-advanced summary')].find((s) => s.textContent.includes('更多采集方式')).click()`);
    await delay(200);

    await cdp.evaluate(`(() => { const select = document.querySelector('select[aria-label="搜索平台"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'reddit'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('input[aria-label="限定 subreddit"]'))`), { label: 'Reddit controls' });
    await cdp.evaluate(`(() => {
      const set = (selector, value) => { const node = document.querySelector(selector); const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
      set('input[aria-label="热门主题搜索关键词"]', 'AI 营销');
      set('input[aria-label="限定 subreddit"]', 'marketing');
      set('select[aria-label="搜索结果条数"]', '5');
      set('select[aria-label="Reddit 平台排序"]', 'top');
      set('select[aria-label="Reddit 时间范围"]', 'week');
    })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 3`), { label: 'Reddit results' });

    const request = boundary.requests.find((entry) => entry.fn === 'p22' && entry.body.action === 'search_reddit')?.body;
    assert.deepEqual(request, { action: 'search_reddit', keyword: 'AI 营销', count: 5, sort: 'top', subreddit: 'marketing', time_filter: 'week' });
    const rendered = await cdp.evaluate(`(() => ({
      batch: document.querySelector('.p32-search-batch-line').innerText,
      cards: [...document.querySelectorAll('.p32-search-card')].map((card) => ({ text: card.innerText, href: card.querySelector('a').href })),
      note: document.querySelector('.p32-search-sort span').innerText,
    }))()`);
    assert.ok(rendered.batch.includes('Reddit / r/marketing'));
    assert.equal(rendered.note, '排序（使用真实 Reddit 快照指标）');
    assert.ok(rendered.cards[0].text.includes('Score') && rendered.cards[0].text.includes('评论') && rendered.cards[0].text.includes('总互动') && rendered.cards[0].text.includes('互动速率'));
    assert.ok(rendered.cards[2].text.includes('—'), 'missing Reddit metrics render unavailable');
    assert.ok(rendered.cards.every((card) => card.href.startsWith('https://www.reddit.com/r/marketing/comments/')));
    const disclosure = await cdp.evaluate(`document.querySelector('.p32-search-sort-note').innerText`);
    assert.ok(disclosure.includes('不是 Reddit 官方排行榜'));
    assert.ok(disclosure.includes('净得分快照，不是投票总数'));

    const expectedSorts = {
      reddit_score: ['Reddit 高分案例', 'Reddit 高评论案例', 'Reddit 指标缺失案例'],
      reddit_comments: ['Reddit 高评论案例', 'Reddit 高分案例', 'Reddit 指标缺失案例'],
      reddit_total_engagement: ['Reddit 高分案例', 'Reddit 高评论案例', 'Reddit 指标缺失案例'],
      reddit_interaction_rate: ['Reddit 高分案例', 'Reddit 高评论案例', 'Reddit 指标缺失案例'],
    };
    for (const [sortKey, expected] of Object.entries(expectedSorts)) {
      await cdp.evaluate(`(() => { const select = document.querySelector('select[aria-label="结果排序方式"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(sortKey)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await waitFor(async () => {
        const labels = await cdp.evaluate(`[...document.querySelectorAll('.p32-search-card .p32-search-label .p32-search-text')].map((node) => node.innerText.trim())`);
        return JSON.stringify(labels) === JSON.stringify(expected);
      }, { label: `${sortKey} sorting` });
    }
    await cdp.evaluate(`(() => { const cards = [...document.querySelectorAll('.p32-search-card')]; cards.slice(0, 2).forEach((card) => card.querySelector('input[type="checkbox"]').click()); })()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('导入所选到当前项目（2）')`), { label: 'two selected' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('导入所选到当前项目（2）')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length === 2`), { label: 'Reddit evidence imported' });
    assert.equal(boundary.projects.get(boundary.projectA.id).evidence.length, 2);
    assert.equal(boundary.projects.get(boundary.projectA.id).evidence.every((row) => row.provenance.source_platform === 'reddit' && row.provenance.provider === 'apify:endspec/reddit-instant-search-scraper'), true);

    // 客户端 URL 拒绝也必须先清空旧批次和选择，禁止校验失败后仍导入旧结果。
    await cdp.evaluate(`(() => { const card = document.querySelector('.p32-search-card'); if (!card.querySelector('input[type="checkbox"]').disabled) card.querySelector('input[type="checkbox"]').click(); const input = document.querySelector('input[aria-label="热门主题搜索关键词"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://reddit.com/r/marketing'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('input[aria-label="热门主题搜索关键词"]').value.startsWith('https://reddit.com')`), { label: 'URL keyword committed' });
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 0 && document.querySelector('.p32-search .p19-error-text')?.innerText.includes('不接受链接作为关键词') && !document.body.innerText.includes('导入所选到当前项目（1）')`), { label: 'client URL rejection clears stale batch and selection' });

    // 同项目新搜索的上游失败同样必须立即清空旧批次和选择。
    await cdp.evaluate(`(() => { const platform = document.querySelector('select[aria-label="搜索平台"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(platform, 'reddit'); platform.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('input[aria-label="限定 subreddit"]'))`), { label: 'Reddit controls before failed search' });
    await cdp.evaluate(`(() => { const input = document.querySelector('input[aria-label="热门主题搜索关键词"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AI 营销'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 3`), { label: 'results restored before upstream failure' });
    await cdp.evaluate(`(() => { const input = document.querySelector('input[aria-label="热门主题搜索关键词"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '触发失败'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('input[aria-label="热门主题搜索关键词"]').value === '触发失败'`), { label: 'failed keyword committed' });
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    try {
      await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 0 && Boolean(document.querySelector('.p32-search .p19-error-text'))`), { label: 'failed search clears stale results' });
    } catch (error) {
      const diagnostic = await cdp.evaluate(`({ cards: document.querySelectorAll('.p32-search-card').length, error: document.querySelector('.p32-search .p19-error-text')?.innerText || null, platform: document.querySelector('select[aria-label="搜索平台"]')?.value, keyword: document.querySelector('input[aria-label="热门主题搜索关键词"]')?.value })`);
      throw new Error(`${error.message}; browser=${JSON.stringify(diagnostic)}; last=${JSON.stringify(boundary.requests.slice(-3).map((entry) => entry.body?.action || entry.body?.command))}`);
    }

    // 重新成功搜索后，真实页面刷新必须清空瞬态批次；权威 Evidence 仍保持。
    await cdp.evaluate(`(() => { const input = document.querySelector('input[aria-label="热门主题搜索关键词"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AI 营销'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 3`), { label: 'Reddit results restored before refresh' });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P32-D Reddit 项目 A') && document.querySelectorAll('.p32-search-card').length === 0 && document.querySelectorAll('.p32-evidence-card').length === 2`), { label: 'refresh clears transient search but preserves evidence' });

    // 再次搜索，随后验证项目切换隔离。
    await cdp.evaluate(`(() => { const platform = document.querySelector('select[aria-label="搜索平台"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(platform, 'reddit'); platform.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('input[aria-label="限定 subreddit"]'))`), { label: 'Reddit controls after refresh' });
    await cdp.evaluate(`(() => { const set = (selector, value) => { const node = document.querySelector(selector); const proto = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; set('input[aria-label="热门主题搜索关键词"]', 'AI 营销'); set('input[aria-label="限定 subreddit"]', 'marketing'); })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((button) => button.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 3`), { label: 'Reddit results before project switch' });

    await cdp.evaluate(`(() => { const select = document.querySelector('.p19-project-select select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(boundary.projectB.id)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.p19-project-select select').value === ${JSON.stringify(boundary.projectB.id)} && document.querySelectorAll('.p32-search-card').length === 0`), { label: 'project switch isolation' });
    assert.equal(boundary.projects.get(boundary.projectB.id).evidence.length, 0);
  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(preview);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p32d-browser-')) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
