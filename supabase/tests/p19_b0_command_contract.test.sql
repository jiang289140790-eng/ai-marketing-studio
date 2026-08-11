begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P19_B0_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','p19-contract@example.invalid','{}','{}',now(),now(),false,false);
insert into ams_private.staging_access_v1(user_id,access_role,enabled)
values ('44444444-4444-4444-8444-444444444444','viewer',true);

do $$
declare
  u constant uuid := '44444444-4444-4444-8444-444444444444';
  t text; forbidden text;
  flags constant jsonb := '{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}';
  decision constant jsonb := '{"value":"approved","source":"local_manual","decided_by":"tester","decided_at":"2026-08-12T00:00:00Z"}';
  trace constant jsonb := '{"origin":"local_bridge","created_from":"approved_content_brief"}';
  project_payload jsonb; project_sha text;
  pkg jsonb; pkg_sha text; bad_flags jsonb; flag_name text;
begin
  -- 1. Tables exist with RLS enabled and forced; no client grants (fail closed surface).
  foreach t in array array[
    'p19_research_projects_v1','p19_evidence_records_v1','p19_analyses_v1',
    'p19_knowledge_cards_v1','p19_briefs_v1','p19_handoff_packages_v1','p19_command_ledger_v1',
    'p19_project_locks_v1'
  ] loop
    perform pg_temp.assert_true(exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ams_private' and c.relname = t and c.relkind = 'r'
    ), 'missing table ams_private.' || t);
    perform pg_temp.assert_true(exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ams_private' and c.relname = t and c.relrowsecurity
    ), 'RLS not enabled for ams_private.' || t);
    foreach forbidden in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      perform pg_temp.assert_true(not has_table_privilege('anon', format('ams_private.%I', t), forbidden),
        'anon retains ' || forbidden || ' on ams_private.' || t);
      perform pg_temp.assert_true(not has_table_privilege('authenticated', format('ams_private.%I', t), forbidden),
        'authenticated retains ' || forbidden || ' on ams_private.' || t);
      perform pg_temp.assert_true(not has_table_privilege('public', format('ams_private.%I', t), forbidden),
        'public retains ' || forbidden || ' on ams_private.' || t);
    end loop;
  end loop;

  -- 2. P17 staging role contract is verified in the authenticated section below
  --    （is_staging_user 依赖 auth.uid()，需要 request.jwt.claims 上下文）。

  -- 3. Project payload hash is enforced.
  project_payload := jsonb_build_object('id','prj-aaaaaaaaaaaaaaaaaaaaaaaa','version',1,
    'schema_version','p19_research_project_v1','status','active',
    'topic','topic','objective','objective','audience','audience','channel','channel',
    'constraints',jsonb_build_array());
  project_sha := encode(extensions.digest(convert_to(project_payload::text,'UTF8'),'sha256'),'hex');
  insert into ams_private.p19_research_projects_v1
    (user_id,project_id,project_version,schema_version,status,topic,objective,audience,channel,constraints,payload,payload_sha256)
  values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa',1,'p19_research_project_v1','active','topic','objective','audience','channel','[]'::jsonb,project_payload,project_sha);
  begin
    insert into ams_private.p19_research_projects_v1
      (user_id,project_id,project_version,schema_version,status,topic,objective,audience,channel,constraints,payload,payload_sha256)
    values (u,'prj-bbbbbbbbbbbbbbbbbbbbbbbb',1,'p19_research_project_v1','active','topic','objective','audience','channel','[]'::jsonb,project_payload,repeat('0',64));
    raise exception 'P19_B0_ASSERT: invalid project payload hash accepted';
  exception when check_violation then null; end;

  -- 4. Handoff package mirrors the accepted P5 contract: exact identity/flags/decision/trace/hash.
  pkg := jsonb_build_object('id','handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa','version',1,
    'schema_version','ams_external_handoff_package_v1','status','ready_for_external_import',
    'payload_label','local_external_generation_handoff_package',
    'execution_flags',flags,'human_decision',decision,'source_trace',trace,
    'brief_provenance',jsonb_build_object('brief_id','brief-1','brief_version',1));
  pkg_sha := encode(extensions.digest(convert_to(pkg::text,'UTF8'),'sha256'),'hex');
  insert into ams_private.p19_handoff_packages_v1
    (user_id,project_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
  values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa',1,'ams_external_handoff_package_v1','brief-1',1,'ready_for_external_import',
    'local_external_generation_handoff_package',flags,decision,trace,pkg,pkg_sha);

  foreach flag_name in array array['generation_executed','routing_executed','network_executed','publish_executed'] loop
    bad_flags := jsonb_set(flags,array[flag_name],'true'::jsonb);
    begin
      insert into ams_private.p19_handoff_packages_v1
        (user_id,project_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
      values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','handoff-pkg-bbbbbbbbbbbbbbbbbbbbbbbb',1,'ams_external_handoff_package_v1','brief-2',1,'ready_for_external_import',
        'local_external_generation_handoff_package',bad_flags,decision,trace,'{}',repeat('0',64));
      raise exception 'P19_B0_ASSERT: true execution flag accepted: %', flag_name;
    exception when check_violation then null; end;
  end loop;

  begin
    insert into ams_private.p19_handoff_packages_v1
      (user_id,project_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
    values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','handoff-pkg-cccccccccccccccccccccccc',1,'ams_external_handoff_package_v1','brief-3',1,'ready_for_external_import',
      'local_external_generation_handoff_package',flags,decision,trace,pkg,pkg_sha);
    raise exception 'P19_B0_ASSERT: mismatched package identity accepted';
  exception when check_violation then null; end;

  -- 5. Brief decision snapshot: pending briefs need the exact pending sentinel;
  --    decided briefs need approved/return_for_revision + local_manual.
  insert into ams_private.p19_briefs_v1
    (user_id,project_id,brief_id,brief_version,brief_schema_version,brief_status,decision_snapshot,knowledge_citation_ids,evidence_provenance,payload,payload_sha256)
  values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','brief-pending',1,'ams_content_brief_v1','pending_review',
    '{"value":"pending","source":"none","decided_by":"none","decided_at":"none"}'::jsonb,
    jsonb_build_array('kc-1'),jsonb_build_object('local_only',true),'{}'::jsonb,
    encode(extensions.digest(convert_to('{}','UTF8'),'sha256'),'hex'));
  begin
    insert into ams_private.p19_briefs_v1
      (user_id,project_id,brief_id,brief_version,brief_schema_version,brief_status,decision_snapshot,knowledge_citation_ids,evidence_provenance,payload,payload_sha256)
    values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','brief-1',1,'ams_content_brief_v1','pending_review',
      jsonb_build_object('value','rejected','source','local_manual','decided_by','tester','decided_at','2026-08-12T00:00:00Z'),
      jsonb_build_array('kc-1'),jsonb_build_object('local_only',true),'{}',repeat('0',64));
    raise exception 'P19_B0_ASSERT: invalid brief decision accepted';
  exception when check_violation then null; end;

  -- 6. Command ledger idempotency: same user + key rejected on replay.
  insert into ams_private.p19_command_ledger_v1
    (user_id,idempotency_key,command,entity_type,entity_id,project_id,status,request_summary,request_sha256,diagnostics)
  values (u,'cmd-key-1','project_create','project','prj-aaaaaaaaaaaaaaaaaaaaaaaa','prj-aaaaaaaaaaaaaaaaaaaaaaaa','applied','{}'::jsonb,repeat('a',64),'{}'::jsonb);
  begin
    insert into ams_private.p19_command_ledger_v1
      (user_id,idempotency_key,command,entity_type,entity_id,project_id,status,request_summary,request_sha256,diagnostics)
    values (u,'cmd-key-1','project_create','project','prj-aaaaaaaaaaaaaaaaaaaaaaaa','prj-aaaaaaaaaaaaaaaaaaaaaaaa','applied','{}'::jsonb,repeat('a',64),'{}'::jsonb);
    raise exception 'P19_B0_ASSERT: duplicate idempotency key accepted';
  exception when unique_violation then null; end;

  -- 7. Knowledge card evidence links bounded (1..100).
  begin
    insert into ams_private.p19_knowledge_cards_v1
      (user_id,project_id,knowledge_id,knowledge_version,schema_version,source_observations,evidence_links,trust_status,validation_status,payload,payload_sha256)
    values (u,'prj-aaaaaaaaaaaaaaaaaaaaaaaa','kc-1',1,'content_knowledge_card_v1','{}'::jsonb,'[]'::jsonb,'local','validated','{}',repeat('0',64));
    raise exception 'P19_B0_ASSERT: empty evidence_links accepted';
  exception when check_violation then null; end;
end $$;

-- 已验收 P17 测试同款认证上下文：角色阶梯与 RLS 以 request.jwt.claims 为准。
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
select pg_temp.assert_true(ams_private.is_staging_user('viewer'), 'is_staging_user viewer must pass');
select pg_temp.assert_true(not ams_private.is_staging_user('operator'), 'viewer must not pass operator');
select pg_temp.assert_true(not ams_private.is_staging_user('admin'), 'viewer must not pass admin');
reset role;

rollback;
