create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  workflow_id uuid references public.assets(id) on delete set null,
  tool_id text,
  character_id uuid references public.characters(id) on delete set null,
  prompt_id uuid references public.prompts(id) on delete set null,
  asset_ids uuid[] not null default '{}',
  input_data jsonb not null default '{}',
  output_data jsonb,
  status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failed')),
  cost numeric(12, 4) not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists workflow_runs_user_id_idx on public.workflow_runs(user_id);
create index if not exists workflow_runs_status_idx on public.workflow_runs(status);
create index if not exists workflow_runs_created_at_idx on public.workflow_runs(created_at);
create index if not exists workflow_runs_workflow_id_idx on public.workflow_runs(workflow_id);
create index if not exists workflow_runs_character_id_idx on public.workflow_runs(character_id);
create index if not exists workflow_runs_prompt_id_idx on public.workflow_runs(prompt_id);
create index if not exists workflow_runs_asset_ids_idx on public.workflow_runs using gin(asset_ids);

alter table public.workflow_runs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'workflow_runs'
      and policyname = 'workflow_runs_select_own'
  ) then
    create policy "workflow_runs_select_own" on public.workflow_runs
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
      and tablename = 'workflow_runs'
      and policyname = 'workflow_runs_insert_own'
  ) then
    create policy "workflow_runs_insert_own" on public.workflow_runs
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
      and tablename = 'workflow_runs'
      and policyname = 'workflow_runs_update_own'
  ) then
    create policy "workflow_runs_update_own" on public.workflow_runs
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
      and tablename = 'workflow_runs'
      and policyname = 'workflow_runs_delete_own'
  ) then
    create policy "workflow_runs_delete_own" on public.workflow_runs
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.workflow_runs to authenticated;
