alter table if exists public.comfy_workflows
  add column if not exists category text not null default 'character_generation',
  add column if not exists priority integer not null default 100,
  add column if not exists detected_nodes jsonb not null default '{}'::jsonb,
  add column if not exists detected_models jsonb not null default '{}'::jsonb,
  add column if not exists controlnets jsonb not null default '[]'::jsonb,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists last_synced_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'comfy_workflows_category_check'
      and conrelid = 'public.comfy_workflows'::regclass
  ) then
    alter table public.comfy_workflows
      add constraint comfy_workflows_category_check
      check (category in (
        'character_generation',
        'motion_transfer',
        'face_swap',
        'clothing_transfer',
        'video_generation'
      ));
  end if;
end $$;

create index if not exists idx_comfy_workflows_category
  on public.comfy_workflows(category);

create index if not exists idx_comfy_workflows_priority
  on public.comfy_workflows(priority);

create index if not exists idx_comfy_workflows_tags
  on public.comfy_workflows using gin(tags);
