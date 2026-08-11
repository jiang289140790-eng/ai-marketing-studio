begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P17_B0_ASSERT: %', message; end if; end $$;

select pg_temp.assert_true(
  (select count(*) = 7 from information_schema.tables
   where table_schema = 'ams_private'
     and table_name in ('staging_access_v1','ke_knowledge_cards_v1','ke_content_briefs_v1','ke_handoff_packages_v1','vg_lineage_nodes_v1','vg_lineage_edges_v1')) is false,
  'guard: information_schema must not misclassify the six private tables'
);
select pg_temp.assert_true(
  (select count(*) = 6 from information_schema.tables
   where table_schema = 'ams_private'
     and table_name in ('staging_access_v1','ke_knowledge_cards_v1','ke_content_briefs_v1','ke_handoff_packages_v1','vg_lineage_nodes_v1','vg_lineage_edges_v1')),
  'six private tables must exist'
);
select pg_temp.assert_true(
  (select count(*) = 5 from information_schema.views where table_schema = 'api'
   and table_name in ('ke_knowledge_cards_v1','ke_content_briefs_v1','ke_handoff_manifest_v1','ke_handoff_package_detail_v1','vg_lineage_audit_v1')),
  'five read-only api views must exist'
);
select pg_temp.assert_true(
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='api' and c.relkind='v'
      and not (coalesce(c.reloptions,'{}') @> array['security_invoker=true'])
  ), 'every api view must use security_invoker'
);
select pg_temp.assert_true(
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='ams_private' and c.relkind='r'
      and (not c.relrowsecurity or not c.relforcerowsecurity)
  ), 'every private table must enable and force RLS'
);
select pg_temp.assert_true(not has_schema_privilege('anon','ams_private','USAGE'), 'anon must not use private schema');
select pg_temp.assert_true(not has_schema_privilege('anon','api','USAGE'), 'anon must not use api schema');
select pg_temp.assert_true(has_schema_privilege('authenticated','ams_private','USAGE'), 'authenticated needs private usage for invoker views');
select pg_temp.assert_true(has_schema_privilege('authenticated','api','USAGE'), 'authenticated needs api usage');
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.role_table_grants
    where grantee='anon' and table_schema in ('ams_private','api')
  ), 'anon must have zero private/api table grants'
);
select pg_temp.assert_true(
  not exists (
    select 1 from information_schema.role_table_grants
    where grantee='authenticated' and table_schema in ('ams_private','api')
      and privilege_type <> 'SELECT'
  ), 'authenticated grants must be SELECT-only'
);
select pg_temp.assert_true(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='ams_private' and p.proname='is_staging_user'),
  'staging predicate must be security definer with empty search_path'
);
select pg_temp.assert_true(not has_function_privilege('anon','ams_private.is_staging_user(text)','EXECUTE'), 'anon cannot execute staging predicate');
select pg_temp.assert_true(has_function_privilege('authenticated','ams_private.is_staging_user(text)','EXECUTE'), 'authenticated can execute staging predicate');
select pg_temp.assert_true(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('ams_private','api') and p.prokind = 'f' and pg_get_functiondef(p.oid) ~* 'user_metadata'
  ) and not exists (
    select 1 from pg_policies where schemaname in ('ams_private','api')
      and (coalesce(qual,'') || coalesce(with_check,'')) ~* 'user_metadata'
  ) and not exists (
    select 1 from pg_views where schemaname='api' and definition ~* 'user_metadata'
  ), 'authorization must never use user_metadata'
);

rollback;
