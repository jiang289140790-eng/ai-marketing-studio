// P19 真实 PostgreSQL 17 / Supabase-local SQL 集成测试（隔离、全新数据库）。
//
// 前置：Docker 容器 supabase_db_p19-op-workbench（postgres 17.6.1.147，
// 与已验收 P17 环境同源）。Docker/容器不可用时本文件给出明确基础设施失败
// （M1 验收：Docker/PostgreSQL 17 明确存在时禁止 skip；缺失时不得把 M1
// 判为通过）。
//
// 覆盖（要求验证 #1 与 #8 的真实 SQL 执行部分）：
//   - 全新数据库上回放全部 45 个迁移（bootstrap 仅复刻已验收环境：
//     storage/auth/extensions/graphql_public/vault 架构与扩展，非迁移变更）；
//   - 全部 SQL 测试（已验收 P17 系列 + P19 + P20 + P22 + P17-B2 对抗测试）
//     逐一通过；其中 P17-B2 的 helper 由本文件从 P17-A4 迁移提取并同源注入
//     （哨兵块替换），同时做字节级漂移检测——镜像与迁移实装不一致即失败；
//   - 并发幂等：N 个并行 psql 会话以同一 (user_id, idempotency_key) 调用
//     边界，恰好一次 applied、其余全部 replayed，且恰好 1 行项目 + 1 行台账。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const CONTAINER = 'supabase_db_p19-op-workbench';

/** Docker CLI/daemon 可用性（缺失时给出清晰基础设施失败，绝不静默跳过）。 */
function dockerReady() {
  try {
    const out = execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
    return { ok: true, version: out.trim() };
  } catch {
    return { ok: false };
  }
}

function containerUp() {
  try {
    const out = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { encoding: 'utf8' });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function psql(db, sql, { stdin = null } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q'];
  if (stdin === null) {
    args.push('-t', '-A', '-c', sql);
  }
  return spawnSync('docker', args, { encoding: 'utf8', input: stdin ?? undefined });
}

function psqlAsync(db, sql) {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// ---- P17-B2 同源门禁：对抗测试必须执行迁移实装，禁止镜像漂移 ----
const P17_MIGRATION = '20260810143859_p17_reconcile_out_of_band_foundations.sql';
const P17_B2_TEST = 'p17_b2_function_contract_guard.test.sql';
const P17_HELPERS = ['p17_normalize_search_path', 'p17_normalize_body', 'p17_contract_matches'];

/** 从 P17-A4 迁移中提取 helper 的完整定义（create or replace function … $function$;）。 */
function extractMigrationHelper(migrationSql, helperName) {
  const anchor = `create or replace function pg_temp.${helperName}(`;
  const start = migrationSql.indexOf(anchor);
  assert.notEqual(start, -1, `P17-A4 迁移缺少 helper ${helperName}（锚点 ${anchor}）`);
  const terminator = '\n$function$;';
  const end = migrationSql.indexOf(terminator, start);
  assert.notEqual(end, -1, `P17-A4 迁移 helper ${helperName} 缺少 $function$; 终止`);
  return migrationSql.slice(start, end + terminator.length);
}

/**
 * 同源注入 + 漂移检测：把 B2 测试文件的镜像哨兵块替换为迁移实装，并断言
 * 镜像与迁移实装逐字节一致（EOL 归一后）。P17-B2 实际执行的就是迁移使用
 * 的实现；「迁移与复制测试一起犯同一错误」时哨兵块必然漂移 → 本检查失败。
 */
function injectMigrationHelpers(migrationSql, b2Sql) {
  let injected = b2Sql;
  for (const name of P17_HELPERS) {
    const re = new RegExp(`-- @p17-helper-migration: ${name}@BEGIN([\\s\\S]*?)-- @p17-helper-migration: ${name}@END`);
    const match = injected.match(re);
    assert.ok(match, `B2 对抗测试缺少 helper ${name} 的哨兵块`);
    const migrationHelper = extractMigrationHelper(migrationSql, name).replaceAll('\r', '');
    assert.equal(match[1].trim().replaceAll('\r', ''), migrationHelper.trim(),
      `B2 镜像与迁移 helper ${name} 漂移：必须与迁移实装完全同源（防「迁移与复制测试同错仍绿灯」）`);
    injected = injected.replace(re, () => `-- @p17-helper-migration: ${name}@BEGIN\n${migrationHelper}\n-- @p17-helper-migration: ${name}@END`);
  }
  return injected;
}

const CONCURRENT_SESSIONS = 6;
const CONCURRENT_USER = '44444444-4444-4444-8444-444444444444';
const CONCURRENT_PROJECT = 'prj-eeeeeeeeeeeeeeeeeeeeeeee';
const CONCURRENT_KEY = 'conc-key-1';

test('SQL 集成：全新数据库回放 47 迁移 + SQL 测试 + 并发幂等（真实 PostgreSQL 17）', async () => {
  // 基础设施前置：Docker/PostgreSQL 17 缺失时给出明确基础设施失败（M1 验收）。
  const docker = dockerReady();
  assert.ok(docker.ok, `基础设施失败：Docker CLI/daemon 不可用（${docker.version || '无法探测'}），无法回放真实 PostgreSQL 17 迁移`);
  assert.equal(containerUp(), true, `基础设施失败：PostgreSQL 17 容器 ${CONTAINER} 未在运行，无法回放真实迁移`);
  const dbName = `p19_verify_${process.pid}`;
  try {
    execFileSync('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', dbName], { encoding: 'utf8' });

    // ---- bootstrap（环境复刻，非迁移变更）----
    const dump = execFileSync('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
      '--schema-only', '--schema=storage', '--schema=auth', '--schema=extensions',
      '--schema=graphql_public', '--schema=vault'], { encoding: 'utf8' });
    const ext = 'create extension if not exists pgcrypto with schema extensions;\n'
      + 'create extension if not exists "uuid-ossp" with schema extensions;\n'
      + 'create extension if not exists supabase_vault with schema vault;\n';
    let result = psql(dbName, null, { stdin: dump });
    assert.equal(result.status, 0, `bootstrap dump 应用失败：${result.stderr || result.stdout}`);
    result = psql(dbName, null, { stdin: ext });
    assert.equal(result.status, 0, `扩展引导失败：${result.stderr || result.stdout}`);

    // ---- 45 个迁移按顺序回放 ----
    const migrations = readdirSync(join(REPO_ROOT, 'supabase', 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assert.equal(migrations.length, 47, '迁移集必须包含 Harness Brief 版本并发门禁，共 47 项');
    for (const name of migrations) {
      if (name === '20260815035041_p22_full_request_idempotency_binding.sql') {
        const legacy = `insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
          values ('99999999-9999-4999-8999-999999999999','authenticated','authenticated','legacy-paid@example.invalid','{}','{}',now(),now(),false,false);
          do $fixture$
          begin
            if to_regclass('ams_private.p22_paid_operation_replays_v1') is null then
              create table ams_private.p22_paid_operation_replays_v1 (
                user_id uuid not null, reservation_id uuid not null, provider text not null,
                operation text not null, sequence integer not null, request_sha256 text not null,
                state text not null default 'claimed', lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
                failure_code text, result_json jsonb, claimed_at timestamptz not null default now(), completed_at timestamptz,
                primary key (user_id,reservation_id)
              );
            end if;
          end;
          $fixture$;
          insert into ams_private.p22_paid_operation_replays_v1
            (user_id,reservation_id,provider,operation,sequence,request_sha256,state,result_json,completed_at)
          values
            ('99999999-9999-4999-8999-999999999999','99999999-9999-4999-a999-999999999991','qwen','analyze',0,'${'c'.repeat(64)}','completed','{"ok":true}',now());
          ;`;
        const legacyRun = psql(dbName, null, { stdin: legacy });
        assert.equal(legacyRun.status, 0, legacyRun.stderr || legacyRun.stdout);
      }
      const sql = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
      const run = psql(dbName, null, { stdin: sql });
      assert.equal(run.status, 0, `迁移失败：${name}\n${run.stderr || run.stdout}`);
      if (name === '20260815035041_p22_full_request_idempotency_binding.sql') {
        const retired = psql(dbName, `select
          to_regclass('ams_private.p22_paid_operation_replays_v1') is null,
          to_regprocedure('api.p22_claim_paid_operation_replay(uuid,uuid,text,text,integer,text)') is null,
          to_regprocedure('api.p22_get_paid_operation_replay(uuid,uuid,text,text,integer,text)') is null,
          to_regprocedure('api.p22_complete_paid_operation_replay(uuid,uuid,text,text,integer,text,jsonb)') is null,
          to_regprocedure('api.p22_fail_paid_operation_replay(uuid,uuid,text,text,integer,text,text)') is null;`);
        assert.equal(retired.status, 0, retired.stderr || retired.stdout);
        assert.deepEqual(retired.stdout.trim().split('|'), ['t', 't', 't', 't', 't']);
        const preserved = psql(dbName, `select user_id,provider,operation,sequence,request_sha256,reservation_id,amount_cny
          from ams_private.p22_paid_operation_bindings_v1
          where reservation_id='99999999-9999-4999-a999-999999999991';`);
        assert.equal(preserved.status, 0, preserved.stderr || preserved.stdout);
        assert.deepEqual(preserved.stdout.trim().split('|'), [
          '99999999-9999-4999-8999-999999999999', 'qwen', 'analyze', '0', 'c'.repeat(64),
          '99999999-9999-4999-a999-999999999991', '1.0000',
        ]);
        const preservedRetry = psql(dbName, `select api.p22_claim_paid_operation(
          '99999999-9999-4999-8999-999999999999','qwen','analyze',0,'original-key','${'c'.repeat(64)}',1,
          '99999999-9999-4999-a999-999999999991')::text;`);
        assert.equal(preservedRetry.status, 0, preservedRetry.stderr || preservedRetry.stdout);
        assert.equal(JSON.parse(preservedRetry.stdout.trim()).outcome, 'already_claimed');
        const preservedConflict = psql(dbName, `select api.p22_claim_paid_operation(
          '99999999-9999-4999-8999-999999999999','qwen','analyze',0,'original-key','${'d'.repeat(64)}',1,
          '99999999-9999-4999-a999-999999999991')::text;`);
        assert.notEqual(preservedConflict.status, 0);
        assert.match(preservedConflict.stderr, /P22_IDEMPOTENCY_CONFLICT/);
        const cleanLegacy = psql(dbName, `delete from ams_private.p22_paid_operation_bindings_v1
          where user_id='99999999-9999-4999-8999-999999999999';
          delete from auth.users where id='99999999-9999-4999-8999-999999999999';`);
        assert.equal(cleanLegacy.status, 0, cleanLegacy.stderr || cleanLegacy.stdout);
      }
    }

    // ---- 全部 SQL 测试逐一通过（已验收 P17 系列 + P19/P20/P22 + P17-B2 对抗）----
    // The Harness forward migration is function-only. Paid-operation replay
    // storage is intentionally outside this authorization and must not be
    // introduced as a side effect of the concurrency guard.
    const paidUser = '77777777-7777-4777-8777-777777777777';
    const requestA = 'a'.repeat(64);
    const requestB = 'b'.repeat(64);
    const reservationA = '55555555-5555-4555-a555-555555555551';
    const reservationProvider = '55555555-5555-4555-a555-555555555552';
    const seedPaidUsers = psql(dbName, `insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous) values
      ('${paidUser}','authenticated','authenticated','paid@example.invalid','{}','{}',now(),now(),false,false),
      ('88888888-8888-4888-8888-888888888888','authenticated','authenticated','paid-concurrent@example.invalid','{}','{}',now(),now(),false,false);`);
    assert.equal(seedPaidUsers.status, 0, seedPaidUsers.stderr || seedPaidUsers.stdout);
    const claim = (sha, reservation, provider = 'apify', sequence = 0) =>
      `select api.p22_claim_paid_operation('${paidUser}','${provider}','collect_url',${sequence},'exact-key','${sha}',2,'${reservation}')::text;`;
    const firstClaim = psql(dbName, claim(requestA, reservationA));
    assert.equal(firstClaim.status, 0, firstClaim.stderr || firstClaim.stdout);
    assert.equal(JSON.parse(firstClaim.stdout.trim()).outcome, 'claimed');
    const exactRetry = psql(dbName, claim(requestA, reservationA));
    assert.equal(exactRetry.status, 0, exactRetry.stderr || exactRetry.stdout);
    assert.equal(JSON.parse(exactRetry.stdout.trim()).outcome, 'already_claimed');
    const conflict = psql(dbName, claim(requestB, reservationA));
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /P22_IDEMPOTENCY_CONFLICT/);
    const providerIsolation = psql(dbName, claim(requestA, reservationProvider, 'qwen'));
    assert.equal(providerIsolation.status, 0, providerIsolation.stderr || providerIsolation.stdout);
    assert.equal(JSON.parse(providerIsolation.stdout.trim()).outcome, 'claimed');
    const paidCounts = psql(dbName, `select (select count(*) from ams_private.p22_paid_operation_bindings_v1 where user_id='${paidUser}'), (select count(*) from public.cost_records where user_id='${paidUser}');`);
    assert.deepEqual(paidCounts.stdout.trim().split('|'), ['2', '2']);
    const paidAcl = psql(dbName, `select
      has_table_privilege('anon','ams_private.p22_paid_operation_bindings_v1','select'),
      has_table_privilege('authenticated','ams_private.p22_paid_operation_bindings_v1','select'),
      has_table_privilege('service_role','ams_private.p22_paid_operation_bindings_v1','select'),
      has_function_privilege('anon','api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid)','execute'),
      has_function_privilege('authenticated','api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid)','execute'),
      has_function_privilege('service_role','api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid)','execute');`);
    assert.deepEqual(paidAcl.stdout.trim().split('|'), ['f', 'f', 't', 'f', 'f', 't']);

    const concurrentPaidUser = '88888888-8888-4888-8888-888888888888';
    const concurrentPaidReservation = '66666666-6666-4666-a666-666666666661';
    const concurrentPaidSql = `select api.p22_claim_paid_operation('${concurrentPaidUser}','apify','search',0,'concurrent-paid-key','${requestA}',2,'${concurrentPaidReservation}')::text;`;
    const concurrentPaidRuns = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(dbName, concurrentPaidSql)));
    const concurrentPaidOutcomes = concurrentPaidRuns.map((run) => {
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout.trim()).outcome;
    });
    assert.equal(concurrentPaidOutcomes.filter((outcome) => outcome === 'claimed').length, 1);
    assert.equal(concurrentPaidOutcomes.filter((outcome) => outcome === 'already_claimed').length, 5);
    const concurrentPaidCounts = psql(dbName, `select (select count(*) from ams_private.p22_paid_operation_bindings_v1 where user_id='${concurrentPaidUser}'), (select count(*) from public.cost_records where user_id='${concurrentPaidUser}');`);
    assert.deepEqual(concurrentPaidCounts.stdout.trim().split('|'), ['1', '1']);
    const cleanPaid = psql(dbName, `delete from ams_private.p22_paid_operation_bindings_v1 where user_id in ('${paidUser}','${concurrentPaidUser}'); delete from public.cost_records where user_id in ('${paidUser}','${concurrentPaidUser}'); delete from auth.users where id in ('${paidUser}','${concurrentPaidUser}');`);
    assert.equal(cleanPaid.status, 0, cleanPaid.stderr || cleanPaid.stdout);

    const harnessMigration = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', '20260815085353_harness_brief_version_concurrency_guard.sql'), 'utf8');
    assert.doesNotMatch(harnessMigration, /\b(?:create|alter)\s+table\b/i);
    assert.doesNotMatch(harnessMigration, /\b(?:enable|force)\s+row\s+level\s+security\b/i);
    assert.doesNotMatch(harnessMigration, /\bcreate\s+policy\b/i);
    const tests = readdirSync(join(REPO_ROOT, 'supabase', 'tests'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assert.ok(tests.length >= 6, 'SQL 测试数量必须 >= 6（4 个已验收 P17 + P19 + P17-B2 对抗）');
    const p17MigrationSql = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', P17_MIGRATION), 'utf8');
    for (const name of tests) {
      let sql = readFileSync(join(REPO_ROOT, 'supabase', 'tests', name), 'utf8');
      if (name === P17_B2_TEST) {
        sql = injectMigrationHelpers(p17MigrationSql, sql);
      }
      const run = psql(dbName, null, { stdin: sql });
      assert.equal(run.status, 0, `SQL 测试失败：${name}\n${run.stderr || run.stdout}`);
    }

    // ---- 并发幂等：同 key 并行调用恰好一次 applied ----
    execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'postgres', '-d', dbName, '-q', '-c',
      `insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
       values ('${CONCURRENT_USER}','authenticated','authenticated','conc@example.invalid','{}','{}',now(),now(),false,false)
       on conflict (id) do nothing;`], { encoding: 'utf8' });
    const callSql = `select api.p19_apply_entity_write('${CONCURRENT_USER}','${CONCURRENT_KEY}','project.create','project','${CONCURRENT_PROJECT}', jsonb_build_object('command','project.create'), 'p19_research_projects_v1', jsonb_build_object('id','${CONCURRENT_PROJECT}','version',1,'schema_version','p19_research_project_v1','status','active','topic','并发','objective','o','audience','a','channel','c','constraints','[]'::jsonb), null, null)::text;`;
    const runs = [];
    for (let index = 0; index < CONCURRENT_SESSIONS; index += 1) {
      runs.push(psqlAsync(dbName, callSql));
    }
    const completedRuns = await Promise.all(runs);
    const outcomes = completedRuns.map((run) => {
      assert.equal(run.status, 0, `并发会话失败：${run.stderr || run.stdout}`);
      return JSON.parse(run.stdout.trim().split('\n').pop());
    });
    const applied = outcomes.filter((outcome) => outcome.outcome === 'applied');
    const replayed = outcomes.filter((outcome) => outcome.outcome === 'replayed');
    assert.equal(applied.length, 1, `并发同 key 必须恰好一次 applied，实际 ${applied.length}`);
    assert.equal(replayed.length, CONCURRENT_SESSIONS - 1, `其余会话必须全部 replayed，实际 ${replayed.length}`);
    const counts = psql(dbName, `select (select count(*) from ams_private.p19_research_projects_v1 where project_id='${CONCURRENT_PROJECT}'), (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key='${CONCURRENT_KEY}');`);
    const rows = counts.stdout.trim().split(/[\s|]+/).filter(Boolean);
    assert.deepEqual(rows, ['1', '1'], '并发后必须恰好 1 行项目 + 1 行台账');

    // ---- 归档竞态：归档事务先持有同项目锁，后到的实体写必须等待并拒绝 ----
    const raceProject = 'prj-ffffffffffffffffffffffff';
    const raceEvidence = 'ev-ffffffffffffffffffffffff';
    const createRace = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','race-create','project.create','project','${raceProject}', jsonb_build_object('command','project.create','request_payload',jsonb_build_object('project','race')), 'p19_research_projects_v1', jsonb_build_object('id','${raceProject}','version',1,'schema_version','p19_research_project_v1','status','active','topic','竞态','objective','o','audience','a','channel','c','constraints','[]'::jsonb), null, null)::text;`);
    assert.equal(createRace.status, 0, createRace.stderr || createRace.stdout);
    const archiveSql = `begin; select 1 from ams_private.p19_project_locks_v1 where user_id='${CONCURRENT_USER}' and project_id='${raceProject}' for update; select pg_sleep(1); select api.p19_apply_entity_write('${CONCURRENT_USER}','race-archive','project.archive','project','${raceProject}', jsonb_build_object('command','project.archive','request_payload',jsonb_build_object('project_id','${raceProject}')), 'p19_research_projects_v1', jsonb_build_object('id','${raceProject}','version',2,'schema_version','p19_research_project_v1','status','archived','topic','竞态','objective','o','audience','a','channel','c','constraints','[]'::jsonb), null, 1)::text; commit;`;
    const mutateSql = `select api.p19_apply_entity_write('${CONCURRENT_USER}','race-mutate','evidence.create','evidence','${raceEvidence}', jsonb_build_object('command','evidence.create','request_payload',jsonb_build_object('project_id','${raceProject}')), 'p19_evidence_records_v1', jsonb_build_object('id','${raceEvidence}','project_id','${raceProject}','schema_version','p19_evidence_record_v1','source_url','https://example.com/race','label','race','platform','manual','content_text','race','recorded_at','2026-08-12T00:00:00Z','provenance',jsonb_build_object('manual',true),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z'), null, null)::text;`;
    const archiveRunPromise = psqlAsync(dbName, archiveSql);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    const mutationRunPromise = psqlAsync(dbName, mutateSql);
    const [archiveRun, mutationRun] = await Promise.all([archiveRunPromise, mutationRunPromise]);
    assert.equal(archiveRun.status, 0, archiveRun.stderr || archiveRun.stdout);
    assert.notEqual(mutationRun.status, 0, '归档持锁后到的实体写必须失败');
    assert.match(mutationRun.stderr, /P19_PROJECT_ARCHIVED/);
    const raceCounts = psql(dbName, `select (select status from ams_private.p19_research_projects_v1 where user_id='${CONCURRENT_USER}' and project_id='${raceProject}' order by project_version desc limit 1), (select count(*) from ams_private.p19_evidence_records_v1 where project_id='${raceProject}'), (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key='race-mutate');`);
    assert.deepEqual(raceCounts.stdout.trim().split(/[\s|]+/).filter(Boolean), ['archived', '0', '0'], '归档胜出后不得留下实体或失败台账');

    // ---- Harness project revision race: the v2 wrapper and mutation share one lock/transaction. ----
    const revisionProject = 'prj-abababababababababababab';
    const revisionEvidence = 'ev-abababababababababababab';
    const createRevisionProject = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','revision-create','project.create','project','${revisionProject}','{}'::jsonb,'p19_research_projects_v1',jsonb_build_object('id','${revisionProject}','version',1,'schema_version','p19_research_project_v1','status','active','topic','revision','objective','o','audience','a','channel','c','constraints','[]'::jsonb),null,null,null)::text;`);
    assert.equal(createRevisionProject.status, 0, createRevisionProject.stderr || createRevisionProject.stdout);
    const browserEvidence = 'ev-acababababababababababab';
    const browserCompatibleWrite = psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','browser-compatible-entity','evidence.create','evidence','${browserEvidence}','{}'::jsonb,'p19_evidence_records_v1',jsonb_build_object('id','${browserEvidence}','project_id','${revisionProject}','schema_version','p19_evidence_record_v1','source_url','https://example.com/browser','label','browser','platform','manual','content_text','browser','recorded_at','2026-08-12T00:00:00Z','provenance',jsonb_build_object('manual',true),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z'),null,null,null,null)::text;`);
    assert.equal(browserCompatibleWrite.status, 0, browserCompatibleWrite.stderr || browserCompatibleWrite.stdout);
    assert.match(browserCompatibleWrite.stdout, /applied/, 'existing browser write path remains compatible when no project revision is supplied');
    const projectAdvance = `begin; select 1 from ams_private.p19_project_locks_v1 where user_id='${CONCURRENT_USER}' and project_id='${revisionProject}' for update; select pg_sleep(1); select api.p19_apply_entity_write('${CONCURRENT_USER}','revision-advance','project.update','project','${revisionProject}','{}'::jsonb,'p19_research_projects_v1',jsonb_build_object('id','${revisionProject}','version',2,'schema_version','p19_research_project_v1','status','active','topic','revision 2','objective','o','audience','a','channel','c','constraints','[]'::jsonb),null,1,null)::text; commit;`;
    const staleEntity = `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','revision-stale-entity','evidence.create','evidence','${revisionEvidence}','{}'::jsonb,'p19_evidence_records_v1',jsonb_build_object('id','${revisionEvidence}','project_id','${revisionProject}','schema_version','p19_evidence_record_v1','source_url','https://example.com/revision','label','revision','platform','manual','content_text','revision','recorded_at','2026-08-12T00:00:00Z','provenance',jsonb_build_object('manual',true),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z'),null,null,null,1)::text;`;
    const advancePromise = psqlAsync(dbName, projectAdvance);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    const stalePromise = psqlAsync(dbName, staleEntity);
    const [advanceResult, staleResult] = await Promise.all([advancePromise, stalePromise]);
    assert.equal(advanceResult.status, 0, advanceResult.stderr || advanceResult.stdout);
    assert.notEqual(staleResult.status, 0, 'stale Harness entity write must fail after the concurrent project revision commits');
    assert.match(staleResult.stderr, /P19_PROJECT_REVISION_STALE/);
    const revisionState = psql(dbName, `select (select max(project_version) from ams_private.p19_research_projects_v1 where user_id='${CONCURRENT_USER}' and project_id='${revisionProject}'), (select count(*) from ams_private.p19_evidence_records_v1 where user_id='${CONCURRENT_USER}' and project_id='${revisionProject}'), (select count(*) from ams_private.p19_command_ledger_v1 where user_id='${CONCURRENT_USER}' and idempotency_key='revision-stale-entity');`);
    assert.deepEqual(revisionState.stdout.trim().split('|'), ['2', '1', '0'], 'atomic revision rejection leaves only the prior browser-compatible entity and no stale ledger row');

    // ---- Exact retry after a successful revision-changing update must replay. ----
    const replayProject = 'prj-acacacacacacacacacacacac';
    const createReplayProject = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','replay-create','project.create','project','${replayProject}','{}'::jsonb,'p19_research_projects_v1',jsonb_build_object('id','${replayProject}','version',1,'schema_version','p19_research_project_v1','status','active','topic','replay','objective','o','audience','a','channel','c','constraints','[]'::jsonb),null,null,null)::text;`);
    assert.equal(createReplayProject.status, 0, createReplayProject.stderr || createReplayProject.stdout);
    const replaySummary = `jsonb_build_object('command','project.update','request_payload',jsonb_build_object('project_id','${replayProject}','patch',jsonb_build_object('topic','revision two'),'expected_revision',1),'payload_sha256',null)`;
    const replayPayload = `jsonb_build_object('id','${replayProject}','version',2,'schema_version','p19_research_project_v1','status','active','topic','revision two','objective','o','audience','a','channel','c','constraints','[]'::jsonb)`;
    const replayCall = `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','replay-update','project.update','project','${replayProject}',${replaySummary},'p19_research_projects_v1',${replayPayload},null,1,null,1)::text;`;
    const replayFirst = psql(dbName, replayCall);
    assert.equal(replayFirst.status, 0, replayFirst.stderr || replayFirst.stdout);
    assert.match(replayFirst.stdout, /applied/);
    const replaySecond = psql(dbName, replayCall);
    assert.equal(replaySecond.status, 0, replaySecond.stderr || replaySecond.stdout);
    assert.match(replaySecond.stdout, /replayed/, 'same key and request must replay before revision-stale validation');
    const replayConflict = psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','replay-update','project.update','project','${replayProject}',jsonb_build_object('command','project.update','request_payload',jsonb_build_object('project_id','${replayProject}','patch',jsonb_build_object('topic','different'),'expected_revision',1),'payload_sha256',null),'p19_research_projects_v1',${replayPayload},null,1,null,1)::text;`);
    assert.notEqual(replayConflict.status, 0);
    assert.match(replayConflict.stderr, /P19_IDEMPOTENCY_CONFLICT/);
    const replayState = psql(dbName, `select (select max(project_version) from ams_private.p19_research_projects_v1 where user_id='${CONCURRENT_USER}' and project_id='${replayProject}'), (select count(*) from ams_private.p19_command_ledger_v1 where user_id='${CONCURRENT_USER}' and idempotency_key='replay-update');`);
    assert.deepEqual(replayState.stdout.trim().split('|'), ['2', '1']);
    // ---- Entity optimistic fingerprint: one stale snapshot can win only once. ----
    const entityEvidence = 'ev-dddddddddddddddddddddddd';
    const oldFingerprint = 'a'.repeat(64);
    const leftFingerprint = 'b'.repeat(64);
    const rightFingerprint = 'c'.repeat(64);
    const evidencePayload = (label, fingerprint) => `jsonb_build_object('id','${entityEvidence}','project_id','${CONCURRENT_PROJECT}','schema_version','p19_evidence_record_v1','source_url','https://example.com/entity-race','label','${label}','platform','manual','content_text','entity race','recorded_at','2026-08-12T00:00:00Z','provenance',jsonb_build_object('manual',true),'media_metadata','null'::jsonb,'version',1,'fingerprint','${fingerprint}','created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z')`;
    const createEntity = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','entity-create','evidence.create','evidence','${entityEvidence}','{}'::jsonb,'p19_evidence_records_v1',${evidencePayload('baseline', oldFingerprint)},null,null,null)::text;`);
    assert.equal(createEntity.status, 0, createEntity.stderr || createEntity.stdout);

    const updateLeft = `select api.p19_apply_entity_write('${CONCURRENT_USER}','entity-update-left','evidence.update','evidence','${entityEvidence}','{}'::jsonb,'p19_evidence_records_v1',${evidencePayload('left', leftFingerprint)},null,null,'${oldFingerprint}')::text;`;
    const updateRight = `select api.p19_apply_entity_write('${CONCURRENT_USER}','entity-update-right','evidence.update','evidence','${entityEvidence}','{}'::jsonb,'p19_evidence_records_v1',${evidencePayload('right', rightFingerprint)},null,null,'${oldFingerprint}')::text;`;
    const updateRuns = await Promise.all([psqlAsync(dbName, updateLeft), psqlAsync(dbName, updateRight)]);
    assert.equal(updateRuns.filter((run) => run.status === 0).length, 1, 'one stale entity fingerprint must allow exactly one concurrent update');
    assert.match(updateRuns.find((run) => run.status !== 0)?.stderr || '', /P19_ENTITY_REVISION_STALE/);
    const entityState = psql(dbName, `select payload->>'label', payload->>'fingerprint', (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key in ('entity-update-left','entity-update-right')) from ams_private.p19_evidence_records_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}' and evidence_id='${entityEvidence}';`);
    const [winningLabel, winningFingerprint, updateLedgerCount] = entityState.stdout.trim().split('|');
    assert.ok((winningLabel === 'left' && winningFingerprint === leftFingerprint) || (winningLabel === 'right' && winningFingerprint === rightFingerprint));
    assert.equal(updateLedgerCount, '1', 'the rejected stale update must not leave a command ledger row');

    const entityBrief = 'brief-dddddddddddddddddddddddd';
    const pendingBriefFingerprint = 'd'.repeat(64);
    const approvedBriefFingerprint = 'e'.repeat(64);
    const returnedBriefFingerprint = 'f'.repeat(64);
    const briefPayload = (status, fingerprint, decision, version = 1, cardIds = ['kc-dddddddddddddddddddddddd'], projectId = CONCURRENT_PROJECT) => `jsonb_build_object('id','${entityBrief}','project_id','${projectId}','schema_version','ams_content_brief_v1','version',${version},'status','${status}','topic','entity race','objective','o','audience','a','channel','c','constraints','[]'::jsonb,'knowledge_citation_ids','${JSON.stringify(cardIds)}'::jsonb,'structural_guidance','[]'::jsonb,'evidence_provenance',jsonb_build_object('local_only',true),'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id','${entityBrief}','decision',${decision},'comments','[]'::jsonb),'fingerprint','${fingerprint}','created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z')`;
    const createBrief = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','brief-create','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', pendingBriefFingerprint, "'null'::jsonb")},null,null,null)::text;`);
    assert.equal(createBrief.status, 0, createBrief.stderr || createBrief.stdout);
    const approvedDecision = `jsonb_build_object('value','approved','source','local_manual','rationale','approved','decided_by','left','decided_at','2026-08-12T00:00:01Z')`;
    const returnedDecision = `jsonb_build_object('value','return_for_revision','source','local_manual','rationale','returned','decided_by','right','decided_at','2026-08-12T00:00:02Z')`;
    const decideLeft = `select api.p19_apply_entity_write('${CONCURRENT_USER}','brief-decide-left','brief.decide','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('approved', approvedBriefFingerprint, approvedDecision)},null,null,'${pendingBriefFingerprint}')::text;`;
    const decideRight = `select api.p19_apply_entity_write('${CONCURRENT_USER}','brief-decide-right','brief.decide','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('returned', returnedBriefFingerprint, returnedDecision)},null,null,'${pendingBriefFingerprint}')::text;`;
    const decisionRuns = await Promise.all([psqlAsync(dbName, decideLeft), psqlAsync(dbName, decideRight)]);
    assert.equal(decisionRuns.filter((run) => run.status === 0).length, 1, 'one stale Brief fingerprint must allow exactly one concurrent decision');
    assert.match(decisionRuns.find((run) => run.status !== 0)?.stderr || '', /P19_ENTITY_REVISION_STALE/);
    const briefState = psql(dbName, `select brief_status, payload->>'fingerprint', (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key in ('brief-decide-left','brief-decide-right')) from ams_private.p19_briefs_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}' and brief_id='${entityBrief}' and brief_version=1;`);
    const [winningBriefStatus, winningBriefFingerprint, decisionLedgerCount] = briefState.stdout.trim().split('|');
    assert.ok((winningBriefStatus === 'approved' && winningBriefFingerprint === approvedBriefFingerprint) || (winningBriefStatus === 'returned' && winningBriefFingerprint === returnedBriefFingerprint));
    assert.equal(decisionLedgerCount, '1', 'the rejected stale decision must not leave a command ledger row');

    const projectRevision = psql(dbName, `select max(project_version) from ams_private.p19_research_projects_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}';`).stdout.trim();
    const v2LeftFingerprint = '1'.repeat(64);
    const v2RightFingerprint = '2'.repeat(64);
    const threeCards = ['kc-dddddddddddddddddddddddd', 'kc-eeeeeeeeeeeeeeeeeeeeeeee', 'kc-ffffffffffffffffffffffff'];
    const rejectedV2Keys = ['brief-v2-missing-revision', 'brief-v2-stale-revision', 'brief-v2-missing-fingerprint', 'brief-v2-old-fingerprint', 'brief-v2-wrong-project', 'brief-v2-wrong-user'];
    const rejectedV2 = [
      psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','${rejectedV2Keys[0]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${winningBriefFingerprint}',null)::text;`),
      psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','${rejectedV2Keys[1]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${winningBriefFingerprint}',${Number(projectRevision) + 1})::text;`),
      psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','${rejectedV2Keys[2]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,null,${projectRevision})::text;`),
      psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','${rejectedV2Keys[3]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${'0'.repeat(64)}',${projectRevision})::text;`),
    ];
    assert.match(rejectedV2[0].stderr, /P19_PROJECT_REVISION_STALE/);
    assert.match(rejectedV2[1].stderr, /P19_PROJECT_REVISION_STALE/);
    assert.match(rejectedV2[2].stderr, /P19_ENTITY_REVISION_STALE/);
    assert.match(rejectedV2[3].stderr, /P19_ENTITY_REVISION_STALE/);

    const otherProject = 'prj-dededededededededededede';
    const createOtherProject = psql(dbName, `select api.p19_apply_entity_write('${CONCURRENT_USER}','brief-other-project-create','project.create','project','${otherProject}','{}'::jsonb,'p19_research_projects_v1',jsonb_build_object('id','${otherProject}','version',1,'schema_version','p19_research_project_v1','status','active','topic','other','objective','o','audience','a','channel','c','constraints','[]'::jsonb),null,null,null)::text;`);
    assert.equal(createOtherProject.status, 0, createOtherProject.stderr || createOtherProject.stdout);
    const wrongProject = psql(dbName, `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','${rejectedV2Keys[4]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards, otherProject)},null,null,'${winningBriefFingerprint}',1)::text;`);
    assert.match(wrongProject.stderr, /P19_ENTITY_REVISION_STALE/);
    const wrongBriefUser = '99999999-9999-4999-8999-999999999999';
    const seedWrongBriefUser = psql(dbName, `insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous) values ('${wrongBriefUser}','authenticated','authenticated','wrong-brief@example.invalid','{}','{}',now(),now(),false,false);`);
    assert.equal(seedWrongBriefUser.status, 0, seedWrongBriefUser.stderr || seedWrongBriefUser.stdout);
    const wrongUser = psql(dbName, `select api.p19_apply_entity_write_v2('${wrongBriefUser}','${rejectedV2Keys[5]}','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${winningBriefFingerprint}',${projectRevision})::text;`);
    assert.match(wrongUser.stderr, /P19_PROJECT_REVISION_STALE/);
    const rejectedV2State = psql(dbName, `select (select count(*) from ams_private.p19_briefs_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}' and brief_id='${entityBrief}' and brief_version=2), (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key = any(array['${rejectedV2Keys.join("','")}']));`);
    assert.deepEqual(rejectedV2State.stdout.trim().split('|'), ['0', '0'], 'all rejected baselines must leave zero v2 rows and zero command ledger rows');

    const v2Left = `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','brief-v2-left','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2LeftFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${winningBriefFingerprint}',${projectRevision})::text;`;
    const v2Right = `select api.p19_apply_entity_write_v2('${CONCURRENT_USER}','brief-v2-right','brief.assemble','brief','${entityBrief}','{}'::jsonb,'p19_briefs_v1',${briefPayload('pending_review', v2RightFingerprint, "'null'::jsonb", 2, threeCards)},null,null,'${winningBriefFingerprint}',${projectRevision})::text;`;
    const v2Runs = await Promise.all([psqlAsync(dbName, v2Left), psqlAsync(dbName, v2Right)]);
    assert.equal(v2Runs.filter((run) => run.status === 0).length, 1, `the latest v1 fingerprint must permit exactly one concurrent v2: ${JSON.stringify(v2Runs)}`);
    assert.match(v2Runs.find((run) => run.status !== 0)?.stderr || '', /P19_ENTITY_REVISION_STALE/);
    const v2State = psql(dbName, `select brief_version, jsonb_array_length(payload->'knowledge_citation_ids'), (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key in ('brief-v2-left','brief-v2-right')) from ams_private.p19_briefs_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}' and brief_id='${entityBrief}' order by brief_version desc limit 1;`);
    assert.deepEqual(v2State.stdout.trim().split('|'), ['2', '3', '1']);

    const removeLeft = `select api.p19_remove_evidence('${CONCURRENT_USER}','entity-remove-left','evidence.remove','{}'::jsonb,'${CONCURRENT_PROJECT}','${entityEvidence}','${winningFingerprint}')::text;`;
    const removeRight = `select api.p19_remove_evidence('${CONCURRENT_USER}','entity-remove-right','evidence.remove','{}'::jsonb,'${CONCURRENT_PROJECT}','${entityEvidence}','${winningFingerprint}')::text;`;
    const removeRuns = await Promise.all([psqlAsync(dbName, removeLeft), psqlAsync(dbName, removeRight)]);
    assert.equal(removeRuns.filter((run) => run.status === 0).length, 1, 'one stale entity fingerprint must allow exactly one concurrent remove');
    assert.match(removeRuns.find((run) => run.status !== 0)?.stderr || '', /P19_ENTITY_REVISION_STALE/);
    const removeState = psql(dbName, `select (select count(*) from ams_private.p19_evidence_records_v1 where user_id='${CONCURRENT_USER}' and project_id='${CONCURRENT_PROJECT}' and evidence_id='${entityEvidence}'), (select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key in ('entity-remove-left','entity-remove-right'));`);
    assert.deepEqual(removeState.stdout.trim().split('|'), ['0', '1'], 'concurrent remove must leave zero entities and one successful ledger row');
  } finally {
    execFileSync('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', dbName], { encoding: 'utf8', stdio: 'ignore' });
  }
});
