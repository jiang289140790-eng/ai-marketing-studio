begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P17_B0_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','contract@example.invalid','{}','{}',now(),now(),false,false);
insert into ams_private.staging_access_v1(user_id,access_role,enabled)
values ('44444444-4444-4444-8444-444444444444','viewer',true);

do $$
declare
  u constant uuid := '44444444-4444-4444-8444-444444444444';
  pkg constant text := 'handoff-pkg-aaaaaaaaaaaaaaaaaaaaaaaa';
  flags constant jsonb := '{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}';
  decision constant jsonb := '{"value":"approved","source":"local_manual","decided_by":"tester","decided_at":"2026-08-10T00:00:00Z"}';
  trace constant jsonb := '{"origin":"local_bridge","created_from":"approved_content_brief"}';
  body jsonb; bad_flags jsonb; flag_name text;
begin
  body := jsonb_build_object('id',pkg,'version',1,'schema_version','ams_external_handoff_package_v1',
    'status','ready_for_external_import','payload_label','local_external_generation_handoff_package',
    'execution_flags',flags,'human_decision',decision,'source_trace',trace,
    'brief_provenance',jsonb_build_object('brief_id','brief-1','brief_version',1));
  insert into ams_private.ke_handoff_packages_v1
    (user_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
  values (u,pkg,1,'ams_external_handoff_package_v1','brief-1',1,'ready_for_external_import',
    'local_external_generation_handoff_package',flags,decision,trace,body,
    encode(extensions.digest(convert_to(body::text,'UTF8'),'sha256'),'hex'));

  foreach flag_name in array array['generation_executed','routing_executed','network_executed','publish_executed'] loop
    bad_flags := jsonb_set(flags,array[flag_name],'true'::jsonb);
    begin
      insert into ams_private.ke_handoff_packages_v1
        (user_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
      values (u,'handoff-pkg-bbbbbbbbbbbbbbbbbbbbbbbb',1,'ams_external_handoff_package_v1','brief-2',1,'ready_for_external_import',
        'local_external_generation_handoff_package',bad_flags,decision,trace,'{}',repeat('0',64));
      raise exception 'P17_B0_ASSERT: true execution flag accepted: %', flag_name;
    exception when check_violation then null; end;
  end loop;
  begin
    insert into ams_private.ke_handoff_packages_v1
      (user_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
    values (u,'handoff-pkg-cccccccccccccccccccccccc',1,'ams_external_handoff_package_v1','brief-3',1,'ready_for_external_import',
      'local_external_generation_handoff_package',flags,decision,trace,body,
      encode(extensions.digest(convert_to(body::text,'UTF8'),'sha256'),'hex'));
    raise exception 'P17_B0_ASSERT: mismatched package identity accepted';
  exception when check_violation then null; end;
  body := jsonb_set(body,'{id}','"handoff-pkg-dddddddddddddddddddddddd"'::jsonb);
  begin
    insert into ams_private.ke_handoff_packages_v1
      (user_id,package_id,package_version,schema_version,brief_id,brief_version,status,payload_label,execution_flags,human_decision,source_trace,payload,payload_sha256)
    values (u,'handoff-pkg-dddddddddddddddddddddddd',1,'ams_external_handoff_package_v1','brief-1',1,'ready_for_external_import',
      'local_external_generation_handoff_package',flags,decision,trace,body,repeat('0',64));
    raise exception 'P17_B0_ASSERT: invalid payload hash accepted';
  exception when check_violation then null; end;
end $$;

do $$
declare
  u constant uuid := '44444444-4444-4444-8444-444444444444';
  p_complete constant text := 'handoff-pkg-111111111111111111111111';
  p_partial constant text := 'handoff-pkg-222222222222222222222222';
  p_broken constant text := 'handoff-pkg-333333333333333333333333';
  p_invalid constant text := 'handoff-pkg-444444444444444444444444';
  types text[] := array['handoff_import','campaign_draft','review_worksheet','review_decision','generation_plan','readiness','preparation','signoff_ledger'];
  t text; idx integer; snap jsonb; rid text; fp text := repeat('a',64);
  from_types text[] := array['handoff_import','campaign_draft','review_worksheet','review_worksheet','generation_plan','readiness','preparation'];
  to_types text[] := array['campaign_draft','review_worksheet','review_decision','generation_plan','readiness','preparation','signoff_ledger'];
begin
  foreach t in array types loop
    rid := t || '-complete';
    snap := case when t='handoff_import' then jsonb_build_object('schema_version','ams_external_handoff_package_v1','execution_flags','{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}'::jsonb) else jsonb_build_object('id',rid) end;
    insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
    values(u,p_complete,t,rid,'v1','current',snap,encode(extensions.digest(convert_to(snap::text,'UTF8'),'sha256'),'hex'));
  end loop;
  for idx in 1..7 loop
    insert into ams_private.vg_lineage_edges_v1(user_id,package_id,from_type,from_record_id,to_type,to_record_id,edge_kind,source_fingerprint)
    values(u,p_complete,from_types[idx],from_types[idx]||'-complete',to_types[idx],to_types[idx]||'-complete',
      (array['import_to_draft','draft_to_review','review_to_decision','review_to_plan','plan_to_readiness','readiness_to_preparation','preparation_to_ledger'])[idx],fp);
  end loop;
  begin
    insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
    select user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256
    from ams_private.vg_lineage_nodes_v1 where user_id=u and package_id=p_complete and node_type='campaign_draft';
    raise exception 'P17_B0_ASSERT: duplicate lineage node accepted';
  exception when unique_violation then null; end;
  begin
    insert into ams_private.vg_lineage_edges_v1(user_id,package_id,from_type,from_record_id,to_type,to_record_id,edge_kind,source_fingerprint)
    values(u,p_complete,'handoff_import','missing-import','campaign_draft','campaign_draft-complete','import_to_draft',fp);
    raise exception 'P17_B0_ASSERT: misbound lineage edge accepted';
  exception when foreign_key_violation then null; end;

  snap := jsonb_build_object('schema_version','ams_external_handoff_package_v1','execution_flags','{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}'::jsonb);
  insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
  values(u,p_partial,'handoff_import','import-partial','v1','current',snap,encode(extensions.digest(convert_to(snap::text,'UTF8'),'sha256'),'hex'));

  insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
  select u,p_broken,x,x||'-broken','v1','current',jsonb_build_object('id',x),encode(extensions.digest(convert_to(jsonb_build_object('id',x)::text,'UTF8'),'sha256'),'hex')
  from unnest(array['handoff_import','campaign_draft','review_worksheet','review_decision','generation_plan','readiness','preparation','signoff_ledger']) x;

  insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
  values(u,p_invalid,'handoff_import','import-invalid','v1','stale','{"schema_version":"wrong","execution_flags":{}}',encode(extensions.digest(convert_to('{"schema_version":"wrong","execution_flags":{}}'::jsonb::text,'UTF8'),'sha256'),'hex'));
  foreach rid in array array['draft-invalid-a','draft-invalid-b'] loop
    snap := jsonb_build_object('id',rid);
    insert into ams_private.vg_lineage_nodes_v1(user_id,package_id,node_type,record_id,snapshot_schema_version,source_state,snapshot,snapshot_sha256)
    values(u,p_invalid,'campaign_draft',rid,'v1','current',snap,encode(extensions.digest(convert_to(snap::text,'UTF8'),'sha256'),'hex'));
  end loop;
end $$;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}',true);
select pg_temp.assert_true((select audit_state='COMPLETE' from api.vg_lineage_audit_v1 where package_id='handoff-pkg-111111111111111111111111'), 'complete chain must be COMPLETE');
select pg_temp.assert_true((select audit_state='PARTIAL' from api.vg_lineage_audit_v1 where package_id='handoff-pkg-222222222222222222222222'), 'missing chain must be PARTIAL');
select pg_temp.assert_true((select audit_state='BROKEN' from api.vg_lineage_audit_v1 where package_id='handoff-pkg-333333333333333333333333'), 'misbound/missing edges must be BROKEN');
select pg_temp.assert_true((select audit_state='INVALID_SOURCE' and severity=3 from api.vg_lineage_audit_v1 where package_id='handoff-pkg-444444444444444444444444'), 'invalid source must have highest priority');
reset role;

rollback;
