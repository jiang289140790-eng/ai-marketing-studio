-- P17-B1E: narrow the explicitly reconstructed legacy ACLs on the exact
-- staging knowledge/intelligence boundary. This migration intentionally does
-- not alter owners, RLS policies, schemas, extensions, or application CRUD
-- contracts outside the seven named objects.

do $preflight$
declare
  object_name text;
  object_owner text;
  rls_enabled boolean;
  policy_name text;
  function_owner text;
  function_security_definer boolean;
begin
  if current_user <> 'postgres' then
    raise exception 'P17_B1E_PREFLIGHT: expected postgres executor, got %', current_user;
  end if;

  foreach object_name in array array[
    'knowledge_entries',
    'content_memory',
    'strategy_memory',
    'insights',
    'account_intelligence_reports'
  ] loop
    select pg_get_userbyid(c.relowner), c.relrowsecurity
      into object_owner, rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = object_name
      and c.relkind in ('r', 'p');

    if not found then
      raise exception 'P17_B1E_PREFLIGHT: missing table public.%', object_name;
    end if;
    if object_owner <> 'postgres' then
      raise exception 'P17_B1E_PREFLIGHT: unexpected owner for public.%: %', object_name, object_owner;
    end if;
    if not rls_enabled then
      raise exception 'P17_B1E_PREFLIGHT: RLS disabled for public.%', object_name;
    end if;

    policy_name := 'authenticated_read_' || object_name;
    if not exists (
      select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = object_name
        and p.policyname = policy_name
        and p.cmd = 'SELECT'
        and 'authenticated' = any (p.roles)
    ) then
      raise exception 'P17_B1E_PREFLIGHT: missing authenticated SELECT policy %.%', object_name, policy_name;
    end if;
  end loop;

  select pg_get_userbyid(p.proowner), p.prosecdef
    into function_owner, function_security_definer
  from pg_proc p
  where p.oid = 'public.set_knowledge_entries_updated_at()'::regprocedure;
  if function_owner <> 'postgres' or function_security_definer then
    raise exception 'P17_B1E_PREFLIGHT: invalid set_knowledge_entries_updated_at contract';
  end if;

  select pg_get_userbyid(p.proowner), p.prosecdef
    into function_owner, function_security_definer
  from pg_proc p
  where p.oid = 'public.match_knowledge_entries(vector,integer,text)'::regprocedure;
  if function_owner <> 'postgres' or function_security_definer then
    raise exception 'P17_B1E_PREFLIGHT: invalid match_knowledge_entries contract';
  end if;
end
$preflight$;

revoke all privileges on table
  public.knowledge_entries,
  public.content_memory,
  public.strategy_memory,
  public.insights,
  public.account_intelligence_reports
from anon;

revoke insert, update, delete, truncate, references, trigger, maintain on table
  public.knowledge_entries,
  public.content_memory,
  public.strategy_memory,
  public.insights,
  public.account_intelligence_reports
from authenticated;

grant select on table
  public.knowledge_entries,
  public.content_memory,
  public.strategy_memory,
  public.insights,
  public.account_intelligence_reports
to authenticated;

revoke all privileges on function public.set_knowledge_entries_updated_at()
  from public, anon, authenticated;
revoke all privileges on function public.match_knowledge_entries(vector, integer, text)
  from public, anon, authenticated;

grant execute on function public.set_knowledge_entries_updated_at()
  to postgres, service_role;
grant execute on function public.match_knowledge_entries(vector, integer, text)
  to postgres, service_role;

do $verify$
declare
  object_name text;
  forbidden_privilege text;
begin
  foreach object_name in array array[
    'knowledge_entries',
    'content_memory',
    'strategy_memory',
    'insights',
    'account_intelligence_reports'
  ] loop
    foreach forbidden_privilege in array array[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ] loop
      if has_table_privilege('anon', format('public.%I', object_name), forbidden_privilege) then
        raise exception 'P17_B1E_VERIFY: anon retains % on public.%', forbidden_privilege, object_name;
      end if;
    end loop;

    if not has_table_privilege('authenticated', format('public.%I', object_name), 'SELECT') then
      raise exception 'P17_B1E_VERIFY: authenticated lacks SELECT on public.%', object_name;
    end if;
    foreach forbidden_privilege in array array[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ] loop
      if has_table_privilege('authenticated', format('public.%I', object_name), forbidden_privilege) then
        raise exception 'P17_B1E_VERIFY: authenticated retains % on public.%', forbidden_privilege, object_name;
      end if;
    end loop;

    if not has_table_privilege('service_role', format('public.%I', object_name), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') then
      raise exception 'P17_B1E_VERIFY: service_role contract changed for public.%', object_name;
    end if;
  end loop;

  if exists (
       select 1
       from pg_proc p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = 'public.set_knowledge_entries_updated_at()'::regprocedure
         and a.grantee = 0
         and a.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', 'public.set_knowledge_entries_updated_at()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.set_knowledge_entries_updated_at()', 'EXECUTE') then
    raise exception 'P17_B1E_VERIFY: client execute remains on set_knowledge_entries_updated_at';
  end if;

  if exists (
       select 1
       from pg_proc p
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = 'public.match_knowledge_entries(vector,integer,text)'::regprocedure
         and a.grantee = 0
         and a.privilege_type = 'EXECUTE'
     )
     or has_function_privilege('anon', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE') then
    raise exception 'P17_B1E_VERIFY: client execute remains on match_knowledge_entries';
  end if;

  if not has_function_privilege('service_role', 'public.set_knowledge_entries_updated_at()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.match_knowledge_entries(vector,integer,text)', 'EXECUTE') then
    raise exception 'P17_B1E_VERIFY: service_role function contract changed';
  end if;

  if not has_table_privilege('authenticated', 'public.account_profiles', 'SELECT,INSERT,UPDATE,DELETE')
     or not has_table_privilege('authenticated', 'public.comfy_workflows', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'P17_B1E_VERIFY: existing account_profiles/comfy_workflows CRUD contract changed';
  end if;
end
$verify$;
