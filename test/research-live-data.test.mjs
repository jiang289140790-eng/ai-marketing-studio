import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_INTEGRATION_OWNED_PATHS } from './helpers/harness-integration-owned-paths.mjs';
import {
  RESEARCH_EXECUTION_FLAGS,
  RESEARCH_READ_SCOPE,
  buildDevFallbackView,
  buildReadErrorView,
  fetchResearchWorkspaceData,
} from '../src/services/research-workspace-service.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const OWNED_PATHS = new Set([
  'src/App.jsx',
  'src/data/navigation.js',
  'src/contexts/auth-context.js',
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/data/research-workspace-demo.js',
  'src/services/research-workspace-service.js',
  'test/research-workspace.test.mjs',
  'test/research-live-data.test.mjs',
  'test/navigation-contract.test.mjs',
  'test/online-integrated-preview.test.mjs',
  // 上一里程碑遗留的未提交改动（本任务开始前已存在，本任务未触碰）。
  'src/pages/ContentWorkspacePage.jsx',
  'src/pages/Dashboard.jsx',
  'src/pages/KnowledgeVaultPage.jsx',
  'src/styles.css',
  // P17-C staging integrated preview 新增授权路径。
  'src/services/staging-preview-service.js',
  'src/components/Header.jsx',
  'src/components/Sidebar.jsx',
  'src/pages/CommandCenter.jsx',
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
  // P29 多模态 X 证据闭环新增授权路径（本里程碑）。
  'supabase/functions/p22-research-assist/assist-core.mjs',
  'supabase/functions/p22-research-assist/index.ts',
  'src/services/p22-research-assist.js',
  'src/components/integrated-workspace/P22ResearchAssistPanel.jsx',
  'test/p22-assisted-research.test.mjs',
  'test/p23-link-evidence-knowledge.test.mjs',
  'test/p24-knowledge-brief-review.test.mjs',
  'test/p29-multimodal-x-evidence.test.mjs',
  'test/p29-multimodal-x-evidence.browser.test.mjs',
  'docs/P29_MULTIMODAL_X_EVIDENCE_LOOP.md',
  // P36 渐进式交互重设计新增授权路径（本里程碑）。
  'src/components/integrated-workspace/P36ResearchDestinations.jsx',
  'test/p21-guided-research.test.mjs',
  'test/p32-hot-topic-search.browser.test.mjs',
  'test/p32-reddit-topic-search.browser.test.mjs',
  'test/p32-multipost-synthesis-brief.browser.test.mjs',
  'test/p20-browser-online.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
]);

// P19 已验收迁移对账唯一允许的删除：5 个过时时间戳变体，由已验收规范文件替代。
const ALLOWED_DELETIONS = new Set([
  'supabase/migrations/20260722141035_support_discord_and_read_business_intelligence.sql',
  'supabase/migrations/20260722142451_hard_finish_security_rls_and_search_path.sql',
  'supabase/migrations/20260722142535_restore_vector_operator_search_path.sql',
  'supabase/migrations/20260724133735_fix_content_packages_update_policy.sql',
  'supabase/migrations/20260725043407_day1_publish_state_machine.sql',
]);

// 链式 mock：记录所有调用，按表返回固定数据或错误。测试环境绝不发起网络请求。
function createMockClient(tables) {
  const calls = [];
  const handleFor = (table) => {
    const handle = {
      select() {
        calls.push(['select', table]);
        return handle;
      },
      eq(column, value) {
        calls.push(['eq', table, column, value]);
        return handle;
      },
      order(column, options) {
        calls.push(['order', table, column, options]);
        return handle;
      },
      limit(count) {
        calls.push(['limit', table, count]);
        return handle;
      },
      then(resolve, reject) {
        const entry = tables[table] || { data: [], error: null };
        return Promise.resolve({ data: entry.data || [], error: entry.error || null }).then(
          resolve,
          reject,
        );
      },
    };
    return handle;
  };
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      return handleFor(table);
    },
  };
}

function frozenFlagsObject() {
  return {
    generation_executed: false,
    routing_executed: false,
    network_executed: false,
    publish_executed: false,
  };
}

// 生产只读契约（intelligence-service.js + 账号情报架构迁移）的 mock 行：
// social_accounts 为单一账号实体，viral_contents 经 social_account_id 关联，
// content_analysis 经显式规范外键 content_analysis_viral_content_id_fkey 关联 viral_contents。
const DEMO_ROWS = {
  social_accounts: {
    data: [
      {
        id: 'acct-1',
        account_name: 'PetMate HQ',
        username: '@petmate_hq',
        platform: 'X',
        account_role: 'competitor',
        account_type: 'competitor',
        account_category: 'competitor',
        account_url: 'https://x.com/petmate_hq',
        target_audience: '宠物主',
        content_strategy: null,
        posting_frequency: null,
        ops_notes: '竞品账号',
        followers: 1280000,
        created_at: '2026-08-01T00:00:00Z',
        account_profiles: [{ target_audience: '宠物主' }],
      },
      {
        // 自有账号必须被研究来源过滤掉（角色不属于 competitor/inspiration）。
        id: 'acct-owned',
        account_name: 'My Studio',
        username: '@my_studio',
        platform: 'X',
        account_role: 'owned',
        account_type: 'owned',
        account_category: 'owned',
        account_url: null,
        target_audience: null,
        ops_notes: null,
        followers: 0,
        created_at: '2026-08-01T00:00:00Z',
        account_profiles: [],
      },
    ],
  },
  viral_contents: {
    data: [
      {
        id: 'vc-1',
        social_account_id: 'acct-1',
        platform: 'X',
        source_platform: 'X',
        url: 'https://x.com/petmate_hq/status/123',
        title: '猫咪第一次看到自动猫砂盆',
        content_text: '3 秒震惊镜头开场，全程无旁白。',
        media_url: null,
        views: 1280000,
        likes: 96000,
        comments: 3140,
        engagement_score: 1280000 + 96000 * 10 + 3140 * 20,
        viral_reason: '反差开场',
        content_type: 'video',
        ai_recommendation: '适合复刻',
        published_at: '2026-07-24T09:30:00Z',
        created_at: '2026-08-01T00:00:00Z',
        social_accounts: {
          id: 'acct-1',
          account_name: 'PetMate HQ',
          username: '@petmate_hq',
          platform: 'X',
          account_role: 'competitor',
        },
      },
      {
        id: 'vc-2',
        social_account_id: null,
        platform: 'Instagram',
        source_platform: 'Instagram',
        url: null,
        title: '新手养猫避坑清单',
        content_text: '轮播封面悬念标题。',
        media_url: null,
        views: 410000,
        likes: 32000,
        comments: 480,
        engagement_score: 410000 + 32000 * 10 + 480 * 20,
        viral_reason: null,
        content_type: 'carousel',
        ai_recommendation: null,
        published_at: null,
        created_at: '2026-08-01T00:00:00Z',
        social_accounts: null,
      },
    ],
  },
  content_analysis: {
    data: [
      {
        id: 'ca-1',
        viral_content_id: 'vc-1',
        content_id: 'vc-1',
        social_account_id: 'acct-1',
        analysis: '完整分析文本',
        hook: '3 秒情绪峰值开场',
        structure: '震惊开场 → 行为过程 → 结果验证',
        strategy: '复刻该结构',
        source_platform: 'X',
        engagement_score: 1280000 + 96000 * 10 + 3140 * 20,
        viral_reason: '反差开场',
        ai_recommendation: '适合复刻',
        replication_notes: '保持节奏',
        fit_score: 85,
        created_at: '2026-08-02T00:00:00Z',
        viral_contents: {
          title: '猫咪第一次看到自动猫砂盆',
          platform: 'X',
          url: 'https://x.com/petmate_hq/status/123',
          views: 1280000,
          likes: 96000,
          comments: 3140,
          content_text: '3 秒震惊镜头开场，全程无旁白。',
          published_at: '2026-07-24T09:30:00Z',
          viral_reason: '反差开场',
          ai_recommendation: '适合复刻',
          social_accounts: {
            account_name: 'PetMate HQ',
            username: '@petmate_hq',
            platform: 'X',
            account_role: 'competitor',
          },
        },
      },
    ],
  },
};

test('未配置运行时：返回 not_configured，不接触任何查询客户端', async () => {
  const result = await fetchResearchWorkspaceData({ configured: false, userId: 'u1' });
  assert.equal(result.status, 'not_configured');
  assert.equal(result.configured, false);
  assert.equal(result.signedIn, false);
  assert.ok(result.note.includes('未配置'));
  assert.deepEqual(result.counts, { sources: 0, evidence: 0, analyses: 0, knowledge: 0, brief: 0 });
  assert.equal(result.error, null);
  assert.deepEqual(result.executionFlags, frozenFlagsObject());
});

test('已配置但未登录：返回 not_signed_in，零查询', async () => {
  const client = createMockClient({});
  const result = await fetchResearchWorkspaceData({ configured: true, userId: null, client });
  assert.equal(result.status, 'not_signed_in');
  assert.equal(result.configured, true);
  assert.equal(result.signedIn, false);
  assert.ok(result.note.includes('登录'));
  assert.deepEqual(client.calls, [], '未登录不得发起任何查询');
});

test('实时成功：组合真实记录、溯源完整、知识/Brief 显式不可用', async () => {
  const client = createMockClient(DEMO_ROWS);
  const result = await fetchResearchWorkspaceData({ configured: true, userId: 'u1', client });

  assert.equal(result.status, 'live');
  assert.equal(result.configured, true);
  assert.equal(result.signedIn, true);
  assert.equal(result.error, null);
  assert.deepEqual(result.counts, { sources: 1, evidence: 2, analyses: 1, knowledge: 0, brief: 0 });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].name, '@petmate_hq');
  assert.equal(result.sources[0].followers, 1280000);
  assert.equal(result.sources[0].category, 'competitor');
  assert.ok(
    result.sources.every((source) => source.id !== 'acct-owned'),
    '自有账号（owned）不得作为研究来源',
  );

  assert.equal(result.evidence.length, 2);
  const first = result.evidence[0];
  assert.equal(first.name, '猫咪第一次看到自动猫砂盆');
  assert.equal(first.views, 1280000);
  assert.equal(first.likes, 96000);
  assert.equal(first.comments, 3140);
  assert.equal(first.accountId, 'acct-1');
  assert.equal(first.account.username, '@petmate_hq');
  assert.ok(first.provenance.includes('仅展示，不请求'));
  assert.equal(result.evidence[1].account, null);
  assert.ok(result.evidence[1].provenance.includes('没有保存来源链接'));

  assert.equal(result.analyses.length, 1);
  assert.equal(result.analyses[0].evidenceId, 'vc-1');
  assert.equal(result.analyses[0].title, '猫咪第一次看到自动猫砂盆');
  assert.equal(result.analyses[0].hook, '3 秒情绪峰值开场');

  assert.equal(result.knowledge.available, false);
  assert.equal(result.knowledge.items.length, 0);
  assert.ok(result.knowledge.reason.includes('当前后端数据不可用'));
  assert.equal(result.brief.available, false);
  assert.equal(result.brief.data, null);
  assert.ok(result.brief.reason.includes('当前后端数据不可用'));

  assert.deepEqual(result.provenance.tablesRead, ['social_accounts', 'viral_contents', 'content_analysis']);
  assert.equal(result.provenance.ops, 'select_only');
  assert.ok(result.provenance.note.includes('仅 SELECT'));
  assert.deepEqual(result.executionFlags, frozenFlagsObject());

  // 只允许 SELECT 类调用，且全部按 user_id 约束。
  const methodCalls = client.calls.filter(([method]) => method !== 'from');
  const allowedMethods = new Set(['select', 'eq', 'order', 'limit']);
  for (const call of methodCalls) {
    assert.ok(allowedMethods.has(call[0]), `出现非只读调用: ${call.join(',')}`);
  }
  const userIdCalls = methodCalls.filter(([method]) => method === 'eq');
  assert.equal(userIdCalls.length, 3, '三个表都必须按 user_id 过滤');
  for (const call of userIdCalls) {
    assert.equal(call[2], 'user_id');
    assert.equal(call[3], 'u1');
  }
  const fromTables = client.calls.filter(([method]) => method === 'from').map((call) => call[1]);
  assert.deepEqual(fromTables, ['social_accounts', 'viral_contents', 'content_analysis']);
});

test('实时读取错误：read_error 如实呈现，绝不含示例数据', async () => {
  const tables = {
    social_accounts: DEMO_ROWS.social_accounts,
    viral_contents: DEMO_ROWS.viral_contents,
    content_analysis: { data: [], error: { message: 'select permission denied for table content_analysis' } },
  };
  const client = createMockClient(tables);
  const result = await fetchResearchWorkspaceData({ configured: true, userId: 'u1', client });

  assert.equal(result.status, 'read_error');
  assert.ok(result.error.message.includes('content_analysis'));
  assert.deepEqual(result.counts, { sources: 0, evidence: 0, analyses: 0, knowledge: 0, brief: 0 });
  assert.deepEqual(result.evidence, []);
  assert.deepEqual(result.analyses, []);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('本地示例'), '读取失败视图不得包含示例数据');
  assert.ok(!serialized.includes('petmate'), '读取失败视图不得包含任何真实记录内容');
});

test('真实空库：status empty，计数为 0', async () => {
  const client = createMockClient({
    social_accounts: { data: [] },
    viral_contents: { data: [] },
    content_analysis: { data: [] },
  });
  const result = await fetchResearchWorkspaceData({ configured: true, userId: 'u1', client });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.counts, { sources: 0, evidence: 0, analyses: 0, knowledge: 0, brief: 0 });
  assert.ok(result.note.includes('实时后端为空'));
});

test('显式读取失败视图构建器：结构完整且不含数据', () => {
  const view = buildReadErrorView('网络不可达');
  assert.equal(view.status, 'read_error');
  assert.equal(view.error.message, '网络不可达');
  assert.deepEqual(view.evidence, []);
  assert.deepEqual(view.analyses, []);
  assert.deepEqual(view.executionFlags, frozenFlagsObject());
});

test('开发用本地示例回退：显式构建、明确标注、默认由页面关闭', () => {
  const view = buildDevFallbackView();
  assert.equal(view.status, 'dev_fallback');
  assert.equal(view.devFallback, true);
  assert.equal(view.configured, false);
  assert.equal(view.counts.evidence, 3);
  assert.equal(view.knowledge.available, true);
  assert.ok(view.knowledge.reason.includes('非实时后端数据'));
  assert.equal(view.brief.available, true);
  assert.deepEqual(view.provenance.tablesRead, []);
  assert.equal(view.provenance.ops, 'local_preview_only');
  assert.deepEqual(view.executionFlags, frozenFlagsObject());

  // P19 页面已移除开发回退开关：本地工作台不依赖实时后端，也不降级示例数据。
  const pageSource = readFileSync(join(REPO_ROOT, 'src/pages/ResearchWorkspacePage.jsx'), 'utf8');
  assert.ok(!pageSource.includes('devFallbackOn'), 'P19 页面不得保留 P18 开发回退开关');
  assert.ok(pageSource.includes('本地草稿'), 'P19 页面必须显式标注本地草稿模式');
});

test('适配器源码：仅 SELECT，无写操作/RPC/存储/实时/密钥/网络目标', () => {
  const raw = readFileSync(join(REPO_ROOT, 'src/services/research-workspace-service.js'), 'utf8');
  // 扫描可执行代码行（注释中的边界声明不属于代码访问点）。
  const source = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const forbidden = [
    '.insert(',
    '.update(',
    '.delete(',
    '.rpc(',
    '.upsert(',
    '.storage',
    '.channel(',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'import.meta.env',
    'process.env',
    'Date.now',
    'Math.random',
  ];
  for (const token of forbidden) {
    assert.ok(!source.includes(token), `适配器源码出现禁止内容: ${token}`);
  }
  const secretPatterns = [
    /[A-Za-z]:[\\/]/,
    /https?:\/\//,
    /\.env/,
    /bearer/i,
    /api[_-]?key/i,
    /password/i,
    /apify/i,
  ];
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(source), `适配器源码出现禁止模式: ${pattern}`);
  }
});

test('执行标志：四项严格 false', () => {
  assert.deepEqual(RESEARCH_EXECUTION_FLAGS, frozenFlagsObject());
});

test('读取范围元数据：与实现一致、明确 select_only', () => {
  assert.equal(RESEARCH_READ_SCOPE.ops, 'select_only');
  assert.deepEqual(RESEARCH_READ_SCOPE.tables, ['social_accounts', 'viral_contents', 'content_analysis']);
  assert.ok(RESEARCH_READ_SCOPE.note.includes('SELECT'));
  assert.ok(RESEARCH_READ_SCOPE.note.includes('无写操作'));
  assert.equal(RESEARCH_READ_SCOPE.knowledge.available, false);
  assert.equal(RESEARCH_READ_SCOPE.brief.available, false);
  assert.ok(
    RESEARCH_READ_SCOPE.fields.viral_contents.some((field) => field.includes('social_accounts:social_account_id')),
    '读取范围必须按 social_account_id 声明 viral_contents 到 social_accounts 的关系',
  );
  assert.ok(
    RESEARCH_READ_SCOPE.fields.content_analysis.some((field) => field.includes('content_analysis_viral_content_id_fkey')),
    '读取范围必须显式命名 content_analysis 到 viral_contents 的规范外键',
  );
});

test('适配器源码：与生产内容情报只读契约一致（social_accounts / social_account_id / 显式 FK）', () => {
  const raw = readFileSync(join(REPO_ROOT, 'src/services/research-workspace-service.js'), 'utf8');
  // 只扫描可执行代码行（注释中的契约说明不属于代码访问点）。
  const source = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.ok(source.includes("from('social_accounts')"), '来源必须读取 social_accounts（单一账号实体）');
  assert.ok(source.includes('social_accounts:social_account_id'), 'viral_contents 必须按 social_account_id 关联 social_accounts');
  assert.ok(source.includes('content_analysis_viral_content_id_fkey'), 'content_analysis 到 viral_contents 必须显式命名规范外键');
  assert.ok(source.includes('resolveAccountRole'), '研究来源必须按生产角色契约过滤');
  assert.ok(!source.includes('competitor_accounts'), '不得再读取历史遗留的 competitor_accounts 表');
  assert.ok(!source.includes(':account_id('), '不得再使用历史遗留的 account_id 关联');
});

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
    if (x === '?' && y === '?') continue;
    const paths = line.slice(3).split(' -> ').map((part) => part.trim());
    if (x === 'D' || y === 'D') {
      for (const path of paths) {
        assert.ok(ALLOWED_DELETIONS.has(path), `不允许删除文件: ${path}`);
      }
      continue;
    }
    for (const path of paths) {
      assert.ok(OWNED_PATHS.has(path) || HARNESS_INTEGRATION_OWNED_PATHS.has(path), `受跟踪修改超出授权路径: ${path}`);
    }
  }
});
