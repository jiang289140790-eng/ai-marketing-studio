import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createP19CommandClient } from '../src/services/p19-server-write-adapter.js';
import { createP20OnlineStore } from '../src/services/p20-online-store.js';
import { fingerprintOf } from '../src/services/p19-contracts.js';
import {
  executeCommand,
  parseCommandRequest,
} from '../supabase/functions/p19-workspace-command/command-core.mjs';

const root = join(import.meta.dirname, '..');

test('browser command client sends only the versioned public command envelope', async () => {
  const calls = [];
  const client = {
    auth: {
      async getSession() {
        return {
          data: { session: { access_token: 'test-access-token', user: { id: '11111111-1111-4111-8111-111111111111' } } },
          error: null,
        };
      },
    },
    functions: {
      async invoke(name, request) {
        calls.push({ name, request });
        return {
          data: {
            ok: true,
            schema_version: 'p19_command_contract_v1',
            read_only: true,
            data: { projects: [] },
          },
          error: null,
        };
      },
    },
  };
  const command = createP19CommandClient({ client, randomId: () => 'fixed' });
  const response = await command.invoke('project.list', {});
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{
    name: 'p19-workspace-command',
    request: {
      headers: { Authorization: 'Bearer test-access-token' },
      body: {
        schema_version: 'p19_command_contract_v1',
        command: 'project.list',
        idempotency_key: 'p20-project.list-fixed',
        payload: {},
      },
    },
  }]);
});

test('browser command client fails closed for signed-out and redacts bounded transport errors', async () => {
  const signedOut = createP19CommandClient({
    client: {
      auth: { async getSession() { return { data: { session: null }, error: null }; } },
      functions: { async invoke() { throw new Error('must not be called'); } },
    },
  });
  await assert.rejects(() => signedOut.invoke('project.list', {}), (error) => error.code === 'AUTH_REQUIRED');

  const failing = createP19CommandClient({
    client: {
      auth: {
        async getSession() {
          return { data: { session: { access_token: 'safe-test-token', user: { id: 'u1' } } }, error: null };
        },
      },
      functions: {
        async invoke() {
          return { data: null, error: { message: `Bearer abc.def.ghi token=private-value ${'x'.repeat(500)}` } };
        },
      },
    },
  });
  await assert.rejects(() => failing.invoke('project.list', {}), (error) => {
    assert.equal(error.code, 'ONLINE_REQUEST_FAILED');
    assert.ok(error.message.length <= 300);
    assert.doesNotMatch(error.message, /abc\.def\.ghi|private-value/);
    return true;
  });
});

test('online store lists, reads and refreshes exact project identity', async () => {
  const project = { id: 'prj-aaaaaaaaaaaaaaaaaaaaaaaa', topic: 'online' };
  const commands = [];
  const store = createP20OnlineStore({
    commandClient: {
      async invoke(command, payload) {
        commands.push({ command, payload });
        if (command === 'project.list') return { data: { projects: [{ id: project.id, topic: project.topic }] } };
        if (command === 'project.read') return { data: { project } };
        return { entity: { id: project.id } };
      },
    },
  });
  assert.deepEqual(await store.listProjects(), [{ id: project.id, topic: 'online' }]);
  assert.deepEqual(await store.getProject(project.id), project);
  assert.deepEqual(await store.execute('project.update', { project_id: project.id, patch: { topic: 'next' } }), project);
  assert.deepEqual(commands.map((item) => item.command), ['project.list', 'project.read', 'project.update', 'project.read']);
});

test('project list/read are viewer-only, immutable and owner-scoped through db arguments', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const projectId = 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  const base = {
    schema_version: 'p19_research_project_v1', id: projectId, version: 1, status: 'active',
    topic: 't', objective: 'o', audience: 'a', channel: 'c', constraints: [],
    execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
    created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
  };
  const seen = [];
  const db = {
    async listProjects(received) { seen.push(['list', received]); return [{ id: projectId, topic: 't' }]; },
    async getProject(received, receivedProject) { seen.push(['read', received, receivedProject]); return globalThis.structuredClone(base); },
    async listProjectEntities(received, receivedProject) {
      seen.push(['entities', received, receivedProject]);
      return { evidence: [], analyses: [], cards: [], brief: null, handoff: null };
    },
  };
  const listParsed = parseCommandRequest({ schema_version: 'p19_command_contract_v1', command: 'project.list', idempotency_key: 'list-1', payload: {} });
  const listed = await executeCommand({ ...listParsed, user_id: userId, access_role: 'viewer' }, { db });
  assert.equal(listed.read_only, true);
  assert.deepEqual(listed.data.projects, [{ id: projectId, topic: 't' }]);
  listed.data.projects[0].topic = 'mutated';
  assert.equal((await db.listProjects(userId))[0].topic, 't');

  const readParsed = parseCommandRequest({ schema_version: 'p19_command_contract_v1', command: 'project.read', idempotency_key: 'read-1', payload: { project_id: projectId } });
  const read = await executeCommand({ ...readParsed, user_id: userId, access_role: 'viewer' }, { db });
  assert.equal(read.read_only, true);
  assert.equal(read.data.project.id, projectId);
  assert.deepEqual(seen.filter((entry) => entry[0] !== 'list'), [
    ['read', userId, projectId],
    ['entities', userId, projectId],
  ]);
});

test('project read fails closed across users and never asks the db for sibling entities', async () => {
  const owner = '11111111-1111-4111-8111-111111111111';
  const sibling = '22222222-2222-4222-8222-222222222222';
  const projectId = 'prj-bbbbbbbbbbbbbbbbbbbbbbbb';
  const calls = [];
  const db = {
    async getProject(userId, requestedId) {
      calls.push(['project', userId, requestedId]);
      if (userId !== owner || requestedId !== projectId) return null;
      return {
        schema_version: 'p19_research_project_v1', id: projectId, version: 1, status: 'active',
        topic: 'owned', objective: 'owned', audience: 'owned', channel: 'owned', constraints: [],
        execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
        created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
      };
    },
    async listProjectEntities(userId, requestedId) {
      calls.push(['entities', userId, requestedId]);
      return { evidence: [], analyses: [], cards: [], brief: null, handoff: null };
    },
  };
  const parsed = parseCommandRequest({
    schema_version: 'p19_command_contract_v1', command: 'project.read', idempotency_key: 'cross-user-read', payload: { project_id: projectId },
  });
  const denied = await executeCommand({ ...parsed, user_id: sibling, access_role: 'viewer' }, { db });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PROJECT_NOT_FOUND');
  assert.deepEqual(calls, [['project', sibling, projectId]]);
});

test('explicit project import preserves exact identity, verifies fingerprint and refuses collision', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const projectId = 'prj-abcdefabcdefabcdefabcdef';
  const body = {
    schema_version: 'p19_project_package_v1',
    exported_at: '2026-08-11T12:00:00.000Z',
    project: {
      schema_version: 'p19_research_project_v1', id: projectId, version: 1, status: 'active',
      topic: 'import', objective: 'move local draft online', audience: 'operator', channel: 'research', constraints: [],
      execution_flags: { generation_executed: false, routing_executed: false, network_executed: false, publish_executed: false },
      created_at: '2026-08-11T12:00:00.000Z', updated_at: '2026-08-11T12:00:00.000Z',
    },
    evidence: [], analyses: [], knowledge_cards: [], brief: null, handoff: null,
  };
  const pkg = { ...body, fingerprint: await fingerprintOf(body) };
  const imported = [];
  const db = {
    async importProject(receivedUser, meta) { imported.push({ receivedUser, meta }); return { applied_at: '2026-08-11T12:01:00.000Z' }; },
  };
  const parsed = parseCommandRequest({
    schema_version: 'p19_command_contract_v1', command: 'project.import', idempotency_key: 'import-exact-1', payload: { package: pkg },
  });
  const result = await executeCommand({ ...parsed, user_id: userId, access_role: 'operator' }, { db });
  assert.equal(result.ok, true);
  assert.deepEqual(result.entity, { type: 'project', id: projectId });
  assert.equal(imported[0].receivedUser, userId);
  assert.deepEqual(imported[0].meta.package, pkg);

  const replayed = await executeCommand({ ...parsed, user_id: userId, access_role: 'operator' }, {
    db: { async importProject() { return { outcome: 'replayed', ledger: { idempotency_key: 'import-exact-1' } }; } },
  });
  assert.equal(replayed.applied, false);
  assert.equal(replayed.replay_of, 'import-exact-1');

  const tampered = globalThis.structuredClone(pkg);
  tampered.project.topic = 'tampered';
  const tamperedParsed = parseCommandRequest({
    schema_version: 'p19_command_contract_v1', command: 'project.import', idempotency_key: 'import-tampered', payload: { package: tampered },
  });
  const rejected = await executeCommand({ ...tamperedParsed, user_id: userId, access_role: 'operator' }, { db });
  assert.equal(rejected.code, 'IMPORT_FINGERPRINT_MISMATCH');
  assert.equal(imported.length, 1);

  const crossBoundBody = globalThis.structuredClone(body);
  const crossBoundEvidence = {
    schema_version: 'p19_evidence_record_v1', id: 'ev-0123456789abcdef01234567',
    project_id: 'prj-000000000000000000000000', source_url: 'https://example.invalid/source',
    label: 'cross-bound', platform: 'manual', content_text: 'bounded source',
    recorded_at: '2026-08-11T12:00:00.000Z', provenance: { manual: true, statement: 'manual test evidence' },
    media_metadata: null, version: 1, fingerprint: '',
    created_at: '2026-08-11T12:00:00.000Z', updated_at: '2026-08-11T12:00:00.000Z',
  };
  crossBoundEvidence.fingerprint = await fingerprintOf(crossBoundEvidence);
  crossBoundBody.evidence.push(crossBoundEvidence);
  const crossBoundPackage = { ...crossBoundBody, fingerprint: await fingerprintOf(crossBoundBody) };
  const crossBoundParsed = parseCommandRequest({
    schema_version: 'p19_command_contract_v1', command: 'project.import', idempotency_key: 'import-cross-bound', payload: { package: crossBoundPackage },
  });
  const crossBound = await executeCommand({ ...crossBoundParsed, user_id: userId, access_role: 'operator' }, { db });
  assert.equal(crossBound.code, 'IMPORT_BINDING_FAILED');
  assert.equal(imported.length, 1);

  const collisionDb = {
    async importProject() {
      const error = new Error('collision');
      error.code = 'IMPORT_PROJECT_COLLISION';
      throw error;
    },
  };
  const collided = await executeCommand({ ...parsed, user_id: userId, access_role: 'operator' }, { db: collisionDb });
  assert.equal(collided.code, 'IMPORT_PROJECT_COLLISION');
  assert.equal(imported.length, 1);
});

test('P20 migration is service-only and page switches between online and local truth', () => {
  const sql = readFileSync(join(root, 'supabase', 'migrations', '20260812001000_p20_online_workspace_read_contract.sql'), 'utf8');
  assert.match(sql, /security definer/i);
  assert.match(sql, /where user_id = p_user_id/i);
  assert.match(sql, /revoke all on function api\.p20_list_projects\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function api\.p20_list_projects\(uuid\) to service_role/i);

  const page = readFileSync(join(root, 'src', 'pages', 'ResearchWorkspacePage.jsx'), 'utf8');
  assert.match(page, /onlineMode = isAuthenticated && isServerWriteEnabled\(\)/);
  assert.match(page, /在线工作区 · 已同步/);
  assert.match(page, /本机草稿 · 未上传/);
  assert.match(page, /ONLINE_DELETE_DISABLED/);
  assert.match(page, /确认原子导入/);
  assert.match(page, /不会静默覆盖或合并/);
});

test('client and built source do not reference privileged keys or private schema', () => {
  const adapter = readFileSync(join(root, 'src', 'services', 'p19-server-write-adapter.js'), 'utf8');
  const store = readFileSync(join(root, 'src', 'services', 'p20-online-store.js'), 'utf8');
  for (const source of [adapter, store]) {
    assert.doesNotMatch(source, /SUPABASE_JWT_SECRET|ams_private|service[_-]?role/i);
  }
});
