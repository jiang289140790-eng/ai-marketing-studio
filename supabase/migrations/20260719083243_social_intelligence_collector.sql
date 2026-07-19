create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Reddit')),
  source_type text not null check (source_type in ('competitor_account', 'channel', 'keyword', 'hashtag', 'rss', 'manual')),
  name text not null,
  url text,
  account text,
  category text,
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'error')),
  last_sync timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.content_sources(id) on delete cascade,
  frequency text not null default 'manual' check (frequency in ('manual', 'hourly', 'daily', 'weekly')),
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'error')),
  last_run timestamptz,
  next_run timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.collection_tasks(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  items_found integer not null default 0,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  error text
);

create index if not exists content_sources_user_id_idx on public.content_sources(user_id);
create index if not exists content_sources_platform_idx on public.content_sources(platform);
create index if not exists content_sources_source_type_idx on public.content_sources(source_type);
create index if not exists content_sources_status_idx on public.content_sources(status);
create index if not exists content_sources_category_idx on public.content_sources(category);
create index if not exists collection_tasks_user_id_idx on public.collection_tasks(user_id);
create index if not exists collection_tasks_source_id_idx on public.collection_tasks(source_id);
create index if not exists collection_tasks_status_idx on public.collection_tasks(status);
create index if not exists collection_tasks_next_run_idx on public.collection_tasks(next_run);
create index if not exists collection_runs_user_id_idx on public.collection_runs(user_id);
create index if not exists collection_runs_task_id_idx on public.collection_runs(task_id);
create index if not exists collection_runs_status_idx on public.collection_runs(status);
create index if not exists collection_runs_started_at_idx on public.collection_runs(started_at desc);

alter table public.content_sources enable row level security;
alter table public.collection_tasks enable row level security;
alter table public.collection_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'content_sources'
      and policyname = 'content_sources_select_own'
  ) then
    create policy "content_sources_select_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_insert_own'
  ) then
    create policy "content_sources_insert_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_update_own'
  ) then
    create policy "content_sources_update_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_delete_own'
  ) then
    create policy "content_sources_delete_own" on public.content_sources
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_select_own'
  ) then
    create policy "collection_tasks_select_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_insert_own'
  ) then
    create policy "collection_tasks_insert_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_update_own'
  ) then
    create policy "collection_tasks_update_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_delete_own'
  ) then
    create policy "collection_tasks_delete_own" on public.collection_tasks
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_select_own'
  ) then
    create policy "collection_runs_select_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_insert_own'
  ) then
    create policy "collection_runs_insert_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_update_own'
  ) then
    create policy "collection_runs_update_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_delete_own'
  ) then
    create policy "collection_runs_delete_own" on public.collection_runs
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on
  public.content_sources,
  public.collection_tasks,
  public.collection_runs
to authenticated;
