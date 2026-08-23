/* global URL */
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.HARNESS_HOME || '/data/harness';
const appRoot = fileURLToPath(new URL('.', import.meta.url));
const profileSource = join(appRoot, 'profile');
const pluginSource = join(appRoot, 'plugins', 'ams-tools');
const conversationPluginSource = join(appRoot, 'plugins', 'ams-conversation-runner');
const vendorSource = join(appRoot, 'vendor');
const homeLockdownSource = join(appRoot, 'home-lockdown.patch.yml');
const target = join(home, 'profiles', 'ams');
const marker = join(target, '.ams-profile-version');
const version = 'ams-profile-v12';
// The only plugins promoted from the isolated plugin lab, pinned by exact
// version. Each entry maps a vendored directory (name) to its npm scope and
// the exact published version the promotion is bound to; a mismatch aborts
// initialization so an unpinned or substituted package can never boot.
const promotedPlugins = [
  { name: 'dsh-genui', scope: '@omdsh-dev', version: '0.8.3' },
  { name: 'dsh-visualize', scope: '@dsh-external', version: '0.1.2' },
];
// Symlinked peers the profile row resolution needs beyond the bundle rows:
// dsh-visualize imports schemastery and dsh-skill directly at load time.
const peerPackages = ['dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-system-prompt', 'dsh-tools', 'dsh-skill', 'schemastery'];

async function current() {
  try { return (await readFile(marker, 'utf8')).trim(); } catch { return ''; }
}

await mkdir(join(home, 'profiles'), { recursive: true });
// DSH applies the home patch after every profile patch. Refresh this exact
// final layer on every boot so a persisted override cannot restore general
// shell, filesystem, web, subagent, or arbitrary-code capabilities.
await writeFile(join(home, 'cordis.patch.yml'), await readFile(homeLockdownSource), { mode: 0o600 });
if (await current() !== version) {
  await mkdir(target, { recursive: true });
  for (const filename of ['package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml']) {
    await cp(join(profileSource, filename), join(target, filename), { force: true });
  }
  const scope = join(target, 'node_modules', '@ams');
  const plugin = join(scope, 'harness-tools');
  await mkdir(scope, { recursive: true });
  await rm(plugin, { recursive: true, force: true });
  await cp(pluginSource, plugin, { recursive: true, force: true });
  const conversationPlugin = join(scope, 'conversation-runner');
  await rm(conversationPlugin, { recursive: true, force: true });
  await cp(conversationPluginSource, conversationPlugin, { recursive: true, force: true });
  const deepseekScope = join(target, 'node_modules', '@deepseek-ai');
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
    const pluginScope = join(target, 'node_modules', ...promoted.scope.split('/'));
    const destination = join(pluginScope, promoted.name);
    await mkdir(pluginScope, { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: true });
  }
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
