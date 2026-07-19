create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text,
  type text not null check (type in ('content_generator', 'asset_generator', 'analysis')),
  model text,
  system_prompt text,
  status text not null default 'active' check (status in ('active', 'paused', 'inactive')),
  schedule jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  task_type text not null check (task_type in ('content_generation', 'asset_generation', 'analysis')),
  input_data jsonb not null default '{}',
  workflow_id uuid references public.assets(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agents_user_id_idx on public.agents(user_id);
create index if not exists agents_type_idx on public.agents(type);
create index if not exists agents_status_idx on public.agents(status);
create index if not exists agent_tasks_user_id_idx on public.agent_tasks(user_id);
create index if not exists agent_tasks_agent_id_idx on public.agent_tasks(agent_id);
create index if not exists agent_tasks_status_idx on public.agent_tasks(status);
create index if not exists agent_tasks_created_at_idx on public.agent_tasks(created_at);
create index if not exists agent_tasks_workflow_id_idx on public.agent_tasks(workflow_id);

alter table public.agents enable row level security;
alter table public.agent_tasks enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'agents'
      and policyname = 'agents_select_own'
  ) then
    create policy "agents_select_own" on public.agents
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
      and tablename = 'agents'
      and policyname = 'agents_insert_own'
  ) then
    create policy "agents_insert_own" on public.agents
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
      and tablename = 'agents'
      and policyname = 'agents_update_own'
  ) then
    create policy "agents_update_own" on public.agents
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
      and tablename = 'agents'
      and policyname = 'agents_delete_own'
  ) then
    create policy "agents_delete_own" on public.agents
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
      and tablename = 'agent_tasks'
      and policyname = 'agent_tasks_select_own'
  ) then
    create policy "agent_tasks_select_own" on public.agent_tasks
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
      and tablename = 'agent_tasks'
      and policyname = 'agent_tasks_insert_own'
  ) then
    create policy "agent_tasks_insert_own" on public.agent_tasks
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
      and tablename = 'agent_tasks'
      and policyname = 'agent_tasks_update_own'
  ) then
    create policy "agent_tasks_update_own" on public.agent_tasks
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
      and tablename = 'agent_tasks'
      and policyname = 'agent_tasks_delete_own'
  ) then
    create policy "agent_tasks_delete_own" on public.agent_tasks
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on
  public.agents,
  public.agent_tasks
to authenticated;
