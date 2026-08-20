/* global URL */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const initBin = join(root, 'init-profile.mjs');
const denied = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-skill', 'tool-subagent-control', 'tool-subagent', 'tool-subagent-fork',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-ralph',
  'tool-str-replace-editor', 'web', 'web-search-deepseek', 'tool-web', 'code-runtime',
];

function blockFor(dump, id) {
  const lines = dump.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- id: ${id}`);
  assert.notEqual(start, -1, `profile row ${id} must exist`);
  let end = start + 1;
  while (end < lines.length && !/^\s*- id: /.test(lines[end]) && !/^# ==/.test(lines[end])) end += 1;
  return lines.slice(start, end).join('\n');
}

test('AMS profile exposes its single business plugin and disables general execution tools', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ams-harness-profile-'));
  const env = { ...process.env, HARNESS_HOME: home, DSH_HOME: home };
  try {
    await writeFile(join(home, 'cordis.patch.yml'), '- id: tool-bash\n  disabled: false\n- id: web\n  disabled: false\n');
    const initialized = spawnSync(process.execPath, [initBin], { cwd: root, env, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const pluginUrl = pathToFileURL(join(home, 'profiles', 'ams', 'node_modules', '@ams', 'harness-tools', 'index.mjs')).href;
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pluginUrl)});`], { cwd: root, env, encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    const dumped = spawnSync(process.execPath, [dshBin, '--profile', 'ams', '--dump-config'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(dumped.status, 0, dumped.stderr);
    assert.doesNotMatch(dumped.stderr, /patch: entry|Error:/);
    assert.match(blockFor(dumped.stdout, 'ams-harness-tools'), /name: ['"]@ams\/harness-tools['"]/);
    // The two promoted rendering plugins resolve and load in the dumped
    // composition; both stay display-only next to the locked-down rows.
    assert.match(blockFor(dumped.stdout, 'genui'), /name: ['"]@omdsh-dev\/dsh-genui['"]/);
    assert.match(blockFor(dumped.stdout, 'dsh-visualize'), /name: ['"]@dsh-external\/dsh-visualize['"]/);
    for (const id of denied) assert.match(blockFor(dumped.stdout, id), /disabled: true/, `${id} must stay disabled`);
    // rc.8 composes no persistent-pwsh row from the AMS bundles (dsh-base +
    // dsh-headless), so the deny-list proves it by absence: the dump carries
    // no such row, and the stderr assertion above guarantees no
    // patch-not-found diagnostic either.
    assert.doesNotMatch(dumped.stdout, /- id: tool-pwsh-persistent\r?\n/, 'rc.8 must not compose a persistent-pwsh row');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
