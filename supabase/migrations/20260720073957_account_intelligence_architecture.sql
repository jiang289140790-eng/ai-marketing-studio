alter table public.social_accounts
  add column if not exists username text,
  add column if not exists account_role text not null default 'brand';

update public.social_accounts
set username = coalesce(nullif(username, ''), account_name)
where username is null or username = '';

update public.social_accounts
set account_role = coalesce(nullif(account_role, ''), account_type, account_category, 'brand')
where account_role is null or account_role = '';

alter table public.social_accounts
  drop constraint if exists social_accounts_account_role_check;

alter table public.social_accounts
  add constraint social_accounts_account_role_check
    check (account_role in ('brand', 'personal', 'competitor', 'inspiration'));

create index if not exists social_accounts_username_idx on public.social_accounts(username);
create index if not exists social_accounts_account_role_idx on public.social_accounts(account_role);

create table if not exists public.account_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.social_accounts(id) on delete cascade,
  target_audience text,
  content_direction text,
  content_style text,
  posting_frequency text,
  brand_positioning text,
  ai_strategy text,
  analysis_summary text,
  analysis_result jsonb not null default '{}',
  source_content_ids uuid[] not null default '{}',
  model text,
  confidence_score numeric(5, 2) not null default 0,
  last_analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, account_id)
);

create index if not exists account_profiles_user_id_idx on public.account_profiles(user_id);
create index if not exists account_profiles_account_id_idx on public.account_profiles(account_id);
create index if not exists account_profiles_last_analyzed_at_idx on public.account_profiles(last_analyzed_at desc);

alter table public.content_sources
  add column if not exists social_account_id uuid references public.social_accounts(id) on delete cascade;

create index if not exists content_sources_social_account_id_idx on public.content_sources(social_account_id);

alter table public.viral_contents
  add column if not exists social_account_id uuid references public.social_accounts(id) on delete set null;

create index if not exists viral_contents_social_account_id_idx on public.viral_contents(social_account_id);

alter table public.content_analysis
  add column if not exists social_account_id uuid references public.social_accounts(id) on delete set null;

create index if not exists content_analysis_social_account_id_idx on public.content_analysis(social_account_id);

alter table public.account_profiles enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'account_profiles'
      and policyname = 'account_profiles_select_own'
  ) then
    create policy "account_profiles_select_own" on public.account_profiles
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
      and tablename = 'account_profiles'
      and policyname = 'account_profiles_insert_own'
  ) then
    create policy "account_profiles_insert_own" on public.account_profiles
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
      and tablename = 'account_profiles'
      and policyname = 'account_profiles_update_own'
  ) then
    create policy "account_profiles_update_own" on public.account_profiles
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
      and tablename = 'account_profiles'
      and policyname = 'account_profiles_delete_own'
  ) then
    create policy "account_profiles_delete_own" on public.account_profiles
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.account_profiles to authenticated;

comment on table public.account_profiles is 'AI-generated operating profile for a social account. social_accounts remains the single account entity.';
comment on column public.content_sources.social_account_id is 'Collector source must point to social_accounts instead of creating a separate account entity.';
comment on column public.viral_contents.social_account_id is 'Content intelligence account relationship using social_accounts as the source of truth.';
comment on column public.content_analysis.social_account_id is 'Analysis result account relationship using social_accounts as the source of truth.';
