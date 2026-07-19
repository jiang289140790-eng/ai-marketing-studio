alter table public.assets
  add column if not exists name text,
  add column if not exists thumbnail text,
  add column if not exists model text,
  add column if not exists workflow jsonb,
  add column if not exists tags text[] not null default '{}';

update public.assets
set name = coalesce(name, prompt, type || ' asset')
where name is null;

alter table public.assets
  alter column name set not null;

alter table public.assets
  drop constraint if exists assets_type_check,
  drop constraint if exists assets_source_check;

alter table public.assets
  add constraint assets_type_check
    check (type in ('image', 'video', 'audio', 'prompt', 'workflow', 'lora')),
  add constraint assets_source_check
    check (source in ('manual', 'upload', 'gpt', 'claude', 'qwen', 'comfyui', 'civitai', 'n8n', 'workflow-runtime'));

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

alter table public.content_library
  add column if not exists asset_id uuid references public.assets(id) on delete set null,
  add column if not exists character_id uuid references public.characters(id) on delete set null,
  add column if not exists prompt_id uuid references public.prompts(id) on delete set null;

create index if not exists assets_type_idx on public.assets(type);
create index if not exists assets_tags_idx on public.assets using gin(tags);
create index if not exists characters_user_id_idx on public.characters(user_id);
create index if not exists characters_tags_idx on public.characters using gin(tags);
create index if not exists prompts_user_id_idx on public.prompts(user_id);
create index if not exists prompts_category_idx on public.prompts(category);
create index if not exists content_library_asset_id_idx on public.content_library(asset_id);
create index if not exists content_library_character_id_idx on public.content_library(character_id);
create index if not exists content_library_prompt_id_idx on public.content_library(prompt_id);

alter table public.characters enable row level security;
alter table public.prompts enable row level security;

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

grant select, insert, update, delete on
  public.characters,
  public.prompts
to authenticated;
