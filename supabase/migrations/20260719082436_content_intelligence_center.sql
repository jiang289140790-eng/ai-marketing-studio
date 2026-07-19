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

alter table public.competitor_accounts enable row level security;
alter table public.viral_contents enable row level security;
alter table public.content_analysis enable row level security;

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

grant select, insert, update, delete on
  public.competitor_accounts,
  public.viral_contents,
  public.content_analysis
to authenticated;
