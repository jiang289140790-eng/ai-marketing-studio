import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_STAGING_VIEW_NAMES,
  STAGING_VIEWS,
  LINEAGE_STATES,
  getStagingRuntimeStatus,
  lineageStateDisplay,
  buildStagingNotConfiguredView,
  buildStagingNotSignedInView,
  buildStagingReadErrorView,
} from '../src/services/staging-preview-service.js';
import { navigationItems } from '../src/data/navigation.js';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---- P17-C 授权路径清单 -----------------------------------------------------
const OWNED_PATHS = new Set([
  'src/App.jsx',
  'src/components/Header.jsx',
  'src/components/Sidebar.jsx',
  'src/data/navigation.js',
  'src/pages/CommandCenter.jsx',
  'src/pages/KnowledgeVaultPage.jsx',
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/services/staging-preview-service.js',
  'src/styles.css',
  'test/navigation-contract.test.mjs',
  'test/research-workspace.test.mjs',
  'test/online-integrated-preview.test.mjs',
  'test/research-live-data.test.mjs',
  'test/p17c-staging-preview.test.mjs',
  // P19 运营研究工作台新增授权路径（本里程碑）。
  'src/services/p19-contracts.js',
  'src/services/p19-store.js',
  'src/services/p19-lineage.js',
  'src/services/p19-workspace-service.js',
  'src/services/p19-server-write-adapter.js',
  'src/components/integrated-workspace/P19WorkbenchPanels.jsx',
  // P19 迁移对账：2 个已验收规范文件替换了工作区中的旧版本（内容不一致）。
  'supabase/migrations/20260722023000_ops_execution_gateway.sql',
  'supabase/migrations/20260722033000_ops_business_tables_and_rls_hardening.sql',
  'supabase/migrations/20260812000000_p19_workspace_command_contract_v1.sql',
  'supabase/tests/p19_b0_command_contract.test.sql',
  'supabase/functions/p19-workspace-command/command-core.mjs',
  'supabase/functions/p19-workspace-command/index.ts',
  'test/p19-contracts.test.mjs',
  'test/p19-store.test.mjs',
  'test/p19-workbench-service.test.mjs',
  'test/p19-lineage.test.mjs',
  'test/p19-backend-command.test.mjs',
  'test/p19-forbidden-scan.test.mjs',
  'docs/P19_OPERATIONAL_WORKBENCH.md',
  'docs/P19_COMPLETION_REPORT.md',
  // P19 合并修复（repair 1）：迁移工具链 + 边界函数 + 新聚焦测试。
  'scripts/check-migrations.mjs',
  'scripts/check-p19-deployment-gate.mjs',
  'supabase/functions/p19-workspace-command/jwt-verify.mjs',
  'supabase/tests/p19_b1_rpc_boundary.test.sql',
  'supabase/tests/p19_b2_idempotency_replay.test.sql',
  'test/p19-checker.test.mjs',
  'test/p19-deployment-gate.test.mjs',
  'test/p19-sql-integration.test.mjs',
  // P29 多模态证据闭环新增授权路径（本里程碑）。
  'src/components/integrated-workspace/P22ResearchAssistPanel.jsx',
  'src/services/p22-research-assist.js',
  'supabase/functions/p22-research-assist/assist-core.mjs',
  'supabase/functions/p22-research-assist/index.ts',
  'test/p22-assisted-research.test.mjs',
  'test/p23-link-evidence-knowledge.test.mjs',
  'test/p29-multimodal-x-evidence.test.mjs',
  'test/p29-multimodal-x-evidence.browser.test.mjs',
  'docs/P29_MULTIMODAL_X_EVIDENCE_LOOP.md',
  // P36 渐进式交互重设计新增授权路径（本里程碑）：所有权清单必须同步跟踪。
  'src/components/integrated-workspace/P36ResearchDestinations.jsx',
  'test/p21-guided-research.test.mjs',
  'test/p32-hot-topic-search.browser.test.mjs',
  'test/p32-reddit-topic-search.browser.test.mjs',
  'test/p32-multipost-synthesis-brief.browser.test.mjs',
  'test/p20-browser-online.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
]);

// P19 已验收迁移对账唯一允许的删除：5 个过时时间戳变体。
const ALLOWED_DELETIONS = new Set([
  'supabase/migrations/20260722141035_support_discord_and_read_business_intelligence.sql',
  'supabase/migrations/20260722142451_hard_finish_security_rls_and_search_path.sql',
  'supabase/migrations/20260722142535_restore_vector_operator_search_path.sql',
  'supabase/migrations/20260724133735_fix_content_packages_update_policy.sql',
  'supabase/migrations/20260725043407_day1_publish_state_machine.sql',
]);

// ---- 辅助函数 ---------------------------------------------------------------
function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

// ============================================================================
// 路由测试
// ============================================================================
test('路由：#/dashboard #/research #/knowledge 均可解析为有效页面', async () => {
  globalThis.window = { URLSearchParams: globalThis.URLSearchParams, location: { hash: '#/' } };
  try {
    const { parseAppRoute, buildAppHash } = await import('../src/utils/app-route.js');

    assert.equal(parseAppRoute('#/dashboard').page, 'dashboard');
    assert.equal(parseAppRoute('#/research').page, 'research');
    assert.equal(parseAppRoute('#/knowledge').page, 'knowledge');
    assert.equal(parseAppRoute('#/intelligence').page, 'intelligence');

    assert.equal(buildAppHash('dashboard'), '#/dashboard');
    assert.equal(buildAppHash('research'), '#/research');
    assert.equal(buildAppHash('knowledge'), '#/knowledge');
  } finally {
    delete globalThis.window;
  }
});

test('导航：dashboard、research、knowledge 均在导航条目中', () => {
  for (const id of ['dashboard', 'research', 'knowledge']) {
    assert.ok(navigationItems.some((item) => item.id === id), `导航条目缺失: ${id}`);
  }
});

// ============================================================================
// 五视图契约测试
// ============================================================================
test('五视图契约：服务导出正确的 5 个 staging api 视图名', () => {
  assert.deepEqual(
    [...ALL_STAGING_VIEW_NAMES].sort(),
    [
      'ke_content_briefs_v1',
      'ke_handoff_manifest_v1',
      'ke_handoff_package_detail_v1',
      'ke_knowledge_cards_v1',
      'vg_lineage_audit_v1',
    ],
  );

  assert.equal(STAGING_VIEWS.KNOWLEDGE_CARDS, 'ke_knowledge_cards_v1');
  assert.equal(STAGING_VIEWS.CONTENT_BRIEFS, 'ke_content_briefs_v1');
  assert.equal(STAGING_VIEWS.HANDOFF_MANIFEST, 'ke_handoff_manifest_v1');
  assert.equal(STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL, 'ke_handoff_package_detail_v1');
  assert.equal(STAGING_VIEWS.LINEAGE_AUDIT, 'vg_lineage_audit_v1');

  assert.equal(ALL_STAGING_VIEW_NAMES.length, 5);
});

test('五视图契约：知识引擎 4 视图全部为 ke_ 前缀，世系为 vg_', () => {
  const keViews = [
    STAGING_VIEWS.KNOWLEDGE_CARDS,
    STAGING_VIEWS.CONTENT_BRIEFS,
    STAGING_VIEWS.HANDOFF_MANIFEST,
    STAGING_VIEWS.HANDOFF_PACKAGE_DETAIL,
  ];
  for (const view of keViews) {
    assert.ok(view.startsWith('ke_'), `${view} 必须为 ke_ 前缀（知识引擎视图）`);
  }
  assert.ok(STAGING_VIEWS.LINEAGE_AUDIT.startsWith('vg_'), '世系视图必须为 vg_ 前缀');
});

// ============================================================================
// 世系状态测试
// ============================================================================
test('世系状态：四种状态常量存在且各异', () => {
  const states = Object.values(LINEAGE_STATES);
  assert.equal(states.length, 4);
  assert.equal(new Set(states).size, 4, '四种世系状态不得重复');
  assert.ok(states.includes('COMPLETE'));
  assert.ok(states.includes('PARTIAL'));
  assert.ok(states.includes('BROKEN'));
  assert.ok(states.includes('INVALID_SOURCE'));
});

test('世系状态：显示标签包含中文字段且回退到未知', () => {
  for (const state of ['COMPLETE', 'PARTIAL', 'BROKEN', 'INVALID_SOURCE']) {
    const display = lineageStateDisplay(state);
    assert.ok(display.label.length > 0, `${state} 必须有标签`);
    assert.ok(['success', 'warning', 'error', 'muted'].includes(display.tone), `${state} 色调非法`);
  }
  const unknown = lineageStateDisplay('NONEXISTENT');
  assert.equal(unknown.label, 'NONEXISTENT');
  assert.equal(unknown.tone, 'muted');
});

// ============================================================================
// 关闭失败状态测试
// ============================================================================
test('关闭失败状态：运行时状态始终为只读', () => {
  const runtime = getStagingRuntimeStatus();
  assert.equal(runtime.readOnly, true);
  assert.equal(runtime.views.length, 5);
  assert.ok(runtime.note.includes('SELECT'));
  assert.ok(runtime.note.includes('RPC'));
  assert.ok(runtime.note.includes('SELECT'));
});

test('关闭失败状态：not_configured 视图不含任何数据或已登录暗示', () => {
  const view = buildStagingNotConfiguredView();
  assert.equal(view.status, 'not_configured');
  assert.equal(view.configured, false);
  assert.ok(view.note.includes('VITE_SUPABASE_URL'));
  const json = JSON.stringify(view);
  assert.ok(!json.includes('connected'), '未配置视图不得包含 connected 措辞');
  assert.ok(!json.includes('已登录'), '未配置视图不得包含已登录措辞');
  assert.ok(!json.includes('success'), '未配置视图不得包含 success 措辞');
});

test('关闭失败状态：not_signed_in 视图声明已配置但未登录', () => {
  const view = buildStagingNotSignedInView();
  assert.equal(view.status, 'not_signed_in');
  assert.equal(view.configured, true);
  assert.ok(view.note.includes('登录'));
  const json = JSON.stringify(view);
  assert.ok(!json.includes('success'), '未登录视图不得包含 success 措辞');
});

test('关闭失败状态：read_error 视图显式包含错误消息', () => {
  const view = buildStagingReadErrorView('测试错误');
  assert.equal(view.status, 'read_error');
  assert.equal(view.error.message, '测试错误');
});

// ============================================================================
// 源码证据测试
// ============================================================================
test('源码证据：staging-preview-service 使用 schema("api") 模式且不包含被禁引用', () => {
  const source = readSource('src/services/staging-preview-service.js');
  assert.ok(source.includes("schema('api')"), '服务必须使用 schema(api) 模式');
  assert.ok(source.includes('.from('), '服务必须使用 from() 查询');
  assert.ok(source.includes('select'), '服务必须使用 select 查询');
  // 严禁的生产/写引用
  const forbidden = [
    'qtrlymiqohbjvklwegsw',
    'ams_private',
    'service_role',
    /\.insert\(/,
    /\.update\(/,
    /\.delete\(/,
    /\.upsert\(/,
    /\.rpc\(/,
  ];
  for (const pattern of forbidden) {
    if (typeof pattern === 'string') {
      assert.ok(!source.includes(pattern), `服务出现禁止字符串: ${pattern}`);
    } else {
      assert.ok(!pattern.test(source), `服务出现禁止模式: ${pattern}`);
    }
  }
});

test('源码证据：CommandCenter 引用 staging-preview-service 且无执行/发布/写入', () => {
  const source = readSource('src/pages/CommandCenter.jsx');
  assert.ok(source.includes('staging-preview-service'), 'CommandCenter 必须引用 staging 服务');
  assert.ok(source.includes('fetchAllStagingData'), 'CommandCenter 必须调用批量读取');
  assert.ok(source.includes('fetchLineageAuditData'), 'CommandCenter 必须调用世系读取');
  assert.ok(source.includes('研究工作流'), 'CommandCenter 必须展示工作流链');
  assert.ok(source.includes('世系审计'), 'CommandCenter 必须展示世系审计');
  assert.ok(source.includes('安全边界'), 'CommandCenter 必须展示安全边界');
  // 严禁的依赖
  assert.ok(!source.includes('ops-service'), 'CommandCenter 不得引用 ops-service');
  assert.ok(!source.includes('action-queue-service'), 'CommandCenter 不得引用 action-queue-service');
  assert.ok(!source.includes('execution-gateway'), 'CommandCenter 不得引用 execution-gateway');
  assert.ok(!source.includes('campaign-context'), 'CommandCenter 不得引用 campaign-context');
  // 严禁的写/执行模式
  const forbidden = [
    /\.insert\(/,
    /\.update\(/,
    /\.delete\(/,
    /\.upsert\(/,
    /\.rpc\(/,
    /service_role/,
    /qtrlymiqohbjvklwegsw/,
    /ams_private/,
    /dangerouslySetInnerHTML/,
    /ExecutionButton/,
    /type="submit"/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `CommandCenter 出现禁止模式: ${pattern}`);
  }
  // 无直接 Supabase 引用（必须经服务层）
  assert.ok(!source.includes('@supabase/supabase-js'), 'CommandCenter 不得直接引用 supabase-js');
  assert.ok(!source.includes('from(\'supabase-client\')'), 'CommandCenter 不得直接引用 supabase-client');
});

test('源码证据：KnowledgeVaultPage 引用 staging-preview-service 且无写入/合并/删除', () => {
  const source = readSource('src/pages/KnowledgeVaultPage.jsx');
  assert.ok(source.includes('staging-preview-service'), 'KnowledgeVaultPage 必须引用 staging 服务');
  assert.ok(source.includes('fetchKnowledgeEngineData'), 'KnowledgeVaultPage 必须调用知识引擎读取');
  assert.ok(source.includes('ke_knowledge_cards_v1'), 'KnowledgeVaultPage 必须引用知识卡视图');
  assert.ok(source.includes('ke_content_briefs_v1'), 'KnowledgeVaultPage 必须引用内容Brief视图');
  assert.ok(source.includes('ke_handoff_manifest_v1'), 'KnowledgeVaultPage 必须引用交接清单视图');
  assert.ok(source.includes('ke_handoff_package_detail_v1'), 'KnowledgeVaultPage 必须引用包详情视图');
  // 必须声明只读
  assert.ok(source.includes('只读'), 'KnowledgeVaultPage 必须声明只读边界');
  assert.ok(source.includes('SELECT'), 'KnowledgeVaultPage 必须说明 SELECT 只读');
  // 严禁
  const forbidden = [
    /\.insert\(/,
    /\.update\(/,
    /\.delete\(/,
    /\.upsert\(/,
    /\.rpc\(/,
    /service_role/,
    /qtrlymiqohbjvklwegsw/,
    /merge/i,
    /dangerouslySetInnerHTML/,
    /type="submit"/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `KnowledgeVaultPage 出现禁止模式: ${pattern}`);
  }
  assert.ok(!source.includes('@supabase/supabase-js'), 'KnowledgeVaultPage 不得直接引用 supabase-js');
  assert.ok(!source.includes('supabase-client'), 'KnowledgeVaultPage 不得直接引用 supabase-client');
  // 不得引用旧的治理服务
  assert.ok(!source.includes('knowledge-governance-service'), 'KnowledgeVaultPage 不得引用旧治理服务');
  assert.ok(!source.includes('knowledge-governance'), 'KnowledgeVaultPage 不得引用旧治理工具');
});

test('源码证据：Header 包含只读预览标识', () => {
  const source = readSource('src/components/Header.jsx');
  assert.ok(source.includes('线上只读预览'), 'Header 必须显示只读预览标识');
});

test('源码证据：Sidebar 品牌更新为只读预览', () => {
  const source = readSource('src/components/Sidebar.jsx');
  assert.ok(source.includes('线上只读预览'), 'Sidebar 品牌必须标注只读预览');
});

test('源码证据：App.jsx 仪表盘不再触发 CampaignContextBar', () => {
  const source = readSource('src/App.jsx');
  const contextPagesLine = source.match(/contextPages\s*=\s*new Set\(\[.*?\]\)/s);
  assert.ok(contextPagesLine, 'App.jsx 必须包含 contextPages');
  assert.ok(!contextPagesLine[0].includes("'dashboard'"), 'dashboard 不得在 contextPages 中');
});

// ============================================================================
// 源码证据：无网络请求/环境变量/外链
// ============================================================================
test('源码证据：新文件不含 fetch / axios / env / 外链 / 盘符', () => {
  for (const path of ['src/services/staging-preview-service.js', 'src/pages/CommandCenter.jsx', 'src/pages/KnowledgeVaultPage.jsx']) {
    const source = readSource(path);
    assert.ok(!source.includes('fetch(') && !source.includes('axios'), `${path} 不得直接发起网络请求`);
    assert.ok(!source.includes('import.meta.env'), `${path} 不得读取环境变量`);
    assert.ok(!source.includes('<a '), `${path} 不得渲染可点击外链`);
    assert.ok(!source.includes('<img'), `${path} 不得加载外部图片`);
    assert.ok(!source.includes('Date.now'), `${path} 不得依赖时钟`);
    assert.ok(!source.includes('Math.random'), `${path} 不得依赖随机数`);
    const forbidden = [/[A-Za-z]:[\\/]/, /https?:\/\//, /bearer/i, /api[_-]?key/i, /secret/i, /password/i];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(source), `${path} 出现禁止内容: ${pattern}`);
    }
  }
});

// ============================================================================
// 文件所有权测试
// ============================================================================
test('所有权与删除防护：仅授权路径发生受跟踪修改，无删除', () => {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain=v1'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
  } catch (error) {
    assert.fail(`git status 不可用: ${error.message}`);
  }
  for (const line of status.split('\n').filter(Boolean)) {
    const x = line[0];
    const y = line[1];
    if (x === '?' && y === '?') continue; // 未跟踪文件允许
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    if (x === 'D' || y === 'D') {
      for (const path of paths) {
        assert.ok(ALLOWED_DELETIONS.has(path), `不允许删除文件: ${path}`);
      }
      continue;
    }
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});

// ============================================================================
// 状态标签完整性
// ============================================================================
test('状态标签：所有页面源码包含 loading / empty / error / not_configured / not_signed_in 分支', () => {
  for (const path of ['src/pages/CommandCenter.jsx', 'src/pages/KnowledgeVaultPage.jsx']) {
    const source = readSource(path);
    // 每个页面必须处理的关键状态
    const states = [
      { label: '未配置', pattern: /not.configured|not_configured|notConfigured|等待数据服务配置/ },
      { label: '未登录', pattern: /not.signed.in|not_signed_in|notSignedIn|请先登录|请先登入/ },
      { label: '加载中', pattern: /loading|fetching|正在恢复登录|正在从 staging/ },
      { label: '空数据', pattern: /empty|为空|没有.*记录/ },
      { label: '读取错误', pattern: /error|read_error|读取失败|访问被拒绝/ },
    ];
    for (const state of states) {
      assert.ok(state.pattern.test(source), `${path} 缺少状态处理: ${state.label}`);
    }
  }
});

// ============================================================================
// 服务确定性
// ============================================================================
test('服务确定性：视图名与世系状态深冻结', () => {
  assert.ok(Object.isFrozen(STAGING_VIEWS), 'STAGING_VIEWS 必须冻结');
  assert.ok(Object.isFrozen(ALL_STAGING_VIEW_NAMES), 'ALL_STAGING_VIEW_NAMES 必须冻结');
  assert.ok(Object.isFrozen(LINEAGE_STATES), 'LINEAGE_STATES 必须冻结');
  // 序列化稳定
  const first = JSON.stringify({ STAGING_VIEWS, LINEAGE_STATES });
  const second = JSON.stringify({ STAGING_VIEWS, LINEAGE_STATES });
  assert.equal(first, second);
});
