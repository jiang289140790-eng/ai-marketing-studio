/* global WebSocket, fetch */
// P32-B 真实浏览器验收：使用完整生产构建（vite build → dist/，vite preview 提供），
// 通过 Edge CDP 启动生产 #/research 路由。全部网络/模型/Supabase 调用由本机 mock
// 拦截（返回确定性搜索 fixture），但生产组件、路由、事件处理程序与持久化链路真实执行。
//
// 验证：热门主题搜索（与单帖 URL 读取区分）、五种确定性排序与完整指标文本、勾选
// 1–5 条、批量导入、Evidence 列表更新、已导入禁用、项目切换隔离、刷新恢复、
// 搜索失败错误态、单帖 URL 读取、P32-A Qwen 重分析入口与多帖比较仍可见且可操作。
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

function delay(ms) { return sleep(ms); }

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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
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

// ---- 确定性搜索 fixture：6 条帖子，覆盖五种排序与缺失指标 ----
const SEARCH_FIXTURE = [
  { label: '热门帖子 1', extId: '1900000000000001001', views: 50000, likes: 4000, retweets: 900, replies: 300, quotes: 100, bookmarks: 2000, media: true },
  { label: '热门帖子 2', extId: '1900000000000001002', views: 120000, likes: 9000, retweets: 2500, replies: 800, quotes: 300, bookmarks: 5000, media: true },
  { label: '热门帖子 3', extId: '1900000000000001003', views: 8000, likes: 600, retweets: 150, replies: 60, quotes: 30, bookmarks: 300, media: false },
  { label: '热门帖子 4', extId: '1900000000000001004', views: null, likes: 100, retweets: 20, replies: null, quotes: null, bookmarks: null, media: false },
  { label: '热门帖子 5', extId: '1900000000000001005', views: null, likes: null, retweets: null, replies: null, quotes: null, bookmarks: null, engagementNull: true, media: false },
  { label: '热门帖子 6', extId: '1900000000000001006', views: 200000, likes: 15000, retweets: 4000, replies: 1200, quotes: 500, bookmarks: 8000, media: true },
];

/**
 * mock 边界镜像服务端 searchBatchId 的规范形式：确定性绑定关键词/数量/排序意图/
 * 采集运行/采集时间/（URL|外部 ID|正文哈希）有序身份。导入端会重算批次身份，
 * 任何与内容不一致的 batch_id 都会失败关闭。
 */
function mockSearchBatchId({ keyword, count, runId, collectedAt, items }) {
  const identities = items.map((item) => `${item.source_url}|${item.external_id == null ? '' : String(item.external_id)}|${item.content_sha256}`).join(';');
  const value = `p32-search-batch\0${keyword}\0${count}\0latest\0${runId}\0${collectedAt}\0${identities}`;
  return `p32-search-${sha256(value).slice(0, 24)}`;
}

function makeSearchPost(index, runId = 'apify-run-search-browser') {
  const spec = SEARCH_FIXTURE[index];
  const contentText = `P32-B 浏览器搜索帖子 ${index + 1}：${spec.label} 的确定性正文。`;
  const contentSha = sha256(contentText);
  const engagement = spec.engagementNull ? null : {
    views: spec.views, likes: spec.likes, retweets: spec.retweets,
    replies: spec.replies, quotes: spec.quotes, bookmarks: spec.bookmarks,
  };
  const mediaAssets = spec.media ? [{
    id: `m-${sha256(`p32-media\0${spec.extId}\0`).slice(0, 24)}`,
    tweet_id: spec.extId, external_id: spec.extId,
    canonical_tweet_url: `https://x.com/author${index + 1}/status/${spec.extId}`,
    media_url: `https://pbs.twimg.com/media/photo-${spec.extId}.jpg`,
    order: 0, kind: 'image', mime_type: 'image/jpeg',
    dimensions: { width: 800, height: 600 }, byte_size: 100000,
    hash: { algorithm: 'sha256', kind: 'content', value: 'e'.repeat(64) },
  }] : [];
  return {
    id: `p22-${contentSha.slice(0, 24)}`,
    source_url: `https://x.com/author${index + 1}/status/${spec.extId}`,
    label: spec.label,
    platform: 'x',
    content_text: contentText,
    external_id: spec.extId,
    content_sha256: contentSha,
    source_metadata: {
      author: { name: `作者${index + 1}`, handle: `author${index + 1}`, user_id: `user${index + 1}` },
      published_at: `2026-08-0${index + 1}T08:00:00.000Z`,
      engagement,
    },
    media_assets: mediaAssets,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: 'apify:xquik/x-tweet-scraper',
      run_id: runId,
      collected_at: '2026-08-12T00:00:00.000Z',
      usage_total_usd: 0.01,
      budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
    },
    collection_proof: `9999999999.${'b'.repeat(64)}`,
  };
}

/** 期望排序顺序（按 label）：views / likes / retweets / total_engagement / engagement_rate。 */
const EXPECTED_ORDER = {
  views: ['热门帖子 6', '热门帖子 2', '热门帖子 1', '热门帖子 3', '热门帖子 5', '热门帖子 4'],
  likes: ['热门帖子 6', '热门帖子 2', '热门帖子 1', '热门帖子 3', '热门帖子 4', '热门帖子 5'],
  retweets: ['热门帖子 6', '热门帖子 2', '热门帖子 1', '热门帖子 3', '热门帖子 4', '热门帖子 5'],
  total_engagement: ['热门帖子 6', '热门帖子 2', '热门帖子 1', '热门帖子 3', '热门帖子 4', '热门帖子 5'],
  engagement_rate: ['热门帖子 2', '热门帖子 1', '热门帖子 6', '热门帖子 3', '热门帖子 5', '热门帖子 4'],
};

/** 从 analyze 请求中的 item 构造与来源、媒体精确绑定的 v2 模型结果（模拟 Qwen）。 */
function v2AnalysisForItem(item) {
  const mediaAnalysis = (item.media_assets || []).map((asset, i) => ({
    media_id: asset.id,
    visual_content: `画面 #${i + 1}：高对比度视觉元素，色彩饱和。`,
    composition: '中心对称构图', people: '单人特写', scene: '室内暖光', emotion: '专业自信',
    visual_selling_points: ['高辨识度', '调性统一'], style_pattern: '暖色调 + 浅景深',
  }));
  return {
    source_id: item.id,
    source_url: item.source_url,
    content_sha256: item.content_sha256,
    text_expression: '浏览器测试：强有力的视觉表达与简洁文案形成传播合力。',
    hook: '浏览器测试钩子',
    copy_pattern: '视觉前置 + 情绪共鸣',
    target_audience: '关注科技与生活方式的城市青年',
    audience_need_emotion: '追求效率与品质的信息需求',
    media_analysis: mediaAnalysis,
    virality_drivers: ['视觉冲击力', '信息密度'],
    reusable_methods: ['图胜于文', '情绪共鸣'],
    rewrite_suggestions: ['加入数据可视化'],
    signals: ['高互动率'], risks: ['过度依赖视觉'],
    model: 'qwen3.5-omni-flash',
  };
}

// ---- mock 边界 ----
function p32bBoundary() {
  const projects = new Map();
  let searchFails = false;
  let collectUrlFails = false;
  let failEvidenceCreateAt = -1; // 1-based：让第 N 次 evidence.create 确定性失败
  let evidenceCreateTotal = 0;
  const requests = [];
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'p32b-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p32b-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) {
      return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    }
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'p22', action: body.action, body });
      const base = {
        ok: true, schema_version: 'p22_research_assist_v1', role: 'operator',
        execution_flags: { generation_executed: false, routing_executed: false, external_job_created: false, publish_executed: false },
      };
      if (body.action === 'status') {
        return json(response, 200, {
          ...base, capabilities: { apify_configured: true, qwen_configured: true },
          cost_tracking: { daily_cap_enabled: false, apify: { recorded_cny: 0.01 }, qwen: { recorded_cny: 0.01 } },
        }, origin);
      }
      if (body.action === 'search') {
        if (searchFails) {
          searchFails = false; // 一次性失败：后续搜索恢复正常
          return json(response, 422, { ok: false, code: 'EMPTY_PROVIDER_RESULT', message: '没有返回可验证的公开内容。', execution_flags: base.execution_flags }, origin);
        }
        const items = SEARCH_FIXTURE.slice(0, Math.max(1, Number(body.count) || 10)).map((_, index) => makeSearchPost(index));
        return json(response, 200, {
          ...base, action: 'search',
          // 真实算法签名（导入端会重算校验；与内容不一致即失败关闭）
          search_batch_id: mockSearchBatchId({ keyword: body.keyword, count: body.count, runId: 'apify-run-search-browser', collectedAt: '2026-08-12T00:00:00.000Z', items }),
          keyword: body.keyword, count: body.count, sort_intent: 'latest',
          collected_at: '2026-08-12T00:00:00.000Z',
          items,
          cost: { recorded_cny: 2, actual_cny: 0.08 },
        }, origin);
      }
      if (body.action === 'collect_url') {
        if (collectUrlFails) {
          return json(response, 422, { ok: false, code: 'POST_NOT_FOUND', message: '采集结果无法唯一绑定到请求的帖子。', execution_flags: base.execution_flags }, origin);
        }
        // 单帖读取 fixture 与搜索结果完全隔离：不落入任何已导入来源。
        const contentText = 'P32-B 浏览器单帖读取：与搜索结果隔离的独立帖子正文。';
        const contentSha = sha256(contentText);
        const item = {
          id: `p22-${contentSha.slice(0, 24)}`,
          source_url: 'https://x.com/single/status/9999999999999999999',
          label: '单帖读取帖子',
          platform: 'x',
          content_text: contentText,
          external_id: '9999999999999999999',
          content_sha256: contentSha,
          source_metadata: {
            author: { name: '单帖作者', handle: 'singleauthor', user_id: 'singleuser' },
            published_at: '2026-08-12T07:00:00.000Z',
            engagement: { views: 8888, likes: 888, retweets: 88, replies: 8, quotes: 8, bookmarks: 88 },
          },
          media_assets: [{
            id: `m-${sha256('p32-single-media').slice(0, 24)}`,
            tweet_id: '9999999999999999999', external_id: '9999999999999999999',
            canonical_tweet_url: 'https://x.com/single/status/9999999999999999999',
            media_url: 'https://pbs.twimg.com/media/single-photo.jpg',
            order: 0, kind: 'image', mime_type: 'image/jpeg',
            dimensions: { width: 800, height: 600 }, byte_size: 100000,
            hash: { algorithm: 'sha256', kind: 'content', value: 'c'.repeat(64) },
          }],
          provenance: {
            schema_version: 'p22_collected_source_v1',
            provider: 'apify:xquik/x-tweet-scraper',
            run_id: 'apify-run-url-browser',
            collected_at: '2026-08-12T00:00:00.000Z',
            usage_total_usd: 0.01,
            budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
          },
          collection_proof: `9999999999.${'d'.repeat(64)}`,
        };
        return json(response, 200, { ...base, action: 'collect_url', items: [item], cost: { recorded_cny: 2, actual_cny: 0.01 } }, origin);
      }
      if (body.action === 'analyze') {
        const items = Array.isArray(body.items) ? body.items : [];
        return json(response, 200, {
          ...base, action: 'analyze',
          analyses: items.map((item) => v2AnalysisForItem(item)),
          usage: { total_tokens: 1200 },
          cost: { recorded_cny: 1, tracking: [] },
        }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_ACTION' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'command', command: body.command, body });
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') {
        return json(response, 200, {
          ...envelope, read_only: true,
          data: { projects: [...projects.values()].map((p) => ({ id: p.id, topic: p.topic, status: p.status, version: p.version, fingerprint: p.fingerprint, created_at: p.created_at, updated_at: p.updated_at })) },
        }, origin);
      }
      if (body.command === 'project.read') {
        const project = projects.get(body.payload?.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        return json(response, 200, { ...envelope, read_only: true, data: { project } }, origin);
      }
      if (body.command === 'project.create') {
        const raw = body.payload.project;
        const id = `prj-${sha256(`p32b-proj\0${raw.topic}\0${Date.now()}`).slice(0, 24)}`;
        const project = makeProject(raw, id);
        projects.set(id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id } }, origin);
      }
      if (body.command === 'evidence.create') {
        evidenceCreateTotal += 1;
        if (evidenceCreateTotal === failEvidenceCreateAt) {
          // 确定性部分失败：第 N 次写入返回服务端错误（已写入的 N-1 条保持生效）
          return json(response, 503, { ok: false, code: 'ONLINE_WRITE_FAILED', message: '在线写入暂时失败。' }, origin);
        }
        const record = body.payload.evidence;
        const project = projects.get(record.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        if (!project.evidence.some((item) => item.id === record.id)) {
          project.evidence = [...project.evidence, record];
          project.version += 1;
          projects.set(project.id, project);
        }
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'evidence', id: record.id } }, origin);
      }
      if (body.command === 'analysis.create') {
        const record = body.payload.analysis;
        const project = projects.get(record.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        project.analyses = [...project.analyses.filter((a) => a.id !== record.id), record];
        project.version += 1;
        projects.set(project.id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'analysis', id: record.id } }, origin);
      }
      if (body.command === 'card.create') {
        const record = body.payload.card;
        const project = projects.get(record.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        project.knowledge_cards = [...project.knowledge_cards.filter((c) => c.id !== record.id), record];
        project.version += 1;
        projects.set(project.id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'card', id: record.id } }, origin);
      }
      if (body.command === 'brief.assemble') {
        const record = body.payload.brief;
        const project = projects.get(record.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        project.brief = record;
        project.version += 1;
        projects.set(project.id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'brief', id: record.id } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_COMMAND' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return {
    server, projects, requests,
    failNextSearch() { searchFails = true; },
    failNextCollectUrl() { collectUrlFails = true; },
    failNthEvidenceCreate(n) { failEvidenceCreateAt = n; },
    evidenceCreateCount() { return evidenceCreateTotal; },
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

async function waitForUrl(url, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if ((await globalThis.fetch(url)).ok) return; } catch { /* retry */ }
    await delay(200);
  }
  throw new Error(`preview did not start: ${url}`);
}

test('P32-B real production build: hot-topic search, five deterministic sorts, batch import, imported disable, project-switch isolation, refresh restore, failure states, and P22/P32-A regressions', { timeout: 300_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');

  // 1) mock 边界先启动（构建时内联其 URL）
  const boundaryPort = await freePort();
  const previewPort = await freePort();
  const debugPort = await freePort();
  const boundary = p32bBoundary();
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));

  // 2) 真实构建：清理 dist（避免 Windows rolldown 存量崩溃）→ vite build → preview
  await rm(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  execFileSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p32b-public-browser-test-key',
    },
    timeout: 180_000,
  });
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`);

  const profile = await mkdtemp(join(tmpdir(), 'ams-p32b-browser-'));
  assert.equal(profile.startsWith(tmpdir()), true);
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let cdp;
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
    await cdp.send('Page.navigate', { url: baseUrl });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'base page' });

    // 3) 生产构建无法动态 import src 模块（无 dev-server 模块路径），因此会话引导
    //    必须在应用脚本执行之前注入 localStorage：
    //    Page.addScriptToEvaluateOnNewDocument 保证任何后续文档加载都先写入会话，
    //    AuthProvider 在启动时从 localStorage 恢复登录态。
    //    注意：仅 hash 变化的导航是 same-document 导航（不会重载页面），因此注入后
    //    必须显式 Page.reload 强制整页重载，会话才会在 AuthProvider 启动时被读取。
    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7200,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p32b-browser`;
    const session = {
      access_token: token,
      token_type: 'bearer',
      expires_in: 7200,
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      refresh_token: 'p32b-browser-refresh',
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'p32b-browser@example.invalid',
        user_metadata: { user_name: 'p32b-browser' },
      },
    };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem(${JSON.stringify(AUTH_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))});`,
    });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'research route loaded' });
    await cdp.send('Page.reload', { ignoreCache: true });
    try {
      await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated online research route' });
    } catch (error) {
      const diagnostic = await cdp.evaluate(`({ body: document.body.innerText.slice(0, 1200), stored: Boolean(localStorage.getItem('ai-marketing-studio-auth-session')) })`);
      throw new Error(`${error.message}; browser=${JSON.stringify(diagnostic)}`);
    }

    // 4) 创建项目
    await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')))`), { label: 'research page loaded' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')).click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), { label: 'create project form' });
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ['P32-B 浏览器验证', '热门主题搜索批量导入验收', '测试团队', 'X', '只读来源'];
      fields.forEach((field, i) => {
        if (i < values.length) {
          Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(field, values[i]);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    })()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.p19-create-panel button[type="submit"]').disabled`), { label: 'valid form' });
    await cdp.evaluate(`document.querySelector('.p19-create-panel button[type="submit"]').click()`);
    await waitFor(() => boundary.projects.size === 1, { label: 'project created' });
    await delay(400);
    const projectId = [...boundary.projects.keys()][0];
    assert.ok(projectId, 'project persisted in mock store');

    // P36 渐进式重设计：默认目的地「采集」。热门主题搜索是次级工具，先展开
    // 「更多采集方式」details 再验证面板可见性。
    await cdp.evaluate(`[...document.querySelectorAll('.p36-advanced summary')].find((s) => s.textContent.includes('更多采集方式')).click()`);
    await delay(300);

    // 5) 两个面板都可见且清楚区分（热门主题搜索 vs 智能找资料单帖读取）
    const panels = await cdp.evaluate(`(() => {
      const body = document.body.innerText;
      return {
        hasSearchPanel: body.includes('热门主题搜索（批量导入当前项目）'),
        hasUrlPanel: body.includes('智能找资料'),
        hasDistinctionNote: body.includes('与「智能找资料」的单帖 URL 读取区分'),
        hasModeNote: body.includes('单帖 URL 读取'),
      };
    })()`);
    assert.equal(panels.hasSearchPanel, true, '热门主题搜索面板应可见');
    assert.equal(panels.hasUrlPanel, true, '智能找资料面板应可见');
    assert.equal(panels.hasDistinctionNote, true, '应与单帖 URL 读取明确区分');

    // 6) 搜索 → 确定性 fixture 结果
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p32-search-query-row input[aria-label="热门主题搜索关键词"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AI 营销 出海');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((b) => b.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length >= 5`), { label: 'search results rendered' });
    const metricText = await cdp.evaluate(`document.querySelector('.p32-search-card').innerText`);
    for (const needle of ['浏览', '点赞', '转发', '回复', '收藏', '总互动', '互动率', '热门帖子']) {
      assert.ok(metricText.includes(needle), `结果卡应包含指标文本「${needle}」`);
    }
    const missingShown = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.p32-search-card')];
      const p4 = cards.find((card) => card.innerText.includes('热门帖子 4'));
      return p4 ? p4.innerText.includes('—') : false;
    })()`);
    assert.equal(missingShown, true, '缺失指标应显示「—」而不是 0');
    const sortNote = await cdp.evaluate(`document.body.innerText.includes('不是 X 官方热门榜')`);
    assert.equal(sortNote, true, '应明确说明排序口径不是 X 官方热门榜');

    // 7) 五种排序逐一验证（DOM 顺序与确定性期望一致）
    for (const sortKey of ['views', 'likes', 'retweets', 'total_engagement', 'engagement_rate']) {
      await cdp.evaluate(`(() => {
        const select = document.querySelector('.p32-search-sort select');
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(sortKey)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await delay(120);
      const labels = await cdp.evaluate(`[...document.querySelectorAll('.p32-search-card')].map((card) => card.querySelector('.p32-search-label .p32-search-text').innerText.trim())`);
      const expected = EXPECTED_ORDER[sortKey];
      assert.deepEqual(labels.slice(0, expected.length), expected, `排序 ${sortKey} 的卡片顺序应精确匹配`);
    }

    // 8) 勾选 2 条 → 批量导入 → Evidence 列表更新 + 已导入禁用
    await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.p32-search-card')];
      cards.find((card) => card.innerText.includes('热门帖子 1')).querySelector('input[type="checkbox"]').click();
      cards.find((card) => card.innerText.includes('热门帖子 2')).querySelector('input[type="checkbox"]').click();
    })()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('导入所选到当前项目（2）')`), { label: 'selection of 2' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('导入所选到当前项目（2）')).click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('已导入 2 条搜索结果到当前项目')`), { label: 'import success notice' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length >= 2`), { label: 'evidence library updated' });
    await waitFor(() => cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.p32-search-card')].find((c) => c.innerText.includes('热门帖子 1'));
      return Boolean(card && card.innerText.includes('已导入 ✓'));
    })()`), { label: 'imported marker on result card' });
    const importedState = await cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.p32-search-card')].find((c) => c.innerText.includes('热门帖子 1'));
      const checkbox = card.querySelector('input[type="checkbox"]');
      return { disabled: checkbox.disabled, badge: card.innerText.includes('已导入 ✓'), note: card.innerText.includes('禁止重复导入') };
    })()`);
    assert.equal(importedState.disabled, true, '已导入结果的勾选应禁用');
    assert.equal(importedState.badge, true, '已导入结果应显示已导入标记');
    assert.equal(importedState.note, true, '应显示禁止重复导入说明');

    // 9) 重复导入失败关闭（项目不变）
    const evidenceCountBefore = await cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length`);
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.p32-search-sort select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'likes');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await delay(100);
    // 已导入卡片复选框被禁用 → 无法再选择导入（通过项目级 importSearchSelection 再验证一次原子拒绝）
    const evidenceCountAfter = await cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length`);
    assert.equal(evidenceCountAfter, evidenceCountBefore, '导入后不产生重复证据');

    // 9b) 在线批次部分失败（确定性）：勾选 4 条未导入结果（帖子 3–6），程序化让
    //     本批第 2 次 evidence.create 失败 → 已确认 1 条成功、剩余 3 条待重试；
    //     UI 重载权威状态并显示精确计数，绝不显示全成功。
    const partialSelection = ['热门帖子 3', '热门帖子 4', '热门帖子 5', '热门帖子 6'];
    await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.p32-search-card')];
      for (const label of ${JSON.stringify(partialSelection)}) {
        const card = cards.find((c) => c.innerText.includes(label));
        if (card && !card.querySelector('input[type="checkbox"]').disabled) {
          card.querySelector('input[type="checkbox"]').click();
        }
      }
    })()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('导入所选到当前项目（4）')`), { label: 'partial-failure selection of 4' });
    // 本批第 2 次写入失败（已确认 1 条成功、剩余 3 条待重试）
    boundary.failNthEvidenceCreate(boundary.evidenceCreateCount() + 2);
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('导入所选到当前项目（4）')).click()`);
    try {
      await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.p32-search .p19-error-text')].some((el) => el.innerText.includes('在线导入未全部完成（已确认 1 条成功）：剩余 3 条尚未导入'))`), { label: 'partial failure error with exact counts' });
    } catch (error) {
      const diagnostic = await cdp.evaluate(`({
        errors: [...document.querySelectorAll('.p19-error-text')].map((el) => el.innerText),
        notices: [...document.querySelectorAll('.p22-message')].map((el) => el.innerText),
        selectionText: [...document.querySelectorAll('button')].map((b) => b.textContent).filter((t) => t.includes('导入所选')).join(' | '),
        evidenceCards: document.querySelectorAll('.p32-evidence-card').length,
        bodySnippet: document.body.innerText.slice(0, 800),
      })`);
      const lastCommands = boundary.requests.slice(-6).map((req) => ({ fn: req.fn, command: req.command, action: req.action }));
      throw new Error(`${error.message}; browser=${JSON.stringify(diagnostic)}; evidenceCreateTotal=${boundary.evidenceCreateCount()}; lastRequests=${JSON.stringify(lastCommands)}`);
    }
    const partialState = await cdp.evaluate(`({
      evidenceCount: document.querySelectorAll('.p32-evidence-card').length,
      fullSuccessNotice: document.body.innerText.includes('已导入 4 条搜索结果到当前项目') || document.body.innerText.includes('已导入 5 条搜索结果到当前项目'),
      importedMarker3: (() => {
        const card = [...document.querySelectorAll('.p32-search-card')].find((c) => c.innerText.includes('热门帖子 3'));
        return Boolean(card && card.innerText.includes('已导入 ✓'));
      })(),
      selectionKept: document.body.innerText.includes('导入所选到当前项目（4）'),
    })`);
    assert.equal(partialState.evidenceCount, 3, '部分失败后权威状态只含已确认的 3 条证据（前 2 条 + 本批 1 条）');
    assert.equal(partialState.fullSuccessNotice, false, '部分失败绝不展示全成功提示');
    assert.equal(partialState.importedMarker3, true, '已确认成功的帖子 3 应显示已导入标记');
    assert.equal(partialState.selectionKept, true, '选择应保留以便安全重试');

    // 9c) 同一选择幂等重试：只写入剩余 3 条，不产生重复 Evidence，最终完整导入
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('导入所选到当前项目（4）')).click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('已导入 3 条搜索结果到当前项目')`), { label: 'idempotent retry completed' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length === 6`), { label: 'all six imported' });
    const retriedState = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.p32-search-card')];
      return {
        allImported: ${JSON.stringify(partialSelection)}.every((label) => {
          const card = cards.find((c) => c.innerText.includes(label));
          return Boolean(card && card.innerText.includes('已导入 ✓') && card.querySelector('input[type="checkbox"]').disabled);
        }),
        partialErrorGone: !document.body.innerText.includes('在线导入未全部完成'),
      };
    })()`);
    // 证据总数恰好 = 6 条 fixture（mock 服务端按证据身份幂等，重试绝不产生重复记录）
    const mockProject = [...boundary.projects.values()][0];
    const mockEvidenceIds = mockProject.evidence.map((record) => record.id);
    assert.equal(mockEvidenceIds.length, 6, '重试后服务端证据恰好 6 条，绝不重复');
    assert.equal(new Set(mockEvidenceIds).size, 6, '服务端证据身份全部唯一');
    assert.equal(retriedState.allImported, true, '重试后全部 4 条都显示已导入并禁用勾选');
    assert.equal(retriedState.partialErrorGone, true, '重试完成后部分失败错误应消失');

    // 10) 搜索失败 → 精确错误态
    // 版本递增会确定性重挂载面板并清空关键词输入：重新输入关键词是真实页面控制流。
    boundary.failNextSearch();
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p32-search-query-row input[aria-label="热门主题搜索关键词"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AI 营销 出海');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((b) => b.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.p32-search .p19-error-text')].some((el) => el.innerText.includes('没有返回可验证的公开内容'))`), { label: 'search failure error state' });

    // 11) 项目切换隔离：先在项目 A 重新搜索（产生瞬态结果），再切换到项目 B，
    //     切换后搜索结果与选择必须立即清空。
    const project2Id = `prj-${sha256('p32b-second-project').slice(0, 24)}`;
    const project2 = makeProject({ topic: '项目 B', objective: 'B', audience: 'B', channel: 'B' }, project2Id);
    boundary.projects.set(project2Id, project2);
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'reload with second project' });
    await delay(400);
    // 重新搜索 → 结果重新出现
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p32-search-query-row input[aria-label="热门主题搜索关键词"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AI 营销 出海');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p32-search-query-row button')].find((b) => b.textContent.includes('搜索公开帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-search-card').length >= 5`), { label: 'search results re-rendered' });
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.p19-project-select select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(project2Id)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`(() => {
      const select = document.querySelector('.p19-project-select select');
      return select && select.value === ${JSON.stringify(project2Id)}
        && document.querySelectorAll('.p32-search-card').length === 0
        && !document.body.innerText.includes('批次 p32-search-');
    })()`), { label: 'switched to project B with cleared search state' });
    const clearedAfterSwitch = await cdp.evaluate(`document.querySelectorAll('.p32-search-card').length === 0 && !document.body.innerText.includes('批次 p32-search-')`);
    assert.equal(clearedAfterSwitch, true, '切换项目必须清空瞬态搜索结果与选择');

    // 12) 刷新恢复：搜索状态不跨刷新，已导入证据仍来自服务端
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'reload restore' });
    await delay(400);
    const afterRefresh = await cdp.evaluate(`({
      searchCards: document.querySelectorAll('.p32-search-card').length,
      hasBatchLine: document.body.innerText.includes('批次 p32-search-'),
    })`);
    assert.equal(afterRefresh.searchCards, 0, '刷新后瞬态搜索结果必须清空');
    assert.equal(afterRefresh.hasBatchLine, false, '刷新后不得残留旧搜索批次');
    // 切回项目 A，证据仍来自服务端
    await cdp.evaluate(`(() => {
      const select = document.querySelector('.p19-project-select select');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(projectId)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length >= 2`), { label: 'evidence restored from server' });

    // 13) P32-A 回归：Qwen 重新分析入口可见且可操作（追加版本，旧版保留）
    const reanalyzeButtons = await cdp.evaluate(`[...document.querySelectorAll('button')].filter((b) => b.textContent.includes('用 Qwen 重新分析')).length`);
    assert.ok(reanalyzeButtons >= 1, 'Qwen 重新分析入口应可见');
    const reanalyze = (label) => cdp.evaluate(`(() => {
      const card = [...document.querySelectorAll('.p32-evidence-card')].find((c) => c.innerText.includes(${JSON.stringify(label)}));
      const button = card && [...card.querySelectorAll('button')].find((b) => b.textContent.includes('用 Qwen 重新分析'));
      if (button) button.click();
      return Boolean(button);
    })()`);
    assert.equal(await reanalyze('热门帖子 1'), true, '热门帖子 1 应有重新分析按钮');
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('Qwen 重新分析完成（第 1 个版本已追加')`), { label: 'reanalysis v1 completed' });
    assert.equal(await reanalyze('热门帖子 1'), true, '第二次重新分析仍可用');
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('Qwen 重新分析完成（第 2 个版本已追加')`), { label: 'reanalysis v2 appended' });
    const versionHistory = await cdp.evaluate(`document.body.innerText.includes('2 个版本') && [...document.querySelectorAll('button')].some((b) => b.textContent.includes('查看 2 个版本'))`);
    assert.equal(versionHistory, true, '应显示 2 个分析版本并可见版本历史入口');
    // 热门帖子 2 也重新分析一次，供多帖比较使用
    assert.equal(await reanalyze('热门帖子 2'), true, '热门帖子 2 应有重新分析按钮');
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('Qwen 重新分析完成（第 1 个版本已追加')`), { label: 'reanalysis post-2 completed' });

    // 14) P32-A 回归：多帖比较入口可见且可操作（P36 中位于「分析」目的地的高级工具区）
    await cdp.evaluate(`[...document.querySelectorAll('[data-destination-tab="analyze"]')][0].click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination' });
    await cdp.evaluate(`[...document.querySelectorAll('.p36-advanced summary')].find((s) => s.textContent.includes('多帖比较')).click()`);
    await delay(200);
    await cdp.evaluate(`(() => {
      const chips = [...document.querySelectorAll('.p32-compare-chip input[type="checkbox"]')].slice(0, 2);
      chips.forEach((chip) => chip.click());
    })()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p32-compare-results'))`), { label: 'comparison results rendered' });
    const compareVisible = await cdp.evaluate(`document.body.innerText.includes('多帖比较') && Boolean(document.querySelector('.p32-compare-results'))`);
    assert.equal(compareVisible, true, '多帖比较应可见且可操作');

    // 15) P22 回归：单帖 URL 读取仍可用（P36 中位于「采集」目的地）
    await cdp.evaluate(`[...document.querySelectorAll('[data-destination-tab="collect"]')][0].click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'collect'`), { label: 'collect destination' });
    const urlInput = await cdp.evaluate(`Boolean([...document.querySelectorAll('input[aria-label="帖子链接或研究主题"]')].length > 0)`);
    assert.equal(urlInput, true, '单帖 URL 读取输入应存在');
    await cdp.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="帖子链接或研究主题"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://x.com/user/status/1900000000000001001');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('读取这条帖子'))`), { label: 'url read button' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('读取这条帖子')).click()`);
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('.p22-source-card')].length > 0`), { label: 'single post preview rendered' });
    await cdp.evaluate(`[...document.querySelectorAll('.p22-source-card button')].find((b) => b.textContent.trim() === '保存证据').click()`);
    try {
      await waitFor(() => cdp.evaluate(`document.body.innerText.includes('来源证据已保存。下一步可分析帖子/视频')`), { label: 'single post evidence saved' });
    } catch (error) {
      const diagnostic = await cdp.evaluate(`({
        banners: [...document.querySelectorAll('.p19-error-banner, .p19-notice-banner')].map((el) => el.innerText),
        p22Panel: (document.querySelector('.p22-assist') || { innerText: '(missing)' }).innerText.slice(0, 600),
        evidenceCards: document.querySelectorAll('.p32-evidence-card').length,
        bodySnippet: document.body.innerText.slice(0, 500),
      })`);
      const lastCommands = boundary.requests.slice(-10).map((req) => ({ fn: req.fn, command: req.command, action: req.action }));
      throw new Error(`${error.message}; browser=${JSON.stringify(diagnostic)}; lastRequests=${JSON.stringify(lastCommands)}`);
    }

    // 16) 执行标志恒 false + 无横向溢出 + 页面健康
    const health = await cdp.evaluate(`(() => {
      const project = ${JSON.stringify(projectId)};
      return {
        noOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        flagText: document.body.innerText.includes('四项均为 false'),
        errorBoundary: Boolean(document.querySelector('[data-react-error]')),
        hasContent: document.body.innerText.length > 200,
      };
    })()`);
    assert.equal(health.noOverflow, true, '生产构建页面不应有横向溢出');
    assert.equal(health.flagText, true, '执行标志应显示四项 false');
    assert.equal(health.errorBoundary, false, '不应出现 React 错误边界');
    assert.equal(health.hasContent, true, '页面应有内容');
    const flags = boundary.projects.get(projectId).execution_flags;
    assert.deepEqual(flags, {
      generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false,
    }, '执行标志必须保持严格 false');

    // 17) 网络证据：确切的搜索/导入/分析请求都经由 mock 边界发生
    const searchCalls = boundary.requests.filter((item) => item.fn === 'p22' && item.action === 'search');
    assert.ok(searchCalls.length >= 2, '应至少发起 2 次搜索');
    for (const call of searchCalls) {
      assert.equal(call.body.sort, 'latest');
      assert.ok(Number(call.body.count) >= 1 && Number(call.body.count) <= 20, 'count 必须在 1–20');
      assert.equal(call.body.action, 'search');
    }
    const commandEvidenceCreates = boundary.requests.filter((item) => item.fn === 'command' && item.command === 'evidence.create');
    assert.ok(commandEvidenceCreates.length >= 3, '导入 + 单帖保存都应创建证据');
  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(preview);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p32b-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
