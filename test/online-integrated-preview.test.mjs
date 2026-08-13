// P17-C 在线集成预览修复：本测试不再依赖缺失的 src/data/online-integrated-preview.js
// 模块（该模块从未提交到仓库）。现替换为有界的 P17-C staging 预览边界覆盖，
// 验证当前已提交的 P17-C 实现完整性。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---- P17-C 授权路径清单 -------------------------------------------------------
// 包含：既有里程碑路径 + 研究工作台路径 + P17-C staging 集成预览新增路径。
const OWNED_PATHS = new Set([
  // 既有里程碑路径（在线集成预览 → 研究工作台）
  'src/App.jsx',
  'src/data/navigation.js',
  'src/utils/app-route.js',
  'src/pages/Dashboard.jsx',
  'src/pages/KnowledgeVaultPage.jsx',
  'src/pages/ContentWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.jsx',
  'src/pages/ResearchWorkspacePage.css',
  'src/data/research-workspace-demo.js',
  'src/services/research-workspace-service.js',
  'src/contexts/auth-context.js',
  'src/styles.css',
  'test/online-integrated-preview.test.mjs',
  'test/research-workspace.test.mjs',
  'test/research-live-data.test.mjs',
  'test/navigation-contract.test.mjs',
  // P17-C staging 集成预览新增路径
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

// ---- 辅助函数 -----------------------------------------------------------------
function readSource(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

// ==============================================================================
// 自检：本测试不依赖缺失模块
// ==============================================================================
test('自检：缺失的 online-integrated-preview.js 模块确实不存在于仓库中', () => {
  let missing = false;
  try {
    readFileSync(join(REPO_ROOT, 'src/data/online-integrated-preview.js'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') missing = true;
  }
  assert.ok(missing, '缺失的 src/data/online-integrated-preview.js 必须不存在于仓库中（该模块从未提交）');
  // 本测试文件不包含从缺失模块的 import 语句。
  // 顶部仅有 node:* 内置模块和 staging-preview-service.js 的导入。
});

// ==============================================================================
// P17-C staging 预览服务边界
// ==============================================================================
test('P17-C 边界：staging-preview-service.js 可导入且导出正确的公开 API', async () => {
  const mod = await import('../src/services/staging-preview-service.js');

  // 视图常量
  assert.ok(mod.STAGING_VIEWS, '必须导出 STAGING_VIEWS');
  assert.ok(Object.isFrozen(mod.STAGING_VIEWS), 'STAGING_VIEWS 必须冻结');
  assert.ok(mod.ALL_STAGING_VIEW_NAMES, '必须导出 ALL_STAGING_VIEW_NAMES');
  assert.ok(Object.isFrozen(mod.ALL_STAGING_VIEW_NAMES), 'ALL_STAGING_VIEW_NAMES 必须冻结');
  assert.equal(mod.ALL_STAGING_VIEW_NAMES.length, 5, '必须是五视图');

  // 世系状态
  assert.ok(mod.LINEAGE_STATES, '必须导出 LINEAGE_STATES');
  assert.ok(Object.isFrozen(mod.LINEAGE_STATES), 'LINEAGE_STATES 必须冻结');

  // 运行时状态
  const runtime = mod.getStagingRuntimeStatus();
  assert.equal(runtime.readOnly, true, '运行时必须为只读');
  assert.equal(runtime.views.length, 5, '运行时必须列出五视图');

  // 公开函数
  assert.equal(typeof mod.fetchAllStagingData, 'function', '必须导出 fetchAllStagingData');
  assert.equal(typeof mod.fetchKnowledgeEngineData, 'function', '必须导出 fetchKnowledgeEngineData');
  assert.equal(typeof mod.fetchLineageAuditData, 'function', '必须导出 fetchLineageAuditData');
  assert.equal(typeof mod.buildStagingNotConfiguredView, 'function');
  assert.equal(typeof mod.buildStagingNotSignedInView, 'function');
  assert.equal(typeof mod.buildStagingReadErrorView, 'function');
  assert.equal(typeof mod.lineageStateDisplay, 'function');
});

test('P17-C 边界：staging-preview-service 使用 schema("api") 只读模式且不含禁词', () => {
  const source = readSource('src/services/staging-preview-service.js');
  assert.ok(source.includes("schema('api')"), '必须使用 schema(api)');
  assert.ok(source.includes('.from('), '必须使用 from()');
  assert.ok(source.includes('.select('), '必须使用 select()');

  const forbidden = [
    'qtrlymiqohbjvklwegsw',
    'ams_private',
    'service_role',
    '.insert(',
    '.update(',
    '.delete(',
    '.upsert(',
    '.rpc(',
  ];
  for (const pattern of forbidden) {
    assert.ok(!source.includes(pattern), `服务出现禁止内容: ${pattern}`);
  }
});

// ==============================================================================
// P17-C 路由边界：App.jsx
// ==============================================================================
test('P17-C 边界：App.jsx 将 #/dashboard 默认路由指向 CommandCenter', () => {
  const source = readSource('src/App.jsx');
  assert.ok(source.includes("import('./pages/CommandCenter')"),
    'App.jsx 必须延迟导入 CommandCenter');
  assert.ok(source.includes('<CommandCenter {...props} />'),
    '默认路由（dashboard）必须渲染 CommandCenter');
  // Dashboard.jsx 不再是活跃路由页面
  assert.ok(!source.includes("import('./pages/Dashboard')"),
    'App.jsx 不得导入旧 Dashboard');
});

// ==============================================================================
// Dashboard.jsx：保留既有能力（不再作为活跃 #/dashboard 路由）
// ==============================================================================
test('Dashboard.jsx：保留统计网格、账号/素材/角色入口与配置检查', () => {
  const source = readSource('src/pages/Dashboard.jsx');
  assert.ok(source.includes('listSocialAccounts'), '必须列出社交账号');
  assert.ok(source.includes('listAssets'), '必须列出素材');
  assert.ok(source.includes('listCharacters'), '必须列出角色');
  assert.ok(source.includes('stat-grid'), '必须渲染统计网格');
  assert.ok(source.includes('isSupabaseConfigured'), '必须检查 Supabase 配置');
  assert.ok(source.includes('等待 Supabase 配置'), '必须显示未配置状态');
  assert.ok(source.includes('请先登录'), '必须显示未登录状态');
});

// ==============================================================================
// ContentWorkspacePage.jsx：保留本地编辑预设（d769d7f 实施）
// ==============================================================================
test('ContentWorkspacePage.jsx：保留 LOCAL_EDIT_PRESETS 与三个本地编辑工作流', () => {
  const source = readSource('src/pages/ContentWorkspacePage.jsx');
  assert.ok(source.includes('LOCAL_EDIT_PRESETS'), '必须保留本地编辑预设');
  assert.ok(source.includes('persephone_klein_outfit_edit_api_v1'),
    '必须保留本地换衣工作流 ID');
  assert.ok(source.includes('persephone_klein_body_repair_api_v1'),
    '必须保留本地修复工作流 ID');
  assert.ok(source.includes('persephone_klein_background_edit_api_v1'),
    '必须保留本地改背景工作流 ID');
});

// ==============================================================================
// KnowledgeVaultPage.jsx：P17-C staging 集成
// ==============================================================================
test('KnowledgeVaultPage.jsx：集成 staging-preview-service 四视图', () => {
  const source = readSource('src/pages/KnowledgeVaultPage.jsx');
  assert.ok(source.includes('staging-preview-service'), '必须引用 staging 服务');
  assert.ok(source.includes('fetchKnowledgeEngineData'), '必须调用知识引擎读取');
  assert.ok(source.includes('ke_knowledge_cards_v1'), '必须引用知识卡视图');
  assert.ok(source.includes('ke_content_briefs_v1'), '必须引用 Brief 视图');
  assert.ok(source.includes('ke_handoff_manifest_v1'), '必须引用交接清单视图');
  assert.ok(source.includes('ke_handoff_package_detail_v1'), '必须引用包详情视图');
});

// ==============================================================================
// CommandCenter.jsx：P17-C 指挥中心页面存在且结构与合约一致
// ==============================================================================
test('CommandCenter.jsx：文件存在、导出 CommandCenter 且包含 P17-C 工作流链', () => {
  const source = readSource('src/pages/CommandCenter.jsx');
  assert.ok(source.includes('export function CommandCenter'), '必须导出 CommandCenter 函数组件');
  assert.ok(source.includes('staging-preview-service'), '必须引用 staging 服务');
  assert.ok(source.includes('fetchAllStagingData'), '必须调用批量数据读取');
  assert.ok(source.includes('研究工作流'), '必须展示工作流链');
  assert.ok(source.includes('世系审计'), '必须展示世系审计');
  assert.ok(source.includes('安全边界'), '必须展示安全边界');
});

// ==============================================================================
// Header.jsx 与 Sidebar.jsx：只读标识
// ==============================================================================
test('Header.jsx 与 Sidebar.jsx：标注线上只读预览', () => {
  assert.ok(readSource('src/components/Header.jsx').includes('线上只读预览'),
    'Header 必须显示只读预览标识');
  assert.ok(readSource('src/components/Sidebar.jsx').includes('线上只读预览'),
    'Sidebar 品牌必须标注只读预览');
});

// ==============================================================================
// 所有权与删除防护
// ==============================================================================
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

// ==============================================================================
// 有界条目数量
// ==============================================================================
test('有界条目数量：OWNED_PATHS 不超过合理上限', () => {
  // P19 + P29 里程碑合法扩充授权路径（迁移对账 + 工作台服务 + 函数 + 测试 + 文档）。
  // P36 adds one bounded destination component plus its real-browser regression
  // coverage. Keep the sentinel tight enough to catch accidental whole-repo
  // ownership expansion while accounting for the explicitly reviewed paths.
  assert.ok(OWNED_PATHS.size <= 70, `路径集过大: ${OWNED_PATHS.size}`);
});
