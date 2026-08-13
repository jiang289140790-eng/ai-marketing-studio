/* global WebSocket, fetch */
// P36 研究工作台渐进式交互重设计验收。
//
// 确定性部分（无浏览器）：源码契约 —— 四个目的地（采集/分析/创作/产物）条件渲染
// 同一时刻只有一个进入 DOM；高级工具位于 <details> 渐进披露（折叠不消耗布局）；
// 每个状态有且只有一个主操作；「追加新版分析」等重跑操作位于版本/历史菜单；
// 分析结果暴露逐媒体字段；知识卡详情完整渲染媒体分析与溯源；项目切换隔离契约；
// 所有权守卫。
//
// 浏览器部分（Edge CDP + 生产构建）：桌面 1440×900 / 平板 1024×768 / 手机
// 390×844 三档视口验证无横向溢出、无巨大空列；主路径 项目 → 来源 → 完整已保存
// 分析详情 → 知识卡完整详情 → 相似草稿编辑器 → 保存草稿；逐媒体字段、重跑为次级、
// 单主操作、键盘导航、项目切换隔离；截图输出到临时证据目录（不在业务文件内）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO_ROOT = join(import.meta.dirname, '..');
const DIST = join(REPO_ROOT, 'dist');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const AUTH_STORAGE_KEY = 'ai-marketing-studio-auth-session';
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const OWNED_PATHS = new Set([
  // P36 本里程碑授权路径。
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/components/integrated-workspace/P19WorkbenchPanels.jsx',
  'src/components/integrated-workspace/P22ResearchAssistPanel.jsx',
  'src/components/integrated-workspace/P36ResearchDestinations.jsx',
  'test/research-workspace.test.mjs',
  'test/research-live-data.test.mjs',
  'test/p21-guided-research.test.mjs',
  'test/p22-assisted-research.test.mjs',
  'test/p23-link-evidence-knowledge.test.mjs',
  'test/p29-multimodal-x-evidence.browser.test.mjs',
  'test/p32-hot-topic-search.browser.test.mjs',
  'test/p32-reddit-topic-search.browser.test.mjs',
  'test/p32-multipost-synthesis-brief.browser.test.mjs',
  'test/p20-browser-online.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
  // 所有权守卫清单必须同步跟踪 P36 授权路径。
  'test/p17c-staging-preview.test.mjs',
  'test/online-integrated-preview.test.mjs',
]);

function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

test('P37 analysis trust labels and knowledge-card navigation fail closed', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  assert.ok(dest.includes('基础检测（未理解视频画面/声音）'));
  assert.ok(dest.includes('不能作为全面的视频分析'));
  assert.ok(dest.includes('Qwen 多模态分析'));
  assert.match(dest, /card\.analysis_id === latest\.id[\s\S]*card\.analysis_fingerprint === latest\.fingerprint[\s\S]*card\.analysis_version === latest\.version/);
  assert.match(dest, /cardForLatest \? onViewCard\(cardForLatest\.id\) : onMakeCard\(latest\.id\)/);
  assert.match(dest, /setSelectedCardId\(cardId\)[\s\S]*setOutputSection\('cards'\)[\s\S]*setDestination\(P36_DESTINATIONS\.OUTPUTS\)/);
});

function delay(ms) { return sleep(ms); }

// ---- 确定性源码契约 ------------------------------------------------------------

test('P36 四个目的地：同一时刻只有一个目的地渲染进 DOM，主操作每状态唯一', () => {
  const page = readSource('src/pages/ResearchWorkspacePage.jsx');
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 四个目的地条件渲染（同一时刻只有一个 destination 分支执行）。
  assert.match(dest, /destination === P36_DESTINATIONS\.COLLECT &&/);
  assert.match(dest, /destination === P36_DESTINATIONS\.ANALYZE &&/);
  assert.match(dest, /destination === P36_DESTINATIONS\.CREATE &&/);
  assert.match(dest, /destination === P36_DESTINATIONS\.OUTPUTS &&/);
  assert.ok(dest.includes('data-active-destination={destination}'), '容器必须暴露当前目的地');
  // 目的地标签为四个通俗名称，不含里程碑编号。
  assert.ok(dest.includes("label: '采集'"));
  assert.ok(dest.includes("label: '分析'"));
  assert.ok(dest.includes("label: '创作'"));
  assert.ok(dest.includes("label: '产物'"));
  // 页面以 key={project.id} 挂载目的地容器（切换项目整棵重挂载 → 瞬态状态清零）。
  assert.match(page, /<P36Destinations\s+key=\{project\.id\}/);
  // 采集面板：一个显著输入 + 一个主按钮（p36-hero 唯一）。
  const collect = readSource('src/components/integrated-workspace/P22ResearchAssistPanel.jsx');
  assert.match(collect, /aria-label="帖子链接或研究主题"/);
  assert.ok((collect.match(/p36-hero/g) || []).length === 1, '采集目的地必须只有一个主按钮');
  // 分析目的地：每个状态主按钮唯一（.p36-cta-primary 只出现在分支里）。
  assert.ok((dest.match(/p36-cta-primary/g) || []).length >= 3, '分析/创作必须带主操作标记');
  assert.ok((dest.match(/className="p19-btn p19-btn-primary p36-cta-primary"/g) || []).length >= 3, '主操作按钮样式必须显式标记');
});

test('P36 高级工具渐进披露：<details> 折叠，不消耗布局空间', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 热门主题搜索 / 手工录入在「采集」的 details 中；全部分析记录 / 多帖比较在「分析」的 details 中。
  assert.ok((dest.match(/<details className="p36-advanced">/g) || []).length === 2, '两个高级工具区都必须在 details 中');
  assert.match(dest, /<P32HotTopicSearchPanel[\s\S]*?\/>/);
  assert.match(dest, /<P19EvidenceList[\s\S]*?\/>/);
  assert.match(dest, /<P32ComparisonView[\s\S]*?\/>/);
  assert.match(dest, /<P19AnalysisList[\s\S]*?\/>/);
  // 版本与历史菜单同样是 details（重跑操作在次级菜单内，不是主操作）。
  assert.match(dest, /<details className="p36-version-menu">/);
  assert.ok(dest.includes('追加新版分析'), '追加新版分析必须在版本菜单中存在');
  assert.ok(dest.includes('运行确定性分析'), '确定性本地分析作为次级手动工具保留');
});

test('P36 分析结果暴露逐媒体字段；知识卡详情完整渲染媒体分析与溯源', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 逐媒体/视频发现：每行按 media_id 渲染 visual_content/composition/people/scene/emotion/卖点/风格。
  assert.match(dest, /逐媒体 \/ 视频发现/);
  assert.match(dest, /data-media-id=\{row\.media_id\}/);
  for (const field of ['visual_content', 'composition', 'people', 'scene', 'emotion', 'visual_selling_points', 'style_pattern']) {
    assert.ok(dest.includes(field), `分析结果必须渲染逐媒体字段 ${field}`);
  }
  for (const field of ['text_expression', 'copy_pattern', 'target_audience', 'audience_need_emotion', 'virality_drivers', 'reusable_methods', 'rewrite_suggestions', 'signals', 'risks']) {
    assert.ok(dest.includes(field), `分析结果必须渲染 ${field}`);
  }
  // 知识卡详情：媒体时间线/视觉证据、视觉影响、语义层、情绪基调、受众响应、
  // 可复用特征、风险标签、证据链接、生成指导、不确定性、模型/媒体 ID 溯源。
  for (const needle of [
    '媒体时间线 / 视觉证据', 'visual_evidence', 'audio_evidence', '视觉影响', 'visual_impact',
    '语义层', 'semantic_layers', '情绪基调', 'seductive_tone', '受众响应机制', 'audience_response_mechanisms',
    '可复用特征', 'replicable_features', '风险标签', 'risk_labels', '证据链接', 'evidence_links',
    '生成指导', 'must_preserve', 'must_not_invent', '不确定性', 'uncertainties',
    '来源与技术信息', 'analysis_provenance', 'media_ids', '分析指纹', 'analysis_fingerprint',
  ]) {
    assert.ok(dest.includes(needle), `知识卡详情必须渲染 ${needle}`);
  }
});

test('P36 重跑为次级操作：保存为主操作，追加新版/重新生成不竞争主按钮', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 未保存预览 → 主按钮「保存分析结果」；版本菜单在 details 内。
  assert.match(dest, /'保存分析结果'/);
  assert.ok(dest.indexOf('保存分析结果') < dest.indexOf('追加新版分析'), '保存必须是主操作，追加新版在菜单内');
  // 创作：生成与保存分别为主操作，重新生成为次级。
  assert.match(dest, /'根据分析生成相似帖子'/);
  assert.match(dest, /'保存相似帖子草稿'/);
  assert.match(dest, />\s*重新生成\s*</);
  // 已保存多模态 → 主按钮「去创作」（不静默改绑新分析）。
  assert.match(dest, />\s*去创作\s*</);
});

test('P36 建议步骤映射与键盘导航契约', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 建议步骤 → 目的地映射（P21 引导逻辑保留，仅呈现层重设计）。
  assert.match(dest, /if \(stepId === 'analysis' \|\| stepId === 'card'\) return P36_DESTINATIONS\.ANALYZE/);
  assert.match(dest, /if \(stepId === 'brief' \|\| stepId === 'review' \|\| stepId === 'handoff' \|\| stepId === 'lineage'\) return P36_DESTINATIONS\.OUTPUTS/);
  assert.match(dest, /return P36_DESTINATIONS\.COLLECT;/);
  // 键盘可达的目的地导航（tablist + 方向键 + 焦点移动）。
  assert.match(dest, /role: 'tablist'/);
  assert.match(dest, /'aria-label': '工作台目的地'/);
  assert.match(dest, /onKeyDown: handleDestinationKeyDown/);
  assert.match(dest, /ArrowRight/);
  assert.match(dest, /ArrowLeft/);
  assert.match(dest, /aria-selected=\{destination === meta\.id\}/);
  assert.match(dest, /data-destination-tab=\{meta\.id\}/);
  assert.match(dest, /order\.length\) % order\.length/, '方向键必须循环切换');
});

test('P36 项目切换隔离：页面级瞬态状态在 activeId 变化时清空，目的地容器按项目重挂载', () => {
  const page = readSource('src/pages/ResearchWorkspacePage.jsx');
  // 页面级瞬态状态：热门搜索批次、综合结果、比较选择、草稿记录全部在切换项目时清空。
  assert.match(page, /setHotSearchState\(null\)/);
  assert.match(page, /setSynthesisOutcome\(null\)/);
  assert.match(page, /setComparedEvidenceIds\(\[\]\)/);
  assert.match(page, /setSavedDrafts\(\[\]\)/);
  // 草稿记录绑定项目/来源/分析身份，产物页按 projectId 过滤。
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  assert.match(dest, /savedDrafts\.filter\(\(draft\) => draft\.projectId === project\.id\)/);
  // 分析预览与草稿在渲染时按证据/分析版本与指纹校验，过时即失效。
  assert.match(dest, /preview\.evidenceVersion === selected\.version && preview\.evidenceFingerprint === selected\.fingerprint/);
  assert.match(dest, /draft\.evidence_fingerprint === selectedEvidence\.fingerprint/);
  assert.match(dest, /draft\.analysis_fingerprint === selected\.fingerprint/);
  // 草稿保存的绑定校验仍然存在（fail closed）。
  assert.match(page, /DRAFT_SOURCE_BINDING_MISMATCH/);
  // 归档只读门禁保留。
  assert.match(page, /status === 'archived' && !options\.allowArchived/);
});

test('P36 知识卡详情按持久化绑定渲染（证据/分析/版本/指纹不散落为默认可见技术项）', () => {
  const dest = readSource('src/components/integrated-workspace/P36ResearchDestinations.jsx');
  // 默认视图使用可读状态；精确 ID/指纹/模型进入「来源与技术信息」details。
  assert.match(dest, /<details className="p19-details">/);
  assert.match(dest, /来源与技术信息（ID \/ 模型 \/ 媒体 \/ 指纹）/);
  assert.match(dest, /知识卡ID: card\.id/);
  assert.match(dest, /分析版本: card\.analysis_version/);
  assert.match(dest, /绑定媒体 \$\{provenance\.media_ids\.length\} 项/);
});

test('P36 页面标记：主标题不含里程碑编号，顶栏保留项目选择与更多菜单', () => {
  const page = readSource('src/pages/ResearchWorkspacePage.jsx');
  assert.match(page, /p36-topbar/);
  assert.match(page, /p19-project-select/);
  assert.match(page, />更多<\/summary>/);
  assert.match(page, /项目档案/);
  assert.match(page, /导出备份/);
  assert.match(page, /导入备份/);
  assert.match(page, /确认永久删除/);
  assert.match(page, /key=\{`archive-arm:\$\{activeId\}`\}/);
  assert.match(page, /key=\{`delete-arm:\$\{activeId\}`\}/);
  assert.match(page, /P19FlagStrip/);
  assert.match(page, /四项执行标志恒为 false/);
  // 用户可见标题不使用里程碑编号。
  assert.match(page, /<h2>\{project \? `\$\{project\.topic\.slice\(0, 40\)\}` : '采集 → 分析 → 创作 → 产物'\}<\/h2>/);
});

test('P36 样式契约：暗色视觉、8px 节奏、可读内容宽度、键盘焦点、无横向溢出响应', () => {
  const css = readSource('src/pages/ResearchWorkspacePage.css');
  assert.ok(css.includes('.p19-workspace'), '工作台作用域保留');
  assert.ok(css.includes('max-width: 1280px'), '可读内容宽度');
  assert.ok(css.includes('.p36-topbar'), '紧凑顶栏样式');
  assert.ok(css.includes('.p36-tabs'), '目的地导航样式');
  assert.ok(css.includes('.p36-destination'), '目的地布局样式');
  assert.ok(css.includes('.p36-split'), '媒体与结论分栏样式');
  assert.ok(css.includes('.p36-rail'), '来源/分析 rail 样式');
  assert.ok(css.includes(':focus-visible'), '键盘焦点样式');
  assert.ok(css.includes('@media (max-width: 1080px)'), '平板单列');
  assert.ok(css.includes('@media (max-width: 480px)'), '手机窄屏');
  assert.ok(!css.includes('@import'), '不引入外部资源');
});

test('P36 所有权与删除防护：仅授权路径发生受跟踪修改', () => {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000 });
  } catch (error) {
    assert.fail(`git status 不可用: ${error.message}`);
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') continue;
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    if (x === 'D' || y === 'D') {
      assert.fail(`P36 不允许删除文件: ${paths.join(', ')}`);
    }
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});

// ---- 浏览器验收 ----------------------------------------------------------------

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
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version, prefer, accept-profile, content-profile, range, x-upsert',
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
    created_at: '2026-08-13T00:00:00.000Z', updated_at: '2026-08-13T00:00:00.000Z',
    evidence: [], analyses: [], knowledge_cards: [], brief: null, handoff: null, handoffs: [], lineage: null,
    fingerprint: 'a'.repeat(64),
  };
}

function makeCollectItem(index) {
  const extId = `1900000000000000${index}`;
  const contentText = `P36 浏览器验收来源 ${index}：确定性正文，用于验证完整路径。`;
  const contentSha = sha256(contentText);
  return {
    id: `p22-${contentSha.slice(0, 24)}`,
    source_url: `https://x.com/p36author/status/${extId}`,
    label: `P36 验收来源 ${index}`,
    platform: 'x',
    content_text: contentText,
    external_id: extId,
    content_sha256: contentSha,
    source_metadata: {
      author: { name: 'P36 作者', handle: `p36author${index}`, user_id: `u-${index}` },
      published_at: `2026-08-0${index}T08:00:00.000Z`,
      engagement: { views: 5000, likes: 400, retweets: 80, replies: 20, quotes: 5, bookmarks: 100 },
    },
    media_assets: [{
      id: `m-${sha256(`p36-media\0${extId}\0`).slice(0, 24)}`,
      tweet_id: extId, external_id: extId,
      canonical_tweet_url: `https://x.com/p36author/status/${extId}`,
      media_url: `http://127.0.0.1:${0}/media/p36-${index}.jpg`,
      order: 0, kind: 'image', mime_type: 'image/jpeg',
      dimensions: { width: 800, height: 600 }, byte_size: TINY_PNG.length,
      hash: { algorithm: 'sha256', kind: 'content', value: sha256(`p36-media-bytes-${index}`) },
    }],
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: 'apify:xquik/x-tweet-scraper',
      run_id: 'apify-run-p36-browser',
      collected_at: '2026-08-13T00:00:00.000Z',
      usage_total_usd: 0.01,
      budget_reservation_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1',
    },
    collection_proof: `9999999999.${'f'.repeat(64)}`,
  };
}

function v2AnalysisForEvidence(evidence) {
  const mediaAnalysis = (evidence.media_assets || []).map((asset, i) => ({
    media_id: asset.id,
    visual_content: `画面 #${i + 1}：高对比度产品特写，色彩饱和。`,
    composition: '中心构图', people: '单人演示', scene: '明亮棚拍', emotion: '专业可信',
    visual_selling_points: ['产品聚焦', '调性统一'], style_pattern: '高亮 + 浅景深',
  }));
  return {
    source_id: evidence.provenance?.source_id || evidence.id,
    source_url: evidence.source_url,
    content_sha256: evidence.provenance?.content_sha256 || '',
    text_expression: 'P36 浏览器验收：清晰的视觉表达与简洁文案形成传播合力。',
    hook: 'P36 验收钩子',
    copy_pattern: '视觉前置 + 情绪共鸣',
    target_audience: '关注科技与生活方式的城市青年',
    audience_need_emotion: '追求效率与品质的信息需求',
    media_analysis: mediaAnalysis,
    virality_drivers: ['视觉冲击力', '信息密度'],
    reusable_methods: ['图胜于文', '情绪共鸣'],
    rewrite_suggestions: ['加入数据可视化'],
    signals: ['高互动率'],
    risks: ['过度依赖视觉'],
    model: 'qwen-mock-v2',
  };
}

function makeDraftFor(evidence, analysis) {
  return {
    evidence_id: evidence.id,
    evidence_version: evidence.version,
    evidence_fingerprint: evidence.fingerprint,
    analysis_id: analysis.id,
    analysis_version: analysis.version,
    analysis_fingerprint: analysis.fingerprint,
    title: 'P36 验收草稿标题',
    main_copy: 'P36 验收草稿正文：从已保存分析生成的可编辑草稿。',
    cta: '点击了解详情',
    hashtags: ['#营销', '#出海'],
    media_idea: '高对比度产品特写 + 简洁文案',
    model: 'qwen-mock-v2',
  };
}

function p36Boundary() {
  const projects = new Map();
  const requests = [];
  let mediaBase = '';
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, requestedHeaders: request.headers['access-control-request-headers'] || null });
    const origin = request.headers.origin || '';
    if (request.method === 'OPTIONS') return json(response, 200, {}, origin);
    if (request.method === 'GET' && request.url?.startsWith('/media/')) {
      response.writeHead(200, { 'content-type': 'image/jpeg', 'access-control-allow-origin': origin });
      response.end(TINY_PNG);
      return;
    }
    if (request.url === '/auth/v1/user') {
      return json(response, 200, {
        id: '11111111-1111-4111-8111-111111111111', email: 'p36-browser@example.invalid',
        aud: 'authenticated', role: 'authenticated', user_metadata: { user_name: 'p36-browser' },
      }, origin);
    }
    if (request.url?.startsWith('/rest/v1/content_library') && request.method === 'POST') {
      return json(response, 201, { id: 'draft-p36-0001' }, origin);
    }
    if (request.url?.startsWith('/rest/v1/')) {
      return json(response, 200, request.headers.accept?.includes('object+json') ? {} : [], origin);
    }
    if (request.url === '/functions/v1/p22-research-assist' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'p22', action: body.action });
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
      if (body.action === 'collect_url') {
        const item = makeCollectItem(1);
        item.media_assets[0].media_url = `${mediaBase}/media/p36-1.jpg`;
        return json(response, 200, { ...base, action: 'collect_url', items: [item], cost: { recorded_cny: 0.01, actual_cny: 0.001 } }, origin);
      }
      if (body.action === 'analyze_persisted') {
        const project = projects.get(body.project_id);
        const evidence = project && (project.evidence || []).find((row) => row.id === body.evidence_id);
        if (!evidence) return json(response, 404, { ok: false, code: 'EVIDENCE_NOT_FOUND' }, origin);
        return json(response, 200, {
          ...base, action: 'analyze_persisted',
          analyses: [v2AnalysisForEvidence(evidence)],
          usage: { total_tokens: 900 },
          cost: { recorded_cny: 1, tracking: [] },
        }, origin);
      }
      if (body.action === 'generate_similar') {
        const project = projects.get(body.project_id);
        const evidence = project && (project.evidence || []).find((row) => row.id === body.evidence_id);
        const analysis = project && (project.analyses || []).find((row) => row.id === body.analysis_id);
        if (!evidence || !analysis) return json(response, 404, { ok: false, code: 'ANALYSIS_NOT_FOUND' }, origin);
        return json(response, 200, {
          ...base, action: 'generate_similar',
          draft: makeDraftFor(evidence, analysis),
          usage: { total_tokens: 700 },
          cost: { recorded_cny: 1, tracking: [] },
        }, origin);
      }
      return json(response, 400, { ok: false, code: 'UNKNOWN_ACTION' }, origin);
    }
    if (request.url === '/functions/v1/p19-workspace-command' && request.method === 'POST') {
      const body = await readJson(request);
      requests.push({ fn: 'command', command: body.command });
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
        const id = `prj-${sha256(`p36-proj\0${raw.topic}\0${Date.now()}`).slice(0, 24)}`;
        const project = makeProject(raw, id);
        projects.set(id, project);
        return json(response, 200, { ...envelope, applied: true, entity: { type: 'project', id } }, origin);
      }
      if (body.command === 'evidence.create') {
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
  return { server, projects, requests, setMediaBase(base) { mediaBase = base; } };
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

test('P36 生产构建浏览器验收：三档视口无溢出无空列 + 完整路径 + 单主操作 + 键盘 + 隔离 + 截图', { timeout: 420_000 }, async () => {
  assert.equal(existsSync(EDGE), true, 'Microsoft Edge is required for the real-browser acceptance');

  const boundaryPort = await freePort();
  const previewPort = await freePort();
  const debugPort = await freePort();
  const boundary = p36Boundary();
  boundary.setMediaBase(`http://127.0.0.1:${boundaryPort}`);
  await new Promise((resolve) => boundary.server.listen(boundaryPort, '127.0.0.1', resolve));

  // 临时证据目录（不在受跟踪业务文件内）。
  const evidenceDir = await mkdtemp(join(tmpdir(), 'ams-p36-evidence-'));
  assert.equal(evidenceDir.startsWith(tmpdir()), true);

  await rm(DIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${boundaryPort}`,
      VITE_SUPABASE_ANON_KEY: 'p36-public-browser-test-key',
    },
    timeout: 180_000,
  });
  const preview = spawn(process.execPath, [
    join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort',
  ], { cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true });
  await waitForUrl(`http://127.0.0.1:${previewPort}/`);

  const profile = await mkdtemp(join(tmpdir(), 'ams-p36-browser-'));
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const payload = Buffer.from(JSON.stringify({
      sub: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 7200,
    })).toString('base64url');
    const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.p36`;
    const session = {
      access_token: token, token_type: 'bearer', expires_in: 7200,
      expires_at: Math.floor(Date.now() / 1000) + 7200, refresh_token: 'p36-refresh',
      user: {
        id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated',
        email: 'p36-browser@example.invalid', user_metadata: { user_name: 'p36-browser' },
      },
    };
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem(${JSON.stringify(AUTH_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(session))});`,
    });
    await cdp.send('Page.navigate', { url: `${baseUrl}#/research` });
    await waitFor(() => cdp.evaluate('document.readyState === "complete"'), { label: 'research route loaded' });
    await cdp.send('Page.reload', { ignoreCache: true });
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('在线工作区 · 已同步')`), { label: 'authenticated online research route' });

    // 1) 创建项目 → 默认目的地为「采集」，只有一个主操作。
    await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')))`), { label: 'research page loaded' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')).click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), { label: 'create project form' });
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ['P36 渐进式工作台', '验证四目的地完整路径', '验收团队', 'X', '只读来源'];
      fields.forEach((field, i) => {
        if (i < values.length) {
          Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(field, values[i]);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    })()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.p19-create-panel button[type="submit"]').disabled`), { label: 'valid form' });
    await cdp.evaluate(`document.querySelector('.p19-create-panel button[type="submit"]').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P36 渐进式工作台')`), { label: 'project created' });

    // 默认状态：采集目的地，四个标签可见，只有当前目的地渲染。
    const initialState = await cdp.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('[data-destination-tab]')].map((t) => ({ id: t.getAttribute('data-destination-tab'), selected: t.getAttribute('aria-selected') === 'true' }));
      const rendered = [...document.querySelectorAll('[data-destination]')].map((el) => el.getAttribute('data-destination'));
      const heroes = document.querySelectorAll('.p36-hero').length;
      const ctas = document.querySelectorAll('.p36-cta-primary').length;
      return { tabs, rendered, heroes, ctas };
    })()`);
    assert.deepEqual(initialState.tabs.map((t) => t.id), ['collect', 'analyze', 'create', 'outputs']);
    assert.equal(initialState.tabs.find((t) => t.id === 'collect').selected, true, '默认目的地必须是采集');
    assert.deepEqual(initialState.rendered, ['collect'], '同一时刻只有一个目的地渲染');
    assert.equal(initialState.heroes, 1, '采集只有一个主按钮');

    // 2) 采集：粘贴链接 → 读取 → 来源卡（媒体/作者/互动/未保存）→ 保存证据。
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p22-query-row input'))`), { label: 'smart input' });
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p22-query-row input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://x.com/p36author/status/19000000000000001');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('读取这条帖子'))`), { label: 'URL mode button' });
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('读取这条帖子')).click()`);
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p22-source-card').length === 1`), { label: 'source preview' });
    await waitFor(() => cdp.evaluate(`(() => { const img = document.querySelector('.p22-source-card .p22-media-gallery img'); return Boolean(img && img.complete && img.naturalWidth > 0); })()`), { label: 'media bytes rendered' });
    const sourceCard = await cdp.evaluate(`(() => {
      const card = document.querySelector('.p22-source-card');
      const img = card.querySelector('.p22-media-gallery img');
      return {
        unsaved: card.innerText.includes('来源预览 · 未保存'),
        firstAction: card.querySelector('button').textContent,
        mediaCount: card.querySelectorAll('.p22-media-gallery img').length,
        author: card.innerText.includes('P36 作者'),
        engagement: card.innerText.includes('点赞 400'),
      };
    })()`);
    assert.deepEqual(sourceCard, { unsaved: true, firstAction: '保存证据', mediaCount: 1, author: true, engagement: true });
    await cdp.evaluate(`document.querySelector('.p22-source-card button').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('来源证据已保存。下一步可分析帖子/视频')`), { label: 'evidence saved' });
    await waitFor(() => cdp.evaluate(`document.querySelectorAll('.p32-evidence-card').length === 1`), { label: 'evidence library updated' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent === '去分析')`), { label: 'go analyze button' });
    const evidenceId = [...boundary.projects.values()][0].evidence[0].id;

    // 3) 去分析 → 媒体预览 + 完整结果视图：逐媒体字段 → 分析此来源（唯一主操作）。
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === '去分析').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'analyze destination' });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p36-media-preview'))`), { label: 'media preview surface' });
    const analyzeEmpty = await cdp.evaluate(`(() => ({
      primaryCount: document.querySelectorAll('.p36-cta-primary').length,
      primaryText: document.querySelector('.p36-cta-primary')?.textContent || '',
      mediaNode: Boolean(document.querySelector('.p36-media-grid img')),
      noAnalysisText: document.body.innerText.includes('尚未分析'),
    }))()`);
    assert.deepEqual(analyzeEmpty, { primaryCount: 1, primaryText: '分析此来源', mediaNode: true, noAnalysisText: true }, '未分析状态：媒体预览 + 唯一主操作');
    await cdp.evaluate(`document.querySelector('.p36-cta-primary').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('分析完成。请先查看完整结果')`), { label: 'analysis preview ready' });
    const previewState = await cdp.evaluate(`(() => ({
      primaryText: document.querySelector('.p36-cta-primary')?.textContent || '',
      previewBadge: document.body.innerText.includes('预览 · 未保存'),
      mediaFindings: document.querySelectorAll('.p36-media-findings li').length,
      mediaIdBound: Boolean(document.querySelector('.p36-media-findings li[data-media-id]')),
      hasHook: document.body.innerText.includes('P36 验收钩子'),
      hasAudience: document.body.innerText.includes('关注科技与生活方式的城市青年'),
      hasRisks: document.body.innerText.includes('过度依赖视觉'),
      hasDriver: document.body.innerText.includes('视觉冲击力'),
    }))()`);
    assert.equal(previewState.primaryText, '保存分析结果', '预览态主操作必须是保存');
    assert.equal(previewState.previewBadge, true);
    assert.equal(previewState.mediaFindings, 1, '逐媒体发现数量必须等于媒体数');
    assert.equal(previewState.mediaIdBound, true, '逐媒体发现必须绑定 media_id');
    assert.equal(previewState.hasHook, true);
    assert.equal(previewState.hasAudience, true);
    assert.equal(previewState.hasRisks, true);
    assert.equal(previewState.hasDriver, true);

    // 4) 保存分析结果 → 已保存状态（主操作变为「去创作」，追加新版在版本菜单内）。
    await cdp.evaluate(`document.querySelector('.p36-cta-primary').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('分析结果已保存为第 1 版')`), { label: 'analysis saved' });
    const savedState = await cdp.evaluate(`(() => {
      const versionMenu = document.querySelector('.p36-version-menu');
      return {
        primaryText: document.querySelector('.p36-cta-primary')?.textContent || '',
        savedBadge: document.body.innerText.includes('多模态模型分析 · 第 1 版'),
        versionMenuPresent: Boolean(versionMenu),
        appendInMenu: Boolean(versionMenu && [...versionMenu.querySelectorAll('button')].some((b) => b.textContent.includes('追加新版分析'))),
        primaryCount: document.querySelectorAll('.p36-cta-primary').length,
      };
    })()`);
    assert.equal(savedState.primaryText, '去创作', '已保存后主操作是去创作');
    assert.equal(savedState.savedBadge, true, '必须显示已保存版本状态');
    assert.equal(savedState.versionMenuPresent, true);
    assert.equal(savedState.appendInMenu, true, '追加新版分析必须在版本菜单内');
    assert.equal(savedState.primaryCount, 1, '每状态只有一个主操作');
    const storedAnalysis = [...boundary.projects.values()][0].analyses[0];
    assert.ok(storedAnalysis.model_analysis, '分析必须按 model_analysis 持久化');
    assert.equal(storedAnalysis.model_analysis.result.media_analysis.length, 1, '逐媒体分析必须持久化');

    // 5) 生成知识卡（次级操作）→ 产物 → 知识卡完整详情。
    const cardWritesBefore = boundary.requests.filter((request) => request.command === 'card.create').length;
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent === '生成知识卡').click()`);
    await waitFor(() => ([...boundary.projects.values()][0].knowledge_cards || []).length === 1, { label: 'knowledge card persisted' });
    assert.equal(boundary.requests.filter((request) => request.command === 'card.create').length, cardWritesBefore + 1, '生成知识卡必须恰好写入一次');
    await cdp.evaluate(`[...document.querySelectorAll('[data-destination-tab="outputs"]')][0].click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'outputs destination' });
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-card-item'))`), { label: 'card list rendered' });
    const cardListSnippet = await cdp.evaluate(`document.querySelector('.p19-card-item').innerText`);
    assert.ok(cardListSnippet.includes('查看详情'), '知识卡列表必须提供详情入口');
    await cdp.evaluate(`document.querySelector('.p19-card-open').click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p36-card-detail'))`), { label: 'card detail opened' });
    const cardDetail = await cdp.evaluate(`(() => {
      const el = document.querySelector('.p36-card-detail');
      const text = el.innerText;
      return {
        timeline: text.includes('媒体时间线 / 视觉证据') && text.includes('visual_evidence') === false,
        timelineVisual: text.includes('高对比度产品特写'),
        visualImpact: text.includes('视觉影响') && text.includes('高对比度产品特写'),
        semanticLayers: text.includes('语义层') && text.includes('中心构图'),
        tone: text.includes('情绪基调'),
        audience: text.includes('受众响应机制') && text.includes('高互动率'),
        replicable: text.includes('可复用特征') && text.includes('图胜于文'),
        risks: text.includes('风险标签'),
        evidenceLinks: text.includes('证据链接') && text.includes('置信'),
        guidance: text.includes('生成指导') && text.includes('必须保留') && text.includes('不得虚构'),
        uncertainties: text.includes('不确定性'),
        provenanceLine: text.includes('多模态 · qwen-mock-v2'),
      };
    })()`);
    assert.equal(cardDetail.timeline, true, '知识卡详情必须渲染媒体时间线');
    assert.equal(cardDetail.timelineVisual, true, '视觉证据内容必须渲染');
    assert.equal(cardDetail.visualImpact, true);
    assert.equal(cardDetail.semanticLayers, true);
    assert.equal(cardDetail.tone, true);
    assert.equal(cardDetail.audience, true);
    assert.equal(cardDetail.replicable, true);
    assert.equal(cardDetail.risks, true);
    assert.equal(cardDetail.evidenceLinks, true, '证据链接必须渲染');
    assert.equal(cardDetail.guidance, true, '生成指导必须渲染');
    assert.equal(cardDetail.uncertainties, true);
    assert.equal(cardDetail.provenanceLine, true, '模型/媒体 ID 溯源必须渲染');
    await cdp.evaluate(`[...document.querySelectorAll('.p19-details summary')].find((s) => s.textContent.includes('来源与技术信息')).click()`);
    const technicalText = await cdp.evaluate(`document.querySelector('.p36-card-detail .p19-pre')?.innerText || ''`);
    for (const needle of ['qwen-mock-v2', evidenceId.slice(0, 8), 'media_ids', '分析指纹', storedAnalysis.fingerprint]) {
      assert.ok(technicalText.includes(needle), `来源与技术信息必须包含 ${needle}`);
    }

    // P37：已有知识卡时，“查看知识卡”只能导航到准确卡，绝不能再次写入或触发空命令。
    await cdp.evaluate(`document.querySelector('[data-destination-tab="analyze"]').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'analyze'`), { label: 'return to analyze' });
    assert.equal(await cdp.evaluate(`document.querySelector('[data-testid="p36-analysis-quality"]')?.innerText.includes('Qwen 多模态分析')`), true);
    const requestCountBeforeView = boundary.requests.length;
    await cdp.evaluate(`document.querySelector('.p36-card-action').click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs' && Boolean(document.querySelector('.p36-card-detail'))`), { label: 'view exact card without write' });
    assert.equal(boundary.requests.length, requestCountBeforeView, '查看知识卡必须零在线写命令');
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('无法将本次修改绑定到唯一在线命令')`), false);

    // 6) 创作：从已保存分析生成相似帖子 → 编辑 → 显式保存草稿。
    await cdp.evaluate(`[...document.querySelectorAll('[data-destination-tab="create"]')][0].click()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'create'`), { label: 'create destination' });
    await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('根据分析生成相似帖子'))`), { label: 'generate draft button' });
    const createPrimary = await cdp.evaluate(`(() => ({
      count: document.querySelectorAll('.p36-cta-primary').length,
      text: document.querySelector('.p36-cta-primary')?.textContent || '',
      analysisSelected: document.body.innerText.includes('P36 验收来源 1'),
    }))()`);
    assert.deepEqual(createPrimary, { count: 1, text: '根据分析生成相似帖子', analysisSelected: true }, '创作必须显式选择已保存分析且主操作唯一');
    await cdp.evaluate(`document.querySelector('.p36-cta-primary').click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p36-draft-editor textarea'))`), { label: 'draft editor' });
    await cdp.evaluate(`(() => {
      const input = document.querySelector('.p36-draft-editor input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'P36 验收草稿标题（已编辑）');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`[...document.querySelectorAll('.p36-draft-editor button')].find((b) => b.textContent.includes('保存相似帖子草稿')).click()`);
    await waitFor(async () => {
      const state = await cdp.evaluate(`(() => ({
        saved: [...document.querySelectorAll('button')].some((b) => b.textContent.includes('草稿已保存')),
        error: document.querySelector('[role="alert"]')?.innerText || '',
      }))()`);
      if (state.error) throw new Error(`draft save UI error: ${state.error}; recent requests: ${JSON.stringify(boundary.requests.slice(-8))}`);
      return state.saved;
    }, { label: 'draft saved state' });

    // 7) 产物：相似草稿区列出已保存草稿（绑定来源/分析）。
    await cdp.evaluate(`[...document.querySelectorAll('[data-destination-tab="outputs"]')][0].click()`);
    await waitFor(() => cdp.evaluate(`Boolean([...document.querySelectorAll('.p36-rail-item')].find((b) => b.innerText.includes('相似草稿（1）')))`), { label: 'draft section count' });
    await cdp.evaluate(`[...document.querySelectorAll('.p36-rail-item')].find((b) => b.innerText.includes('相似草稿')).click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P36 验收草稿标题（已编辑）')`), { label: 'draft listed in outputs' });
    const draftListed = await cdp.evaluate(`(() => {
      const item = document.querySelector('.p36-draft-item');
      return { item: Boolean(item), bound: Boolean(item && item.innerText.includes('P36 验收来源 1') && item.innerText.includes('分析第 1 版')), flags: Boolean(item && item.innerText.includes('未审核、未路由、未发布')) };
    })()`);
    assert.equal(draftListed.item, true);
    assert.equal(draftListed.bound, true, '草稿记录必须绑定来源与分析版本');
    assert.equal(draftListed.flags, true);

    // 8) 键盘导航：方向键切换目的地（焦点保持在标签上）。
    await cdp.evaluate(`document.querySelector('[data-destination-tab="outputs"]').focus()`);
    await cdp.evaluate(`(() => {
      const tab = document.querySelector('[data-destination-tab="outputs"]');
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'collect'`), { label: 'arrow-right wraps to collect' });
    await cdp.evaluate(`(() => {
      const tab = document.querySelector('[data-destination-tab="collect"]');
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    })()`);
    await waitFor(() => cdp.evaluate(`document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination') === 'outputs'`), { label: 'arrow-left back to outputs' });

    // 9) 项目切换隔离：新建项目 B → 采集输入/来源/分析/草稿全部清空，绝不泄漏。
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建项目')).click()`);
    await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('.p19-create-panel form'))`), { label: 'create project B form' });
    await cdp.evaluate(`(() => {
      const fields = [...document.querySelectorAll('.p19-create-panel input, .p19-create-panel textarea')];
      const values = ['P36 隔离项目 B', '验证切换隔离', '验收团队', 'X', '无'];
      fields.forEach((field, i) => {
        if (i < values.length) {
          Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(field, values[i]);
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    })()`);
    await waitFor(() => cdp.evaluate(`!document.querySelector('.p19-create-panel button[type="submit"]').disabled`), { label: 'valid B form' });
    await cdp.evaluate(`document.querySelector('.p19-create-panel button[type="submit"]').click()`);
    await waitFor(() => cdp.evaluate(`document.body.innerText.includes('P36 隔离项目 B')`), { label: 'project B created' });
    await delay(300);
    const isolationB = await cdp.evaluate(`(() => ({
      destination: document.querySelector('[data-active-destination]')?.getAttribute('data-active-destination'),
      sourceCards: document.querySelectorAll('.p22-source-card').length,
      collectInput: document.querySelector('.p22-query-row input')?.value || '',
      evidenceCards: document.querySelectorAll('.p32-evidence-card').length,
      hasProjectAText: document.body.innerText.includes('P36 验收来源 1'),
      draftCount: document.querySelectorAll('.p36-draft-item').length,
    }))()`);
    assert.equal(isolationB.destination, 'collect', '切换项目必须回到采集目的地');
    assert.equal(isolationB.sourceCards, 0, 'B 项目不得显示 A 的来源结果');
    assert.equal(isolationB.collectInput, '', 'B 项目不得残留 A 的采集输入');
    assert.equal(isolationB.evidenceCards, 0, 'B 项目不得显示 A 的证据库');
    assert.equal(isolationB.hasProjectAText, false, 'B 项目不得出现 A 的来源文本');
    assert.equal(isolationB.draftCount, 0, 'B 项目不得显示 A 的草稿');

    // 10) 三档视口：无横向溢出 + 无巨大空列 + 截图。
    const viewports = [
      { width: 1440, height: 900, name: 'desktop-1440x900' },
      { width: 1024, height: 768, name: 'tablet-1024x768' },
      { width: 390, height: 844, name: 'mobile-390x844' },
    ];
    for (const viewport of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width <= 480 });
      await delay(300);
      const layout = await cdp.evaluate(`(() => {
        const doc = document.documentElement;
        const canvas = document.querySelector('.p36-canvas');
        const workspace = document.querySelector('.p19-workspace');
        const rect = canvas ? canvas.getBoundingClientRect() : null;
        return {
          noOverflow: doc.scrollWidth <= doc.clientWidth + 1,
          canvasWidth: rect ? Math.round(rect.width) : 0,
          workspaceWidth: workspace ? Math.round(workspace.getBoundingClientRect().width) : 0,
          noEmptyColumn: rect ? rect.width / workspace.getBoundingClientRect().width > 0.45 : false,
        };
      })()`);
      assert.equal(layout.noOverflow, true, `${viewport.name} 不得横向溢出（scrollWidth=${layout.noOverflow}）`);
      assert.ok(layout.canvasWidth > 300, `${viewport.name} 主画布必须占主导宽度（${layout.canvasWidth}px）`);
      assert.equal(layout.noEmptyColumn, true, `${viewport.name} 不得出现巨大空列`);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(evidenceDir, `p36-${viewport.name}.png`), Buffer.from(shot.data, 'base64'));
    }
    // 桌面再截四目的地各一张。
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const id of ['collect', 'analyze', 'create', 'outputs']) {
      await cdp.evaluate(`document.querySelector('[data-destination-tab="${id}"]').click()`);
      await delay(250);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(evidenceDir, `p36-desktop-${id}.png`), Buffer.from(shot.data, 'base64'));
    }

    // 11) 无 React 错误边界 + 执行标志恒 false。
    const health = await cdp.evaluate(`(() => ({
      errorBoundary: Boolean(document.querySelector('[data-react-error]')),
      flags: document.body.innerText.includes('四项均为 false'),
    }))()`);
    assert.equal(health.errorBoundary, false, '不应出现 React 错误边界');
    assert.equal(health.flags, true, '执行标志必须恒 false');
    const storedProject = [...boundary.projects.values()][0];
    assert.deepEqual(storedProject.execution_flags, {
      generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false,
    });
    const p22Actions = boundary.requests.filter((item) => item.fn === 'p22').map((item) => item.action);
    assert.ok(p22Actions.includes('collect_url'), '必须发生一次单帖读取');
    assert.ok(p22Actions.includes('analyze_persisted'), '必须发生一次分析');
    assert.ok(p22Actions.includes('generate_similar'), '必须发生一次相似帖生成');
    console.log(`[p36] screenshots: ${evidenceDir}`);
  } finally {
    cdp?.close();
    await killTree(edge);
    await killTree(preview);
    await new Promise((resolve) => boundary.server.close(resolve));
    if (profile.startsWith(tmpdir()) && profile.includes('ams-p36-browser-')) {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
});
