-- P19-B1: server-only database boundary (api schema) contract.
-- Runs as postgres (migration runner / SQL-test executor), exactly like the
-- accepted P17 tests. Exercises the same security-definer functions that the
-- service-role server client will call:
--   - anon / authenticated / public have zero EXECUTE; service_role has EXECUTE;
--   - canonical JSONB hash validated atomically inside the boundary
--     (declared sha must equal digest(payload::text), never JSON.stringify);
--   - every entity command persists a valid row with ALL required columns;
--   - malformed payloads are rejected (fail closed, no reservation left);
--   - latest project revision reads are deterministic (project_version desc,
--     id tie breaker) and never branch from an older revision; a stale base on
--     update or archive is rejected with P19_PROJECT_REVISION_STALE (the server
--     adapter maps it to the bounded public code PROJECT_REVISION_STALE / 409);
--   - evidence removal binds to the logical evidence_id, not the uuid pk;
--   - the archive boundary: after archive, every mutating write is rejected
--     with P19_PROJECT_ARCHIVED (entity writes, project.update, evidence
--     removal); the archive transition active -> archived applies; archiving
--     an already-archived project is an idempotent bounded no-op; read-only
--     boundary functions may still read the archived project.

begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P19_B1_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','p19-b1@example.invalid','{}','{}',now(),now(),false,false);

do $$
declare
  u constant uuid := '44444444-4444-4444-8444-444444444444';
  p1 constant text := 'prj-aaaaaaaaaaaaaaaaaaaaaaaa';
  p2 constant text := 'prj-bbbbbbbbbbbbbbbbbbbbbbbb';
  pc constant text := 'prj-cccccccccccccccccccccccc';
  fn text;
  payload1 jsonb;
  payload2 jsonb;
  payload3 jsonb;
  payload4 jsonb;
  result jsonb;
  ev jsonb;
  an jsonb;
  kc jsonb;
  br jsonb;
  br2 jsonb;
  ho jsonb;
  target text;
begin
  -- The Edge Function's service client may enter the RPC schema but cannot
  -- create objects there. Browser roles remain outside the schema entirely.
  perform pg_temp.assert_true(not has_schema_privilege('anon', 'api', 'USAGE'), 'anon can use api schema');
  perform pg_temp.assert_true(not has_schema_privilege('authenticated', 'api', 'USAGE'), 'authenticated can use api schema');
  perform pg_temp.assert_true(has_schema_privilege('service_role', 'api', 'USAGE'), 'service_role cannot use api schema');
  perform pg_temp.assert_true(not has_schema_privilege('service_role', 'api', 'CREATE'), 'service_role can create in api schema');

  -- 1. Client roles have zero EXECUTE on every boundary function; service_role has EXECUTE.
  foreach fn in array array[
    'api.p19_staging_role(uuid)',
    'api.p19_get_project(uuid,text)',
    'api.p19_list_project_entities(uuid,text)',
    'api.p19_apply_entity_write(uuid,text,text,text,text,jsonb,text,jsonb,text,integer,text)',
    'api.p19_remove_evidence(uuid,text,text,jsonb,text,text,text)'
  ] loop
    perform pg_temp.assert_true(not has_function_privilege('anon', fn, 'EXECUTE'), 'anon can execute ' || fn);
    perform pg_temp.assert_true(not has_function_privilege('authenticated', fn, 'EXECUTE'), 'authenticated can execute ' || fn);
    perform pg_temp.assert_true(not has_function_privilege('public', fn, 'EXECUTE'), 'public can execute ' || fn);
    perform pg_temp.assert_true(has_function_privilege('service_role', fn, 'EXECUTE'), 'service_role cannot execute ' || fn);
  end loop;

  -- 2. Canonical hash: declared sha must equal digest(payload::text); mismatch fails
  --    atomically and leaves no reservation.
  payload1 := jsonb_build_object(
    'id',p1,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','主题','objective','目标','audience','受众','channel','渠道',
    'constraints',jsonb_build_array());
  begin
    perform api.p19_apply_entity_write(u,'b1-hash-bad','project.create','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',payload1,repeat('0',64),null);
    raise exception 'P19_B1_ASSERT: mismatched declared hash accepted';
  exception when others then
    if sqlerrm not like '%P19_PAYLOAD_HASH_MISMATCH%' then raise; end if;
  end;
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_command_ledger_v1 where idempotency_key='b1-hash-bad'),
    'hash failure must not leave a reservation');

  -- 3. project.create via boundary: row persists with every required column and the
  --    canonical hash (the same digest the CHECK constraint enforces).
  result := api.p19_apply_entity_write(u,'b1-create-1','project.create','project',p1,
    jsonb_build_object('command','project.create'),'p19_research_projects_v1',payload1,null,null);
  perform pg_temp.assert_true(result->>'outcome' = 'applied', 'project.create must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_research_projects_v1
    where user_id=u and project_id=p1 and project_version=1
      and schema_version='p19_research_project_v1' and status='active'
      and topic='主题' and objective='目标' and audience='受众' and channel='渠道'
      and jsonb_typeof(constraints)='array'
      and payload_sha256 = encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex')),
    'project row must populate all required columns with canonical hash');

  -- 4. Malformed payloads rejected: blank required column fails the check constraint.
  begin
    perform api.p19_apply_entity_write(u,'b1-create-bad','project.create','project',pc,
      '{}'::jsonb,'p19_research_projects_v1',
      jsonb_build_object('id',pc,'version',1,'schema_version','p19_research_project_v1','status','active',
        'topic','','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array()),
      null,null);
    raise exception 'P19_B1_ASSERT: blank required column accepted';
  exception when others then
    if sqlerrm not like '%violates%' then raise; end if;
  end;
  begin
    perform api.p19_apply_entity_write(u,'b1-create-bad2','project.create','project',pc,
      '{}'::jsonb,'p19_research_projects_v1',
      jsonb_build_object('id',pc,'version',1,'schema_version','p18_research_project_v1','status','active',
        'topic','主题','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array()),
      null,null);
    raise exception 'P19_B1_ASSERT: wrong schema_version accepted';
  exception when others then
    if sqlerrm not like '%violates%' then raise; end if;
  end;

  -- 5. Deterministic latest revision read + base version guard (never branch
  --    from an older revision). Project stays ACTIVE through sections 6-11 so
  --    every entity command can be exercised; the archive boundary is tested
  --    in section 12.
  payload2 := jsonb_build_object(
    'id',p1,'version',2,'schema_version','p19_research_project_v1','status','active',
    'topic','主题 v2','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array());
  result := api.p19_apply_entity_write(u,'b1-update-1','project.update','project',p1,
    '{}'::jsonb,'p19_research_projects_v1',payload2,null,1);
  perform pg_temp.assert_true(result->>'outcome' = 'applied', 'project.update must apply');
  -- a stale base (the latest revision is now 2, so base 1 must be rejected)
  -- → the server adapter maps this to the bounded public code
  --   PROJECT_REVISION_STALE (409-equivalent), never INTERNAL_ERROR.
  begin
    perform api.p19_apply_entity_write(u,'b1-update-stale','project.update','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',payload2,null,1);
    raise exception 'P19_B1_ASSERT: stale base version accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_REVISION_STALE%' then raise; end if;
  end;
  -- create with an existing project id (new key) fails closed
  begin
    perform api.p19_apply_entity_write(u,'b1-create-dup','project.create','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',payload1,null,null);
    raise exception 'P19_B1_ASSERT: duplicate project.create accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_REVISION_STALE%' then raise; end if;
  end;
  -- archive from a stale base (latest is 2, base 1) is rejected the same way:
  -- the archive command never branches from an older revision.
  begin
    perform api.p19_apply_entity_write(u,'b1-archive-stale','project.archive','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',
      jsonb_build_object('id',p1,'version',2,'schema_version','p19_research_project_v1','status','archived',
        'topic','主题 v2','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array()),
      null,1);
    raise exception 'P19_B1_ASSERT: stale-base archive accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_REVISION_STALE%' then raise; end if;
  end;
  -- latest read is deterministic: version 2, never an older revision
  perform pg_temp.assert_true(api.p19_get_project(u,p1)->>'version' = '2', 'latest read must return version 2');
  perform pg_temp.assert_true(api.p19_get_project(u,p1)->>'topic' = '主题 v2', 'latest read must return the newest revision');

  -- 6. evidence.create via boundary: all required columns populated; json null
  --    media_metadata stored as sql null.
  ev := jsonb_build_object(
    'id','ev-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','p19_evidence_record_v1',
    'source_url','https://example.com/x','label','证据','platform','x','content_text','内容',
    'recorded_at','2026-08-12T00:00:00Z',
    'provenance',jsonb_build_object('manual',true,'statement','人工提交'),
    'media_metadata','null'::jsonb,'version',1,'fingerprint',repeat('1',64),
    'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-ev-1','evidence.create','evidence','ev-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_evidence_records_v1',ev,null,null);
  perform pg_temp.assert_true(result->>'outcome'='applied','evidence.create must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_evidence_records_v1
    where user_id=u and project_id=p1 and evidence_id='ev-aaaaaaaaaaaaaaaaaaaaaaaa'
      and schema_version='p19_evidence_record_v1'
      and source_url='https://example.com/x' and label='证据' and platform='x'
      and recorded_at='2026-08-12T00:00:00Z'::timestamptz
      and provenance->>'manual'='true' and media_metadata is null),
    'evidence row must populate all required columns (media_metadata null stays null)');

  -- 7. analysis.create via boundary (rule_ids + provenance required columns).
  an := jsonb_build_object(
    'id','an-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','p19_analysis_v1',
    'evidence_id','ev-aaaaaaaaaaaaaaaaaaaaaaaa','kind','deterministic_local',
    'rule_ids',jsonb_build_array('source_url_shape','text_length_profile'),
    'provenance',jsonb_build_object('method','deterministic_local','model','null'::jsonb),
    'result',jsonb_build_object('summary',jsonb_build_object('label','x'),'rules',jsonb_build_array()),
    'version',1,'fingerprint',repeat('2',64),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-an-1','analysis.create','analysis','an-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_analyses_v1',an,null,null);
  perform pg_temp.assert_true(result->>'outcome'='applied','analysis.create must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_analyses_v1
    where user_id=u and project_id=p1 and analysis_id='an-aaaaaaaaaaaaaaaaaaaaaaaa'
      and schema_version='p19_analysis_v1' and kind='deterministic_local'
      and jsonb_array_length(rule_ids)=2 and provenance->>'method'='deterministic_local'),
    'analysis row must populate all required columns');
  begin
    perform api.p19_apply_entity_write(u,'b1-an-bad','analysis.create','analysis','an-bbbbbbbbbbbbbbbbbbbbbbbb',
      '{}'::jsonb,'p19_analyses_v1',
      jsonb_build_object('id','an-bbbbbbbbbbbbbbbbbbbbbbbb','project_id',p1,'schema_version','p19_analysis_v1',
        'evidence_id','ev-aaaaaaaaaaaaaaaaaaaaaaaa','kind','model_inference',
        'rule_ids',jsonb_build_array(),'provenance',jsonb_build_object('method','model_inference')),
      null,null);
    raise exception 'P19_B1_ASSERT: non-deterministic analysis accepted';
  exception when others then
    if sqlerrm not like '%violates%' then raise; end if;
  end;

  -- 8. knowledge card via boundary (source_observations + evidence_links required).
  kc := jsonb_build_object(
    'id','kc-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','content_knowledge_card_v1',
    'analysis_id','an-aaaaaaaaaaaaaaaaaaaaaaaa',
    'source_observations',jsonb_build_object('post_text','文本'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','c','evidence_type','post_text',
      'source_ref','ev-aaaaaaaaaaaaaaaaaaaaaaaa','time_range','null'::jsonb,'confidence',0.9)),
    'trust_status','manual_local','validation_status','validated_deterministic',
    'version',1,'fingerprint',repeat('3',64),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-kc-1','card.create','card','kc-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_knowledge_cards_v1',kc,null,null);
  perform pg_temp.assert_true(result->>'outcome'='applied','card.create must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_knowledge_cards_v1
    where user_id=u and project_id=p1 and knowledge_id='kc-aaaaaaaaaaaaaaaaaaaaaaaa'
      and knowledge_version=1 and schema_version='content_knowledge_card_v1'
      and jsonb_array_length(evidence_links)=1
      and trust_status='manual_local' and validation_status='validated_deterministic'),
    'knowledge card row must populate all required columns');

  -- 9. brief.assemble via boundary: pending brief persists with the exact pending
  --    decision snapshot sentinel; brief.decide upserts the approved snapshot.
  br := jsonb_build_object(
    'id','brief-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','ams_content_brief_v1',
    'version',1,'status','pending_review','topic','主题','objective','目标','audience','受众','channel','渠道',
    'constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array('kc-aaaaaaaaaaaaaaaaaaaaaaaa'),
    'evidence_provenance',jsonb_build_object('local_only',true,'store','p19_local_store_v1',
      'created_from','selected_knowledge_cards','statement','本地'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1',
      'brief_id','brief-aaaaaaaaaaaaaaaaaaaaaaaa','decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('4',64),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-br-1','brief.assemble','brief','brief-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_briefs_v1',br,null,null);
  perform pg_temp.assert_true(result->>'outcome'='applied','brief.assemble must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_briefs_v1
    where user_id=u and project_id=p1 and brief_id='brief-aaaaaaaaaaaaaaaaaaaaaaaa'
      and brief_version=1 and brief_status='pending_review'
      and decision_snapshot = '{"value":"pending","source":"none","decided_by":"none","decided_at":"none"}'::jsonb
      and jsonb_array_length(knowledge_citation_ids)=1),
    'pending brief must persist with the exact pending decision snapshot');
  br2 := jsonb_build_object(
    'id','brief-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','ams_content_brief_v1',
    'version',1,'status','approved','topic','主题','objective','目标','audience','受众','channel','渠道',
    'constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array('kc-aaaaaaaaaaaaaaaaaaaaaaaa'),
    'evidence_provenance',jsonb_build_object('local_only',true,'store','p19_local_store_v1',
      'created_from','selected_knowledge_cards','statement','本地'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1',
      'brief_id','brief-aaaaaaaaaaaaaaaaaaaaaaaa',
      'decision',jsonb_build_object('value','approved','source','local_manual',
        'decided_by','tester','decided_at','2026-08-12T00:00:00Z'),
      'comments',jsonb_build_array()),
    'fingerprint',repeat('5',64),'created_at','2026-08-12T00:00:00Z','updated_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-br-2','brief.decide','brief','brief-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_briefs_v1',br2,null,null,repeat('4',64));
  perform pg_temp.assert_true(result->>'outcome'='applied','brief.decide must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_briefs_v1
    where user_id=u and project_id=p1 and brief_id='brief-aaaaaaaaaaaaaaaaaaaaaaaa' and brief_version=1
      and brief_status='approved' and decision_snapshot->>'value'='approved'
      and decision_snapshot->>'source'='local_manual'),
    'decided brief must persist with the approved local_manual decision snapshot');

  -- 10. handoff.create via boundary: all required columns (identity, flags, decision,
  --     source trace) populated and cross-checked by table constraints.
  ho := jsonb_build_object(
    'id','handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa','project_id',p1,'schema_version','ams_external_handoff_package_v1',
    'version',1,'kind','external_generation_handoff_package','status','ready_for_external_import',
    'payload_label','local_external_generation_handoff_package',
    'brief_provenance',jsonb_build_object('brief_id','brief-aaaaaaaaaaaaaaaaaaaaaaaa','brief_version',1,
      'brief_schema_version','ams_content_brief_v1','brief_status','approved'),
    'human_decision',jsonb_build_object('value','approved','source','local_manual','rationale','批准',
      'decided_by','tester','decided_at','2026-08-12T00:00:00Z'),
    'execution_flags',jsonb_build_object('generation_executed',false,'routing_executed',false,
      'network_executed',false,'publish_executed',false),
    'source_trace',jsonb_build_object('origin','local_bridge','created_from','approved_content_brief'),
    'fingerprint',repeat('6',64),'created_at','2026-08-12T00:00:00Z');
  result := api.p19_apply_entity_write(u,'b1-ho-1','handoff.create','handoff','handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa',
    '{}'::jsonb,'p19_handoff_packages_v1',ho,null,null);
  perform pg_temp.assert_true(result->>'outcome'='applied','handoff.create must apply');
  perform pg_temp.assert_true(exists (
    select 1 from ams_private.p19_handoff_packages_v1
    where user_id=u and project_id=p1 and package_id='handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa'
      and brief_id='brief-aaaaaaaaaaaaaaaaaaaaaaaa' and brief_version=1
      and execution_flags = '{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}'::jsonb
      and human_decision->>'value'='approved' and source_trace->>'origin'='local_bridge'),
    'handoff row must populate all required columns');

  -- 11. evidence removal binds to the LOGICAL evidence_id, never the uuid pk.
  begin
    select id::text into target
    from ams_private.p19_evidence_records_v1 where evidence_id='ev-aaaaaaaaaaaaaaaaaaaaaaaa';
    perform api.p19_remove_evidence(u,'b1-rem-bad','evidence.remove',
      '{}'::jsonb,p1,target,repeat('1',64));
    raise exception 'P19_B1_ASSERT: removal by uuid pk accepted';
  exception when others then
    if sqlerrm not like '%P19_EVIDENCE_ID_INVALID%' then raise; end if;
  end;
  result := api.p19_remove_evidence(u,'b1-rem-1','evidence.remove',
    '{}'::jsonb,p1,'ev-aaaaaaaaaaaaaaaaaaaaaaaa',repeat('1',64));
  perform pg_temp.assert_true(result->>'outcome'='applied','evidence removal must apply');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_evidence_records_v1 where evidence_id='ev-aaaaaaaaaaaaaaaaaaaaaaaa'),
    'evidence row must be gone after removal by logical id');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_analyses_v1 where user_id=u and project_id=p1),
    'evidence removal must prune bound analyses');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_knowledge_cards_v1 where user_id=u and project_id=p1),
    'evidence removal must prune bound knowledge cards');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_briefs_v1 where user_id=u and project_id=p1),
    'evidence removal must prune briefs that cite removed cards');
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_handoff_packages_v1 where user_id=u and project_id=p1),
    'evidence removal must prune handoffs bound to removed briefs');

  -- 12. Archive boundary: the transition applies, every later mutation is
  --     rejected with P19_PROJECT_ARCHIVED (never INTERNAL_ERROR), archiving
  --     an already-archived project is an idempotent bounded no-op, and the
  --     read-only boundary still reads the archived project.
  payload3 := jsonb_build_object(
    'id',p1,'version',3,'schema_version','p19_research_project_v1','status','archived',
    'topic','主题 v2','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array());
  result := api.p19_apply_entity_write(u,'b1-archive-1','project.archive','project',p1,
    '{}'::jsonb,'p19_research_projects_v1',payload3,null,2);
  perform pg_temp.assert_true(result->>'outcome' = 'applied', 'project.archive must apply');
  perform pg_temp.assert_true(api.p19_get_project(u,p1)->>'status' = 'archived', 'latest read must return archived');

  -- 12a. archiving an already-archived project is an idempotent bounded no-op:
  --      outcome applied with already_archived=true, no new revision written.
  payload4 := jsonb_build_object(
    'id',p1,'version',4,'schema_version','p19_research_project_v1','status','archived',
    'topic','主题 v2','objective','目标','audience','受众','channel','渠道','constraints',jsonb_build_array());
  result := api.p19_apply_entity_write(u,'b1-archive-2','project.archive','project',p1,
    '{}'::jsonb,'p19_research_projects_v1',payload4,null,3);
  perform pg_temp.assert_true(result->>'outcome'='applied' and result->>'already_archived'='true',
    'idempotent archive must be a bounded no-op');
  perform pg_temp.assert_true((select count(*) from ams_private.p19_research_projects_v1 where user_id=u and project_id=p1) = 3,
    'idempotent archive must not write a new revision');

  -- 12b. every mutating write on an archived project is rejected with
  --      P19_PROJECT_ARCHIVED: project.update (matching base), entity create,
  --      and evidence removal. None of them may leave a reservation.
  begin
    perform api.p19_apply_entity_write(u,'b1-arch-update','project.update','project',p1,
      '{}'::jsonb,'p19_research_projects_v1',payload2,null,2);
    raise exception 'P19_B1_ASSERT: project.update on archived project accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_ARCHIVED%' then raise; end if;
  end;
  begin
    perform api.p19_apply_entity_write(u,'b1-arch-ev','evidence.create','evidence','ev-bbbbbbbbbbbbbbbbbbbbbbbb',
      '{}'::jsonb,'p19_evidence_records_v1',ev,null,null);
    raise exception 'P19_B1_ASSERT: evidence.create on archived project accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_ARCHIVED%' then raise; end if;
  end;
  begin
    perform api.p19_remove_evidence(u,'b1-arch-rem','evidence.remove','{}'::jsonb,p1,'ev-bbbbbbbbbbbbbbbbbbbbbbbb');
    raise exception 'P19_B1_ASSERT: evidence removal on archived project accepted';
  exception when others then
    if sqlerrm not like '%P19_PROJECT_ARCHIVED%' then raise; end if;
  end;
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_command_ledger_v1 where idempotency_key in ('b1-arch-update','b1-arch-ev','b1-arch-rem')),
    'rejected archive mutations must not leave reservations');

  -- 12c. read-only boundary still reads the archived project (lineage.audit
  --      and the read-only entity list are not mutations).
  perform pg_temp.assert_true(api.p19_get_project(u,p1)->>'status' = 'archived',
    'read of archived project must still work');
  perform pg_temp.assert_true(jsonb_typeof(api.p19_list_project_entities(u,p1)->'evidence') = 'array',
    'read-only entity list of archived project must still work');

  -- 13. unknown table fails closed with no reservation.
  begin
    perform api.p19_apply_entity_write(u,'b1-unknown','project.create','project',p1,
      '{}'::jsonb,'p19_evil_table',payload1,null,null);
    raise exception 'P19_B1_ASSERT: unknown table accepted';
  exception when others then
    if sqlerrm not like '%P19_UNKNOWN_TABLE%' then raise; end if;
  end;
  perform pg_temp.assert_true(not exists (
    select 1 from ams_private.p19_command_ledger_v1 where idempotency_key='b1-unknown'),
    'unknown table failure must not leave a reservation');
end $$;

rollback;
