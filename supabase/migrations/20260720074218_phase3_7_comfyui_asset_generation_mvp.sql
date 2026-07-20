create table if not exists public.comfy_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_id uuid references public.assets(id) on delete set null,
  name text not null,
  description text,
  mode text not null default 'image' check (mode in ('image', 'video', 'workflow')),
  version text not null default '1.0.0',
  status text not null default 'active' check (status in ('active', 'archived', 'draft')),
  workflow_json jsonb not null default '{}',
  input_schema jsonb not null default '{}',
  output_schema jsonb not null default '{}',
  model text,
  checkpoint text,
  loras jsonb not null default '[]',
  default_params jsonb not null default '{}',
  node_mappings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comfy_workflows_user_id_idx on public.comfy_workflows(user_id);
create index if not exists comfy_workflows_asset_id_idx on public.comfy_workflows(asset_id);
create index if not exists comfy_workflows_mode_idx on public.comfy_workflows(mode);
create index if not exists comfy_workflows_status_idx on public.comfy_workflows(status);
create index if not exists comfy_workflows_loras_idx on public.comfy_workflows using gin(loras);

alter table public.comfy_workflows enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'comfy_workflows' and policyname = 'comfy_workflows_select_own') then
    create policy "comfy_workflows_select_own" on public.comfy_workflows
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'comfy_workflows' and policyname = 'comfy_workflows_insert_own') then
    create policy "comfy_workflows_insert_own" on public.comfy_workflows
      for insert to authenticated
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'comfy_workflows' and policyname = 'comfy_workflows_update_own') then
    create policy "comfy_workflows_update_own" on public.comfy_workflows
      for update to authenticated
      using ((select auth.uid()) = user_id)
      with check ((select auth.uid()) = user_id);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'comfy_workflows' and policyname = 'comfy_workflows_delete_own') then
    create policy "comfy_workflows_delete_own" on public.comfy_workflows
      for delete to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.comfy_workflows to authenticated;
