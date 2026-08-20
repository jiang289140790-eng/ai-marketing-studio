import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { resolveHarnessLaunch } from '../harness-runner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function text(relative) {
  return readFile(join(root, relative), 'utf8');
}

test('gateway installs the AMS tool plugin at the loader resolution root', async () => {
  const manifest = JSON.parse(await text('package.json'));
  const lock = JSON.parse(await text('package-lock.json'));
  const pluginManifest = JSON.parse(await text('plugins/ams-tools/package.json'));
  assert.equal(manifest.dependencies['@ams/harness-tools'], 'file:plugins/ams-tools');
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.1.0-rc.8');
  assert.equal(lock.packages[''].dependencies['@ams/harness-tools'], 'file:plugins/ams-tools');
  assert.equal(lock.packages[''].dependencies['@deepseek-ai/dsh'], '0.1.0-rc.8');
  assert.equal(lock.packages['node_modules/@ams/harness-tools'].resolved, 'plugins/ams-tools');
  assert.equal(pluginManifest.peerDependencies['@deepseek-ai/dsh-system-prompt'], '0.1.0-rc.8');
  assert.equal(pluginManifest.peerDependencies['@deepseek-ai/dsh-tools'], '0.1.0-rc.8');

  const plugin = await import('@ams/harness-tools');
  assert.equal(plugin.name, 'ams-harness-tools');
  assert.deepEqual(plugin.inject, ['tools', 'systemPrompt']);
});

test('AMS operator prompt binds persisted analysis to one exact Evidence per call', async () => {
  const plugin = await text('plugins/ams-tools/index.mjs');
  assert.match(plugin, /research\.analyze_persisted use payload exactly \{project_id,evidence_id\}/);
  assert.match(plugin, /never send evidence_ids, count, or a batch payload/);
  assert.match(plugin, /once per exact evidence_id, sequentially, with a distinct idempotency_key and stop on the first failure/);
});

test('Docker build makes the local plugin available before npm ci', async () => {
  const dockerfile = await text('Dockerfile');
  const copyPlugin = dockerfile.indexOf('COPY services/harness-gateway/plugins ./plugins');
  const install = dockerfile.indexOf('RUN npm ci');
  assert.ok(copyPlugin >= 0);
  assert.ok(install > copyPlugin);
  assert.equal(dockerfile.indexOf('COPY services/harness-gateway/plugins ./plugins', copyPlugin + 1), -1);
  assert.match(dockerfile, /COPY .*services\/harness-gateway\/planner\.mjs .*services\/harness-gateway\/deterministic-executor\.mjs .*services\/harness-gateway\/workflow-catalog\.mjs/);
  assert.match(dockerfile, /COPY package\.json \/package\.json/);
  assert.match(dockerfile, /COPY src \/src/);
  assert.match(dockerfile, /COPY supabase\/functions\/p22-research-assist\/assist-core\.mjs \/supabase\/functions\/p22-research-assist\/assist-core\.mjs/);
  assert.match(dockerfile, /ln -s \/app\/node_modules \/node_modules/);
});

test('both profile layers fail closed before importing subprocess/node-pty', async () => {
  for (const file of ['profile/cordis.patch.yml', 'home-lockdown.patch.yml']) {
    const patch = await text(file);
    assert.match(patch, /- id: subprocess\r?\n\s+disabled: true/);
    assert.match(patch, /- id: bash-sandbox\r?\n\s+disabled: true/);
    assert.match(patch, /- id: permission\r?\n\s+disabled: true/);
    for (const forbidden of ['tool-bash', 'tool-pwsh', 'tool-fs', 'web', 'tool-subagent', 'tool-workflow', 'code-runtime']) {
      assert.match(patch, new RegExp(`- id: ${forbidden}\\r?\\n\\s+disabled: true`));
    }
    // rc.8 composes no persistent-pwsh row from the AMS bundles, so neither
    // layer may reference the absent id: patching it would warn
    // "patch: entry ... not found" on every boot, and absence is the
    // lockdown — there is no row for any persisted override to re-enable.
    assert.doesNotMatch(patch, /tool-pwsh-persistent/);
  }
});

test('persistent profile version advances for the corrected loader tree', async () => {
  assert.match(await text('init-profile.mjs'), /const version = 'ams-profile-v10';/);
});

test('rc.8 runtime uses a fresh Harness home without replacing gateway audit state', async () => {
  const compose = await text('compose.yaml');
  assert.match(compose, /- harness_gateway_data:\/data/);
  assert.match(compose, /- harness_runtime_rc8:\/data\/harness/);
  assert.match(compose, /HARNESS_EVENT_FILE: \/data\/gateway\/events\.jsonl/);
  assert.match(compose, /\n\s+harness_runtime_rc8:\s*(?:\r?\n|$)/);
});

test('only the pinned dsh-genui 0.8.3 and dsh-visualize 0.1.2 are promoted into the profile', async () => {
  const init = await text('init-profile.mjs');
  const patch = await text('profile/cordis.patch.yml');
  const genuiManifest = JSON.parse(await text('vendor/dsh-genui/package.json'));
  const visualizeManifest = JSON.parse(await text('vendor/dsh-visualize/package.json'));

  assert.equal(genuiManifest.name, '@omdsh-dev/dsh-genui');
  assert.equal(genuiManifest.version, '0.8.3');
  assert.equal(visualizeManifest.name, '@dsh-external/dsh-visualize');
  assert.equal(visualizeManifest.version, '0.1.2');
  assert.match(init, /\{ name: 'dsh-genui', scope: '@omdsh-dev', version: '0\.8\.3' \}/);
  assert.match(init, /\{ name: 'dsh-visualize', scope: '@dsh-external', version: '0\.1\.2' \}/);
  assert.match(init, /Promoted plugin \$\{promoted\.scope\}\/\$\{promoted\.name\} must be pinned/);
  assert.match(patch, /- id: genui\s*\r?\n\s+name: ['"]@omdsh-dev\/dsh-genui['"]/);
  assert.match(patch, /- id: dsh-visualize\s*\r?\n\s+name: ['"]@dsh-external\/dsh-visualize['"]/);

  // The profile's plugin rows stay exactly the AMS tool plus the two promoted
  // rendering plugins; every other plugin-lab package remains unpromoted.
  const insertRows = [...patch.matchAll(/^\s*-\s+id:\s+(\S+)/gm)].map((match) => match[1]);
  const pluginRows = [...patch.matchAll(/name:\s+(['"]@[^'"]+['"])/g)].map((match) => match[1]);
  assert.deepEqual(insertRows.filter((id) => id.startsWith('ams-') || id === 'genui' || id === 'dsh-visualize').sort(), ['ams-harness-tools', 'dsh-visualize', 'genui']);
  assert.deepEqual(pluginRows.sort(), ["'@ams/harness-tools'", "'@dsh-external/dsh-visualize'", "'@omdsh-dev/dsh-genui'"]);

  const dockerfile = await text('Dockerfile');
  assert.match(dockerfile, /COPY services\/harness-gateway\/vendor \.\/vendor/);
  assert.match(dockerfile, /COPY services\/harness-gateway\/presentation \.\/presentation/);
});

test('production Harness launch exposes internals only to the DSH child', () => {
  const launch = resolveHarnessLaunch('');
  assert.equal(launch.executable, process.execPath);
  assert.deepEqual(launch.profileArgs.slice(0, 2), [
    '--expose-internals',
    fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)),
  ]);
  assert.deepEqual(launch.profileArgs.slice(2), ['--profile', 'ams']);

  const custom = resolveHarnessLaunch('/tmp/fake-dsh');
  assert.equal(custom.executable, '/tmp/fake-dsh');
  assert.deepEqual(custom.profileArgs, ['--profile', 'ams']);
});
