alter table public.platform_credentials enable row level security;

create policy service_role_full_access_platform_credentials
  on public.platform_credentials
  for all
  to service_role
  using (true)
  with check (true);

do $migration$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='set_knowledge_entries_updated_at'
  ) then
    execute 'alter function public.set_knowledge_entries_updated_at() set search_path = ' || quote_literal('');
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='match_knowledge_entries'
  ) then
    execute 'alter function public.match_knowledge_entries(vector, integer, text) set search_path = ' || quote_literal('');
  end if;
end
$migration$;

do $migration$
begin
  if to_regprocedure('public.set_strategy_plans_updated_at()') is not null then
    execute 'alter function public.set_strategy_plans_updated_at() set search_path = ' || quote_literal('');
  end if;
  if to_regprocedure('public.set_asset_library_updated_at()') is not null then
    execute 'alter function public.set_asset_library_updated_at() set search_path = ' || quote_literal('');
  end if;
  if to_regprocedure('public.set_distribution_updated_at()') is not null then
    execute 'alter function public.set_distribution_updated_at() set search_path = ' || quote_literal('');
  end if;
end
$migration$;
