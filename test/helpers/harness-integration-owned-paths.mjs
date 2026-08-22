// Harness GenUI/visualize integration file ownership.
//
// Two views of the same boundary coexist:
// - HARNESS_INTEGRATION_OWNED_PATHS: a legacy Set of concrete paths shared
//   with earlier harness milestones; existing milestone tests call `.has()`
//   on it for their tracked-modification gates, so it stays a superset.
// - HARNESS_INTEGRATION_OWNED_GLOBS + isPathOwned + unownedChangedPaths: the
//   strict revision-2 contract of task
//   ams-harness-genui-visualize-structured-results (glob support), used by
//   this task's own diff gate to prove every changed business path stays
//   inside the allowed set.
import { execFileSync } from 'node:child_process';

export const HARNESS_INTEGRATION_OWNED_PATHS = new Set([
  // Revision-2 contract (concrete files; glob-covered directories are
  // enumerated through HARNESS_INTEGRATION_OWNED_GLOBS below).
  'services/harness-gateway/Dockerfile',
  'services/harness-gateway/package.json',
  'services/harness-gateway/package-lock.json',
  'services/harness-gateway/init-profile.mjs',
  'services/harness-gateway/profile/cordis.patch.yml',
  'services/harness-gateway/gateway-core.mjs',
  'services/harness-gateway/harness-runner.mjs',
  'services/harness-gateway/server.mjs',
  'services/harness-gateway/workflow-catalog.mjs',
  'services/harness-gateway/planner.mjs',
  'services/harness-gateway/deterministic-executor.mjs',
  'services/harness-gateway/state-store.mjs',
  'services/harness-gateway/test/plan-confirm-queue.test.mjs',
  'services/harness-gateway/test/profile-bootstrap.test.mjs',
  'services/harness-gateway/test/profile-config.test.mjs',
  'services/harness-gateway/test/state-store.test.mjs',
  'supabase/functions/harness-command/index.ts',
  'supabase/functions/harness-command/edge-core.mjs',
  'src/pages/AIWorkspacePage.jsx',
  'src/pages/AIWorkspacePage.css',
  'src/services/harness-client.js',
  'src/services/harness-presentation.js',
  'test/g1-harness-tools.test.mjs',
  'test/h2-harness-edge-contract.test.mjs',
  'test/h3-harness-ui.browser.test.mjs',
  'test/h3-harness-ui.test.mjs',
  'test/harness-genui-visualize.test.mjs',
  'test/harness-genui-visualize.browser.test.mjs',
  'test/harness-deterministic-orchestrator.browser.test.mjs',
  'test/helpers/harness-integration-owned-paths.mjs',
  // G1 generation execution layer (accepted image-contract repair + video
  // status/artifact preview repair): exact modified paths only.
  'services/generation-worker/bailian-adapter.mjs',
  'services/generation-worker/db-adapter.mjs',
  'services/generation-worker/recover-existing-task.mjs',
  'services/generation-worker/worker.mjs',
  'test/g1-provider-adapter.test.mjs',
  'test/g1-worker.test.mjs',
  'test/g1-generation.browser.test.mjs',
  'test/g2-simplified-generation-workspace.test.mjs',
  'src/components/generation-execution/GenerationJobCard.jsx',
  'src/components/generation-execution/GenerationArtifactViewer.jsx',
  'src/pages/GenerationTasksPage.jsx',
  'src/pages/GenerationTasksPage.css',
  'src/App.jsx',
  'src/data/navigation.js',
  'supabase/migrations/20260820071137_g1_existing_provider_task_artifact_recovery.sql',
  // G1 P19 Evidence quote binding final repair: exact migration and
  // corresponding database/P19 replay tests authorized for this closure.
  'supabase/migrations/20260819080000_g1_p19_evidence_quote_binding_v1.sql',
  'supabase/migrations/20260820050013_g1_p19_evidence_quote_binding_acl_closeout.sql',
  'supabase/tests/g1_b0_generation_adversarial.test.sql',
  'test/g1-migration-replay.test.mjs',
  'test/p19-sql-integration.test.mjs',
  // Legacy union from earlier harness milestones (their tests call `.has()`).
  'services/harness-gateway/compose.yaml',
  'services/harness-gateway/home-lockdown.patch.yml',
  'services/harness-gateway/plugins/ams-tools/index.mjs',
  'services/harness-gateway/plugins/ams-tools/artifact-journal.mjs',
  'services/harness-gateway/plugins/ams-tools/package.json',
  'services/harness-gateway/presentation/presentation-contract.mjs',
  'services/harness-gateway/profile/package.json',
  'services/harness-gateway/profile/pnpm-workspace.yaml',
  'services/harness-gateway/server.mjs',
  'services/harness-gateway/start.mjs',
  'services/harness-gateway/test/gateway-core.test.mjs',
  'services/harness-gateway/test/artifact-journal.test.mjs',
  'services/harness-gateway/test/harness-runner.test.mjs',
  'services/harness-gateway/test/tool-client.test.mjs',
  'services/harness-gateway/test/tool-contract.test.mjs',
  'services/harness-gateway/test/deterministic-executor.test.mjs',
  'services/harness-gateway/test/planner.test.mjs',
  'services/harness-gateway/tool-client.mjs',
  'services/harness-gateway/tool-contract.mjs',
  'src/App.jsx',
  'src/components/Header.jsx',
  'src/components/Sidebar.jsx',
  'src/styles.css',
  'src/data/navigation.js',
  'src/utils/app-route.js',
  'supabase/functions/harness-command/edge-core.mjs',
  'supabase/functions/harness-tool-bridge/bridge-core.mjs',
  'supabase/functions/harness-tool-bridge/index.ts',
  'supabase/functions/p19-workspace-command/command-core.mjs',
  'supabase/functions/p19-workspace-command/index.ts',
  'supabase/migrations/20260814094040_harness_atomic_project_revision_guard.sql',
  'supabase/functions/p22-research-assist/assist-core.mjs',
  'supabase/functions/p22-research-assist/index.ts',
  'test/h3-harness-ui.browser.test.mjs',
  'test/h3-harness-ui.test.mjs',
  'test/p19-sql-integration.test.mjs',
  'test/p19-api-schema.test.mjs',
  'docs/ENGINEERING_BASELINE.md',
  'test/navigation-contract.test.mjs',
  'test/online-integrated-preview.test.mjs',
  'test/p17c-staging-preview.test.mjs',
  'test/p18-integrated-product-chain.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
  'test/research-live-data.test.mjs',
  'test/research-workspace.test.mjs',
  // AI 三页任务架构（新任务首页/执行详情/结果与审核）：精确路径清单。
  'src/pages/TaskExecutionPage.jsx',
  'src/pages/TaskResultsPage.jsx',
  'src/pages/ai-task-pages.css',
  'src/services/harness-task-model.js',
  'test/ai-three-page-model.test.mjs',
  'test/ai-three-page-route.test.mjs',
  'test/ai-three-page.browser.test.mjs',
  'acceptance-evidence/ai-three-page-architecture-2026-08-23/**',
  // REVIEW repair 2（三页任务架构）：P30 内容创建模式浏览器测试的确定性修复
  // （Brief gate 契约对齐 p19-workspace-command + 固定时钟/编号/证据临时目录），
  // 仅该测试文件本身，无通配；业务代码零改动。
  'test/content-creation-modes.browser.test.mjs',
]);

// Strict revision-2 contract with glob support (`/**` matches a directory and
// everything below it).
export const HARNESS_INTEGRATION_OWNED_GLOBS = Object.freeze([
  'services/harness-gateway/Dockerfile',
  'services/harness-gateway/package.json',
  'services/harness-gateway/package-lock.json',
  'services/harness-gateway/init-profile.mjs',
  'services/harness-gateway/profile/cordis.patch.yml',
  // ams-harness-rc8-isolated-upgrade: exact rc.8 paths only (no directory
  // wildcard expansion).
  'services/harness-gateway/compose.yaml',
  'services/harness-gateway/home-lockdown.patch.yml',
  'services/harness-gateway/plugins/ams-tools/package.json',
  'services/harness-gateway/vendor/**',
  'services/harness-gateway/presentation/**',
  'services/harness-gateway/gateway-core.mjs',
  'services/harness-gateway/harness-runner.mjs',
  'services/harness-gateway/server.mjs',
  'services/harness-gateway/workflow-catalog.mjs',
  'services/harness-gateway/planner.mjs',
  'services/harness-gateway/deterministic-executor.mjs',
  'services/harness-gateway/state-store.mjs',
  'services/harness-gateway/tool-client.mjs',
  'services/harness-gateway/tool-contract.mjs',
  'services/harness-gateway/test/**',
  'supabase/functions/harness-command/index.ts',
  'supabase/functions/harness-command/edge-core.mjs',
  'supabase/functions/harness-tool-bridge/bridge-core.mjs',
  'src/pages/AIWorkspacePage.jsx',
  'src/pages/AIWorkspacePage.css',
  'src/components/harness-presentation/**',
  'src/services/harness-client.js',
  'src/services/harness-presentation.js',
  'test/g1-harness-tools.test.mjs',
  'test/h2-harness-edge-contract.test.mjs',
  'test/h3-harness-ui.browser.test.mjs',
  'test/h3-harness-ui.test.mjs',
  'test/harness-genui-visualize.test.mjs',
  'test/harness-genui-visualize.browser.test.mjs',
  'test/harness-deterministic-orchestrator.browser.test.mjs',
  'test/helpers/harness-integration-owned-paths.mjs',
  // G1 generation execution layer (accepted image-contract repair + video
  // status/artifact preview repair): exact modified paths only.
  'services/generation-worker/bailian-adapter.mjs',
  'services/generation-worker/db-adapter.mjs',
  'services/generation-worker/recover-existing-task.mjs',
  'services/generation-worker/worker.mjs',
  'test/g1-provider-adapter.test.mjs',
  'test/g1-worker.test.mjs',
  'test/g1-generation.browser.test.mjs',
  'test/g2-simplified-generation-workspace.test.mjs',
  'src/components/generation-execution/GenerationJobCard.jsx',
  'src/components/generation-execution/GenerationArtifactViewer.jsx',
  'src/pages/GenerationTasksPage.jsx',
  'src/pages/GenerationTasksPage.css',
  'src/App.jsx',
  'src/components/Header.jsx',
  'src/components/Sidebar.jsx',
  'src/styles.css',
  'src/data/navigation.js',
  'src/utils/app-route.js',
  'test/navigation-contract.test.mjs',
  'test/online-integrated-preview.test.mjs',
  'test/p17c-staging-preview.test.mjs',
  'test/p18-integrated-product-chain.test.mjs',
  'test/p36-research-ux-redesign.test.mjs',
  'test/research-live-data.test.mjs',
  'test/research-workspace.test.mjs',
  'supabase/migrations/20260820071137_g1_existing_provider_task_artifact_recovery.sql',
  // G1 P19 Evidence quote binding final repair: the same exact paths
  // mirrored from HARNESS_INTEGRATION_OWNED_PATHS for the strict diff gate,
  // plus the forward ACL closeout migration (exact path only, no globs).
  'supabase/migrations/20260819080000_g1_p19_evidence_quote_binding_v1.sql',
  'supabase/migrations/20260820050013_g1_p19_evidence_quote_binding_acl_closeout.sql',
  'supabase/tests/g1_b0_generation_adversarial.test.sql',
  'test/g1-migration-replay.test.mjs',
  'test/p19-sql-integration.test.mjs',
  // AI 三页任务架构（新任务首页/执行详情/结果与审核）：严格 diff 门禁镜像。
  'src/pages/TaskExecutionPage.jsx',
  'src/pages/TaskResultsPage.jsx',
  'src/pages/ai-task-pages.css',
  'src/services/harness-task-model.js',
  'test/ai-three-page-model.test.mjs',
  'test/ai-three-page-route.test.mjs',
  'test/ai-three-page.browser.test.mjs',
  'acceptance-evidence/ai-three-page-architecture-2026-08-23/**',
  // REVIEW repair 2：P30 内容创建模式浏览器测试确定性修复（严格门禁镜像）。
  'test/content-creation-modes.browser.test.mjs',
]);

// Environment files the harness itself writes next to the worktree; they are
// not business changes and are excluded from the ownership gate.
export const HARNESS_ENVIRONMENT_PATHS = Object.freeze([
  '.agentbridge/**',
  'AGENTS.md',
  'CLAUDE.md',
]);

function globMatches(pattern, normalized) {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }
  return normalized === pattern;
}

export function isPathOwned(path) {
  const normalized = String(path).replace(/\\/g, '/');
  return HARNESS_INTEGRATION_OWNED_GLOBS.some((pattern) => globMatches(pattern, normalized));
}

/**
 * Glob-aware membership on the legacy Set: entries ending in `/**` match a
 * directory and everything below it (the Set predates glob support, so plain
 * `.has()` never matched them — e.g. the acceptance-evidence directory of the
 * AI three-page milestone). Exact entries keep exact-match semantics, so
 * scope outside the declared ownership is still rejected.
 */
export function isHarnessOwnedPath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  return HARNESS_INTEGRATION_OWNED_PATHS.has(normalized)
    || [...HARNESS_INTEGRATION_OWNED_PATHS].some((pattern) => globMatches(pattern, normalized));
}

export function isEnvironmentPath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  return HARNESS_ENVIRONMENT_PATHS.some((pattern) => globMatches(pattern, normalized));
}

/**
 * Repo-relative paths changed against the baseline (tracked diff + untracked
 * files). The portable environment leaks GIT_DIR into child processes, which
 * makes git misreport "not a repository"; the env is cleaned explicitly here.
 */
export function changedPaths({ cwd = process.cwd(), baseline = 'HEAD' } = {}) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  const tracked = execFileSync('git', ['diff', '--name-only', '-z', baseline], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0').filter(Boolean);
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\0').filter(Boolean);
  return [...new Set([...tracked, ...untracked])];
}

export function unownedChangedPaths(options) {
  return changedPaths(options).filter((path) => !isPathOwned(path) && !isEnvironmentPath(path));
}
