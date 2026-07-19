create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  username text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  account_name text not null,
  account_url text,
  avatar text,
  account_category text not null default 'brand' check (account_category in ('brand', 'personal', 'competitor', 'inspiration')),
  status text not null default 'active' check (status in ('active', 'inactive', 'needs_review')),
  created_at timestamptz not null default now()
);

create table if not exists public.content_library (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content_text text,
  media_url text,
  content_type text not null default 'text' check (content_type in ('text', 'image', 'video', 'carousel', 'ad')),
  platform text check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  account_category text not null default 'brand' check (account_category in ('brand', 'personal', 'competitor', 'inspiration')),
  asset_id uuid,
  character_id uuid,
  prompt_id uuid,
  status text not null default 'draft' check (status in ('draft', 'review', 'scheduled', 'published', 'failed')),
  created_at timestamptz not null default now()
);

create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Untitled asset',
  type text not null check (type in ('image', 'video', 'audio', 'prompt', 'workflow', 'lora')),
  url text,
  thumbnail text,
  prompt text,
  model text,
  workflow jsonb,
  tags text[] not null default '{}',
  source text not null default 'manual' check (source in ('manual', 'upload', 'gpt', 'claude', 'qwen', 'comfyui', 'civitai', 'n8n', 'workflow-runtime')),
  created_at timestamptz not null default now()
);

create table if not exists public.characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  avatar text,
  description text,
  personality text,
  appearance text,
  prompt text,
  lora text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  content text not null,
  platform text check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  character uuid references public.characters(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.publish_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_id uuid references public.content_library(id) on delete cascade,
  platform_connection_id uuid,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  publish_time timestamptz,
  scheduled_time timestamptz,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed')),
  external_id text,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists public.viral_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  account text not null,
  content_url text,
  views bigint not null default 0,
  likes bigint not null default 0,
  analysis text,
  created_at timestamptz not null default now()
);

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

create table if not exists public.competitor_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  username text not null,
  url text,
  category text,
  audience text,
  followers bigint not null default 0,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.viral_contents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid references public.competitor_accounts(id) on delete set null,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  url text,
  title text not null,
  content_text text,
  media_url text,
  views bigint not null default 0,
  likes bigint not null default 0,
  comments bigint not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.content_analysis (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  viral_content_id uuid references public.viral_contents(id) on delete cascade,
  analysis text,
  hook text,
  structure text,
  strategy text,
  created_at timestamptz not null default now()
);

create table if not exists public.content_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Reddit')),
  source_type text not null check (source_type in ('competitor_account', 'channel', 'keyword', 'hashtag', 'rss', 'manual', 'telegram')),
  name text not null,
  url text,
  account text,
  channel text,
  username text,
  last_message_id text,
  sync_time timestamptz,
  category text,
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'error')),
  last_sync timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_id uuid not null references public.content_sources(id) on delete cascade,
  frequency text not null default 'manual' check (frequency in ('manual', 'hourly', 'daily', 'weekly')),
  status text not null default 'active' check (status in ('active', 'paused', 'inactive', 'error')),
  last_run timestamptz,
  next_run timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.collection_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.collection_tasks(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  items_found integer not null default 0,
  duration_ms integer not null default 0,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  error text
);

create table if not exists public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  type text not null check (type in ('collector', 'agent', 'workflow', 'platform')),
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
  status text not null default 'queued' check (status in ('queued', 'running', 'success', 'failed')),
  result jsonb,
  error text
);

create table if not exists public.platform_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('Telegram', 'X', 'Instagram', 'TikTok', 'YouTube')),
  account_id uuid references public.social_accounts(id) on delete set null,
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'pending', 'error')),
  connected_at timestamptz,
  last_sync timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.platform_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.platform_connections(id) on delete cascade,
  encrypted_token text,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

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

create table if not exists public.campaign_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_id uuid references public.content_library(id) on delete cascade,
  platform text not null check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  utm_source text,
  utm_campaign text,
  url text not null,
  clicks bigint not null default 0,
  registrations bigint not null default 0,
  revenue numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.content_library
  add constraint content_library_asset_id_fkey foreign key (asset_id) references public.assets(id) on delete set null,
  add constraint content_library_character_id_fkey foreign key (character_id) references public.characters(id) on delete set null,
  add constraint content_library_prompt_id_fkey foreign key (prompt_id) references public.prompts(id) on delete set null;

alter table public.publish_tasks
  add constraint publish_tasks_platform_connection_id_fkey foreign key (platform_connection_id) references public.platform_connections(id) on delete set null;

alter table public.publish_tasks
  add column if not exists campaign_id uuid references public.campaign_links(id) on delete set null;

create index if not exists social_accounts_user_id_idx on public.social_accounts(user_id);
create index if not exists content_library_user_id_idx on public.content_library(user_id);
create index if not exists content_library_status_idx on public.content_library(status);
create index if not exists assets_user_id_idx on public.assets(user_id);
create index if not exists assets_type_idx on public.assets(type);
create index if not exists assets_tags_idx on public.assets using gin(tags);
create index if not exists characters_user_id_idx on public.characters(user_id);
create index if not exists characters_tags_idx on public.characters using gin(tags);
create index if not exists prompts_user_id_idx on public.prompts(user_id);
create index if not exists prompts_category_idx on public.prompts(category);
create index if not exists content_library_asset_id_idx on public.content_library(asset_id);
create index if not exists content_library_character_id_idx on public.content_library(character_id);
create index if not exists content_library_prompt_id_idx on public.content_library(prompt_id);
create index if not exists publish_tasks_user_id_idx on public.publish_tasks(user_id);
create index if not exists publish_tasks_publish_time_idx on public.publish_tasks(publish_time);
create index if not exists publish_tasks_platform_connection_id_idx on public.publish_tasks(platform_connection_id);
create index if not exists publish_tasks_status_idx on public.publish_tasks(status);
create index if not exists publish_tasks_scheduled_time_idx on public.publish_tasks(scheduled_time);
create index if not exists publish_tasks_external_id_idx on public.publish_tasks(external_id);
create index if not exists viral_analysis_user_id_idx on public.viral_analysis(user_id);
create index if not exists workflow_runs_user_id_idx on public.workflow_runs(user_id);
create index if not exists workflow_runs_status_idx on public.workflow_runs(status);
create index if not exists workflow_runs_created_at_idx on public.workflow_runs(created_at);
create index if not exists workflow_runs_workflow_id_idx on public.workflow_runs(workflow_id);
create index if not exists workflow_runs_character_id_idx on public.workflow_runs(character_id);
create index if not exists workflow_runs_prompt_id_idx on public.workflow_runs(prompt_id);
create index if not exists workflow_runs_asset_ids_idx on public.workflow_runs using gin(asset_ids);
create index if not exists agents_user_id_idx on public.agents(user_id);
create index if not exists agents_type_idx on public.agents(type);
create index if not exists agents_status_idx on public.agents(status);
create index if not exists agent_tasks_user_id_idx on public.agent_tasks(user_id);
create index if not exists agent_tasks_agent_id_idx on public.agent_tasks(agent_id);
create index if not exists agent_tasks_status_idx on public.agent_tasks(status);
create index if not exists agent_tasks_created_at_idx on public.agent_tasks(created_at);
create index if not exists agent_tasks_workflow_id_idx on public.agent_tasks(workflow_id);
create index if not exists competitor_accounts_user_id_idx on public.competitor_accounts(user_id);
create index if not exists competitor_accounts_platform_idx on public.competitor_accounts(platform);
create index if not exists competitor_accounts_category_idx on public.competitor_accounts(category);
create index if not exists competitor_accounts_username_idx on public.competitor_accounts(username);
create index if not exists viral_contents_user_id_idx on public.viral_contents(user_id);
create index if not exists viral_contents_account_id_idx on public.viral_contents(account_id);
create index if not exists viral_contents_platform_idx on public.viral_contents(platform);
create index if not exists viral_contents_views_idx on public.viral_contents(views desc);
create index if not exists viral_contents_published_at_idx on public.viral_contents(published_at desc);
create index if not exists content_analysis_user_id_idx on public.content_analysis(user_id);
create index if not exists content_analysis_viral_content_id_idx on public.content_analysis(viral_content_id);
create index if not exists content_sources_user_id_idx on public.content_sources(user_id);
create index if not exists content_sources_platform_idx on public.content_sources(platform);
create index if not exists content_sources_source_type_idx on public.content_sources(source_type);
create index if not exists content_sources_status_idx on public.content_sources(status);
create index if not exists content_sources_category_idx on public.content_sources(category);
create index if not exists content_sources_channel_idx on public.content_sources(channel);
create index if not exists content_sources_username_idx on public.content_sources(username);
create index if not exists collection_tasks_user_id_idx on public.collection_tasks(user_id);
create index if not exists collection_tasks_source_id_idx on public.collection_tasks(source_id);
create index if not exists collection_tasks_status_idx on public.collection_tasks(status);
create index if not exists collection_tasks_next_run_idx on public.collection_tasks(next_run);
create index if not exists collection_runs_user_id_idx on public.collection_runs(user_id);
create index if not exists collection_runs_task_id_idx on public.collection_runs(task_id);
create index if not exists collection_runs_status_idx on public.collection_runs(status);
create index if not exists collection_runs_started_at_idx on public.collection_runs(started_at desc);
create index if not exists automation_jobs_user_id_idx on public.automation_jobs(user_id);
create index if not exists automation_jobs_type_idx on public.automation_jobs(type);
create index if not exists automation_jobs_status_idx on public.automation_jobs(status);
create index if not exists automation_jobs_next_run_idx on public.automation_jobs(next_run);
create index if not exists automation_runs_user_id_idx on public.automation_runs(user_id);
create index if not exists automation_runs_job_id_idx on public.automation_runs(job_id);
create index if not exists automation_runs_status_idx on public.automation_runs(status);
create index if not exists automation_runs_started_at_idx on public.automation_runs(started_at desc);
create index if not exists platform_connections_user_id_idx on public.platform_connections(user_id);
create index if not exists platform_connections_platform_idx on public.platform_connections(platform);
create index if not exists platform_connections_status_idx on public.platform_connections(status);
create index if not exists platform_connections_account_id_idx on public.platform_connections(account_id);
create index if not exists platform_credentials_connection_id_idx on public.platform_credentials(connection_id);
create index if not exists platform_credentials_expires_at_idx on public.platform_credentials(expires_at);
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
create index if not exists campaign_links_user_id_idx on public.campaign_links(user_id);
create index if not exists campaign_links_content_id_idx on public.campaign_links(content_id);
create index if not exists campaign_links_platform_idx on public.campaign_links(platform);
create index if not exists campaign_links_utm_campaign_idx on public.campaign_links(utm_campaign);
create index if not exists publish_tasks_campaign_id_idx on public.publish_tasks(campaign_id);

alter table public.profiles enable row level security;
alter table public.social_accounts enable row level security;
alter table public.content_library enable row level security;
alter table public.assets enable row level security;
alter table public.characters enable row level security;
alter table public.prompts enable row level security;
alter table public.publish_tasks enable row level security;
alter table public.viral_analysis enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.agents enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.competitor_accounts enable row level security;
alter table public.viral_contents enable row level security;
alter table public.content_analysis enable row level security;
alter table public.content_sources enable row level security;
alter table public.collection_tasks enable row level security;
alter table public.collection_runs enable row level security;
alter table public.automation_jobs enable row level security;
alter table public.automation_runs enable row level security;
alter table public.platform_connections enable row level security;
alter table public.platform_credentials enable row level security;
alter table public.content_metrics enable row level security;
alter table public.publish_metrics enable row level security;
alter table public.content_strategies enable row level security;
alter table public.campaign_links enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_select_own'
  ) then
    create policy "profiles_select_own" on public.profiles
      for select to authenticated
      using ((select auth.uid()) = id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_insert_own'
  ) then
    create policy "profiles_insert_own" on public.profiles
      for insert to authenticated
      with check ((select auth.uid()) = id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname = 'profiles_update_own'
  ) then
    create policy "profiles_update_own" on public.profiles
      for update to authenticated
      using ((select auth.uid()) = id)
      with check ((select auth.uid()) = id);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'social_accounts'
      and policyname = 'social_accounts_select_own'
  ) then
    create policy "social_accounts_select_own" on public.social_accounts
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
      and tablename = 'social_accounts'
      and policyname = 'social_accounts_insert_own'
  ) then
    create policy "social_accounts_insert_own" on public.social_accounts
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
      and tablename = 'social_accounts'
      and policyname = 'social_accounts_update_own'
  ) then
    create policy "social_accounts_update_own" on public.social_accounts
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
      and tablename = 'social_accounts'
      and policyname = 'social_accounts_delete_own'
  ) then
    create policy "social_accounts_delete_own" on public.social_accounts
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
      and tablename = 'content_library'
      and policyname = 'content_library_select_own'
  ) then
    create policy "content_library_select_own" on public.content_library
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
      and tablename = 'content_library'
      and policyname = 'content_library_insert_own'
  ) then
    create policy "content_library_insert_own" on public.content_library
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
      and tablename = 'content_library'
      and policyname = 'content_library_update_own'
  ) then
    create policy "content_library_update_own" on public.content_library
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
      and tablename = 'content_library'
      and policyname = 'content_library_delete_own'
  ) then
    create policy "content_library_delete_own" on public.content_library
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
      and tablename = 'assets'
      and policyname = 'assets_select_own'
  ) then
    create policy "assets_select_own" on public.assets
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
      and tablename = 'assets'
      and policyname = 'assets_insert_own'
  ) then
    create policy "assets_insert_own" on public.assets
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
      and tablename = 'assets'
      and policyname = 'assets_update_own'
  ) then
    create policy "assets_update_own" on public.assets
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
      and tablename = 'assets'
      and policyname = 'assets_delete_own'
  ) then
    create policy "assets_delete_own" on public.assets
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
      and tablename = 'characters'
      and policyname = 'characters_select_own'
  ) then
    create policy "characters_select_own" on public.characters
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
      and tablename = 'characters'
      and policyname = 'characters_insert_own'
  ) then
    create policy "characters_insert_own" on public.characters
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
      and tablename = 'characters'
      and policyname = 'characters_update_own'
  ) then
    create policy "characters_update_own" on public.characters
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
      and tablename = 'characters'
      and policyname = 'characters_delete_own'
  ) then
    create policy "characters_delete_own" on public.characters
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
      and tablename = 'prompts'
      and policyname = 'prompts_select_own'
  ) then
    create policy "prompts_select_own" on public.prompts
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
      and tablename = 'prompts'
      and policyname = 'prompts_insert_own'
  ) then
    create policy "prompts_insert_own" on public.prompts
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
      and tablename = 'prompts'
      and policyname = 'prompts_update_own'
  ) then
    create policy "prompts_update_own" on public.prompts
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
      and tablename = 'prompts'
      and policyname = 'prompts_delete_own'
  ) then
    create policy "prompts_delete_own" on public.prompts
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
      and tablename = 'publish_tasks'
      and policyname = 'publish_tasks_select_own'
  ) then
    create policy "publish_tasks_select_own" on public.publish_tasks
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
      and tablename = 'publish_tasks'
      and policyname = 'publish_tasks_insert_own'
  ) then
    create policy "publish_tasks_insert_own" on public.publish_tasks
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
      and tablename = 'publish_tasks'
      and policyname = 'publish_tasks_update_own'
  ) then
    create policy "publish_tasks_update_own" on public.publish_tasks
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
      and tablename = 'publish_tasks'
      and policyname = 'publish_tasks_delete_own'
  ) then
    create policy "publish_tasks_delete_own" on public.publish_tasks
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
      and tablename = 'viral_analysis'
      and policyname = 'viral_analysis_select_own'
  ) then
    create policy "viral_analysis_select_own" on public.viral_analysis
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
      and tablename = 'viral_analysis'
      and policyname = 'viral_analysis_insert_own'
  ) then
    create policy "viral_analysis_insert_own" on public.viral_analysis
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
      and tablename = 'viral_analysis'
      and policyname = 'viral_analysis_update_own'
  ) then
    create policy "viral_analysis_update_own" on public.viral_analysis
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
      and tablename = 'viral_analysis'
      and policyname = 'viral_analysis_delete_own'
  ) then
    create policy "viral_analysis_delete_own" on public.viral_analysis
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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'competitor_accounts'
      and policyname = 'competitor_accounts_select_own'
  ) then
    create policy "competitor_accounts_select_own" on public.competitor_accounts
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
      and tablename = 'competitor_accounts'
      and policyname = 'competitor_accounts_insert_own'
  ) then
    create policy "competitor_accounts_insert_own" on public.competitor_accounts
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
      and tablename = 'competitor_accounts'
      and policyname = 'competitor_accounts_update_own'
  ) then
    create policy "competitor_accounts_update_own" on public.competitor_accounts
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
      and tablename = 'competitor_accounts'
      and policyname = 'competitor_accounts_delete_own'
  ) then
    create policy "competitor_accounts_delete_own" on public.competitor_accounts
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
      and tablename = 'viral_contents'
      and policyname = 'viral_contents_select_own'
  ) then
    create policy "viral_contents_select_own" on public.viral_contents
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
      and tablename = 'viral_contents'
      and policyname = 'viral_contents_insert_own'
  ) then
    create policy "viral_contents_insert_own" on public.viral_contents
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
      and tablename = 'viral_contents'
      and policyname = 'viral_contents_update_own'
  ) then
    create policy "viral_contents_update_own" on public.viral_contents
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
      and tablename = 'viral_contents'
      and policyname = 'viral_contents_delete_own'
  ) then
    create policy "viral_contents_delete_own" on public.viral_contents
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
      and tablename = 'content_analysis'
      and policyname = 'content_analysis_select_own'
  ) then
    create policy "content_analysis_select_own" on public.content_analysis
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
      and tablename = 'content_analysis'
      and policyname = 'content_analysis_insert_own'
  ) then
    create policy "content_analysis_insert_own" on public.content_analysis
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
      and tablename = 'content_analysis'
      and policyname = 'content_analysis_update_own'
  ) then
    create policy "content_analysis_update_own" on public.content_analysis
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
      and tablename = 'content_analysis'
      and policyname = 'content_analysis_delete_own'
  ) then
    create policy "content_analysis_delete_own" on public.content_analysis
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_select_own'
  ) then
    create policy "content_sources_select_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_insert_own'
  ) then
    create policy "content_sources_insert_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_update_own'
  ) then
    create policy "content_sources_update_own" on public.content_sources
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
      and tablename = 'content_sources'
      and policyname = 'content_sources_delete_own'
  ) then
    create policy "content_sources_delete_own" on public.content_sources
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_select_own'
  ) then
    create policy "collection_tasks_select_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_insert_own'
  ) then
    create policy "collection_tasks_insert_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_update_own'
  ) then
    create policy "collection_tasks_update_own" on public.collection_tasks
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
      and tablename = 'collection_tasks'
      and policyname = 'collection_tasks_delete_own'
  ) then
    create policy "collection_tasks_delete_own" on public.collection_tasks
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_select_own'
  ) then
    create policy "collection_runs_select_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_insert_own'
  ) then
    create policy "collection_runs_insert_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_update_own'
  ) then
    create policy "collection_runs_update_own" on public.collection_runs
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
      and tablename = 'collection_runs'
      and policyname = 'collection_runs_delete_own'
  ) then
    create policy "collection_runs_delete_own" on public.collection_runs
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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_select_own'
  ) then
    create policy "platform_connections_select_own" on public.platform_connections
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
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_insert_own'
  ) then
    create policy "platform_connections_insert_own" on public.platform_connections
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
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_update_own'
  ) then
    create policy "platform_connections_update_own" on public.platform_connections
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
      and tablename = 'platform_connections'
      and policyname = 'platform_connections_delete_own'
  ) then
    create policy "platform_connections_delete_own" on public.platform_connections
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

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'campaign_links'
      and policyname = 'campaign_links_select_own'
  ) then
    create policy "campaign_links_select_own" on public.campaign_links
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
      and tablename = 'campaign_links'
      and policyname = 'campaign_links_insert_own'
  ) then
    create policy "campaign_links_insert_own" on public.campaign_links
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
      and tablename = 'campaign_links'
      and policyname = 'campaign_links_update_own'
  ) then
    create policy "campaign_links_update_own" on public.campaign_links
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
      and tablename = 'campaign_links'
      and policyname = 'campaign_links_delete_own'
  ) then
    create policy "campaign_links_delete_own" on public.campaign_links
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

insert into storage.buckets (id, name, public)
values ('marketing-assets', 'marketing-assets', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'marketing_assets_select_own_folder'
  ) then
    create policy "marketing_assets_select_own_folder" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'marketing-assets'
        and (select auth.uid())::text = (storage.foldername(name))[1]
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'marketing_assets_insert_own_folder'
  ) then
    create policy "marketing_assets_insert_own_folder" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'marketing-assets'
        and (select auth.uid())::text = (storage.foldername(name))[1]
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'marketing_assets_update_own_folder'
  ) then
    create policy "marketing_assets_update_own_folder" on storage.objects
      for update to authenticated
      using (
        bucket_id = 'marketing-assets'
        and (select auth.uid())::text = (storage.foldername(name))[1]
      )
      with check (
        bucket_id = 'marketing-assets'
        and (select auth.uid())::text = (storage.foldername(name))[1]
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'marketing_assets_delete_own_folder'
  ) then
    create policy "marketing_assets_delete_own_folder" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'marketing-assets'
        and (select auth.uid())::text = (storage.foldername(name))[1]
      );
  end if;
end $$;

grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.social_accounts,
  public.content_library,
  public.assets,
  public.characters,
  public.prompts,
  public.publish_tasks,
  public.viral_analysis,
  public.workflow_runs,
  public.agents,
  public.agent_tasks,
  public.competitor_accounts,
  public.viral_contents,
  public.content_analysis,
  public.content_sources,
  public.collection_tasks,
  public.collection_runs,
  public.automation_jobs,
  public.automation_runs,
  public.platform_connections,
  public.content_metrics,
  public.publish_metrics,
  public.content_strategies,
  public.campaign_links
to authenticated;

revoke all on public.platform_credentials from anon;
revoke all on public.platform_credentials from authenticated;

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
    create policy "notifications_select_own" on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
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
    create policy "notifications_insert_own" on public.notifications for insert to authenticated with check ((select auth.uid()) = user_id);
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
    create policy "notifications_update_own" on public.notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
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
    create policy "notifications_delete_own" on public.notifications for delete to authenticated using ((select auth.uid()) = user_id);
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
    create policy "cost_records_select_own" on public.cost_records for select to authenticated using ((select auth.uid()) = user_id);
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
    create policy "cost_records_insert_own" on public.cost_records for insert to authenticated with check ((select auth.uid()) = user_id);
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
    create policy "cost_records_update_own" on public.cost_records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
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
    create policy "cost_records_delete_own" on public.cost_records for delete to authenticated using ((select auth.uid()) = user_id);
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
    create policy "audit_logs_select_own" on public.audit_logs for select to authenticated using ((select auth.uid()) = user_id);
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
    create policy "audit_logs_insert_own" on public.audit_logs for insert to authenticated with check ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.notifications, public.cost_records to authenticated;
grant select, insert on public.audit_logs to authenticated;
