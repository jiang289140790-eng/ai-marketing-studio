alter table public.social_accounts
  add column if not exists account_category text not null default 'brand';

alter table public.content_library
  add column if not exists account_category text not null default 'brand';

alter table public.social_accounts
  drop constraint if exists social_accounts_platform_check,
  drop constraint if exists social_accounts_account_category_check;

alter table public.social_accounts
  add constraint social_accounts_platform_check
    check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  add constraint social_accounts_account_category_check
    check (account_category in ('brand', 'personal', 'competitor', 'inspiration'));

alter table public.content_library
  drop constraint if exists content_library_platform_check,
  drop constraint if exists content_library_status_check,
  drop constraint if exists content_library_account_category_check;

alter table public.content_library
  add constraint content_library_platform_check
    check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram')),
  add constraint content_library_status_check
    check (status in ('draft', 'review', 'scheduled', 'published', 'failed')),
  add constraint content_library_account_category_check
    check (account_category in ('brand', 'personal', 'competitor', 'inspiration'));

alter table public.publish_tasks
  drop constraint if exists publish_tasks_platform_check;

alter table public.publish_tasks
  add constraint publish_tasks_platform_check
    check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram'));

alter table public.viral_analysis
  drop constraint if exists viral_analysis_platform_check;

alter table public.viral_analysis
  add constraint viral_analysis_platform_check
    check (platform in ('X', 'Instagram', 'TikTok', 'YouTube', 'Telegram'));
