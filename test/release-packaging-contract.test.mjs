import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('root Docker context preserves every Harness COPY source', async () => {
  const [dockerfile, dockerignore] = await Promise.all([
    read('services/harness-gateway/Dockerfile'),
    read('.dockerignore'),
  ]);
  const ignoredRoots = new Set(dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && !line.includes('*')));
  const copySources = dockerfile
    .split(/\r?\n/)
    .filter((line) => line.startsWith('COPY '))
    .flatMap((line) => line.trim().split(/\s+/).slice(1, -1));

  assert.ok(copySources.length > 0);
  for (const source of copySources) {
    await access(resolve(root, source));
    const sourceRoot = source.replaceAll('\\', '/').split('/')[0];
    assert.equal(ignoredRoots.has(source), false, `${source} is excluded by .dockerignore`);
    assert.equal(ignoredRoots.has(sourceRoot), false, `${sourceRoot} is excluded by .dockerignore`);
  }
});

test('runtime bundle source selection has no machine-specific project path', async () => {
  const [prepare, config] = await Promise.all([
    read('services/mcp-runtime-bridge/runtime/Prepare-RuntimeBundle.ps1'),
    read('services/mcp-runtime-bridge/runtime/runtime-source.config.json').then(JSON.parse),
  ]);
  assert.doesNotMatch(prepare, /[A-Za-z]:\\projects\\/i);
  assert.equal(config.schema_version, 'ams_mcp_runtime_source_v1');
  assert.equal(config.marketing_studio_mcp_dir.startsWith('../'), true);
});
