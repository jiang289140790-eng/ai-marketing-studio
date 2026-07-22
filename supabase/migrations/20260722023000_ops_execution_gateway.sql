-- Ops execution gateway.
-- Records frontend-triggered AI Marketing OS actions without storing secrets.

create table if not exists public.ops_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid,
  action text not null,
  resource_type text,
  resource_id uuid,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_external', 'completed', 'failed', 'cancelled')),
  progress integer not null default 0 check (progress >= 0 and progress <= 100),
  input_summary jsonb not null default '{}',
  result_summary jsonb not null default '{}',
  error_code text,
  error_message text,
  retryable boolean not null default false,
  idempotency_key text not null,
  bridge_run_id text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ops_runs_user_id_idempotency_key_idx
  on public.ops_runs(user_id, idempotency_key);

create index if not exists ops_runs_user_id_idx on public.ops_runs(user_id);
create index if not exists ops_runs_status_idx on public.ops_runs(status);
create index if not exists ops_runs_action_idx on public.ops_runs(action);
create index if not exists ops_runs_resource_idx on public.ops_runs(resource_type, resource_id);
create index if not exists ops_runs_created_at_idx on public.ops_runs(created_at desc);

alter table public.ops_runs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ops_runs'
      and policyname = 'ops_runs_select_own'
  ) then
    create policy "ops_runs_select_own" on public.ops_runs
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ops_runs'
      and policyname = 'ops_runs_insert_own'
  ) then
    create policy "ops_runs_insert_own" on public.ops_runs
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'ops_runs'
      and policyname = 'ops_runs_update_own'
  ) then
    create policy "ops_runs_update_own" on public.ops_runs
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update on public.ops_runs to authenticated;
