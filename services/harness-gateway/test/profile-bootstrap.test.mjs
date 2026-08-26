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

test('conversation model selection does not leak a disposer as an agent setup transaction', async () => {
  const plugin = await text('plugins/ams-conversation-runner/index.mjs');
  assert.match(plugin, /return \(agentCtx\) => \{\s*installModelSelection\(agentCtx,/);
  assert.doesNotMatch(plugin, /=>\s*installModelSelection\(agentCtx,/);
});

test('Docker build makes the local plugin available before npm ci', async () => {
  const dockerfile = await text('Dockerfile');
  const copyPlugin = dockerfile.indexOf('COPY services/harness-gateway/plugins ./plugins');
  const copyWebProfile = dockerfile.indexOf('COPY services/harness-gateway/profile-web ./profile-web');
  const install = dockerfile.indexOf('RUN npm ci');
  assert.ok(copyPlugin >= 0);
  assert.ok(copyWebProfile >= 0);
  assert.ok(install > copyPlugin);
  assert.ok(install > copyWebProfile);
  assert.equal(dockerfile.indexOf('COPY services/harness-gateway/plugins ./plugins', copyPlugin + 1), -1);
  assert.match(dockerfile, /COPY .*services\/harness-gateway\/planner\.mjs .*services\/harness-gateway\/deterministic-executor\.mjs .*services\/harness-gateway\/workflow-catalog\.mjs/);
  assert.match(dockerfile, /COPY .*services\/harness-gateway\/conversation-runner\.mjs .*services\/harness-gateway\/server\.mjs/);
  assert.match(dockerfile, /COPY .*services\/harness-gateway\/task-projector\.mjs .*services\/harness-gateway\/server\.mjs/);
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

test('persistent profile version advances for the agent-first conversation and official web profiles', async () => {
  const init = await text('init-profile.mjs');
  const plugin = await text('plugins/ams-tools/index.mjs');
  const webPackage = JSON.parse(await text('profile-web/package.json'));
  const webPatch = await text('profile-web/cordis.patch.yml');
  assert.match(plugin, /name: 'ams_call'/);
  assert.match(plugin, /name: 'ams_research_search_x'/);
  assert.match(plugin, /name: 'ams_research_search_reddit'/);
  assert.match(plugin, /name: 'ams_research_analyze_persisted'/);
  assert.match(plugin, /name: 'ams_brief_assemble'/);
  assert.match(plugin, /name: 'ams_generation_quote'/);
  assert.match(plugin, /name: 'ams_generation_submit'/);
  assert.doesNotMatch(plugin, /name: 'ams_request_plan'/);
  assert.match(plugin, /prefer the specific ams_\* tools registered by this plugin/);
  assert.match(plugin, /Use ams_call only as a compatibility fallback/);
  assert.match(plugin, /Do not request or create a separate deterministic AMS execution plan/);
  assert.match(plugin, /'generation\.quote', 'generation\.submit', 'generation\.status', 'generation\.artifact'/);
  assert.match(plugin, /'research\.generate_similar', 'research\.inspect_attachments'/);
  assert.match(init, /const profileWebSource = join\(appRoot, 'profile-web'\);/);
  assert.match(init, /const webTarget = join\(home, 'profiles', 'web'\);/);
  assert.match(init, /const version = 'ams-profile-v15';/);
  assert.match(init, /installCommonProfileDependencies\(webTarget\)/);
  assert.equal(webPackage.name, 'dsh-profile-web');
  assert.equal(webPackage.dependencies['@ams/harness-tools'], 'file:/app/plugins/ams-tools');
  assert.deepEqual(webPackage.dsh?.profile?.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  assert.match(webPatch, /- id: ams-harness-tools/);
  assert.doesNotMatch(webPatch, /ams-conversation-runner/);
});

test('rc.8 runtime uses a fresh Harness home without replacing gateway audit state', async () => {
  const compose = await text('compose.yaml');
  assert.match(compose, /- harness_gateway_data:\/data/);
  assert.match(compose, /- harness_runtime_rc8:\/data\/harness/);
  assert.match(compose, /harness-web:/);
  assert.match(compose, /network_mode: host/);
  assert.match(compose, /node --expose-internals \/app\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js web --host 127\.0\.0\.1 --port 8792 --no-open/);
  assert.doesNotMatch(compose, /dsh\/lib\/bin\.js web --host 0\.0\.0\.0/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:8792:8792/);
  assert.match(compose, /127\.0\.0\.1:8791:8791/);
  assert.match(compose, /- harness_web_runtime:\/data\/harness/);
  assert.match(compose, /HARNESS_EVENT_FILE: \/data\/gateway\/events\.jsonl/);
  assert.match(compose, /\n\s+harness_runtime_rc8:\s*(?:\r?\n|$)/);
  assert.match(compose, /\n\s+harness_web_runtime:\s*(?:\r?\n|$)/);
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

  // The profile's plugin rows stay exactly the two AMS boundary plugins plus
  // the two promoted rendering plugins; every plugin-lab package remains unpromoted.
  const insertRows = [...patch.matchAll(/^\s*-\s+id:\s+(\S+)/gm)].map((match) => match[1]);
  const pluginRows = [...patch.matchAll(/name:\s+(['"]@[^'"]+['"])/g)].map((match) => match[1]);
  assert.deepEqual(insertRows.filter((id) => id.startsWith('ams-') || id === 'genui' || id === 'dsh-visualize').sort(), ['ams-conversation-runner', 'ams-harness-tools', 'dsh-visualize', 'genui']);
  assert.deepEqual(pluginRows.sort(), ["'@ams/conversation-runner'", "'@ams/harness-tools'", "'@dsh-external/dsh-visualize'", "'@omdsh-dev/dsh-genui'"]);

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
