begin;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('44444444-4444-4444-8444-444444444444','authenticated','authenticated','p20-import@example.invalid','{}','{}',now(),now(),false,false);

do $$
begin
  if has_schema_privilege('anon', 'api', 'USAGE')
    or has_schema_privilege('authenticated', 'api', 'USAGE') then
    raise exception 'browser roles must not use the server-only api schema';
  end if;
  if not has_schema_privilege('service_role', 'api', 'USAGE') then
    raise exception 'service_role must use the api schema';
  end if;
  if has_schema_privilege('service_role', 'api', 'CREATE') then
    raise exception 'service_role must not create in the api schema';
  end if;
  if has_function_privilege('anon', 'api.p20_list_projects(uuid)', 'EXECUTE') then
    raise exception 'anon must not execute api.p20_list_projects';
  end if;
  if has_function_privilege('authenticated', 'api.p20_list_projects(uuid)', 'EXECUTE') then
    raise exception 'authenticated must not execute api.p20_list_projects';
  end if;
  if not has_function_privilege('service_role', 'api.p20_list_projects(uuid)', 'EXECUTE') then
    raise exception 'service_role must execute api.p20_list_projects';
  end if;
  if has_function_privilege('anon', 'api.p20_import_project(uuid,text,jsonb)', 'EXECUTE')
    or has_function_privilege('authenticated', 'api.p20_import_project(uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'browser roles must not execute api.p20_import_project';
  end if;
  if not has_function_privilege('service_role', 'api.p20_import_project(uuid,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role must execute api.p20_import_project';
  end if;
  if (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'api' and p.proname = 'p20_list_projects') is distinct from true then
    raise exception 'p20_list_projects must be security definer';
  end if;
  if (select proconfig @> array['search_path=ams_private, pg_catalog']
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = 'p20_list_projects') is distinct from true then
    raise exception 'p20_list_projects must use the exact private and pg_catalog search_path';
  end if;
  if (select prosecdef and proconfig @> array['search_path=ams_private, api, extensions, pg_catalog']
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'api' and p.proname = 'p20_import_project') is distinct from true then
    raise exception 'p20_import_project must be security definer with the exact bounded search_path';
  end if;
end $$;

do $$
declare
  v_user uuid := '44444444-4444-4444-8444-444444444444';
  v_project_id text := 'prj-abcdefabcdefabcdefabcdef';
  v_replay jsonb;
  v_package jsonb := jsonb_build_object(
    'schema_version', 'p19_project_package_v1',
    'exported_at', '2026-08-11T12:00:00.000Z',
    'project', jsonb_build_object(
      'schema_version', 'p19_research_project_v1',
      'id', 'prj-abcdefabcdefabcdefabcdef',
      'version', 1,
      'status', 'active',
      'topic', 'P20 SQL import',
      'objective', 'atomic identity preserving import',
      'audience', 'operator',
      'channel', 'research',
      'constraints', '[]'::jsonb,
      'execution_flags', jsonb_build_object(
        'generation_executed', false,
        'routing_executed', false,
        'network_executed', false,
        'publish_executed', false
      ),
      'created_at', '2026-08-11T12:00:00.000Z',
      'updated_at', '2026-08-11T12:00:00.000Z'
    ),
    'evidence', '[]'::jsonb,
    'analyses', '[]'::jsonb,
    'knowledge_cards', '[]'::jsonb,
    'brief', null,
    'handoff', null,
    'fingerprint', repeat('a', 64)
  );
begin
  perform api.p20_import_project(v_user, 'p20-sql-import-1', v_package);
  if (select count(*) from ams_private.p19_research_projects_v1 where user_id = v_user and project_id = v_project_id) <> 1 then
    raise exception 'P20 import must persist exactly one project with its original identity';
  end if;

  -- Exact replay uses the derived ledger keys and must not duplicate any row.
  v_replay := api.p20_import_project(v_user, 'p20-sql-import-1', v_package);
  if v_replay ->> 'outcome' <> 'replayed' then
    raise exception 'P20 import exact replay must report replayed';
  end if;
  if (select count(*) from ams_private.p19_research_projects_v1 where user_id = v_user and project_id = v_project_id) <> 1 then
    raise exception 'P20 import replay duplicated the project';
  end if;

  begin
    perform api.p20_import_project(v_user, 'p20-sql-import-collision', v_package);
    raise exception 'P20 import collision was not rejected';
  exception
    when raise_exception then
      if sqlerrm <> 'P20_IMPORT_PROJECT_COLLISION' then
        raise;
      end if;
  end;
end $$;

rollback;
