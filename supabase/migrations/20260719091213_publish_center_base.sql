alter table public.publish_tasks
  add column if not exists platform_connection_id uuid references public.platform_connections(id) on delete set null,
  add column if not exists scheduled_time timestamptz,
  add column if not exists external_id text,
  add column if not exists result jsonb,
  add column if not exists error_message text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists published_at timestamptz;

update public.publish_tasks
set scheduled_time = coalesce(scheduled_time, publish_time)
where scheduled_time is null;

update public.publish_tasks
set status = 'scheduled'
where status = 'pending';

alter table public.publish_tasks
  alter column publish_time drop not null;

alter table public.publish_tasks
  alter column status set default 'draft';

alter table public.publish_tasks
  drop constraint if exists publish_tasks_status_check;

alter table public.publish_tasks
  add constraint publish_tasks_status_check
  check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed'));

create index if not exists publish_tasks_platform_connection_id_idx on public.publish_tasks(platform_connection_id);
create index if not exists publish_tasks_status_idx on public.publish_tasks(status);
create index if not exists publish_tasks_scheduled_time_idx on public.publish_tasks(scheduled_time);
create index if not exists publish_tasks_external_id_idx on public.publish_tasks(external_id);
