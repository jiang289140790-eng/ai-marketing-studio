-- Phase 3 execution hardening.
-- Personal AI Ops Workspace only: no billing, subscriptions, memberships, pricing, or SaaS tenant features.

create extension if not exists pgcrypto with schema public;
create extension if not exists pg_trgm with schema public;

-- The MCP runtime writes these business records with service_role.
-- Browser users may read only rows stamped with their own auth.uid().

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null,
  goal text not null,
  target_audience jsonb not null default '[]'::jsonb,
  target_accounts jsonb not null default '[]'::jsonb,
  target_platforms jsonb not null default '[]'::jsonb,
  content_themes jsonb not null default '[]'::jsonb,
  asset_requirements jsonb not null default '{}'::jsonb,
  publish_window jsonb not null default '{}'::jsonb,
  conversion_path text,
  budget_limit jsonb not null default '{}'::jsonb,
  success_metrics jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','active','paused','completed','archived')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.campaigns
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists target_audience jsonb not null default '[]'::jsonb,
  add column if not exists target_accounts jsonb not null default '[]'::jsonb,
  add column if not exists target_platforms jsonb not null default '[]'::jsonb,
  add column if not exists content_themes jsonb not null default '[]'::jsonb,
  add column if not exists asset_requirements jsonb not null default '{}'::jsonb,
  add column if not exists publish_window jsonb not null default '{}'::jsonb,
  add column if not exists conversion_path text,
  add column if not exists budget_limit jsonb not null default '{}'::jsonb,
  add column if not exists success_metrics jsonb not null default '{}'::jsonb,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.strategy_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  name text not null,
  description text,
  period_type text not null default 'custom' check (period_type in ('daily','weekly','monthly','custom')),
  period_start date,
  period_end date,
  target_accounts jsonb not null default '[]'::jsonb,
  target_platforms jsonb not null default '[]'::jsonb,
  content_themes jsonb not null default '[]'::jsonb,
  daily_plan jsonb not null default '{}'::jsonb,
  opportunities_used jsonb not null default '[]'::jsonb,
  kpi_targets jsonb not null default '{}'::jsonb,
  status text not null default 'review' check (status in ('draft','review','approved','active','completed','archived')),
  approved_by text,
  approved_at timestamptz,
  strategy_version integer not null default 1,
  source_insights jsonb not null default '[]'::jsonb,
  source_memories jsonb not null default '[]'::jsonb,
  llm_model text,
  llm_prompt_tokens integer not null default 0,
  llm_completion_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.strategy_plans
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null,
  add column if not exists target_accounts jsonb not null default '[]'::jsonb,
  add column if not exists target_platforms jsonb not null default '[]'::jsonb,
  add column if not exists content_themes jsonb not null default '[]'::jsonb,
  add column if not exists daily_plan jsonb not null default '{}'::jsonb,
  add column if not exists opportunities_used jsonb not null default '[]'::jsonb,
  add column if not exists kpi_targets jsonb not null default '{}'::jsonb,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists strategy_version integer not null default 1,
  add column if not exists source_insights jsonb not null default '[]'::jsonb,
  add column if not exists source_memories jsonb not null default '[]'::jsonb,
  add column if not exists llm_model text,
  add column if not exists llm_prompt_tokens integer not null default 0,
  add column if not exists llm_completion_tokens integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.content_packages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  strategy_plan_id uuid references public.strategy_plans(id) on delete set null,
  account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null,
  title text not null,
  body text not null,
  cta text,
  hook text,
  hashtags jsonb not null default '[]'::jsonb,
  keywords jsonb not null default '[]'::jsonb,
  language_style text,
  image_requirements jsonb not null default '{}'::jsonb,
  video_requirements jsonb not null default '{}'::jsonb,
  source_insights jsonb not null default '[]'::jsonb,
  scheduled_at timestamptz,
  review_status text not null default 'draft' check (review_status in ('draft','review','approved','rejected','scheduled','published')),
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.content_packages
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists strategy_plan_id uuid references public.strategy_plans(id) on delete set null,
  add column if not exists hook text,
  add column if not exists hashtags jsonb not null default '[]'::jsonb,
  add column if not exists keywords jsonb not null default '[]'::jsonb,
  add column if not exists language_style text,
  add column if not exists source_insights jsonb not null default '[]'::jsonb,
  add column if not exists status text not null default 'draft',
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.asset_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  content_package_id uuid references public.content_packages(id) on delete set null,
  strategy_plan_id uuid references public.strategy_plans(id) on delete set null,
  campaign_id uuid references public.campaigns(id) on delete set null,
  asset_type text not null default 'image' check (asset_type in ('image','video','audio','script','other')),
  generation_provider text not null default 'autodl',
  generation_workflow text,
  generation_params jsonb not null default '{}'::jsonb,
  generation_prompt text,
  input_reference_url text,
  output_url text,
  output_storage_path text,
  thumbnail_url text,
  duration_seconds numeric,
  file_size_bytes bigint,
  resolution text,
  status text not null default 'pending' check (status in ('pending','generating','completed','failed','archived')),
  error_message text,
  cost_estimate jsonb not null default '{}'::jsonb,
  generation_task_id text,
  metadata jsonb not null default '{}'::jsonb,
  approved_for_publishing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.asset_library
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists content_package_id uuid references public.content_packages(id) on delete set null,
  add column if not exists strategy_plan_id uuid references public.strategy_plans(id) on delete set null,
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null,
  add column if not exists output_storage_path text,
  add column if not exists thumbnail_url text,
  add column if not exists approved_for_publishing boolean not null default false,
  add column if not exists updated_at timestamptz not null default now();

alter table public.publish_tasks
  alter column user_id drop not null,
  add column if not exists content_package_id uuid references public.content_packages(id) on delete set null,
  add column if not exists campaign_id uuid references public.campaigns(id) on delete set null,
  add column if not exists platform_account_id text,
  add column if not exists scheduled_at timestamptz,
  add column if not exists publish_content jsonb not null default '{}'::jsonb,
  add column if not exists publish_result jsonb not null default '{}'::jsonb,
  add column if not exists approval_status text not null default 'pending',
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table public.platform_connections
  alter column user_id drop not null,
  add column if not exists connection_type text not null default 'api',
  add column if not exists is_connected boolean not null default false,
  add column if not exists connection_config jsonb not null default '{}'::jsonb,
  add column if not exists last_verified_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists campaigns_user_id_idx on public.campaigns(user_id);
create index if not exists campaigns_status_idx on public.campaigns(status);
create index if not exists strategy_plans_user_id_idx on public.strategy_plans(user_id);
create index if not exists strategy_plans_campaign_id_idx on public.strategy_plans(campaign_id);
create index if not exists strategy_plans_status_idx on public.strategy_plans(status);
create index if not exists content_packages_user_id_idx on public.content_packages(user_id);
create index if not exists content_packages_campaign_id_idx on public.content_packages(campaign_id);
create index if not exists content_packages_strategy_plan_id_idx on public.content_packages(strategy_plan_id);
create index if not exists content_packages_review_status_idx on public.content_packages(review_status);
create index if not exists asset_library_user_id_idx on public.asset_library(user_id);
create index if not exists asset_library_content_package_id_idx on public.asset_library(content_package_id);
create index if not exists asset_library_status_idx on public.asset_library(status);
create index if not exists publish_tasks_content_package_id_idx on public.publish_tasks(content_package_id);
create index if not exists publish_tasks_approval_status_idx on public.publish_tasks(approval_status);
create index if not exists platform_connections_is_connected_idx on public.platform_connections(is_connected);

alter table public.campaigns enable row level security;
alter table public.strategy_plans enable row level security;
alter table public.content_packages enable row level security;
alter table public.asset_library enable row level security;
alter table public.ops_runs enable row level security;

drop policy if exists "ops_runs_insert_own" on public.ops_runs;
drop policy if exists "ops_runs_update_own" on public.ops_runs;
revoke insert, update, delete on public.ops_runs from authenticated;
grant select on public.ops_runs to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='ops_runs' and policyname='ops_runs_select_own'
  ) then
    create policy "ops_runs_select_own" on public.ops_runs
      for select to authenticated
      using (user_id::text = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='campaigns' and policyname='campaigns_select_own'
  ) then
    create policy "campaigns_select_own" on public.campaigns
      for select to authenticated
      using (user_id::text = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='strategy_plans' and policyname='strategy_plans_select_own'
  ) then
    create policy "strategy_plans_select_own" on public.strategy_plans
      for select to authenticated
      using (
        user_id::text = auth.uid()::text
        or exists (
          select 1 from public.campaigns c
          where c.id::text = strategy_plans.campaign_id::text
            and c.user_id::text = auth.uid()::text
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='content_packages' and policyname='content_packages_select_own'
  ) then
    create policy "content_packages_select_own" on public.content_packages
      for select to authenticated
      using (
        user_id::text = auth.uid()::text
        or exists (
          select 1 from public.campaigns c
          where c.id::text = content_packages.campaign_id::text
            and c.user_id::text = auth.uid()::text
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='asset_library' and policyname='asset_library_select_own'
  ) then
    create policy "asset_library_select_own" on public.asset_library
      for select to authenticated
      using (
        user_id::text = auth.uid()::text
        or exists (
          select 1 from public.content_packages cp
          where cp.id::text = asset_library.content_package_id::text
            and cp.user_id::text = auth.uid()::text
        )
        or exists (
          select 1 from public.campaigns c
          where c.id::text = asset_library.campaign_id::text
            and c.user_id::text = auth.uid()::text
        )
      );
  end if;
end;
$$;
