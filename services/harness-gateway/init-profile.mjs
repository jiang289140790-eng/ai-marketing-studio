/* global URL */
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.HARNESS_HOME || '/data/harness';
const workspaceRoot = process.env.HARNESS_WORKSPACE || '/workspace';
const amsWorkspacePath = join(workspaceRoot, 'node');
const appRoot = fileURLToPath(new URL('.', import.meta.url));
const profileSource = join(appRoot, 'profile');
const profileWebSource = join(appRoot, 'profile-web');
const pluginSource = join(appRoot, 'plugins', 'ams-tools');
const conversationPluginSource = join(appRoot, 'plugins', 'ams-conversation-runner');
const vendorSource = join(appRoot, 'vendor');
const homeLockdownSource = join(appRoot, 'home-lockdown.patch.yml');
const target = join(home, 'profiles', 'ams');
const webTarget = join(home, 'profiles', 'web');
const marker = join(target, '.ams-profile-version');
const settingsFile = join(home, 'settings.yaml');
// Advance this marker whenever a persisted profile input changes.  The
// runtime volume survives container replacement, so reusing an old marker
// would leave the previous plugin copy active even though the image contains
// a newer AMS conversation tool catalog.
const version = 'ams-profile-v20-native-standard-session';
// The only plugins promoted from the isolated plugin lab, pinned by exact
// version. Each entry maps a vendored directory (name) to its npm scope and
// the exact published version the promotion is bound to; a mismatch aborts
// initialization so an unpinned or substituted package can never boot.
const promotedPlugins = [
  { name: 'dsh-genui', scope: '@omdsh-dev', version: '0.8.3' },
  { name: 'dsh-visualize', scope: '@dsh-external', version: '0.1.2' },
];
const npmProfilePlugins = [
  { name: 'dsh-find-plugin', version: '0.3.7' },
  { name: 'dsh-context', version: '0.33.1' },
  { name: 'dsh-plugin-subagents', version: '0.1.2' },
];
// Symlinked peers the profile row resolution needs beyond the bundle rows:
// dsh-visualize imports schemastery and dsh-skill directly at load time.
const peerPackages = [
  'cordis',
  'dsh-agent',
  'dsh-client-ui-primitives',
  'dsh-llm',
  'dsh-home-paths',
  'dsh-jobs',
  'dsh-session',
  'dsh-settings',
  'dsh-subagent',
  'dsh-system-prompt',
  'dsh-tools',
  'dsh-skill',
  'schemastery',
];

async function current() {
  try { return (await readFile(marker, 'utf8')).trim(); } catch { return ''; }
}

async function installCommonProfileDependencies(profileTarget, { includeConversationRunner = false } = {}) {
  const scope = join(profileTarget, 'node_modules', '@ams');
  const plugin = join(scope, 'harness-tools');
  await mkdir(scope, { recursive: true });
  await rm(plugin, { recursive: true, force: true });
  await cp(pluginSource, plugin, { recursive: true, force: true });
  if (includeConversationRunner) {
    const conversationPlugin = join(scope, 'conversation-runner');
    await rm(conversationPlugin, { recursive: true, force: true });
    await cp(conversationPluginSource, conversationPlugin, { recursive: true, force: true });
  }
  const deepseekScope = join(profileTarget, 'node_modules', '@deepseek-ai');
  await mkdir(deepseekScope, { recursive: true });
  for (const peer of peerPackages) {
    const source = join(appRoot, 'node_modules', '@deepseek-ai', peer);
    const destination = join(deepseekScope, peer);
    await access(source, constants.R_OK);
    await rm(destination, { recursive: true, force: true });
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
  for (const promoted of promotedPlugins) {
    const source = join(vendorSource, promoted.name);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (manifest.version !== promoted.version) {
      throw new Error(`Promoted plugin ${promoted.scope}/${promoted.name} must be pinned to ${promoted.version}, found ${manifest.version}.`);
    }
    const pluginScope = join(profileTarget, 'node_modules', ...promoted.scope.split('/'));
    const destination = join(pluginScope, promoted.name);
    await mkdir(pluginScope, { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  for (const plugin of npmProfilePlugins) {
    const source = join(appRoot, 'node_modules', plugin.name);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    if (manifest.version !== plugin.version) {
      throw new Error(`Profile plugin ${plugin.name} must be pinned to ${plugin.version}, found ${manifest.version}.`);
    }
    const destination = join(profileTarget, 'node_modules', plugin.name);
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: true });
  }
  for (const unscopedPeer of ['zod']) {
    const source = join(appRoot, 'node_modules', unscopedPeer);
    const destination = join(profileTarget, 'node_modules', unscopedPeer);
    await access(source, constants.R_OK);
    await rm(destination, { recursive: true, force: true });
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

async function ensureSingleAmsWorkspace() {
  const storageDir = join(home, 'storages');
  const registryFile = join(storageDir, 'workspace.json');
  const workspaceId = 'ams-ai-marketing-studio';
  const now = new Date().toISOString();
  await mkdir(storageDir, { recursive: true });
  await mkdir(amsWorkspacePath, { recursive: true });
  let previous = {};
  try {
    previous = JSON.parse(await readFile(registryFile, 'utf8'));
  } catch {
    previous = {};
  }
  const oldWorkspace = previous?.tables?.workspaces?.[workspaceId]
    || Object.values(previous?.tables?.workspaces || {}).find((workspace) => workspace?.path === amsWorkspacePath)
    || {};
  const registry = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [workspaceId],
      archivedSessionIds: previous?.global?.archivedSessionIds || [],
    },
    tables: {
      workspaces: {
        [workspaceId]: {
          path: amsWorkspacePath,
          title: 'AI Marketing Studio',
          sessionIds: oldWorkspace.sessionIds || [],
          createdAt: oldWorkspace.createdAt || now,
          updatedAt: now,
        },
      },
    },
  };
  await writeFile(registryFile, JSON.stringify(registry, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function ensureDeepSeekVisionModelSettings() {
  let previous = '';
  try {
    previous = await readFile(settingsFile, 'utf8');
  } catch {
    previous = '';
  }
  if (
    previous.includes('deepseek-v4-flash-vision-exp')
    && previous.includes('agent-default-model:')
  ) {
    return;
  }
  const settings = `llm-deepseek:
  apiKeyEnv: DEEPSEEK_API_KEY
  models:
    - id: deepseek-v4-flash
      name: DeepSeek-V4-Flash
      inputModalities: [text]
      contextWindow: 1000000
    - id: deepseek-v4-pro
      name: DeepSeek-V4-Pro
      inputModalities: [text]
      contextWindow: 1000000
    - id: deepseek-v4-flash-vision-exp
      name: DeepSeek-V4-Flash-Vision-Exp
      description: DeepSeek official multimodal vision model for text + image analysis
      inputModalities: [text, image]
      contextWindow: 1000000
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash-vision-exp
`;
  await writeFile(settingsFile, settings, { encoding: 'utf8', mode: 0o600 });
}

await mkdir(join(home, 'profiles'), { recursive: true });
await ensureSingleAmsWorkspace();
await ensureDeepSeekVisionModelSettings();
// DSH applies the home patch after every profile patch. Refresh this exact
// final layer on every boot so the official Harness web profile can boot its
// standard preset while business writes remain gated by the AMS Tool Bridge.
await writeFile(join(home, 'cordis.patch.yml'), await readFile(homeLockdownSource), { mode: 0o600 });
if (await current() !== version) {
  await mkdir(target, { recursive: true });
  for (const filename of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    await cp(join(profileSource, filename), join(target, filename), { force: true });
  }
  await installCommonProfileDependencies(target, { includeConversationRunner: true });
  await mkdir(webTarget, { recursive: true });
  for (const filename of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    await cp(join(profileWebSource, filename), join(webTarget, filename), { force: true });
  }
  await installCommonProfileDependencies(webTarget);
  await writeFile(marker, `${version}\n`, { encoding: 'utf8', mode: 0o600 });
}
await access(join(target, 'node_modules', '@ams', 'harness-tools', 'index.mjs'), constants.R_OK);
await access(join(target, 'node_modules', '@ams', 'conversation-runner', 'index.mjs'), constants.R_OK);
for (const peer of peerPackages) {
  await access(join(target, 'node_modules', '@deepseek-ai', peer), constants.R_OK);
}
for (const promoted of promotedPlugins) {
  await access(join(target, 'node_modules', ...promoted.scope.split('/'), promoted.name, 'package.json'), constants.R_OK);
}
for (const plugin of npmProfilePlugins) {
  await access(join(target, 'node_modules', plugin.name, 'package.json'), constants.R_OK);
}
await access(join(webTarget, 'node_modules', '@ams', 'harness-tools', 'index.mjs'), constants.R_OK);
for (const peer of peerPackages) {
  await access(join(webTarget, 'node_modules', '@deepseek-ai', peer), constants.R_OK);
}
for (const promoted of promotedPlugins) {
  await access(join(webTarget, 'node_modules', ...promoted.scope.split('/'), promoted.name, 'package.json'), constants.R_OK);
}
for (const plugin of npmProfilePlugins) {
  await access(join(webTarget, 'node_modules', plugin.name, 'package.json'), constants.R_OK);
}
