create table if not exists public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('collector', 'agent', 'workflow')),
  schedule jsonb not null default '{}',
  target jsonb not null default '{}',
  config jsonb not null default '{}',
  status text not null default 'active' check (status in ('active', 'paused', 'failed')),
  last_run timestamptz,
  next_run timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.automation_jobs(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  result jsonb,
  error text
);

create index if not exists automation_jobs_user_id_idx on public.automation_jobs(user_id);
create index if not exists automation_jobs_type_idx on public.automation_jobs(type);
create index if not exists automation_jobs_status_idx on public.automation_jobs(status);
create index if not exists automation_jobs_next_run_idx on public.automation_jobs(next_run);
create index if not exists automation_runs_user_id_idx on public.automation_runs(user_id);
create index if not exists automation_runs_job_id_idx on public.automation_runs(job_id);
create index if not exists automation_runs_status_idx on public.automation_runs(status);
create index if not exists automation_runs_started_at_idx on public.automation_runs(started_at desc);

alter table public.automation_jobs enable row level security;
alter table public.automation_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_jobs'
      and policyname = 'automation_jobs_select_own'
  ) then
    create policy "automation_jobs_select_own" on public.automation_jobs
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
      and tablename = 'automation_jobs'
      and policyname = 'automation_jobs_insert_own'
  ) then
    create policy "automation_jobs_insert_own" on public.automation_jobs
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
      and tablename = 'automation_jobs'
      and policyname = 'automation_jobs_update_own'
  ) then
    create policy "automation_jobs_update_own" on public.automation_jobs
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
      and tablename = 'automation_jobs'
      and policyname = 'automation_jobs_delete_own'
  ) then
    create policy "automation_jobs_delete_own" on public.automation_jobs
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
      and tablename = 'automation_runs'
      and policyname = 'automation_runs_select_own'
  ) then
    create policy "automation_runs_select_own" on public.automation_runs
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
      and tablename = 'automation_runs'
      and policyname = 'automation_runs_insert_own'
  ) then
    create policy "automation_runs_insert_own" on public.automation_runs
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
      and tablename = 'automation_runs'
      and policyname = 'automation_runs_update_own'
  ) then
    create policy "automation_runs_update_own" on public.automation_runs
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
      and tablename = 'automation_runs'
      and policyname = 'automation_runs_delete_own'
  ) then
    create policy "automation_runs_delete_own" on public.automation_runs
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on
  public.automation_jobs,
  public.automation_runs
to authenticated;
