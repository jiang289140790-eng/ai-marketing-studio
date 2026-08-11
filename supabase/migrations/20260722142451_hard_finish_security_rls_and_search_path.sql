alter table public.platform_credentials enable row level security;

create policy service_role_full_access_platform_credentials
  on public.platform_credentials
  for all
  to service_role
  using (true)
  with check (true);

alter function public.set_knowledge_entries_updated_at()
  set search_path = '';

alter function public.match_knowledge_entries(vector, integer, text)
  set search_path = '';

alter function public.set_strategy_plans_updated_at()
  set search_path = '';

alter function public.set_asset_library_updated_at()
  set search_path = '';

alter function public.set_distribution_updated_at()
  set search_path = '';
