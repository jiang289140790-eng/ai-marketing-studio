alter table public.social_accounts
  drop constraint if exists social_accounts_platform_check;

alter table public.social_accounts
  add constraint social_accounts_platform_check
  check (
    platform = any (
      array['X', 'Instagram', 'TikTok', 'YouTube', 'Telegram', 'Discord']::text[]
    )
  );

create policy authenticated_read_account_intelligence_reports
  on public.account_intelligence_reports
  for select
  to authenticated
  using (true);

create policy authenticated_read_insights
  on public.insights
  for select
  to authenticated
  using (true);
