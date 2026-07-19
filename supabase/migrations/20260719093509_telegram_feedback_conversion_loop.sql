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

alter table public.publish_tasks
  add column if not exists campaign_id uuid references public.campaign_links(id) on delete set null;

create index if not exists campaign_links_user_id_idx on public.campaign_links(user_id);
create index if not exists campaign_links_content_id_idx on public.campaign_links(content_id);
create index if not exists campaign_links_platform_idx on public.campaign_links(platform);
create index if not exists campaign_links_utm_campaign_idx on public.campaign_links(utm_campaign);
create index if not exists publish_tasks_campaign_id_idx on public.publish_tasks(campaign_id);

alter table public.campaign_links enable row level security;

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

grant select, insert, update, delete on public.campaign_links to authenticated;
