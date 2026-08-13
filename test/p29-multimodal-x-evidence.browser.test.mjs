/* global WebSocket, fetch */
// P29 真实生产页面验收：粘贴示例 X 帖子链接 → 读取双图来源 → 渲染两个真实媒体节点
// （精确顺序）→ 一次点击保存图文证据并生成多模态分析 → Evidence / Knowledge / Brief
// 全部绑定持久化 → 硬刷新后身份一致。全部网络流量指向本机 mock（含媒体字节与模型）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { TextEncoder } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const TWEET_ID = '2087047011753467912';
const EXAMPLE_URL = `https://x.com/example/status/${TWEET_ID}`;
const IMAGE_1_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMAGE_2_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const VISUAL_1 = '视觉：产品特写与使用演示，构图居中';
const VISUAL_2 = '视觉：用户反馈特写，暖色调场景';
const TEXT_EXPRESSION = '这条帖子用两个画面说明产品价值：先展示特写，再展示用户反馈。';

function delay(ms) { return sleep(ms); }

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, { timeout = 25_000, interval = 100, label = 'condition', diagnose } = {}) {
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
  let detail = `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`;
  if (diagnose) {
    // 有界失败诊断：附加一次页面/调用快照，绝不输出无界正文。
    try {
      const snapshot = await diagnose();
      detail += `\n诊断快照: ${JSON.stringify(snapshot)}`;
    } catch (snapshotError) {
      detail += `\n（诊断快照不可用: ${String(snapshotError?.message || snapshotError).slice(0, 300)}）`;
    }
  }
  throw new Error(detail);
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

function makeProject(raw, id) {
  return {
    schema_version: 'p19_research_project_v1', id, version: 1, status: 'active',
    topic: raw.topic, objective: raw.objective, audience: raw.audience, channel: raw.channel,
    constraints: raw.constraints || [],
    execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
    created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    evidence: [], analyses: [], knowledge_cards: [], brief: null, handoff: null, handoffs: [], lineage: null,
    fingerprint: 'a'.repeat(64),
  };
}

/** 双图 Actor 夹具（示例帖子 2087047011753467912）：两个 pbs.twimg 风格的媒体 URL。 */
function twoImageItem(mediaBase) {
  const contentText = 'P29 multimodal evidence post with a concrete hook and two photos.';
  const contentSha = createHash('sha256').update(contentText).digest('hex');
  const image1 = `${mediaBase}/media/p29-1.jpg`;
  const image2 = `${mediaBase}/media/p29-2.jpg`;
  const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const asset = (url, order, bytes, dimensions) => ({
    id: `m-${createHash('sha256').update(`p29-media\0${TWEET_ID}\0${order}\0${url}`).digest('hex').slice(0, 24)}`,
    tweet_id: TWEET_ID,
    external_id: TWEET_ID,
    canonical_tweet_url: `https://x.com/i/web/status/${TWEET_ID}`,
    media_url: url,
    order,
    kind: 'image',
    mime_type: 'image/png',
    dimensions,
    byte_size: bytes.length,
    hash: { algorithm: 'sha256', kind: 'content', value: hashOf(bytes) },
  });
  return {
    id: `p22-${contentSha.slice(0, 24)}`, external_id: TWEET_ID,
    source_url: `https://x.com/example/status/${TWEET_ID}`, label: 'P29 双图示例帖子',
    platform: 'x', content_text: contentText, content_sha256: contentSha,
    source_metadata: {
      author: { name: 'Example Author', handle: 'example_handle', user_id: 'u-2087047011753467912' },
      published_at: '2026-08-11T09:30:00.000Z',
      engagement: { likes: 128, retweets: 34, replies: 12, quotes: 3, views: 4567, bookmarks: 8 },
    },
    media_assets: [
      asset(image1, 0, IMAGE_1_BYTES, { width: 1200, height: 800 }),
      asset(image2, 1, IMAGE_2_BYTES, { width: 900, height: 1200 }),
    ],
    collection_proof: `1999999999.${'a'.repeat(64)}`,
    provenance: {
      schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper',
      run_id: 'p29-browser-run', collected_at: '2026-08-12T00:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    },
  };
}

/** 与 p19-contracts.stableCanonicalJson 一致的确定性规范化（mock 端复算工作区指纹）。 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function workspaceFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

/** P29 全链路 mock 边界：媒体字节、采集、模型、命令全部本机，绝无外网。 */
function p29Boundary() {
  let project = null;
  let mediaBase = '';
  const p22Requests = [];
  const analyzeRequests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'p29-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p29-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    if (request.url?.startsWith('/media/')) {
      const bytes = request.url.includes('p29-1.jpg') ? IMAGE_1_BYTES : IMAGE_2_BYTES;
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length });
      response.end(bytes);
      return;
    }
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
      p22Requests.push(body);
      const base = {
        ok: true, schema_version: 'p22_research_assist_v1', role: 'operator',
        execution_flags: { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false },
      };
      if (body.action === 'status') {
        return json(response, 200, {
          ...base, capabilities: { apify_configured: true, qwen_configured: true },
          cost_tracking: { daily_cap_enabled: false, apify: { recorded_cny: 0.1 }, qwen: { recorded_cny: 0.1 } },
        }, origin);
      }
      if (body.action === 'collect_url') {
        if (String(body.url).includes(TWEET_ID) !== true) {
          return json(response, 422, { ok: false, code: 'POST_NOT_FOUND', message: '帖子未找到。' }, origin);
        }
        return json(response, 200, {
          ...base, action: 'collect_url', cost: { recorded_cny: 0.1 },
          items: [twoImageItem(mediaBase)],
        }, origin);
      }
      if (body.action === 'analyze') {
        analyzeRequests.push(body);
        const item = body.items[0];
        const media = (item.media_assets || []).map((asset, index) => ({
          media_id: asset.id,
          visual_content: index === 0 ? VISUAL_1 : VISUAL_2,
          composition: index === 0 ? '居中特写' : '暖色全景',
          people: index === 0 ? '一名演示者' : '一名用户',
          scene: index === 0 ? '明亮室内' : '生活场景',
          emotion: '兴奋与信任',
        }));
        return json(response, 200, {
          ...base, action: 'analyze',
          usage: { total_tokens: 432 },
          cost: { recorded_cny: 1, tracking: { reservation_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc4' } },
          analyses: [{
            source_id: item.id,
            source_url: item.source_url,
            content_sha256: item.content_sha256,
            text_expression: TEXT_EXPRESSION,
            media_analysis: media,
            virality_drivers: ['真实使用场景', '明确示范'],
            reusable_methods: ['先用场景吸引注意', '再给出具体事实'],
            signals: ['高互动内容', '可视化示范'],
            risks: [],
            method: 'qwen_multimodal_assisted_review',
            model: 'qwen3.5-omni-flash',
          }],
        }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported action.' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') return json(response, 200, { ...envelope, read_only: true, data: { projects: project ? [{ id: project.id, topic: project.topic, status: project.status }] : [] } }, origin);
      if (body.command === 'project.read') return json(response, 200, { ...envelope, read_only: true, data: { project } }, origin);
      if (body.command === 'project.create') {
        project = makeProject(body.payload.project, 'prj-0123456789abcdef01234567');
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id: project.id } }, origin);
      }
      if (body.command === 'evidence.create') {
        const record = body.payload.evidence;
        // 复算工作区同款确定性 id 与指纹，保证证据/分析/卡的绑定在重载后依然精确。
        const identity = {
          project_id: project.id,
          provider: record.provenance.provider,
          source_url: record.source_url,
          external_id: record.provenance.external_id ?? null,
          content_sha256: record.provenance.content_sha256,
        };
        record.id = `ev-${createHash('sha256').update(JSON.stringify(canonicalize(identity))).digest('hex').slice(0, 24)}`;
        record.fingerprint = workspaceFingerprint(record);
        project = { ...project, evidence: [...project.evidence.filter((row) => row.id !== record.id), record], version: project.version + 1, fingerprint: 'b'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'evidence', id: record.id } }, origin);
      }
      if (body.command === 'analysis.create') {
        const record = body.payload.analysis;
        project = { ...project, analyses: [...project.analyses.filter((row) => row.id !== record.id), record], version: project.version + 1, fingerprint: 'c'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'analysis', id: record.id } }, origin);
      }
      if (body.command === 'card.create') {
        const record = body.payload.card;
        project = { ...project, knowledge_cards: [...project.knowledge_cards.filter((row) => row.id !== record.id), record], version: project.version + 1, fingerprint: 'd'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'card', id: record.id } }, origin);
      }
      if (body.command === 'brief.assemble') {
        const record = body.payload.brief;
        project = { ...project, brief: record, version: project.version + 1, fingerprint: '7'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'brief', id: record.id } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_COMMAND', message: 'Unsupported command.' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return {
    server,
    p22Requests,
    analyzeRequests,
    setMediaBase(base) { mediaBase = base; },
    getProject: () => project,
  };
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map();
    this.eventHandlers = new Map();
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        // 事件（如 Fetch.requestPaused）：分发给订阅者（可能内联回复命令）。
        const handlers = this.eventHandlers.get(message.method) || [];
        for (const handler of handlers) handler(message.params);
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
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

/**
 * 有界页面快照（固定字节上限）：失败诊断用，区分页面未就绪（readyState）、
 * 目标 tab 不存在/未激活、预览未出现（notice/CTA/按钮/正文片段）与页面或
 * CDP 异常（evaluate 抛错）。绝不输出无界正文。
 */
async function pageSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const tab = document.querySelector('[data-destination-tab="analyze"]');
    const notice = document.querySelector('[data-testid="p38-media-notice"]');
    const cta = document.querySelector('.p38-rehydrate-cta');
    return {
      readyState: document.readyState,
      href: String(location.href).slice(0, 200),
      hasAnalyzeTab: Boolean(tab),
      analyzeTabActive: Boolean(tab && tab.classList.contains('active')),
      hasNotice: Boolean(notice),
      noticeText: notice ? notice.innerText.slice(0, 240) : null,
      rehydrateCta: cta ? { text: cta.textContent.trim().slice(0, 60), disabled: cta.disabled } : null,
      hasVersionMenu: Boolean(document.querySelector('.p36-version-menu')),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 25),
      bodyText: document.body.innerText.slice(0, 400),
    };
  })()`);
}

/** P38 恢复链调用计数：区分「恢复命令未完成」（调用缺失）与「命令已完成但预览未出现」。 */
async function p38Diagnose(cdp, boundary) {
  const snapshot = await pageSnapshot(cdp);
  const calls = boundary.calls;
  return {
    ...snapshot,
    calls: {
      collect_url: calls.filter((c) => c.fn === 'p22' && c.action === 'collect_url').length,
      evidence_update: calls.filter((c) => c.fn === 'command' && c.command === 'evidence.update').length,
      analyze_persisted: calls.filter((c) => c.fn === 'p22' && c.action === 'analyze_persisted').length,
      total: calls.length,
    },
  };
}

async function killTree(child) {
  if (!child || child.exitCode !== null) return;
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => killer.once('close', resolve));
  await delay(150);
}

test('P29 production page collects the two-image example post, renders real media in order, saves and survives reload', { timeout: 90_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');
  const boundaryPort = await freePort();
  const vitePort = await freePort();
  const debugPort = await freePort();
  const mediaBase = `http://127.0.0.1:${boundaryPort}`;
  const boundary = p29Boundary();
  boundary.setMediaBase(mediaBase);
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'ams-p29-browser-'));
  assert.equal(profile.startsWith(tmpdir()), true);

  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p29-public-browser-test-key',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'Vite route' });
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find((item) => item.type === 'page');
    }, { label: 'Edge DevTools target' });
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 主 frame 导航计数：硬刷新必须等真实提交；旧文档在提交前仍可被 evaluate
    // 命中（文本/卡片仍在），会造成「刷新恢复」在旧 DOM 上假通过或 Uncaught。
    let mainFrameNavigations = 0;
    cdp.on('Page.frameNavigated', (params) => {
      if (params.frame && !params.frame.parentId) mainFrameNavigations += 1;
    });
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate(`document.location.origin === 'http://127.0.0.1:${vitePort}' && document.readyState === 'complete'`), { label: 'base page' });

    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p29`;
    const authResult = await cdp.evaluate(`(async () => {
      const { supabase } = await import('/ai-marketing-studio/src/services/supabase-client.js');
      const { data, error } = await supabase.auth.setSession({
        access_token: ${JSON.stringify(token)},
        refresh_token: 'p29-browser-refresh'
      });
      return { ok: !error && Boolean(data?.session?.user?.id), error: error?.message || null };
    })()`);
    assert.deepEqual(authResult, { ok: true, error: null });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated online mode' });

    // 创建研究项目。
    await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((button) => button.textContent.includes('新建项目')))`), { label: 'research page' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('新建项目')).click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), { label: 'new project form' });
    const values = ['P29 双图示例', '验证多模态证据闭环', '运营团队', 'X', '只读来源'];
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ${JSON.stringify(values)};
      fields.forEach((field, index) => {
        const prototype = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, values[index]);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    })()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.p19-create-panel button[type="submit"]').disabled`), { label: 'valid project form' });
    await cdp.evaluate(`document.querySelector('.p19-create-panel button[type="submit"]').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P29 双图示例')`), { label: 'project created' });

    // 粘贴示例 X 帖子链接并读取。
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p22-query-row input'))`), { label: 'p22 intake' });
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p22-query-row input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(EXAMPLE_URL)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('.p22-query-row button').textContent.includes('读取这条帖子')`), { label: 'exact URL mode' });
    await cdp.evaluate(`document.querySelector('.p22-query-row button').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p22-source-card').length === 1`), { label: 'source preview' });
    // 媒体节点出现后还需等到字节真正渲染完成（lazy 加载下不能立即断言 naturalWidth）。
    await waitFor(() => cdp.evaluate(`(() => { const images=[...document.querySelectorAll('.p22-source-card .p22-media-gallery img')]; return images.length===2 && images.every((img) => img.complete && img.naturalWidth > 0); })()`), { label: 'media bytes rendered' });

    // 来源卡：作者/句柄/时间/互动 + 精确两个真实媒体节点（按顺序）。
    const sourceCard = await cdp.evaluate(`(() => {
      const card = document.querySelector('.p22-source-card');
      const images = [...card.querySelectorAll('.p22-media-gallery img')];
      return {
        text: card.innerText,
        mediaCount: card.querySelectorAll('.p22-media-gallery img').length,
        mediaSrcs: images.map((img) => img.getAttribute('src')),
        mediaOrders: images.map((img) => img.getAttribute('data-media-order')),
        loaded: images.every((img) => img.complete && img.naturalWidth > 0),
        previewUnsaved: card.innerText.includes('来源预览 · 未保存'),
        action: card.querySelector('button').textContent,
      };
    })()`);
    assert.equal(sourceCard.mediaCount, 2, `exactly two real media nodes: ${JSON.stringify(sourceCard)}`);
    assert.deepEqual(sourceCard.mediaSrcs, [`${mediaBase}/media/p29-1.jpg`, `${mediaBase}/media/p29-2.jpg`], 'true media URLs in source order');
    assert.deepEqual(sourceCard.mediaOrders, ['0', '1']);
    assert.equal(sourceCard.loaded, true, 'both real media images must render their bytes');
    assert.equal(sourceCard.previewUnsaved, true, 'preview must clearly read 预览未保存');
    assert.equal(sourceCard.action, '保存证据', 'saving Evidence is an explicit first step');
    assert.match(sourceCard.text, /Example Author/);
    assert.match(sourceCard.text, /@example_handle/);
    assert.match(sourceCard.text, /点赞 128/);
    assert.match(sourceCard.text, /浏览 4567/);

    // 第一步只保存证据；分析与后续产物必须由用户分别确认。
    await cdp.evaluate(`document.querySelector('.p22-source-card button').click()`);
    await waitFor(() => {
      const state = boundary.getProject();
      return Boolean(state && state.evidence.length === 1 && state.analyses.length === 0
        && state.knowledge_cards.length === 0 && state.brief === null);
    }, { label: 'evidence-only persistence' });

    const persisted = boundary.getProject();
    const evidence = persisted.evidence[0];
    // Evidence：来源快照 + 两条媒体身份/哈希。
    assert.equal(evidence.media_assets.length, 2);
    assert.deepEqual(evidence.media_assets.map((asset) => asset.media_url), [`${mediaBase}/media/p29-1.jpg`, `${mediaBase}/media/p29-2.jpg`]);
    assert.equal(evidence.media_assets[0].hash.kind, 'content');
    assert.equal(evidence.media_assets[0].hash.value, createHash('sha256').update(IMAGE_1_BYTES).digest('hex'));
    assert.equal(evidence.media_assets[1].hash.value, createHash('sha256').update(IMAGE_2_BYTES).digest('hex'));
    assert.deepEqual(evidence.source_metadata.author, { name: 'Example Author', handle: 'example_handle', user_id: 'u-2087047011753467912' });
    assert.equal(boundary.analyzeRequests.length, 0, 'saving Evidence must not invoke analysis automatically');

    // 硬刷新：Evidence 的媒体、哈希和来源身份保持一致。
    await cdp.send('Page.reload', { ignoreCache: true });
    const navigationsBefore = mainFrameNavigations;
    await waitFor(() => mainFrameNavigations > navigationsBefore, { label: 'hard reload navigation' });
    await waitFor(() => cdp.evaluate(`document.readyState === 'complete' && document.body.innerText.includes('在线工作区 · 已同步') && document.body.innerText.includes('P29 双图示例')`), { label: 'reload recovery', diagnose: () => pageSnapshot(cdp) });
    // P36 默认目的地为「采集」，保存后的来源卡直接可见（不再需要切换完整视图）。
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p22-source-card').length === 1`), { label: 'saved source card after reload' });
    const reloaded = await cdp.evaluate(`(() => {
      const card = document.querySelector('.p22-source-card');
      return {
        saved: card.innerText.includes('证据已保存'),
        analysisReady: card.querySelector('button').textContent.includes('去分析'),
        mediaCount: card.querySelectorAll('.p22-media-gallery img').length,
      };
    })()`);
    assert.deepEqual(reloaded, {
      saved: true, analysisReady: true, mediaCount: 2,
    });
    const persistedAfterReload = boundary.getProject();
    assert.equal(persistedAfterReload.evidence[0].id, evidence.id);
    assert.equal(persistedAfterReload.analyses.length, 0);
    assert.equal(persistedAfterReload.brief, null);

    // 未保存预览在收集后出现；保存后的证据卡不再显示 预览未保存。
    assert.equal(await cdp.evaluate(`document.querySelector('.p22-source-card').innerText.includes('来源预览 · 未保存')`), false);
  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(vite);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p29-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});

// ---- P38 旧视频证据恢复（真实浏览器验收） -----------------------------------------
//
// 旧合同保存的 X 视频证据：播放器来源存在，但媒体绑定为 URL 哈希 + 非白名单主机
// + 缺内容字节。验收：分析页显示「视频媒体尚未完成安全验证」与唯一主操作
// 「重新采集媒体并分析」→ 点击后严格按 collect_url → 唯一身份绑定 → 一次
// evidence.update → 权威重载 → analyze_persisted 顺序执行 → 预览 → 显式保存 →
// 硬刷新后版本历史与 Knowledge Card 入口准确。全部流量指向本机 mock。

const P38_TWEET_ID = '1900000000000000001';
const P38_URL = `https://x.com/p38author/status/${P38_TWEET_ID}`;
const P38_TEXT = 'P38 旧视频恢复验收正文（同一帖子重新采集后正文逐字一致）';

function p38LegacyAsset(overrides = {}) {
  return {
    id: 'm-0123456789abcdef01234567',
    tweet_id: P38_TWEET_ID, external_id: P38_TWEET_ID,
    canonical_tweet_url: P38_URL,
    media_url: 'http://127.0.0.1:1/media/p38-legacy.mp4',
    order: 0, kind: 'video', mime_type: 'video/mp4',
    dimensions: { width: 720, height: 1280 },
    byte_size: null,
    hash: { algorithm: 'sha256', kind: 'url', value: 'd'.repeat(64) },
    ...overrides,
  };
}

/** 重新采集返回的已验证视频资产（严格 CDN 白名单 + content 哈希 + 字节大小）。 */
function p38VerifiedAsset() {
  return p38LegacyAsset({
    id: 'm-111111111111111111111111',
    media_url: 'https://video.twimg.com/ext_tw_video/9/pu/vid/avc1/720x1280.mp4?exp=1999999999&sig=abcdef1234567890',
    byte_size: 20480,
    hash: { algorithm: 'sha256', kind: 'content', value: 'e'.repeat(64) },
  });
}

async function p38LegacyProject() {
  const contentSha = createHash('sha256').update(P38_TEXT).digest('hex');
  const projectId = 'prj-0123456789abcdef01234567';
  const identity = {
    project_id: projectId,
    provider: 'apify:xquik/x-tweet-scraper',
    source_url: P38_URL,
    external_id: P38_TWEET_ID,
    content_sha256: contentSha,
  };
  const evidenceId = `ev-${createHash('sha256').update(JSON.stringify(canonicalize(identity))).digest('hex').slice(0, 24)}`;
  const evidence = {
    schema_version: 'p19_evidence_record_v1', id: evidenceId, project_id: projectId,
    source_url: P38_URL, label: 'P38 旧视频证据', platform: 'X · Apify',
    content_text: P38_TEXT, recorded_at: '2026-08-12T00:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper', source_platform: 'x',
      source_id: 'p38-legacy-source', external_id: P38_TWEET_ID, source_url: P38_URL,
      run_id: 'apify-run-p38-legacy', collected_at: '2026-08-12T00:00:00.000Z', usage_total_usd: 0.01,
      budget_reservation_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', content_sha256: contentSha,
      collection_proof: `1999999999.${'a'.repeat(64)}`, statement: 'Server-bound P22 source evidence.',
    },
    media_metadata: {
      filename: 'p38-legacy.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: new TextEncoder().encode(P38_TEXT).byteLength,
      last_modified: '2026-08-12T00:00:00.000Z', sha256: contentSha,
    },
    source_metadata: {
      author: { name: 'P38 Author', handle: 'p38author', user_id: 'u-p38' },
      published_at: '2026-08-11T09:30:00.000Z',
      engagement: { likes: 55, views: 3210 },
    },
    media_assets: [p38LegacyAsset()],
    version: 1, fingerprint: '', created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
  };
  evidence.fingerprint = workspaceFingerprint(evidence);
  const analysis = {
    schema_version: 'p19_analysis_v1', id: 'an-0123456789abcdef01234567', project_id: projectId,
    evidence_id: evidenceId, kind: 'deterministic_local',
    rule_ids: ['source_url_shape', 'text_length_profile', 'keyword_frequency', 'tone_indicators', 'media_metadata_bounds', 'manual_provenance_trust'],
    provenance: {
      method: 'deterministic_local', generated_by: 'p19_analysis_engine_v1', model: null,
      executed_at: '2026-08-12T00:00:00.000Z',
      statement: '本分析完全由确定性文本/本地元数据规则在本机计算，不调用任何模型、不联网、不产生费用。',
    },
    result: {
      summary: { label: '确定性本地分析（无模型）', keyword_count: 0, top_keywords: [], exclamations: 0, questions: 0 },
      rules: [],
    },
    evidence_fingerprint: evidence.fingerprint, evidence_version: 1,
    version: 1, fingerprint: '', created_at: '2026-08-12T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
  };
  analysis.fingerprint = workspaceFingerprint(analysis);
  const project = makeProject({ topic: 'P38 旧视频恢复', objective: '验证原位恢复', audience: '验收团队', channel: 'X' }, projectId);
  return { ...project, evidence: [evidence], analyses: [analysis] };
}

/** P38 全链路 mock 边界：旧证据种子 + collect_url/evidence.update/analyze_persisted。 */
function p38LegacyBoundary() {
  let project = null;
  const calls = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'p38-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p38-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
      calls.push({ fn: 'p22', action: body.action });
      const base = {
        ok: true, schema_version: 'p22_research_assist_v1', role: 'operator',
        execution_flags: { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false },
      };
      if (body.action === 'status') {
        return json(response, 200, {
          ...base, capabilities: { apify_configured: true, qwen_configured: true },
          cost_tracking: { daily_cap_enabled: false, apify: { recorded_cny: 0.1 }, qwen: { recorded_cny: 0.1 } },
        }, origin);
      }
      if (body.action === 'collect_url') {
        if (String(body.url) !== P38_URL) {
          return json(response, 422, { ok: false, code: 'POST_NOT_FOUND', message: '帖子未找到。' }, origin);
        }
        const contentSha = createHash('sha256').update(P38_TEXT).digest('hex');
        return json(response, 200, {
          ...base, action: 'collect_url', cost: { recorded_cny: 0.1 },
          items: [{
            id: 'p38-legacy-source', source_url: P38_URL, label: 'P38 旧视频证据',
            platform: 'x', content_text: P38_TEXT, external_id: P38_TWEET_ID, content_sha256: contentSha,
            source_metadata: {
              author: { name: 'P38 Author', handle: 'p38author', user_id: 'u-p38' },
              published_at: '2026-08-11T09:30:00.000Z',
              engagement: { likes: 60, views: 4000 },
            },
            media_assets: [p38VerifiedAsset()],
            collection_proof: `1999999998.${'b'.repeat(64)}`,
            provenance: {
              schema_version: 'p22_collected_source_v1', provider: 'apify:xquik/x-tweet-scraper',
              run_id: 'apify-run-p38-rehydrated', collected_at: '2026-08-13T00:00:00.000Z',
              usage_total_usd: 0.02, budget_reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
            },
          }],
        }, origin);
      }
      if (body.action === 'analyze_persisted') {
        const evidence = (project.evidence || []).find((row) => row.id === body.evidence_id);
        if (!evidence) return json(response, 404, { ok: false, code: 'EVIDENCE_NOT_FOUND' }, origin);
        return json(response, 200, {
          ...base, action: 'analyze_persisted',
          analyses: [{
            source_id: evidence.provenance?.source_id,
            source_url: evidence.source_url,
            content_sha256: evidence.provenance?.content_sha256,
            text_expression: '旧视频恢复后的画面分析（逐媒体绑定）',
            hook: '以真实视频画面建立开场钩子',
            copy_pattern: '画面观察 → 传播原因 → 可复用方法',
            target_audience: '内容运营人员',
            audience_need_emotion: '需要可信、可复核的视频洞察',
            media_analysis: (evidence.media_assets || []).map((asset) => ({
              media_id: asset.id, visual_content: '画面内容描述', composition: '居中构图',
              people: '一名人物', scene: '室内场景', emotion: '积极',
              visual_selling_points: ['真实场景'], style_pattern: '短视频纪实风格',
            })),
            virality_drivers: ['真实视频场景'], reusable_methods: ['先展示画面'],
            rewrite_suggestions: ['保留真实画面证据并改写文案'], signals: ['高互动'], risks: ['不得超出视频可见内容进行推断'],
            method: 'qwen_multimodal_assisted_review', model: 'qwen3.5-omni-flash',
          }],
          usage: { total_tokens: 321 },
          cost: { recorded_cny: 1 },
        }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_ACTION', message: 'Unsupported action.' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      calls.push({ fn: 'command', command: body.command });
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') {
        return json(response, 200, { ...envelope, read_only: true, data: { projects: project ? [{ id: project.id, topic: project.topic, status: project.status, version: project.version, fingerprint: project.fingerprint, created_at: project.created_at, updated_at: project.updated_at }] : [] } }, origin);
      }
      if (body.command === 'project.read') {
        return json(response, 200, { ...envelope, read_only: true, data: { project } }, origin);
      }
      if (body.command === 'evidence.update') {
        const record = (project.evidence || []).find((row) => row.id === body.payload?.evidence_id);
        if (!record || record.fingerprint !== body.payload?.expected_fingerprint) {
          return json(response, 409, { ok: false, code: 'EVIDENCE_FINGERPRINT_CONFLICT', message: '证据指纹冲突。' }, origin);
        }
        const patch = body.payload?.patch || {};
        for (const field of ['source_url', 'label', 'platform', 'content_text', 'recorded_at', 'provenance', 'media_metadata', 'source_metadata', 'media_assets']) {
          if (patch[field] !== undefined) {
            if (patch[field] === null) delete record[field];
            else record[field] = JSON.parse(JSON.stringify(patch[field]));
          }
        }
        record.version = (record.version || 1) + 1;
        record.updated_at = new Date().toISOString();
        record.fingerprint = workspaceFingerprint(record);
        project = { ...project, version: project.version + 1, fingerprint: 'b'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'evidence', id: record.id } }, origin);
      }
      if (body.command === 'analysis.create') {
        const record = body.payload.analysis;
        project = { ...project, analyses: [...(project.analyses || []).filter((row) => row.id !== record.id), record], version: project.version + 1, fingerprint: 'c'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'analysis', id: record.id } }, origin);
      }
      if (body.command === 'card.create') {
        const record = body.payload.card;
        project = { ...project, knowledge_cards: [...(project.knowledge_cards || []).filter((row) => row.id !== record.id), record], version: project.version + 1, fingerprint: 'd'.repeat(64) };
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'card', id: record.id } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_COMMAND', message: 'Unsupported command.' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return {
    server,
    calls,
    seed(next) { project = next; },
    getProject: () => project,
  };
}

test('P38 production page: legacy video evidence shows the unverified state, recovers in place with exactly one evidence.update, then Qwen preview and explicit save survive reload', { timeout: 120_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');
  const boundaryPort = await freePort();
  const vitePort = await freePort();
  const debugPort = await freePort();
  const boundary = p38LegacyBoundary();
  boundary.seed(await p38LegacyProject());
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'ams-p38-browser-'));
  assert.equal(profile.startsWith(tmpdir()), true);

  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p38-public-browser-test-key',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
  try {
    const baseUrl = `http://127.0.0.1:${vitePort}/ai-marketing-studio/`;
    await waitFor(async () => (await fetch(baseUrl)).ok, { label: 'Vite route' });
    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) return null;
      return (await response.json()).find((item) => item.type === 'page');
    }, { label: 'Edge DevTools target' });
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 恢复后的媒体（video.twimg.com）经 CDP Fetch 拦截到本机 mock，绝不访问真实 CDN。
    await cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: 'https://video.twimg.com/*', requestStage: 'Request' },
        { urlPattern: 'https://pbs.twimg.com/*', requestStage: 'Request' },
        { urlPattern: 'https://abs.twimg.com/*', requestStage: 'Request' },
      ],
    });
    cdp.on('Fetch.requestPaused', (params) => {
      const url = params.request?.url || '';
      if (/\/[^?#]+\.(?:jpg|jpeg|png|mp4)(?:$|[?#])/.test(url)) {
        cdp.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'content-type', value: 'image/png' }, { name: 'cache-control', value: 'no-store' }],
          body: IMAGE_1_BYTES.toString('base64'),
        });
      } else {
        cdp.send('Fetch.continueRequest', { requestId: params.requestId });
      }
    });
    // 主 frame 导航计数：硬刷新必须等真实提交；旧文档在提交前仍可被 evaluate
    // 命中（正文与元素仍在），会造成假通过或紧随其后的 Uncaught。
    let mainFrameNavigations = 0;
    cdp.on('Page.frameNavigated', (params) => {
      if (params.frame && !params.frame.parentId) mainFrameNavigations += 1;
    });
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate(`document.location.origin === 'http://127.0.0.1:${vitePort}' && document.readyState === 'complete'`), { label: 'base page' });

    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p38`;
    const authResult = await cdp.evaluate(`(async () => {
      const { supabase } = await import('/ai-marketing-studio/src/services/supabase-client.js');
      const { data, error } = await supabase.auth.setSession({
        access_token: ${JSON.stringify(token)},
        refresh_token: 'p38-browser-refresh'
      });
      return { ok: !error && Boolean(data?.session?.user?.id), error: error?.message || null };
    })()`);
    assert.deepEqual(authResult, { ok: true, error: null });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated online mode' });
    // 正文文本出现不等于工作台挂载：目标 tab 元素存在才是可点击的真实生产状态。
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P38 旧视频恢复') && Boolean(document.querySelector('[data-destination-tab="analyze"]'))`), { label: 'seeded project loaded', diagnose: () => pageSnapshot(cdp) });

    // 分析目的地：旧证据状态 —— 横幅 + 唯一主操作「重新采集媒体并分析」，零 Qwen。
    await cdp.evaluate(`document.querySelector('[data-destination-tab="analyze"]').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-destination-tab="analyze"]').classList.contains('active')`), { label: 'analyze tab active', diagnose: () => pageSnapshot(cdp) });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="p38-media-notice"]'))`), { label: 'P38 media notice', diagnose: () => pageSnapshot(cdp) });
    const legacyState = await cdp.evaluate(`(() => ({
      notice: document.querySelector('[data-testid="p38-media-notice"]').innerText,
      primary: document.querySelector('.p36-cta-primary')?.textContent || '',
      quality: document.querySelector('[data-testid="p36-analysis-quality"]')?.innerText || '',
      textPackage: document.body.innerText.includes('帖子文本证据'),
      railStatus: document.body.innerText.includes('媒体待恢复'),
    }))()`);
    assert.match(legacyState.notice, /视频媒体尚未完成安全验证/);
    assert.match(legacyState.notice, /基础检测没有理解视频画面\/声音/);
    assert.equal(legacyState.primary, '重新采集媒体并分析', '旧媒体证据的唯一主操作必须是恢复入口，不得是不可解释的死按钮');
    assert.match(legacyState.quality, /基础检测/);
    assert.equal(legacyState.textPackage, true, '正文文本包必须标记为「帖子文本证据」');
    assert.equal(legacyState.railStatus, true, '来源列表必须显示「媒体待恢复」');
    assert.equal(boundary.calls.filter((c) => c.fn === 'p22' && c.action === 'analyze_persisted').length, 0, '恢复前零 Qwen 调用');

    // 点击恢复：严格顺序 collect_url → 一次 evidence.update → analyze_persisted。
    await waitFor(() => cdp.evaluate(`(() => { const el = document.querySelector('.p38-rehydrate-cta'); return Boolean(el && !el.disabled); })()`), { label: 'rehydrate CTA enabled', diagnose: () => p38Diagnose(cdp, boundary) });
    await cdp.evaluate(`document.querySelector('.p38-rehydrate-cta').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('预览 · 未保存') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('保存分析结果'))`), { label: 'rehydrate preview', diagnose: () => p38Diagnose(cdp, boundary) });
    const p38Calls = boundary.calls;
    assert.equal(p38Calls.filter((c) => c.fn === 'p22' && c.action === 'collect_url').length, 1, '恰好一次 collect_url');
    assert.equal(p38Calls.filter((c) => c.fn === 'command' && c.command === 'evidence.update').length, 1, '恰好一次 evidence.update');
    assert.equal(p38Calls.filter((c) => c.fn === 'p22' && c.action === 'analyze_persisted').length, 1, '权威重载后才调用一次 Qwen');
    const collectIndex = p38Calls.findIndex((c) => c.fn === 'p22' && c.action === 'collect_url');
    const updateIndex = p38Calls.findIndex((c) => c.fn === 'command' && c.command === 'evidence.update');
    const analyzeIndex = p38Calls.findIndex((c) => c.fn === 'p22' && c.action === 'analyze_persisted');
    assert.ok(collectIndex < updateIndex && updateIndex < analyzeIndex, '顺序必须为 collect_url → evidence.update → analyze_persisted');

    // 原位升级：数量不变、id 不变、版本 +1、指纹变化、媒体绑定更新为内容哈希。
    const seeded = await p38LegacyProject();
    const upgraded = boundary.getProject();
    assert.equal(upgraded.evidence.length, 1, '不得产生重复 Evidence');
    assert.equal(upgraded.evidence[0].id, seeded.evidence[0].id, 'evidence_id 必须保持不变');
    assert.equal(upgraded.evidence[0].version, seeded.evidence[0].version + 1, '版本必须 +1');
    assert.notEqual(upgraded.evidence[0].fingerprint, seeded.evidence[0].fingerprint, '指纹必须变化');
    assert.equal(upgraded.evidence[0].media_assets[0].hash.kind, 'content');
    assert.equal(upgraded.evidence[0].media_assets[0].byte_size, 20480);
    assert.equal(upgraded.evidence[0].media_assets[0].media_url.includes('video.twimg.com'), true);

    // 显式保存分析结果：逐 media_id 完整绑定。
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('保存分析结果')).click()`);
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('去创作'))`), { label: 'analysis saved', diagnose: () => p38Diagnose(cdp, boundary) });
    const saved = boundary.getProject();
    const savedAnalyses = saved.analyses.filter((row) => row.evidence_id === saved.evidence[0].id).sort((a, b) => b.version - a.version);
    const modelAnalysis = savedAnalyses[0];
    assert.ok(modelAnalysis && modelAnalysis.model_analysis, '必须保存多模态模型分析');
    assert.equal(modelAnalysis.model_analysis.method, 'multimodal_model');
    assert.deepEqual(modelAnalysis.model_analysis.media_ids, saved.evidence[0].media_assets.map((a) => a.id), '模型结果必须逐 media_id 完整绑定恢复后的媒体');
    assert.equal(modelAnalysis.evidence_fingerprint, saved.evidence[0].fingerprint, '分析必须绑定当前证据指纹');
    assert.equal(modelAnalysis.evidence_version, saved.evidence[0].version);

    // 硬刷新：版本历史与 Knowledge Card 入口准确，旧 deterministic 不作为当前有效结果。
    await cdp.send('Page.reload', { ignoreCache: true });
    // 硬刷新必须等真实导航提交：旧文档在提交前仍可被 evaluate 命中（正文与
    // 元素仍在），文本/元素等待可能在旧 DOM 上假通过，随后对新文档立即报
    // Uncaught（历史失败签名）。提交后再等新文档 DOM 就绪与工作台挂载。
    const navigationsBefore = mainFrameNavigations;
    await waitFor(() => mainFrameNavigations > navigationsBefore, { label: 'hard reload navigation' });
    await waitFor(() => cdp.evaluate(`document.readyState === 'complete' && document.body.innerText.includes('P38 旧视频恢复') && Boolean(document.querySelector('[data-destination-tab="analyze"]'))`), { label: 'reload recovery', diagnose: () => pageSnapshot(cdp) });
    await cdp.evaluate(`document.querySelector('[data-destination-tab="analyze"]').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-destination-tab="analyze"]').classList.contains('active')`), { label: 'analyze tab active after reload', diagnose: () => pageSnapshot(cdp) });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('去创作'))`), { label: 'reloaded analyze state', diagnose: () => p38Diagnose(cdp, boundary) });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p36-version-menu summary'))`), { label: 'version menu', diagnose: () => pageSnapshot(cdp) });
    await cdp.evaluate(`document.querySelector('.p36-version-menu summary').click()`);
    const history = await cdp.evaluate(`document.querySelector('.p36-version-menu').innerText`);
    assert.match(history, /v1/, '版本历史必须包含旧确定性分析 v1');
    assert.match(history, /v2/, '版本历史必须包含恢复后的模型分析 v2');
    assert.match(history, /确定性分析/, 'v1 明确标记为确定性分析');
    const cardAction = await cdp.evaluate(`[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).find((t) => t === '生成知识卡' || t === '查看知识卡') || ''`);
    assert.ok(cardAction === '生成知识卡' || cardAction === '查看知识卡', `Knowledge Card 入口必须准确: ${cardAction}`);
    const qualityAfter = await cdp.evaluate(`document.querySelector('[data-testid="p36-analysis-quality"]')?.innerText || ''`);
    assert.match(qualityAfter, /Qwen 多模态分析/, '刷新后必须显示 Qwen 多模态分析为当前有效结果');
    assert.equal(boundary.calls.filter((c) => c.fn === 'p22' && c.action === 'collect_url').length, 1, '刷新绝不触发重新采集');
    assert.equal(boundary.calls.filter((c) => c.fn === 'command' && c.command === 'evidence.update').length, 1, '刷新绝不触发重复升级');
  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(vite);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p38-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
