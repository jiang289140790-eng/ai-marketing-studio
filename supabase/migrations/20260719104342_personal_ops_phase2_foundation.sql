-- Phase 2: Personal AI Ops Workspace foundation.
-- This migration intentionally avoids SaaS billing, plans, subscriptions, pricing, or membership features.

alter table public.social_accounts
  add column if not exists account_type text not null default 'brand',
  add column if not exists target_audience text,
  add column if not exists content_strategy text,
  add column if not exists posting_frequency text,
  add column if not exists api_status text not null default 'not_connected',
  add column if not exists ops_notes text;

update public.social_accounts
set account_type = coalesce(nullif(account_type, ''), account_category, 'brand')
where account_type is null or account_type = '';

alter table public.social_accounts
  drop constraint if exists social_accounts_account_type_check,
  drop constraint if exists social_accounts_api_status_check;

alter table public.social_accounts
  add constraint social_accounts_account_type_check
    check (account_type in ('brand', 'personal', 'competitor', 'inspiration')),
  add constraint social_accounts_api_status_check
    check (api_status in ('not_connected', 'connected', 'limited', 'error', 'expired'));

create index if not exists social_accounts_account_type_idx on public.social_accounts(account_type);
create index if not exists social_accounts_api_status_idx on public.social_accounts(api_status);

alter table public.content_library
  add column if not exists pipeline_stage text not null default 'draft',
  add column if not exists source_intelligence_id uuid references public.viral_contents(id) on delete set null,
  add column if not exists source_analysis_id uuid references public.content_analysis(id) on delete set null,
  add column if not exists idea_notes text,
  add column if not exists generation_brief jsonb not null default '{}',
  add column if not exists published_url text,
  add column if not exists last_analyzed_at timestamptz;

update public.content_library
set pipeline_stage = case
  when status in ('draft', 'review', 'scheduled', 'published') then status
  when status = 'failed' then 'review'
  else 'draft'
end
where pipeline_stage is null or pipeline_stage = '';

alter table public.content_library
  drop constraint if exists content_library_status_check,
  drop constraint if exists content_library_content_type_check,
  drop constraint if exists content_library_pipeline_stage_check;

alter table public.content_library
  add constraint content_library_status_check
    check (status in ('idea', 'researching', 'draft', 'generating', 'review', 'scheduled', 'published', 'analyzing', 'archived', 'failed')),
  add constraint content_library_content_type_check
    check (content_type in ('text', 'image', 'video', 'carousel', 'ad', 'thread', 'short_video')),
  add constraint content_library_pipeline_stage_check
    check (pipeline_stage in ('idea', 'researching', 'draft', 'generating', 'review', 'scheduled', 'published', 'analyzing', 'archived'));

create index if not exists content_library_pipeline_stage_idx on public.content_library(pipeline_stage);
create index if not exists content_library_source_intelligence_idx on public.content_library(source_intelligence_id);
create index if not exists content_library_source_analysis_idx on public.content_library(source_analysis_id);

alter table public.competitor_accounts
  add column if not exists source_platform text,
  add column if not exists account_type text not null default 'competitor',
  add column if not exists content_strategy text,
  add column if not exists posting_frequency text;

alter table public.viral_contents
  add column if not exists source_platform text,
  add column if not exists engagement_score numeric(12, 4) not null default 0,
  add column if not exists viral_reason text,
  add column if not exists content_type text not null default 'text',
  add column if not exists ai_recommendation text;

update public.viral_contents
set source_platform = coalesce(source_platform, platform),
    engagement_score = greatest(engagement_score, views + likes * 10 + comments * 20)
where source_platform is null or engagement_score = 0;

alter table public.viral_contents
  drop constraint if exists viral_contents_content_type_check;

alter table public.viral_contents
  add constraint viral_contents_content_type_check
    check (content_type in ('text', 'image', 'video', 'carousel', 'ad', 'thread', 'short_video'));

create index if not exists viral_contents_source_platform_idx on public.viral_contents(source_platform);
create index if not exists viral_contents_engagement_score_idx on public.viral_contents(engagement_score desc);
create index if not exists viral_contents_content_type_idx on public.viral_contents(content_type);

alter table public.content_analysis
  add column if not exists source_platform text,
  add column if not exists engagement_score numeric(12, 4) not null default 0,
  add column if not exists viral_reason text,
  add column if not exists content_type text,
  add column if not exists ai_recommendation text,
  add column if not exists replication_notes text,
  add column if not exists fit_score numeric(5, 2) not null default 0;

create index if not exists content_analysis_source_platform_idx on public.content_analysis(source_platform);
create index if not exists content_analysis_fit_score_idx on public.content_analysis(fit_score desc);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete set null,
  agent_task_id uuid references public.agent_tasks(id) on delete set null,
  agent_name text not null,
  input jsonb not null default '{}',
  output jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'success', 'failed')),
  cost numeric(12, 4) not null default 0,
  duration integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists agent_runs_user_id_idx on public.agent_runs(user_id);
create index if not exists agent_runs_agent_id_idx on public.agent_runs(agent_id);
create index if not exists agent_runs_agent_task_id_idx on public.agent_runs(agent_task_id);
create index if not exists agent_runs_status_idx on public.agent_runs(status);
create index if not exists agent_runs_created_at_idx on public.agent_runs(created_at desc);

alter table public.agent_runs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_runs' and policyname = 'agent_runs_select_own') then
    create policy "agent_runs_select_own" on public.agent_runs
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_runs' and policyname = 'agent_runs_insert_own') then
    create policy "agent_runs_insert_own" on public.agent_runs
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_runs' and policyname = 'agent_runs_update_own') then
    create policy "agent_runs_update_own" on public.agent_runs
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agent_runs' and policyname = 'agent_runs_delete_own') then
    create policy "agent_runs_delete_own" on public.agent_runs
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

create table if not exists public.tool_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  tool_name text not null,
  provider text,
  usage_type text not null default 'operation' check (usage_type in ('text_generation', 'image_generation', 'video_generation', 'workflow', 'api', 'operation')),
  units numeric(12, 4) not null default 1,
  unit_cost numeric(12, 6) not null default 0,
  total_cost numeric(12, 4) not null default 0,
  related_content_id uuid references public.content_library(id) on delete set null,
  related_agent_run_id uuid references public.agent_runs(id) on delete set null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists tool_usage_user_id_idx on public.tool_usage(user_id);
create index if not exists tool_usage_tool_name_idx on public.tool_usage(tool_name);
create index if not exists tool_usage_usage_type_idx on public.tool_usage(usage_type);
create index if not exists tool_usage_created_at_idx on public.tool_usage(created_at desc);
create index if not exists tool_usage_related_content_id_idx on public.tool_usage(related_content_id);

alter table public.tool_usage enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tool_usage' and policyname = 'tool_usage_select_own') then
    create policy "tool_usage_select_own" on public.tool_usage
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tool_usage' and policyname = 'tool_usage_insert_own') then
    create policy "tool_usage_insert_own" on public.tool_usage
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tool_usage' and policyname = 'tool_usage_update_own') then
    create policy "tool_usage_update_own" on public.tool_usage
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tool_usage' and policyname = 'tool_usage_delete_own') then
    create policy "tool_usage_delete_own" on public.tool_usage
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

create table if not exists public.platform_adapters (
  id uuid primary key default gen_random_uuid(),
  platform text not null unique check (platform in ('telegram', 'x', 'youtube', 'instagram', 'tiktok')),
  display_name text not null,
  status text not null default 'planned' check (status in ('implemented', 'prepared', 'planned', 'disabled')),
  auth_type text not null default 'oauth_or_token',
  capabilities jsonb not null default '{}',
  config_requirements jsonb not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_adapters enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'platform_adapters' and policyname = 'platform_adapters_select_authenticated') then
    create policy "platform_adapters_select_authenticated" on public.platform_adapters
      for select to authenticated
      using (true);
  end if;
end $$;

insert into public.platform_adapters(platform, display_name, status, auth_type, capabilities, config_requirements, notes)
values
  ('telegram', 'Telegram', 'implemented', 'bot_token', '{"publish":true,"metrics":true,"webhook":true}'::jsonb, '{"bot_token":"edge_secret_or_platform_credentials","chat_id":"required"}'::jsonb, 'First real publishing and feedback channel.'),
  ('x', 'X', 'prepared', 'oauth2', '{"publish":false,"metrics":false,"webhook":false}'::jsonb, '{"client_id":"edge_secret","client_secret":"edge_secret","redirect_uri":"edge_function"}'::jsonb, 'Adapter shape is prepared. Real X API keys and OAuth app are required before use.'),
  ('youtube', 'YouTube', 'planned', 'oauth2', '{"publish":false,"metrics":false}'::jsonb, '{}'::jsonb, 'Future channel.'),
  ('instagram', 'Instagram', 'planned', 'oauth2', '{"publish":false,"metrics":false}'::jsonb, '{}'::jsonb, 'Future channel.'),
  ('tiktok', 'TikTok', 'planned', 'oauth2', '{"publish":false,"metrics":false}'::jsonb, '{}'::jsonb, 'Future channel.')
on conflict (platform) do update
set display_name = excluded.display_name,
    status = excluded.status,
    auth_type = excluded.auth_type,
    capabilities = excluded.capabilities,
    config_requirements = excluded.config_requirements,
    notes = excluded.notes,
    updated_at = now();

grant select, insert, update, delete on
  public.agent_runs,
  public.tool_usage
to authenticated;

grant select on public.platform_adapters to authenticated;
