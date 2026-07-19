create table if not exists public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('Telegram', 'X', 'Instagram', 'TikTok', 'YouTube')),
  account_id uuid references public.social_accounts(id) on delete set null,
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'pending', 'error')),
  connected_at timestamptz,
  last_sync timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.platform_connections(id) on delete cascade,
  encrypted_token text,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists platform_connections_user_id_idx on public.platform_connections(user_id);
create index if not exists platform_connections_platform_idx on public.platform_connections(platform);
create index if not exists platform_connections_status_idx on public.platform_connections(status);
create index if not exists platform_connections_account_id_idx on public.platform_connections(account_id);
create index if not exists platform_credentials_connection_id_idx on public.platform_credentials(connection_id);
create index if not exists platform_credentials_expires_at_idx on public.platform_credentials(expires_at);

alter table public.platform_connections enable row level security;
alter table public.platform_credentials enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_select_own'
  ) then
    create policy "platform_connections_select_own" on public.platform_connections
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_insert_own'
  ) then
    create policy "platform_connections_insert_own" on public.platform_connections
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_update_own'
  ) then
    create policy "platform_connections_update_own" on public.platform_connections
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_delete_own'
  ) then
    create policy "platform_connections_delete_own" on public.platform_connections
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

revoke all on public.platform_credentials from anon;
revoke all on public.platform_credentials from authenticated;

grant select, insert, update, delete on public.platform_connections to authenticated;

alter table public.automation_jobs
  drop constraint if exists automation_jobs_type_check;

alter table public.automation_jobs
  add constraint automation_jobs_type_check
  check (type in ('collector', 'agent', 'workflow', 'platform'));
