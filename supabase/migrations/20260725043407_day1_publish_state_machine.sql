-- Align the existing publish_tasks table with the Campaign -> Day 1 publishing flow.
-- Execution mode, preflight evidence and safe error details remain in publish_result JSONB.

alter table public.publish_tasks
  drop constraint if exists publish_tasks_campaign_id_fkey;

alter table public.publish_tasks
  add constraint publish_tasks_campaign_id_fkey
  foreign key (campaign_id)
  references public.campaigns(id)
  on delete set null;

alter table public.publish_tasks
  drop constraint if exists publish_tasks_status_check;

alter table public.publish_tasks
  add constraint publish_tasks_status_check
  check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled'));

comment on column public.publish_tasks.status is
  'Publish task state only: draft, scheduled, publishing, published, failed, cancelled.';

comment on column public.publish_tasks.approval_status is
  'Human approval dimension: pending, approved, needs_revision, rejected.';

comment on column public.publish_tasks.publish_result is
  'Platform result plus preflight, execution_mode, audit-safe error and retry metadata.';
