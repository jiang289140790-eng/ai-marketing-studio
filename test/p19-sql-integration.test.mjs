// P19 真实 PostgreSQL 17 / Supabase-local SQL 集成测试（隔离、全新数据库）。
//
// 前置：Docker 容器 supabase_db_p19-op-workbench（postgres 17.6.1.147，
// 与已验收 P17 环境同源；容器不可用时本文件跳过，npm test 不受影响）。
//
// 覆盖（要求验证 #1 与 #8 的真实 SQL 执行部分）：
//   - 全新数据库上回放全部 40 个迁移（bootstrap 仅复刻已验收环境：
//     storage/auth/extensions/graphql_public/vault 架构与扩展，非迁移变更）；
//   - 全部 7 个 SQL 测试（4 个已验收 P17 + 3 个 P19）逐一通过；
//   - 并发幂等：N 个并行 psql 会话以同一 (user_id, idempotency_key) 调用
//     边界，恰好一次 applied、其余全部 replayed，且恰好 1 行项目 + 1 行台账。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const CONTAINER = 'supabase_db_p19-op-workbench';

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

const CONCURRENT_SESSIONS = 6;
const CONCURRENT_USER = '44444444-4444-4444-8444-444444444444';
const CONCURRENT_PROJECT = 'prj-eeeeeeeeeeeeeeeeeeeeeeee';
const CONCURRENT_KEY = 'conc-key-1';

test('SQL 集成：全新数据库回放 41 迁移 + SQL 测试 + 并发幂等（真实 PostgreSQL 17）', { skip: containerUp() ? false : 'Docker 容器不可用，跳过真实 SQL 集成测试' }, async () => {
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

    // ---- 40 个迁移按顺序回放 ----
    const migrations = readdirSync(join(REPO_ROOT, 'supabase', 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assert.equal(migrations.length, 41, '迁移集必须是规范 39 + P19 + P20 共 41 个');
    for (const name of migrations) {
      const sql = readFileSync(join(REPO_ROOT, 'supabase', 'migrations', name), 'utf8');
      const run = psql(dbName, null, { stdin: sql });
      assert.equal(run.status, 0, `迁移失败：${name}\n${run.stderr || run.stdout}`);
    }

    // ---- 7 个 SQL 测试逐一通过 ----
    const tests = readdirSync(join(REPO_ROOT, 'supabase', 'tests'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    assert.ok(tests.length >= 5, 'SQL 测试数量必须 >= 5（4 个已验收 P17 + P19）');
    for (const name of tests) {
      const sql = readFileSync(join(REPO_ROOT, 'supabase', 'tests', name), 'utf8');
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
