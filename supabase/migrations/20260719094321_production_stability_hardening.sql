alter table public.collection_tasks
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.collection_runs
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.agent_tasks
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.workflow_runs
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.publish_tasks
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.automation_jobs
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

alter table public.automation_runs
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_retry integer not null default 3,
  add column if not exists last_error text;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('workflow_failed', 'publish_failed', 'collector_failed', 'agent_failed', 'automation_failed', 'cost_alert', 'system')),
  channel text not null default 'in_app' check (channel in ('in_app', 'telegram', 'email')),
  title text not null,
  message text,
  status text not null default 'unread' check (status in ('unread', 'read', 'sent', 'failed')),
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table if not exists public.cost_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  cost_date date not null default current_date,
  category text not null check (category in ('ai', 'workflow', 'api')),
  source text,
  amount numeric(12, 4) not null default 0,
  revenue numeric(12, 4) not null default 0,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  entity_type text not null check (entity_type in ('tool', 'workflow', 'campaign', 'prompt', 'asset', 'content', 'settings')),
  entity_id uuid,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_id_idx on public.notifications(user_id);
create index if not exists notifications_status_idx on public.notifications(status);
create index if not exists notifications_type_idx on public.notifications(type);
create index if not exists notifications_created_at_idx on public.notifications(created_at desc);

create index if not exists cost_records_user_id_idx on public.cost_records(user_id);
create index if not exists cost_records_cost_date_idx on public.cost_records(cost_date desc);
create index if not exists cost_records_category_idx on public.cost_records(category);

create index if not exists audit_logs_user_id_idx on public.audit_logs(user_id);
create index if not exists audit_logs_entity_idx on public.audit_logs(entity_type, entity_id);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

alter table public.notifications enable row level security;
alter table public.cost_records enable row level security;
alter table public.audit_logs enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'notifications'
      and policyname = 'notifications_select_own'
  ) then
    create policy "notifications_select_own" on public.notifications
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
      and tablename = 'notifications'
      and policyname = 'notifications_insert_own'
  ) then
    create policy "notifications_insert_own" on public.notifications
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
      and tablename = 'notifications'
      and policyname = 'notifications_update_own'
  ) then
    create policy "notifications_update_own" on public.notifications
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
      and tablename = 'notifications'
      and policyname = 'notifications_delete_own'
  ) then
    create policy "notifications_delete_own" on public.notifications
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
      and tablename = 'cost_records'
      and policyname = 'cost_records_select_own'
  ) then
    create policy "cost_records_select_own" on public.cost_records
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
      and tablename = 'cost_records'
      and policyname = 'cost_records_insert_own'
  ) then
    create policy "cost_records_insert_own" on public.cost_records
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
      and tablename = 'cost_records'
      and policyname = 'cost_records_update_own'
  ) then
    create policy "cost_records_update_own" on public.cost_records
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
      and tablename = 'cost_records'
      and policyname = 'cost_records_delete_own'
  ) then
    create policy "cost_records_delete_own" on public.cost_records
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
      and tablename = 'audit_logs'
      and policyname = 'audit_logs_select_own'
  ) then
    create policy "audit_logs_select_own" on public.audit_logs
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
      and tablename = 'audit_logs'
      and policyname = 'audit_logs_insert_own'
  ) then
    create policy "audit_logs_insert_own" on public.audit_logs
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on
  public.notifications,
  public.cost_records
to authenticated;

grant select, insert on public.audit_logs to authenticated;
