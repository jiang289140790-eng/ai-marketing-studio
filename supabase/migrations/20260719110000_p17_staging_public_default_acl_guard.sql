begin;

do $guard_identity$
begin
  if current_user <> 'postgres' then
    raise exception using
      errcode = '42501',
      message = 'P17 ACL guard requires current_user=postgres';
  end if;
end;
$guard_identity$;

alter default privileges for role postgres in schema public
  revoke all privileges on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all privileges on sequences from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all privileges on functions from anon, authenticated;

do $guard_verify$
begin
  if exists (
    select 1
    from pg_default_acl as defaults
    join pg_namespace as namespaces
      on namespaces.oid = defaults.defaclnamespace
    cross join lateral aclexplode(defaults.defaclacl) as acl
    join pg_roles as owner_role
      on owner_role.oid = defaults.defaclrole
    join pg_roles as grantee_role
      on grantee_role.oid = acl.grantee
    where owner_role.rolname = 'postgres'
      and namespaces.nspname = 'public'
      and defaults.defaclobjtype in ('r', 'S', 'f')
      and grantee_role.rolname in ('anon', 'authenticated')
  ) then
    raise exception using
      errcode = '42501',
      message = 'P17 ACL guard verification failed: public defaults still grant anon/authenticated';
  end if;
end;
$guard_verify$;

commit;
