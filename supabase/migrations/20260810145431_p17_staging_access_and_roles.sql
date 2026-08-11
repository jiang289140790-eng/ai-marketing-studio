create table ams_private.staging_access_v1 (
  user_id uuid primary key references auth.users(id) on delete restrict,
  access_role text not null check (access_role in ('viewer', 'reviewer', 'operator', 'admin')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (updated_at >= created_at)
);

alter table ams_private.staging_access_v1 enable row level security;
alter table ams_private.staging_access_v1 force row level security;

create or replace function ams_private.is_staging_user(required_role text default 'viewer')
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from ams_private.staging_access_v1 as access
    where access.user_id = (select auth.uid())
      and access.enabled is true
      and case required_role
        when 'viewer' then access.access_role in ('viewer', 'reviewer', 'operator', 'admin')
        when 'reviewer' then access.access_role in ('reviewer', 'operator', 'admin')
        when 'operator' then access.access_role in ('operator', 'admin')
        when 'admin' then access.access_role = 'admin'
        else false
      end
  );
$function$;

revoke all on table ams_private.staging_access_v1 from public, anon, authenticated;
revoke all on function ams_private.is_staging_user(text) from public, anon;
grant usage on schema ams_private to authenticated;
grant execute on function ams_private.is_staging_user(text) to authenticated;

comment on table ams_private.staging_access_v1 is 'Server-managed staging allowlist. It is not readable or writable through the Data API.';
comment on function ams_private.is_staging_user(text) is 'Fail-closed role check sourced only from the private allowlist; never from user_metadata.';
