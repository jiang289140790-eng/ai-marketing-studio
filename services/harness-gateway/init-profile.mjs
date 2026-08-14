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
const homeLockdownSource = join(appRoot, 'home-lockdown.patch.yml');
const target = join(home, 'profiles', 'ams');
const marker = join(target, '.ams-profile-version');
const version = 'ams-profile-v6';
const peerPackages = ['dsh-system-prompt', 'dsh-tools'];

async function current() {
  try { return (await readFile(marker, 'utf8')).trim(); } catch { return ''; }
}

await mkdir(join(home, 'profiles'), { recursive: true });
// DSH applies the home patch after every profile patch. Refresh this exact
// final layer on every boot so a persisted override cannot restore general
// shell, filesystem, web, subagent, or arbitrary-code capabilities.
await writeFile(join(home, 'cordis.patch.yml'), await readFile(homeLockdownSource), { mode: 0o600 });
if (await current() !== version) {
  await cp(profileSource, target, { recursive: true, force: true });
  const scope = join(target, 'node_modules', '@ams');
  const plugin = join(scope, 'harness-tools');
  await mkdir(scope, { recursive: true });
  await rm(plugin, { recursive: true, force: true });
  await cp(pluginSource, plugin, { recursive: true, force: true });
  const deepseekScope = join(target, 'node_modules', '@deepseek-ai');
  await mkdir(deepseekScope, { recursive: true });
  for (const peer of peerPackages) {
    const source = join(appRoot, 'node_modules', '@deepseek-ai', peer);
    const destination = join(deepseekScope, peer);
    await access(source, constants.R_OK);
    await rm(destination, { recursive: true, force: true });
    await symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(marker, `${version}\n`, { encoding: 'utf8', mode: 0o600 });
}
await access(join(target, 'node_modules', '@ams', 'harness-tools', 'index.mjs'), constants.R_OK);
for (const peer of peerPackages) {
  await access(join(target, 'node_modules', '@deepseek-ai', peer), constants.R_OK);
}
