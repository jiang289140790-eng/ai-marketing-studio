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

test('SQL 集成：全新数据库回放 45 迁移 + SQL 测试 + 并发幂等（真实 PostgreSQL 17）', async () => {
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
    assert.equal(migrations.length, 45, '迁移集必须是既有 44 项加 Harness 原子项目修订门禁，共 45 项');
    for (const name of migrations) {
      const sql = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
      const run = psql(dbName, null, { stdin: sql });
      assert.equal(run.status, 0, `迁移失败：${name}\n${run.stderr || run.stdout}`);
    }

    // ---- 全部 SQL 测试逐一通过（已验收 P17 系列 + P19/P20/P22 + P17-B2 对抗）----
    // Harness paid-operation receipts are private, exact, and replayable.
    const receiptUser = '55555555-5555-4555-8555-555555555555';
    const receiptId = '66666666-6666-4666-8666-666666666666';
    const receiptRequest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const receipt = `jsonb_build_object('items',jsonb_build_array(jsonb_build_object('id','source-1')),'cost',jsonb_build_object('recorded_cny',2))`;
    const claimReceipt = psql(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}');`);
    assert.equal(claimReceipt.status, 0, claimReceipt.stderr || claimReceipt.stdout);
    assert.equal(claimReceipt.stdout.trim(), 'claimed');
    const replayPending = psql(dbName, `select api.p22_get_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}')::text;`);
    assert.equal(replayPending.status, 0, replayPending.stderr || replayPending.stdout);
    assert.equal(replayPending.stdout.trim(), '');
    const failReceipt = psql(dbName, `select api.p22_fail_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}','APIFY_TIMEOUT');`);
    assert.equal(failReceipt.status, 0, failReceipt.stderr || failReceipt.stdout);
    assert.equal(failReceipt.stdout.trim(), 'failed');
    const reclaimReceipt = psql(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}');`);
    assert.equal(reclaimReceipt.status, 0, reclaimReceipt.stderr || reclaimReceipt.stdout);
    assert.equal(reclaimReceipt.stdout.trim(), 'reclaimed');
    const concurrentReceiptId = '77777777-7777-4777-8777-777777777777';
    const concurrentClaim = psql(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${concurrentReceiptId}','qwen','analyze',1,'${receiptRequest}');`);
    assert.equal(concurrentClaim.stdout.trim(), 'claimed');
    const concurrentFail = psql(dbName, `select api.p22_fail_paid_operation_replay('${receiptUser}','${concurrentReceiptId}','qwen','analyze',1,'${receiptRequest}','MODEL_TIMEOUT');`);
    assert.equal(concurrentFail.stdout.trim(), 'failed');
    const concurrentReclaims = await Promise.all([
      psqlAsync(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${concurrentReceiptId}','qwen','analyze',1,'${receiptRequest}');`),
      psqlAsync(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${concurrentReceiptId}','qwen','analyze',1,'${receiptRequest}');`),
    ]);
    const reclaimOutcomes = concurrentReclaims.map((run) => {
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return run.stdout.trim();
    }).sort();
    assert.deepEqual(reclaimOutcomes, ['already_claimed', 'reclaimed'], 'only one concurrent retry may reclaim a failed paid operation');
    const claimConflict = psql(dbName, `select api.p22_claim_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');`);
    assert.notEqual(claimConflict.status, 0);
    assert.match(claimConflict.stderr, /P22_PAID_REPLAY_IDENTITY_CONFLICT/);
    const completeReceipt = `select api.p22_complete_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}',${receipt})::text;`;
    const firstReceipt = psql(dbName, completeReceipt);
    assert.equal(firstReceipt.status, 0, firstReceipt.stderr || firstReceipt.stdout);
    const replayReceipt = psql(dbName, `select api.p22_get_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}')::text;`);
    assert.equal(replayReceipt.status, 0, replayReceipt.stderr || replayReceipt.stdout);
    assert.deepEqual(JSON.parse(replayReceipt.stdout.trim()), { cost: { recorded_cny: 2 }, items: [{ id: 'source-1' }] });
    const conflictReceipt = psql(dbName, `select api.p22_complete_paid_operation_replay('${receiptUser}','${receiptId}','apify','collect_url',0,'${receiptRequest}',jsonb_build_object('items','[]'::jsonb))::text;`);
    assert.notEqual(conflictReceipt.status, 0);
    assert.match(conflictReceipt.stderr, /P22_PAID_REPLAY_IDENTITY_CONFLICT/);
    const receiptAcl = psql(dbName, `select c.relrowsecurity,c.relforcerowsecurity,has_function_privilege('anon','api.p22_get_paid_operation_replay(uuid,uuid,text,text,integer,text)','execute'),has_function_privilege('authenticated','api.p22_complete_paid_operation_replay(uuid,uuid,text,text,integer,text,jsonb)','execute'),has_function_privilege('service_role','api.p22_claim_paid_operation_replay(uuid,uuid,text,text,integer,text)','execute') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='ams_private' and c.relname='p22_paid_operation_replays_v1';`);
    assert.deepEqual(receiptAcl.stdout.trim().split('|'), ['t', 't', 'f', 'f', 't']);

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
    assert.deepEqual(revisionState.stdout.trim().split('|'), ['2', '0', '0'], 'atomic revision rejection leaves no entity or ledger row');

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
    const briefPayload = (status, fingerprint, decision) => `jsonb_build_object('id','${entityBrief}','project_id','${CONCURRENT_PROJECT}','schema_version','ams_content_brief_v1','version',1,'status','${status}','topic','entity race','objective','o','audience','a','channel','c','constraints','[]'::jsonb,'knowledge_citation_ids',jsonb_build_array('kc-dddddddddddddddddddddddd'),'structural_guidance','[]'::jsonb,'evidence_provenance',jsonb_build_object('local_only',true),'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id','${entityBrief}','decision',${decision},'comments','[]'::jsonb),'fingerprint','${fingerprint}','created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z')`;
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
