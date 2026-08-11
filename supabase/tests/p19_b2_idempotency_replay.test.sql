-- P19-B2: atomic idempotency reservation before mutation (sequential replay).
-- Concurrent same-key requests are exercised separately by
-- test/p19-sql-integration.test.mjs with parallel psql sessions; this file
-- proves the replay semantics of the transactional boundary in one session:
--   - the same (user_id, idempotency_key) applies exactly once;
--   - replays return the recorded ledger row and never mutate;
--   - a different key that would produce the same project is rejected
--     (never branches from an existing revision).

begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P19_B2_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','p19-b2@example.invalid','{}','{}',now(),now(),false,false);

do $$
declare
  u constant uuid := '44444444-4444-4444-8444-444444444444';
  p1 constant text := 'prj-dddddddddddddddddddddddd';
  payload1 jsonb;
  result jsonb;
begin
  payload1 := jsonb_build_object(
    'id',p1,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','幂等','objective','目标','audience','受众','channel','渠道',
    'constraints',jsonb_build_array());

  -- 1. First call applies exactly once.
  result := api.p19_apply_entity_write(u,'b2-key-1','project.create','project',p1,
    jsonb_build_object('command','project.create'),'p19_research_projects_v1',payload1,null,null);
  perform pg_temp.assert_true(result->>'outcome' = 'applied', 'first call must apply');
  perform pg_temp.assert_true((select count(*) from ams_private.p19_research_projects_v1 where user_id=u and project_id=p1) = 1,
    'exactly one project row after first call');

  -- 2. Replay with the same key: replayed, no second mutation, ledger intact.
  result := api.p19_apply_entity_write(u,'b2-key-1','project.create','project',p1,
    jsonb_build_object('command','project.create'),'p19_research_projects_v1',payload1,null,null);
  perform pg_temp.assert_true(result->>'outcome' = 'replayed', 'second call must replay');
  perform pg_temp.assert_true(result->'ledger'->>'status' = 'applied', 'replay must carry the applied ledger row');
  perform pg_temp.assert_true(result->'ledger'->>'entity_id' = p1, 'replay must carry the recorded entity');
  perform pg_temp.assert_true((select count(*) from ams_private.p19_research_projects_v1 where user_id=u and project_id=p1) = 1,
    'replay must not mutate');
  perform pg_temp.assert_true((select count(*) from ams_private.p19_command_ledger_v1 where user_id=u and idempotency_key='b2-key-1') = 1,
    'exactly one ledger row for the key');

  -- 2a. Reusing the same key for a different request identity is a conflict,
  --     never a replay of unrelated output.
  begin
    perform api.p19_apply_entity_write(u,'b2-key-1','project.create','project',p1,
      jsonb_build_object('command','project.create','request_payload',jsonb_build_object('topic','different')),
      'p19_research_projects_v1',payload1,null,null);
    raise exception 'P19_B2_ASSERT: idempotency key reuse with changed request accepted';
  exception when others then
    if sqlerrm not like '%P19_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;

  -- 3. Replay via evidence removal: create with key A, remove with key B (applied),
  --    replay B (replayed) — exactly one ledger row per key, evidence gone once.
  perform api.p19_apply_entity_write(u,'b2-ev-a','evidence.create','evidence','ev-cccccccccccccccccccccccc',
    '{}'::jsonb,'p19_evidence_records_v1',
    jsonb_build_object('id','ev-cccccccccccccccccccccccc','project_id',p1,'schema_version','p19_evidence_record_v1',
      'source_url','https://example.com/ev','label','l','platform','p','content_text','c',
      'recorded_at','2026-08-12T00:00:00Z','provenance',jsonb_build_object('manual',true),
      'version',1,'fingerprint',repeat('c',64),
      'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z'),
    null,null);

  -- Exact identity includes command, entity id, logical project and expected base.
  begin
    perform api.p19_apply_entity_write(u,'b2-ev-a','evidence.update','evidence','ev-cccccccccccccccccccccccc',
      '{}'::jsonb,'p19_evidence_records_v1',
      jsonb_build_object('id','ev-cccccccccccccccccccccccc','project_id',p1,'schema_version','p19_evidence_record_v1'),
      null,null);
    raise exception 'P19_B2_ASSERT: changed command accepted';
  exception when others then
    if sqlerrm not like '%P19_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;
  begin
    perform api.p19_apply_entity_write(u,'b2-ev-a','evidence.create','evidence','ev-dddddddddddddddddddddddd',
      '{}'::jsonb,'p19_evidence_records_v1',
      jsonb_build_object('id','ev-dddddddddddddddddddddddd','project_id',p1,'schema_version','p19_evidence_record_v1'),
      null,null);
    raise exception 'P19_B2_ASSERT: changed entity id accepted';
  exception when others then
    if sqlerrm not like '%P19_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;
  begin
    perform api.p19_apply_entity_write(u,'b2-ev-a','evidence.create','evidence','ev-cccccccccccccccccccccccc',
      '{}'::jsonb,'p19_evidence_records_v1',
      jsonb_build_object('id','ev-cccccccccccccccccccccccc','project_id','prj-eeeeeeeeeeeeeeeeeeeeeeee','schema_version','p19_evidence_record_v1'),
      null,null);
    raise exception 'P19_B2_ASSERT: changed logical project accepted';
  exception when others then
    if sqlerrm not like '%P19_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;
  begin
    perform api.p19_apply_entity_write(u,'b2-ev-a','evidence.create','evidence','ev-cccccccccccccccccccccccc',
      '{}'::jsonb,'p19_evidence_records_v1',
      jsonb_build_object('id','ev-cccccccccccccccccccccccc','project_id',p1,'schema_version','p19_evidence_record_v1'),
      null,1);
    raise exception 'P19_B2_ASSERT: changed expected base accepted';
  exception when others then
    if sqlerrm not like '%P19_IDEMPOTENCY_CONFLICT%' then raise; end if;
  end;

  result := api.p19_remove_evidence(u,'b2-ev-b','evidence.remove','{}'::jsonb,p1,'ev-cccccccccccccccccccccccc',repeat('c',64));
  perform pg_temp.assert_true(result->>'outcome' = 'applied', 'first removal must apply');
  result := api.p19_remove_evidence(u,'b2-ev-b','evidence.remove','{}'::jsonb,p1,'ev-cccccccccccccccccccccccc',repeat('c',64));
  perform pg_temp.assert_true(result->>'outcome' = 'replayed', 'replayed removal must not re-delete');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_evidence_records_v1 where evidence_id='ev-cccccccccccccccccccccccc'),
    'evidence must be gone exactly once');
  perform pg_temp.assert_true((select count(*) from ams_private.p19_command_ledger_v1 where idempotency_key='b2-ev-b') = 1,
    'exactly one ledger row for the removal key');

  -- 4. A different key that would create the same project fails closed
  --    (P19_PROJECT_REVISION_STALE — the server adapter maps it to the bounded
  --    public code PROJECT_REVISION_STALE / 409) — never branches from the
  --    existing revision.
  begin
    perform api.p19_apply_entity_write(u,'b2-key-2','project.create','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',payload1,null,null);
    raise exception 'P19_B2_ASSERT: duplicate project via different key accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_REVISION_STALE%' then raise; end if;
  end;

  -- 5. Database contract matches the UI/core limit exactly: 5000 accepted,
  --    5001 rejected (never silently truncated).
  perform api.p19_apply_entity_write(u,'b2-limit-ok','project.create','project','prj-111111111111111111111111',
    jsonb_build_object('command','project.create','request_payload',jsonb_build_object('topic','limit-ok')),
    'p19_research_projects_v1',
    jsonb_build_object('id','prj-111111111111111111111111','version',1,'schema_version','p19_research_project_v1','status','active',
      'topic',repeat('x',5000),'objective',repeat('y',5000),'audience','a','channel','c','constraints','[]'::jsonb),null,null);
  perform pg_temp.assert_true((select length(topic) from ams_private.p19_research_projects_v1 where project_id='prj-111111111111111111111111')=5000,
    '5000-character topic must persist exactly');
  begin
    perform api.p19_apply_entity_write(u,'b2-limit-bad','project.create','project','prj-222222222222222222222222',
      jsonb_build_object('command','project.create','request_payload',jsonb_build_object('topic','limit-bad')),
      'p19_research_projects_v1',
      jsonb_build_object('id','prj-222222222222222222222222','version',1,'schema_version','p19_research_project_v1','status','active',
        'topic',repeat('x',5001),'objective','o','audience','a','channel','c','constraints','[]'::jsonb),null,null);
    raise exception 'P19_B2_ASSERT: 5001-character topic accepted';
  exception when check_violation then null; end;
end $$;

rollback;
