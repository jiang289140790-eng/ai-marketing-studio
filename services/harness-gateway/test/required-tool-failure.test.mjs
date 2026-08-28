import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugins/ams-tools/index.mjs';
import { consumeRequiredFailure } from '../plugins/ams-tools/required-failure-journal.mjs';

test('real ams_call plugin latches the first required failure and never contacts the bridge again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ams-required-tool-'));
  const previous = {
    client: process.env.AMS_TOOL_CLIENT_MODULE,
    home: process.env.DSH_HOME,
    task: process.env.AMS_TASK_ID,
    user: process.env.AMS_USER_ID,
    project: process.env.AMS_PROJECT_ID,
    authorization: process.env.AMS_DELEGATED_AUTHORIZATION,
  };
  globalThis.__amsRequiredToolClientCalls = 0;
  process.env.AMS_TOOL_CLIENT_MODULE = `data:text/javascript,${encodeURIComponent(`
    export function createToolClient() {
      return async function () {
        globalThis.__amsRequiredToolClientCalls += 1;
        return { ok: false, code: 'P19_ENTITY_REVISION_STALE' };
      };
    }
  `)}`;
  process.env.DSH_HOME = home;
  process.env.AMS_TASK_ID = 'ht-11111111-1111-4111-8111-111111111111';
  process.env.AMS_USER_ID = 'user-test';
  process.env.AMS_PROJECT_ID = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  process.env.AMS_DELEGATED_AUTHORIZATION = 'Bearer test.delegated.authorization-value';

  try {
    let registered;
    apply({
      systemPrompt: { section() {} },
      tools: { register(tool) { registered = tool; } },
    });
    const base = {
      schema_version: 'ams_harness_tool_v1',
      payload: {},
      idempotency_key: 'idem-required-failure',
    };
    await assert.rejects(
      registered.execute({ ...base, operation: 'workspace.brief.assemble' }),
      (error) => error?.code === 'P19_ENTITY_REVISION_STALE',
    );
    await assert.rejects(
      registered.execute({ ...base, operation: 'research.analyze_persisted', idempotency_key: 'idem-must-not-run' }),
      (error) => error?.code === 'AMS_DEPENDENCY_BLOCKED',
    );
    assert.equal(globalThis.__amsRequiredToolClientCalls, 1, 'dependent write/paid calls must not load or contact the client');
    assert.deepEqual(consumeRequiredFailure(home, process.env.AMS_TASK_ID), {
      code: 'HARNESS_EXIT_FAILED',
      tool_code: 'P19_ENTITY_REVISION_STALE',
      operation: 'workspace.brief.assemble',
      category: 'ams_tool_plugin',
      stage: 'tool_call',
      exit_code: null,
      summary: 'A required AI Marketing Studio tool failed; dependent actions were stopped.',
    });
  } finally {
    if (previous.client === undefined) delete process.env.AMS_TOOL_CLIENT_MODULE; else process.env.AMS_TOOL_CLIENT_MODULE = previous.client;
    if (previous.home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous.home;
    if (previous.task === undefined) delete process.env.AMS_TASK_ID; else process.env.AMS_TASK_ID = previous.task;
    if (previous.user === undefined) delete process.env.AMS_USER_ID; else process.env.AMS_USER_ID = previous.user;
    if (previous.project === undefined) delete process.env.AMS_PROJECT_ID; else process.env.AMS_PROJECT_ID = previous.project;
    if (previous.authorization === undefined) delete process.env.AMS_DELEGATED_AUTHORIZATION; else process.env.AMS_DELEGATED_AUTHORIZATION = previous.authorization;
    delete globalThis.__amsRequiredToolClientCalls;
    await rm(home, { recursive: true, force: true });
  }
});
