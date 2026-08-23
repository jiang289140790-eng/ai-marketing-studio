// G1 验收 #1 + #2（并发部分）：真实 PostgreSQL 17 / Supabase-local。
//
// - 全新数据库 A：bootstrap（复刻已验收环境）→ 回放全部 50 个迁移 →
//   运行 g1_b0 对抗 SQL → 并发同 key 提交（6 个并行 psql 会话 → 恰好 1
//   applied + 5 replayed + 1 行作业）→ 丢弃；
// - 全新数据库 B：第二次干净回放全部迁移 → 冒烟（注册表/ACL/quote 往返）→
//   丢弃；
// - Docker/容器缺失时给出明确基础设施失败（M1 验收：禁止静默跳过）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const CONTAINER = process.env.AMS_SUPABASE_DB_CONTAINER || 'supabase_db_p19-op-workbench';

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
  if (stdin === null) args.push('-t', '-A', '-c', sql);
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

function bootstrap(dbName) {
  const dump = execFileSync('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
    '--schema-only', '--schema=storage', '--schema=auth', '--schema=extensions',
    '--schema=graphql_public', '--schema=vault'], { encoding: 'utf8' });
  const ext = 'create extension if not exists pgcrypto with schema extensions;\n'
    + 'create extension if not exists "uuid-ossp" with schema extensions;\n'
    + 'create extension if not exists supabase_vault with schema vault;\n';
  let result = psql(dbName, 'create schema if not exists api; create schema if not exists ams_private;');
  assert.equal(result.status, 0, `bootstrap schemas failed: ${result.stderr || result.stdout}`);
  result = psql(dbName, null, { stdin: dump });
  assert.equal(result.status, 0, `bootstrap dump 应用失败：${result.stderr || result.stdout}`);
  result = psql(dbName, null, { stdin: ext });
  assert.equal(result.status, 0, `扩展引导失败：${result.stderr || result.stdout}`);
}

function replayAllMigrations(dbName) {
  const migrations = readdirSync(join(REPO_ROOT, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations.length, 54, '迁移集必须包含 staging 已应用的 G3 历史与 Harness conversation contract，共 54 项');
  for (const name of migrations) {
    if (name === '20260815035041_p22_full_request_idempotency_binding.sql') {
      // P22 迁移需要 legacy 预留行前置（与 p19-sql-integration 同源）。
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
  }
}

function replayG1Adversarial(dbName) {
  const sql = readFileSync(join(REPO_ROOT, 'supabase', 'tests', 'g1_b0_generation_adversarial.test.sql'), 'utf8');
  const run = psql(dbName, null, { stdin: sql });
  assert.equal(run.status, 0, `G1 对抗 SQL 失败：\n${run.stderr || run.stdout}`);
}

function replayConversationContract(dbName) {
  const sql = readFileSync(join(REPO_ROOT, 'supabase', 'tests', 'harness_conversation_contract_v1.test.sql'), 'utf8');
  const run = psql(dbName, null, { stdin: sql });
  assert.equal(run.status, 0, `Harness conversation contract SQL failed:\n${run.stderr || run.stdout}`);
}

test('G1：两次干净迁移回放 + G1 对抗 SQL + 并发同 key 提交（真实 PostgreSQL 17）', async () => {
  const docker = dockerReady();
  assert.ok(docker.ok, `基础设施失败：Docker CLI/daemon 不可用（${docker.version || '无法探测'}），无法回放真实 PostgreSQL 17 迁移`);
  assert.equal(containerUp(), true, `基础设施失败：PostgreSQL 17 容器 ${CONTAINER} 未在运行，无法回放真实迁移`);

  const dbA = `g1_replay_a_${process.pid}`;
  const dbB = `g1_replay_b_${process.pid}`;
  try {
    // ---- 第一次干净回放 ----
    execFileSync('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', dbA], { encoding: 'utf8' });
    bootstrap(dbA);
    replayAllMigrations(dbA);
    replayG1Adversarial(dbA);
    replayConversationContract(dbA);

    const conversationSeed = psql(dbA, `
      insert into auth.users (id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
      values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','thread-concurrency@example.invalid','',now(),now());
      select api.harness_create_thread_v1('dddddddd-dddd-4ddd-8ddd-dddddddddddd','ai-marketing-studio-staging',null,'concurrent-thread','Concurrency');`);
    assert.equal(conversationSeed.status, 0, conversationSeed.stderr || conversationSeed.stdout);
    const conversationThread = JSON.parse(conversationSeed.stdout.trim().split(/\r?\n/).at(-1)).threadId;
    const generationClaims = await Promise.all(['generation-a', 'generation-b'].map((generationId) => psqlAsync(dbA,
      `select api.harness_claim_generation_v1('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${conversationThread}','${generationId}')::text;`)));
    const claimed = generationClaims.map((run) => {
      assert.equal(run.status, 0, run.stderr || run.stdout);
      return JSON.parse(run.stdout.trim()).claimed;
    });
    assert.equal(claimed.filter(Boolean).length, 1, 'two real PostgreSQL sessions must yield exactly one generation claim');

    // 冒烟：注册表 + ACL + quote 往返（第一次回放）。
    const smoke = psql(dbA, `select
      (select count(*) from ams_private.g1_generation_provider_registry_v1),
      (select to_regclass('ams_private.g1_generation_jobs_v1') is not null),
      (select to_regclass('ams_private.g1_generation_artifacts_v1') is not null),
      (select to_regprocedure('api.g1_approve_submit(uuid,text,jsonb,jsonb,integer)') is not null),
      has_function_privilege('anon','api.g1_quote_request(uuid,jsonb)','execute'),
      has_function_privilege('service_role','api.g1_quote_request(uuid,jsonb)','execute'),
      (select public from storage.buckets where id = 'g1-generation-artifacts'),
      has_function_privilege('public','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('anon','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('authenticated','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('service_role','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('public','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      has_function_privilege('anon','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      has_function_privilege('authenticated','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      has_function_privilege('service_role','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      (select prosecdef and proconfig @> array['search_path=ams_private, public'] from pg_proc p where p.oid='ams_private.g1_normalize_request(uuid,jsonb)'::regprocedure),
      (select prosecdef and proconfig @> array['search_path=ams_private, public'] from pg_proc p where p.oid='ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure);`);
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    assert.deepEqual(smoke.stdout.trim().split('|'),
      ['6', 't', 't', 't', 'f', 't', 'f', 'f', 'f', 'f', 't', 'f', 'f', 'f', 't', 't', 't'],
      '第一次回放后注册表/表/函数/ACL（含内部 helper 权限收窄）/私有 bucket 必须精确');

    // ---- 并发同 key 提交：恰好 1 applied + 5 replayed + 1 行作业 ----
    const seed = `
      insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
      values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','authenticated','authenticated','g1-conc@example.invalid','{}','{}',now(),now(),false,false);
      select api.p19_apply_entity_write('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-proj','project.create','project','prj-cccccccccccccccccccccccc','{}'::jsonb,
        'p19_research_projects_v1', jsonb_build_object('id','prj-cccccccccccccccccccccccc','version',1,'schema_version','p19_research_project_v1','status','active','topic','并发','objective','o','audience','a','channel','c','constraints','[]'::jsonb), null, null);
      select api.p19_apply_entity_write('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-ev','evidence.create','evidence','ev-cccccccccccccccccccccccc','{}'::jsonb,
        'p19_evidence_records_v1', jsonb_build_object('id','ev-cccccccccccccccccccccccc','project_id','prj-cccccccccccccccccccccccc','schema_version','p19_evidence_record_v1','source_url','https://example.com/conc','label','并发','platform','manual','content_text','并发','recorded_at','2026-08-16T00:00:00Z','provenance',jsonb_build_object('manual',true),'media_metadata','null'::jsonb,'version',1,'fingerprint','${'c'.repeat(64)}','created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z'), null, null);
      select api.p19_apply_entity_write('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-kc','card.create','card','kc-cccccccccccccccccccccccc','{}'::jsonb,
        'p19_knowledge_cards_v1', jsonb_build_object('id','kc-cccccccccccccccccccccccc','project_id','prj-cccccccccccccccccccccccc','schema_version','content_knowledge_card_v1','version',1,'source_observations',jsonb_build_object('post_text','并发卡'),'evidence_links',jsonb_build_array(jsonb_build_object('claim','c','evidence_type','post_text','source_ref','ev-cccccccccccccccccccccccc')),'trust_status','verified_local','validation_status','bound_exact','fingerprint','${'c'.repeat(64)}','created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z'), null, null);
      select api.p19_apply_entity_write('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-brief','brief.assemble','brief','brief-cccccccccccccccccccccccc','{}'::jsonb,
        'p19_briefs_v1', jsonb_build_object('id','brief-cccccccccccccccccccccccc','project_id','prj-cccccccccccccccccccccccc','schema_version','ams_content_brief_v1','version',1,'status','pending_review','topic','并发 Brief','objective','o','audience','a','channel','c','constraints','[]'::jsonb,'knowledge_citation_ids',jsonb_build_array('kc-cccccccccccccccccccccccc'),'structural_guidance','[]'::jsonb,'evidence_provenance',jsonb_build_object('local_only',true,'evidence_ids',jsonb_build_array('ev-cccccccccccccccccccccccc')),'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id','brief-cccccccccccccccccccccccc','decision','null'::jsonb,'comments','[]'::jsonb),'fingerprint','${'c'.repeat(64)}','created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z'), null, null);
      ;`;
    const seeded = psql(dbA, null, { stdin: seed });
    assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
    const quoteRun = psql(dbA, `select api.g1_quote_request('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-cccccccccccccccccccccccc','mode','image','prompt','并发图片','aspect_ratio','1:1'))::text;`);
    assert.equal(quoteRun.status, 0, quoteRun.stderr || quoteRun.stdout);
    const quoteJson = JSON.parse(quoteRun.stdout.trim());
    const quote = quoteJson.quote;
    const submitSql = `select api.g1_approve_submit('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-key',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-cccccccccccccccccccccccc','mode','image','prompt','并发图片','aspect_ratio','1:1'),
      jsonb_build_object('quote_id','${quote.quote_id}','quote_fingerprint','${quote.quote_fingerprint}','request_fingerprint','${quote.request_sha256}','estimated_max_cost_cny',0.3,'expires_at',now() + interval '10 minutes','source','browser'),
      1)::text;`;
    const runs = await Promise.all(Array.from({ length: 6 }, () => psqlAsync(dbA, submitSql)));
    const outcomes = runs.map((run) => {
      assert.equal(run.status, 0, `并发会话失败：${run.stderr || run.stdout}`);
      return JSON.parse(run.stdout.trim()).outcome;
    });
    assert.equal(outcomes.filter((outcome) => outcome === 'applied').length, 1, `并发同 key 必须恰好 1 applied，实际 ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes.filter((outcome) => outcome === 'replayed').length, 5, `其余必须全部 replayed，实际 ${JSON.stringify(outcomes)}`);
    const counts = psql(dbA, `select (select count(*) from ams_private.g1_generation_jobs_v1 where user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' and idempotency_key='g1c-key'), (select count(*) from ams_private.g1_generation_attempts_v1 where job_id in (select id from ams_private.g1_generation_jobs_v1 where idempotency_key='g1c-key'));`);
    assert.equal(counts.status, 0, counts.stderr || counts.stdout);
    assert.deepEqual(counts.stdout.trim().split('|'), ['1', '1'], '并发后必须恰好 1 行作业 + 1 行尝试');

    // ---- 同 key + 不同规范请求（真实 PG17 对抗重放）：必须 G1_IDEMPOTENCY_CONFLICT
    // （优先于 quote 过期/修订检查），且不得产生第二个作业/尝试 ----
    const conflictRun = psql(dbA, `select api.g1_approve_submit('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-key',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-cccccccccccccccccccccccc','mode','image','prompt','并发图片改','aspect_ratio','1:1'),
      jsonb_build_object('quote_id','${quote.quote_id}','quote_fingerprint','${quote.quote_fingerprint}','request_fingerprint','${quote.request_sha256}','estimated_max_cost_cny',0.3,'expires_at',now() + interval '10 minutes','source','browser'),
      1)::text;`);
    assert.notEqual(conflictRun.status, 0, `同 key 不同请求必须失败：${conflictRun.stdout || conflictRun.stderr}`);
    assert.match(conflictRun.stderr, /G1_IDEMPOTENCY_CONFLICT/, `必须 G1_IDEMPOTENCY_CONFLICT，实际 ${conflictRun.stderr}`);
    const countsAfterConflict = psql(dbA, `select (select count(*) from ams_private.g1_generation_jobs_v1 where user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc' and idempotency_key='g1c-key'), (select count(*) from ams_private.g1_generation_attempts_v1 where job_id in (select id from ams_private.g1_generation_jobs_v1 where idempotency_key='g1c-key'));`);
    assert.equal(countsAfterConflict.status, 0, countsAfterConflict.stderr || countsAfterConflict.stdout);
    assert.deepEqual(countsAfterConflict.stdout.trim().split('|'), ['1', '1'], '冲突拒绝后必须仍只有 1 行作业 + 1 行尝试');

    // ---- P19 证据报价绑定：历史 Brief（evidence_provenance 无 evidence_ids）在
    // 干净回放上必须从被引卡 evidence_links[].source_ref 派生权威证据集并成功报价 ----
    const historicalSeed = `
      select api.p19_apply_entity_write('cccccccc-cccc-4ccc-8ccc-cccccccccccc','g1c-brief-hist','brief.assemble','brief','brief-ccccccccccccccccccccccdd','{}'::jsonb,
        'p19_briefs_v1', jsonb_build_object('id','brief-ccccccccccccccccccccccdd','project_id','prj-cccccccccccccccccccccccc','schema_version','ams_content_brief_v1','version',1,'status','pending_review','topic','历史 Brief','objective','o','audience','a','channel','c','constraints','[]'::jsonb,'knowledge_citation_ids',jsonb_build_array('kc-cccccccccccccccccccccccc'),'structural_guidance','[]'::jsonb,'evidence_provenance',jsonb_build_object('created_from','selected_knowledge_cards','local_only',true,'statement','历史 Brief 无显式证据身份。','store','p19_workspace_v1'),'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id','brief-ccccccccccccccccccccccdd','decision','null'::jsonb,'comments','[]'::jsonb),'fingerprint','${'d'.repeat(64)}','created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z'), null, null);
      ;`;
    const historicalSeeded = psql(dbA, null, { stdin: historicalSeed });
    assert.equal(historicalSeeded.status, 0, historicalSeeded.stderr || historicalSeeded.stdout);
    const historicalQuote = psql(dbA, `select api.g1_quote_request('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-ccccccccccccccccccccccdd','mode','image','prompt','历史绑定图片','aspect_ratio','1:1'))::text;`);
    assert.equal(historicalQuote.status, 0, historicalQuote.stderr || historicalQuote.stdout);
    const historicalQuoteJson = JSON.parse(historicalQuote.stdout.trim());
    assert.equal(historicalQuoteJson.ok, true, '历史 Brief（无 evidence_ids）必须成功报价');
    assert.deepEqual(historicalQuoteJson.quote.evidence_ids, ['ev-cccccccccccccccccccccccc'],
      '历史 Brief 报价必须从卡片 evidence_links 派生权威证据集（绝不视为空集）');
    assert.deepEqual(historicalQuoteJson.quote.knowledge_card_ids, ['kc-cccccccccccccccccccccccc'],
      '历史 Brief 报价必须绑定规范知识卡集合');
    // 显式请求证据与权威集一致 → 复用同一不可变 quote（刷新恢复）。
    const historicalQuoteExact = psql(dbA, `select api.g1_quote_request('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-ccccccccccccccccccccccdd','mode','image','prompt','历史绑定图片','aspect_ratio','1:1','knowledge_card_ids',jsonb_build_array('kc-cccccccccccccccccccccccc'),'evidence_ids',jsonb_build_array('ev-cccccccccccccccccccccccc')))::text;`);
    assert.equal(historicalQuoteExact.status, 0, historicalQuoteExact.stderr || historicalQuoteExact.stdout);
    assert.equal(JSON.parse(historicalQuoteExact.stdout.trim()).quote.quote_fingerprint,
      historicalQuoteJson.quote.quote_fingerprint, '显式精确请求必须复用同一 quote 指纹');
    // 请求证据与权威集不一致 → 报价前 fail closed，零作业。
    const historicalMismatch = psql(dbA, `select api.g1_quote_request('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      jsonb_build_object('schema_version','g1_generation_request_v1','project_id','prj-cccccccccccccccccccccccc','brief_id','brief-ccccccccccccccccccccccdd','mode','image','prompt','历史绑定图片','aspect_ratio','1:1','evidence_ids',jsonb_build_array('ev-111111111111111111111111')))::text;`);
    assert.notEqual(historicalMismatch.status, 0, `不匹配证据请求必须失败：${historicalMismatch.stdout || historicalMismatch.stderr}`);
    assert.match(historicalMismatch.stderr, /G1_BINDING_MISMATCH/, `必须 G1_BINDING_MISMATCH，实际 ${historicalMismatch.stderr}`);
    const jobsAfterBinding = psql(dbA, `select count(*) from ams_private.g1_generation_jobs_v1 where user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';`);
    assert.equal(jobsAfterBinding.status, 0, jobsAfterBinding.stderr || jobsAfterBinding.stdout);
    assert.equal(jobsAfterBinding.stdout.trim(), '1', '绑定失败后必须仍只有 1 行作业（零新 submit）');

    // ---- 第二次干净回放 ----
    execFileSync('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', dbB], { encoding: 'utf8' });
    bootstrap(dbB);
    replayAllMigrations(dbB);
    const smokeB = psql(dbB, `select
      (select count(*) from ams_private.g1_generation_provider_registry_v1),
      (select count(*) from ams_private.g1_generation_jobs_v1),
      (select to_regclass('ams_private.g1_generation_events_v1') is not null),
      has_function_privilege('authenticated','api.g1_complete_attempt(text,text,text,jsonb)','execute'),
      has_function_privilege('service_role','api.g1_complete_attempt(text,text,text,jsonb)','execute'),
      has_function_privilege('public','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('authenticated','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('service_role','ams_private.g1_normalize_request(uuid,jsonb)','execute'),
      has_function_privilege('public','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      has_function_privilege('authenticated','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute'),
      has_function_privilege('service_role','ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)','execute');`);
    assert.equal(smokeB.status, 0, smokeB.stderr || smokeB.stdout);
    assert.deepEqual(smokeB.stdout.trim().split('|'), ['6', '0', 't', 'f', 't', 'f', 'f', 't', 'f', 'f', 't'],
      '第二次干净回放后注册表/空作业表/事件表/ACL（含内部 helper 权限收窄）必须精确');
  } finally {
    execFileSync('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', dbA], { encoding: 'utf8', stdio: 'ignore' });
    execFileSync('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', dbB], { encoding: 'utf8', stdio: 'ignore' });
  }
});
