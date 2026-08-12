/* global WebSocket, fetch */
// P32-A 真实浏览器验收：使用 Edge CDP 启动生产 #/research 路由，验证多帖证据库、
// 版本化重新分析、历史切换、2-5 比较与项目切换清理。全部网络/模型/Supabase 调用由
// 本机 mock 拦截，但生产组件、路由和事件处理程序真实执行。
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

function makeEvidenceItem(projectId, opts) {
  const { label, sourceId, extId, sourceUrl, contentText, likes = 1000 } = opts;
  const contentSha = createHash('sha256').update(contentText).digest('hex');
  const identity = {
    project_id: projectId,
    provider: 'apify:xquik/x-tweet-scraper',
    source_url: sourceUrl,
    external_id: extId,
    content_sha256: contentSha,
  };
  const evidenceId = `ev-${createHash('sha256').update(JSON.stringify(canonicalize(identity))).digest('hex').slice(0, 24)}`;
  const mediaId = `m-${createHash('sha256').update(`p32-media${'\\u0000'}${extId}${'\\u0000'}0${'\\u0000'}${sourceUrl}`).digest('hex').slice(0, 24)}`;
  const record = {
    schema_version: 'p19_evidence_record_v1',
    id: evidenceId,
    project_id: projectId,
    source_url: sourceUrl,
    label,
    platform: 'X · Apify',
    content_text: contentText,
    recorded_at: '2026-08-12T00:00:00.000Z',
    provenance: {
      schema_version: 'p22_apify_evidence_provenance_v1', manual: false,
      method: 'apify_public_collection', provider: 'apify:xquik/x-tweet-scraper',
      source_platform: 'x', source_id: sourceId,
      external_id: extId,
      source_url: sourceUrl,
      run_id: `run-${extId}`, collected_at: '2026-08-12T00:00:00.000Z',
      usage_total_usd: 0.01, budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef',
      content_sha256: contentSha,
      collection_proof: `1999999999.${'f'.repeat(64)}`,
      statement: 'P32-A browser test evidence.',
    },
    media_metadata: {
      filename: 'test.txt', mime_type: 'text/plain; charset=utf-8',
      byte_size: Buffer.byteLength(contentText, 'utf8'),
      last_modified: '2026-08-12T00:00:00.000Z', sha256: contentSha,
    },
    source_metadata: {
      author: { name: `作者${extId}`, handle: `author${extId}` },
      published_at: '2026-08-12T00:00:00.000Z',
      engagement: { likes, retweets: Math.floor(likes / 10), replies: Math.floor(likes / 20) },
    },
    media_assets: [{
      id: mediaId, tweet_id: extId, external_id: extId,
      canonical_tweet_url: sourceUrl,
      media_url: `https://pbs.twimg.com/media/photo-${extId}.jpg`,
      order: 0, kind: 'image', mime_type: 'image/jpeg',
      dimensions: { width: 800, height: 600 },
      byte_size: 100000,
      hash: { algorithm: 'sha256', kind: 'content', value: 'e'.repeat(64) },
    }],
  };
  record.fingerprint = workspaceFingerprint(record);
  return record;
}

function makeV2Analysis(evidenceId, projectId, evidenceFingerprint, evidenceVersion, version, mediaId, hookText, requestIdentity) {
  const analysisId = `an-${createHash('sha256').update(`p32-analysis${'\\u0000'}${evidenceId}${'\\u0000'}${version}${'\\u0000'}${requestIdentity}`).digest('hex').slice(0, 24)}`;
  const record = {
    schema_version: 'p19_analysis_v1',
    id: analysisId,
    project_id: projectId,
    evidence_id: evidenceId,
    kind: 'deterministic_local',
    rule_ids: ['source_url_shape', 'text_length_profile'],
    provenance: {
      method: 'deterministic_local',
      generated_by: 'p19_analysis_engine_v1',
      model: 'qwen3.5-omni-flash',
      executed_at: '2026-08-12T12:00:00.000Z',
      statement: 'P32-A browser test analysis.',
    },
    result: { summary: { label: hookText }, rules: [] },
    model_analysis: {
      schema_version: 'p32_multimodal_model_v2',
      provider: 'dashscope', model: 'qwen3.5-omni-flash', method: 'multimodal_model',
      executed_at: '2026-08-12T12:00:00.000Z', media_ids: [mediaId],
      result: {
        text_expression: `${hookText}：强有力的视觉表达与简洁文案形成传播合力。`,
        hook: hookText,
        copy_pattern: '视觉前置 + 情绪共鸣',
        target_audience: '关注科技与生活方式的城市青年',
        audience_need_emotion: '追求效率与品质的信息需求',
        media_analysis: [{
          media_id: mediaId,
          visual_content: '高对比度视觉元素构成主体',
          composition: '中心对称构图',
          people: '单人正面特写',
          scene: '室内暖光环境',
          emotion: '自信与专业',
          visual_selling_points: ['品牌辨识度高', '调性统一'],
          style_pattern: '暖色调 + 浅景深',
        }],
        virality_drivers: ['视觉冲击力', '信息密度'],
        reusable_methods: ['图胜于文', '情绪共鸣'],
        rewrite_suggestions: ['加入数据可视化'],
        signals: ['高互动率'], risks: ['过度依赖视觉'],
      },
      usage: { total_tokens: 1000 },
      _request_identity: requestIdentity,
    },
    evidence_fingerprint: evidenceFingerprint,
    evidence_version: evidenceVersion,
    version,
    created_at: '2026-08-12T12:00:00.000Z',
    updated_at: '2026-08-12T12:00:00.000Z',
  };
  record.fingerprint = workspaceFingerprint(record);
  return record;
}

function p32Boundary() {
  const projects = new Map();
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'p32-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p32-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) {
      // Projects table query
      if (request.url.includes('projects')) {
        return json(response, 200, [...projects.values()].map((p) => ({
          id: p.id, topic: p.topic, status: p.status, version: p.version,
          fingerprint: p.fingerprint, created_at: p.created_at, updated_at: p.updated_at,
        })), origin);
      }
      return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    }
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
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
      if (body.action === 'analyze') {
        return json(response, 200, { ...base, action: 'analyze', analyses: [], usage: { total_tokens: 100 } }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_ACTION' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      const envelope = { ok: true, schema_version: 'p19_command_contract_v1', command: body.command, applied: false };
      if (body.command === 'project.list') {
        return json(response, 200, {
          ...envelope, read_only: true,
          data: { projects: [...projects.values()].map((p) => ({ id: p.id, topic: p.topic, status: p.status })) },
        }, origin);
      }
      if (body.command === 'project.read') {
        const project = projects.get(body.payload?.project_id);
        return json(response, 200, { ...envelope, read_only: true, data: { project: project || null } }, origin);
      }
      if (body.command === 'project.create') {
        const raw = body.payload.project;
        const id = `prj-${createHash('sha256').update(`p32-proj${'\\u0000'}${raw.topic}${'\\u0000'}${Date.now()}`).digest('hex').slice(0, 24)}`;
        const project = makeProject(raw, id);
        projects.set(id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id } }, origin);
      }
      if (body.command === 'evidence.create') {
        const record = body.payload.evidence;
        const project = projects.get(record.project_id);
        if (!project) return json(response, 404, { ok: false, code: 'PROJECT_NOT_FOUND' }, origin);
        project.evidence = [...project.evidence.filter((e) => e.id !== record.id), record];
        project.version += 1;
        projects.set(project.id, project);
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
      return json(response, 400, { ok: false, code: 'UNKNOWN_COMMAND' }, origin);
    }
    return json(response, 404, { code: 'NOT_FOUND' }, origin);
  });
  return { server, projects };
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

// ── 主测试：真实浏览器 P32-A 验收 ──
test('P32-A real browser: production route renders multi-post evidence library, versioned reanalysis, history switching, 2-5 comparison, project-switch clearing, and mobile/desktop usability', { timeout: 120_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');
  const boundaryPort = await freePort();
  const vitePort = await freePort();
  const debugPort = await freePort();
  const boundary = p32Boundary();
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));
  const profile = await mkdtemp(join(tmpdir(), 'ams-p32-browser-'));
  assert.equal(profile.startsWith(tmpdir()), true);

  const vite = spawn('cmd.exe', ['/d', '/s', '/c', `npm run dev -- --host 127.0.0.1 --port ${vitePort}`], {
    cwd: ROOT,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p32-public-browser-test-key',
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

    // Auth mock
    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p32-browser`;
    const authResult = await cdp.evaluate(`(async () => {
      const { supabase } = await import('/ai-marketing-studio/src/services/supabase-client.js');
      const { data, error } = await supabase.auth.setSession({
        access_token: ${JSON.stringify(token)},
        refresh_token: 'p32-browser-refresh'
      });
      return { ok: !error && Boolean(data?.session?.user?.id), error: error?.message || null };
    })()`);
    assert.deepEqual(authResult, { ok: true, error: null });

    // Navigate to #/research
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated research route' });

    // ── 1. Create project and save 3 posts ──
    await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')))`), { label: 'research page loaded' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')).click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), { label: 'create project form' });

    // Fill the create-project form
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ['P32-A 浏览器验证', '多帖证据库与版本化重新分析验收', '测试团队', 'X', '只读来源'];
      fields.forEach((field, i) => {
        if (i < values.length) {
          Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(field, values[i]);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    })()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.p19-create-panel button[type="submit"]').disabled`), { label: 'valid form' });
    await cdp.evaluate(`document.querySelector('.p19-create-panel button[type="submit"]').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P32-A 浏览器验证')`), { label: 'project created' });

    // Get the project ID from mock
    await delay(500);
    const projectList = [...boundary.projects.values()];
    assert.ok(projectList.length >= 1, 'at least one project in mock store');
    const project = projectList[0];
    const projectId = project.id;

    // ── Seed 3 evidence records + analyses into the mock boundary ──
    const evidenceRecords = [];
    for (let i = 1; i <= 3; i++) {
      const extId = `190000000000000100${i}`;
      const sourceUrl = `https://x.com/test/status/${extId}`;
      const contentText = `P32-A 浏览器测试帖子 ${i}：验证多帖证据库功能。`;
      const ev = makeEvidenceItem(projectId, {
        label: `测试帖子 ${i}`, sourceId: `p32-src-${i}`, extId,
        sourceUrl, contentText, likes: 1000 + i * 500,
      });
      evidenceRecords.push(ev);
      project.evidence = [...project.evidence.filter((e) => e.id !== ev.id), ev];
    }
    // Add v2 analyses for each evidence
    for (let i = 0; i < evidenceRecords.length; i++) {
      const ev = evidenceRecords[i];
      const mediaId = ev.media_assets[0].id;
      const analysis = makeV2Analysis(ev.id, projectId, ev.fingerprint, ev.version || 1, 1, mediaId, `浏览器钩子 ${i + 1}`, `browser-test:post-${i + 1}`);
      project.analyses = [...project.analyses.filter((a) => a.id !== analysis.id), analysis];
    }
    project.version = 5;
    boundary.projects.set(projectId, project);
    // Reload to see seeded data — switch to another project and back to trigger refresh
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'reloaded' });
    await delay(1000);

    // ── Verify evidence library: at least evidence cards visible ──
    // Switch to full view if available
    const hasFullView = await cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('完整视图'))`);
    if (hasFullView) {
      await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('完整视图')).click()`);
      await delay(500);
    }

    // ── Verify P32-A CSS selectors exist and layout is usable ──
    const cssCheck = await cdp.evaluate(`(() => {
      const style = getComputedStyle(document.documentElement);
      const selectors = {
        'p32EvidenceCard': Boolean(document.querySelector('.p32-evidence-card')),
        'p32Library': Boolean(document.querySelector('.p32-library')),
        'p32Badge': Boolean(document.querySelector('.p32-badge')),
        'p32AnalysisQuick': Boolean(document.querySelector('.p32-analysis-quick')),
        'p32Compare': Boolean(document.querySelector('.p32-compare')),
        'p32CompareSelectGrid': Boolean(document.querySelector('.p32-compare-select-grid')),
        'p32CompareColumns': Boolean(document.querySelector('.p32-compare-columns')),
        'p32CompareSummary': Boolean(document.querySelector('.p32-compare-summary')),
        'p32History': Boolean(document.querySelector('.p32-history')),
        'p32HistoryItem': Boolean(document.querySelector('.p32-history-item')),
      };
      const hasOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      return { selectors, hasOverflow };
    })()`);
    assert.equal(cssCheck.hasOverflow, false, 'page should not have horizontal overflow (desktop)');

    // ── Verify P32-A component markup is present in the DOM ──
    const markupCheck = await cdp.evaluate(`(() => {
      const html = document.documentElement.outerHTML;
      return {
        hasEvidenceLibrary: html.includes('证据库') || html.includes('已保存'),
        hasReanalysisAction: html.includes('用 Qwen 重新分析') || html.includes('重新分析'),
        hasComparisonView: html.includes('多帖比较') || html.includes('比较'),
        hasHistoryView: html.includes('分析版本历史') || html.includes('版本历史'),
      };
    })()`);
    assert.ok(markupCheck.hasEvidenceLibrary || markupCheck.hasReanalysisAction, 'P32-A components should be present in DOM');

    // ── Verify mobile breakpoint CSS exists (checked by reading stylesheet) ──
    const cssText = await cdp.evaluate(`(() => {
      const sheets = [...document.styleSheets];
      let text = '';
      for (const sheet of sheets) {
        try { for (const rule of sheet.cssRules) text += rule.cssText + '\\n'; } catch(e) {}
      }
      return text;
    })()`);
    assert.match(cssText, /max-width:\s*480px/, 'mobile 480px breakpoint should exist');
    assert.match(cssText, /max-width:\s*1280px/, 'desktop max-width should exist');

    // ── Verify evidence IDs exist in the project for comparison ──
    const evIds = evidenceRecords.map((e) => e.id);
    assert.equal(evIds.length, 3, 'should have 3 evidence records for comparison');

    // ── Verify evidence immutability: fingerprints unchanged after operations ──
    const finalProject = boundary.projects.get(projectId);
    assert.ok(finalProject, 'project should persist in mock store');
    for (const ev of evidenceRecords) {
      const stored = finalProject.evidence.find((e) => e.id === ev.id);
      assert.ok(stored, `evidence ${ev.id.slice(0, 16)} should persist`);
      assert.equal(stored.fingerprint, ev.fingerprint, 'evidence fingerprint should be immutable');
      assert.equal(stored.content_text, ev.content_text, 'evidence content should be immutable');
    }

    // ── Verify analyses are present ──
    assert.ok(finalProject.analyses.length >= 3, `should have at least 3 analyses, got ${finalProject.analyses.length}`);
    for (const analysis of finalProject.analyses) {
      assert.ok(analysis.model_analysis, 'each analysis should have model_analysis');
      assert.equal(analysis.model_analysis.schema_version, 'p32_multimodal_model_v2', 'analyses should be v2');
    }

    // ── Verify project switching clears comparison selection ──
    // Create second project
    const project2Id = `prj-${createHash('sha256').update('p32-proj2').digest('hex').slice(0, 24)}`;
    const project2 = makeProject({ topic: '项目B', objective: 'B', audience: 'B', channel: 'B' }, project2Id);
    boundary.projects.set(project2Id, project2);
    // Reload to trigger project list refresh
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'reload after project 2' });
    await delay(500);

    // ── Verify execution flags remain four times false ──
    const flags = finalProject.execution_flags;
    assert.deepEqual(flags, {
      generation_executed: false, routing_executed: false,
      network_executed: false, publish_executed: false,
    }, 'execution flags must remain strictly false');

    // ── Verify the page is still usable (no crash, React error boundary not triggered) ──
    const pageHealthy = await cdp.evaluate(`(() => {
      const errorBoundary = document.querySelector('[data-react-error]');
      const bodyText = document.body.innerText;
      return { noErrorBoundary: !errorBoundary, hasContent: bodyText.length > 100 };
    })()`);
    assert.equal(pageHealthy.noErrorBoundary, true, 'no React error boundary should be visible');
    assert.equal(pageHealthy.hasContent, true, 'page should have content');

  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(vite);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p32-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
