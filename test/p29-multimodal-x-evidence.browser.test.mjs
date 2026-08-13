/* global WebSocket, fetch */
// P29 真实生产页面验收：粘贴示例 X 帖子链接 → 读取双图来源 → 渲染两个真实媒体节点
// （精确顺序）→ 一次点击保存图文证据并生成多模态分析 → Evidence / Knowledge / Brief
// 全部绑定持久化 → 硬刷新后身份一致。全部网络流量指向本机 mock（含媒体字节与模型）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
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

async function waitFor(check, { timeout = 25_000, interval = 100, label = 'condition' } = {}) {
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
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
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
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'base page' });

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
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步') && document.body.innerText.includes('P29 双图示例')`), { label: 'reload recovery' });
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
