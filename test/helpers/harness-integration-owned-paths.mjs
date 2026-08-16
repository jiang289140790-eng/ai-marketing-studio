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
  'services/harness-gateway/test/profile-bootstrap.test.mjs',
  'services/harness-gateway/test/profile-config.test.mjs',
  'services/harness-gateway/test/state-store.test.mjs',
  'supabase/functions/harness-command/index.ts',
  'supabase/functions/harness-command/edge-core.mjs',
  'src/pages/AIWorkspacePage.jsx',
  'src/pages/AIWorkspacePage.css',
  'src/services/harness-client.js',
  'src/services/harness-presentation.js',
  'test/h2-harness-edge-contract.test.mjs',
  'test/h3-harness-ui.browser.test.mjs',
  'test/h3-harness-ui.test.mjs',
  'test/harness-genui-visualize.test.mjs',
  'test/harness-genui-visualize.browser.test.mjs',
  'test/harness-deterministic-orchestrator.browser.test.mjs',
  'test/helpers/harness-integration-owned-paths.mjs',
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
  'services/harness-gateway/tool-client.mjs',
  'services/harness-gateway/tool-contract.mjs',
  'src/App.jsx',
  'src/components/Sidebar.jsx',
  'src/data/navigation.js',
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
]);

// Strict revision-2 contract with glob support (`/**` matches a directory and
// everything below it).
export const HARNESS_INTEGRATION_OWNED_GLOBS = Object.freeze([
  'services/harness-gateway/Dockerfile',
  'services/harness-gateway/package.json',
  'services/harness-gateway/package-lock.json',
  'services/harness-gateway/init-profile.mjs',
  'services/harness-gateway/profile/cordis.patch.yml',
  'services/harness-gateway/vendor/**',
  'services/harness-gateway/presentation/**',
  'services/harness-gateway/gateway-core.mjs',
  'services/harness-gateway/harness-runner.mjs',
  'services/harness-gateway/server.mjs',
  'services/harness-gateway/workflow-catalog.mjs',
  'services/harness-gateway/planner.mjs',
  'services/harness-gateway/deterministic-executor.mjs',
  'services/harness-gateway/state-store.mjs',
  'services/harness-gateway/tool-contract.mjs',
  'services/harness-gateway/test/**',
  'supabase/functions/harness-command/index.ts',
  'supabase/functions/harness-command/edge-core.mjs',
  'src/pages/AIWorkspacePage.jsx',
  'src/pages/AIWorkspacePage.css',
  'src/components/harness-presentation/**',
  'src/services/harness-client.js',
  'src/services/harness-presentation.js',
  'test/h2-harness-edge-contract.test.mjs',
  'test/h3-harness-ui.browser.test.mjs',
  'test/h3-harness-ui.test.mjs',
  'test/harness-genui-visualize.test.mjs',
  'test/harness-genui-visualize.browser.test.mjs',
  'test/harness-deterministic-orchestrator.browser.test.mjs',
  'test/helpers/harness-integration-owned-paths.mjs',
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
