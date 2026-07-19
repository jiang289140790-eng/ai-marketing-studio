create table if not exists public.content_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_id uuid not null references public.content_library(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  views bigint not null default 0,
  likes bigint not null default 0,
  comments bigint not null default 0,
  shares bigint not null default 0,
  clicks bigint not null default 0,
  registrations bigint not null default 0,
  revenue numeric(12, 2) not null default 0,
  collected_at timestamptz not null default now()
);

create table if not exists public.publish_metrics (
  publish_task_id uuid primary key references public.publish_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  metrics_json jsonb not null default '{}',
  last_sync timestamptz
);

create table if not exists public.content_strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  source text not null default 'analysis-agent',
  input_data jsonb not null default '{}',
  optimization_strategy jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists content_metrics_user_id_idx on public.content_metrics(user_id);
create index if not exists content_metrics_content_id_idx on public.content_metrics(content_id);
create index if not exists content_metrics_platform_idx on public.content_metrics(platform);
create index if not exists content_metrics_collected_at_idx on public.content_metrics(collected_at desc);
create index if not exists content_metrics_revenue_idx on public.content_metrics(revenue desc);

create index if not exists publish_metrics_user_id_idx on public.publish_metrics(user_id);
create index if not exists publish_metrics_last_sync_idx on public.publish_metrics(last_sync desc);

create index if not exists content_strategies_user_id_idx on public.content_strategies(user_id);
create index if not exists content_strategies_created_at_idx on public.content_strategies(created_at desc);
create index if not exists content_strategies_source_idx on public.content_strategies(source);

alter table public.content_metrics enable row level security;
alter table public.publish_metrics enable row level security;
alter table public.content_strategies enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'content_metrics'
      and policyname = 'content_metrics_select_own'
  ) then
    create policy "content_metrics_select_own" on public.content_metrics
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
      and tablename = 'content_metrics'
      and policyname = 'content_metrics_insert_own'
  ) then
    create policy "content_metrics_insert_own" on public.content_metrics
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
      and tablename = 'content_metrics'
      and policyname = 'content_metrics_update_own'
  ) then
    create policy "content_metrics_update_own" on public.content_metrics
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
      and tablename = 'content_metrics'
      and policyname = 'content_metrics_delete_own'
  ) then
    create policy "content_metrics_delete_own" on public.content_metrics
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
      and tablename = 'publish_metrics'
      and policyname = 'publish_metrics_select_own'
  ) then
    create policy "publish_metrics_select_own" on public.publish_metrics
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
      and tablename = 'publish_metrics'
      and policyname = 'publish_metrics_insert_own'
  ) then
    create policy "publish_metrics_insert_own" on public.publish_metrics
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
      and tablename = 'publish_metrics'
      and policyname = 'publish_metrics_update_own'
  ) then
    create policy "publish_metrics_update_own" on public.publish_metrics
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
      and tablename = 'publish_metrics'
      and policyname = 'publish_metrics_delete_own'
  ) then
    create policy "publish_metrics_delete_own" on public.publish_metrics
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
      and tablename = 'content_strategies'
      and policyname = 'content_strategies_select_own'
  ) then
    create policy "content_strategies_select_own" on public.content_strategies
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
      and tablename = 'content_strategies'
      and policyname = 'content_strategies_insert_own'
  ) then
    create policy "content_strategies_insert_own" on public.content_strategies
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
      and tablename = 'content_strategies'
      and policyname = 'content_strategies_update_own'
  ) then
    create policy "content_strategies_update_own" on public.content_strategies
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
      and tablename = 'content_strategies'
      and policyname = 'content_strategies_delete_own'
  ) then
    create policy "content_strategies_delete_own" on public.content_strategies
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on
  public.content_metrics,
  public.publish_metrics,
  public.content_strategies
to authenticated;
