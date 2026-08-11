begin;

create or replace function pg_temp.assert_true(condition boolean, message text)
returns void language plpgsql as $$
begin
  if condition is distinct from true then
    raise exception 'P17_B1E_ASSERT: %', message;
  end if;
end
$$;

do $test$
declare
  object_name text;
  forbidden_privilege text;
  owner_name text;
  rls_enabled boolean;
begin
  foreach object_name in array array[
    'knowledge_entries',
    'content_memory',
    'strategy_memory',
    'insights',
    'account_intelligence_reports'
  ] loop
    select pg_get_userbyid(c.relowner), c.relrowsecurity
      into owner_name, rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = object_name and c.relkind in ('r', 'p');

    perform pg_temp.assert_true(owner_name = 'postgres', object_name || ' owner must remain postgres');
    perform pg_temp.assert_true(rls_enabled, object_name || ' RLS must remain enabled');

    foreach forbidden_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ] loop
      perform pg_temp.assert_true(
        not has_table_privilege('anon', format('public.%I', object_name), forbidden_privilege),
        'anon must not retain ' || forbidden_privilege || ' on ' || object_name
      );
    end loop;

    perform pg_temp.assert_true(
      has_table_privilege('authenticated', format('public.%I', object_name), 'SELECT'),
      'authenticated must retain SELECT on ' || object_name
    );
    foreach forbidden_privilege in array array[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ] loop
      perform pg_temp.assert_true(
        not has_table_privilege('authenticated', format('public.%I', object_name), forbidden_privilege),
        'authenticated must not retain ' || forbidden_privilege || ' on ' || object_name
      );
    end loop;

    perform pg_temp.assert_true(
      has_table_privilege('service_role', format('public.%I', object_name), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
      'service_role contract must remain complete on ' || object_name
    );
  end loop;
end
$test$;

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'public.set_knowledge_entries_updated_at()'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  )
  and not has_function_privilege('anon', 'public.set_knowledge_entries_updated_at()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_knowledge_entries_updated_at()', 'EXECUTE'),
  'set_knowledge_entries_updated_at must not be client-executable'
);

select pg_temp.assert_true(
  not exists (
    select 1
    from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'public.match_knowledge_entries(vector,integer,text)'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE'
  )
  and not has_function_privilege('anon', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE'),
  'match_knowledge_entries must not be client-executable'
);

select pg_temp.assert_true(
  has_function_privilege('service_role', 'public.set_knowledge_entries_updated_at()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE'),
  'service_role must retain both function executions'
);

select pg_temp.assert_true(
  has_table_privilege('authenticated', 'public.account_profiles', 'SELECT,INSERT,UPDATE,DELETE')
  and has_table_privilege('authenticated', 'public.comfy_workflows', 'SELECT,INSERT,UPDATE,DELETE'),
  'account_profiles and comfy_workflows CRUD contracts must remain unchanged'
);

select pg_temp.assert_true(
  (select count(*) = 5 from pg_policies
   where schemaname = 'public'
     and tablename in ('knowledge_entries','content_memory','strategy_memory','insights','account_intelligence_reports')
     and policyname = 'authenticated_read_' || tablename
     and cmd = 'SELECT'
     and 'authenticated' = any (roles)),
  'all five authenticated SELECT policies must remain exact'
);

rollback;
