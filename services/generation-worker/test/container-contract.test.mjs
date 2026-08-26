import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(resolve(serviceDir, name), 'utf8');

test('Generation Worker container is deterministic and complete', async () => {
  const [dockerfile, packageText, lockText, runtimeText, worker] = await Promise.all([
    read('Dockerfile'),
    read('package.json'),
    read('package-lock.json'),
    read('runtime-contract.json'),
    read('worker.mjs'),
  ]);
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  const runtime = JSON.parse(runtimeText);

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.match(dockerfile, /CMD \["node", "worker\.mjs"\]/);
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(lock.packages[''].engines.node, '>=22');
  assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);
  assert.equal(runtime.node_engine, packageJson.engines.node);
  assert.equal(runtime.entrypoint, 'worker.mjs');
  assert.equal(runtime.provider_adapter, 'bailian-adapter.mjs');
  assert.match(worker, /from ['"]\.\/bailian-adapter\.mjs['"]/);

  const copyLines = dockerfile.split(/\r?\n/).filter((line) => line.startsWith('COPY '));
  const sources = copyLines.flatMap((line) => line.trim().split(/\s+/).slice(1, -1));
  await Promise.all(sources.map((source) => read(source)));
});
