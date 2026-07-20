-- Phase 3.10: AI operation loop foundation.
-- Personal AI Ops Workspace only: no billing, subscriptions, memberships, workspaces, or SaaS tenant changes.

alter table public.social_accounts
  drop constraint if exists social_accounts_account_role_check;

alter table public.social_accounts
  drop constraint if exists social_accounts_account_type_check;

alter table public.social_accounts
  drop constraint if exists social_accounts_account_category_check;

update public.social_accounts
set
  account_role = case when account_role in ('brand', 'personal') then 'owned' else coalesce(nullif(account_role, ''), 'owned') end,
  account_type = case when account_type in ('brand', 'personal') then 'owned' else coalesce(nullif(account_type, ''), 'owned') end,
  account_category = case when account_category in ('brand', 'personal') then 'owned' else coalesce(nullif(account_category, ''), 'owned') end
where
  account_role in ('brand', 'personal')
  or account_type in ('brand', 'personal')
  or account_category in ('brand', 'personal')
  or account_role is null
  or account_type is null
  or account_category is null;

alter table public.social_accounts
  add constraint social_accounts_account_role_check
    check (account_role in ('owned', 'brand', 'personal', 'competitor', 'inspiration'));

alter table public.social_accounts
  add constraint social_accounts_account_type_check
    check (account_type in ('owned', 'brand', 'personal', 'competitor', 'inspiration'));

alter table public.social_accounts
  add constraint social_accounts_account_category_check
    check (account_category in ('owned', 'brand', 'personal', 'competitor', 'inspiration'));

alter table public.agents
  drop constraint if exists agents_type_check;

alter table public.agents
  add constraint agents_type_check
    check (type in ('content_generator', 'asset_generator', 'analysis', 'strategy'));

alter table public.account_profiles
  add column if not exists cost numeric(12, 6) not null default 0,
  add column if not exists duration_ms integer not null default 0,
  add column if not exists visual_style text,
  add column if not exists copywriting_style text,
  add column if not exists best_posting_windows jsonb not null default '[]',
  add column if not exists viral_patterns jsonb not null default '[]',
  add column if not exists operation_advice text;

alter table public.content_strategies
  add column if not exists strategy_type text not null default 'optimization',
  add column if not exists account_id uuid references public.social_accounts(id) on delete set null,
  add column if not exists strategy_date date not null default current_date,
  add column if not exists daily_strategy jsonb not null default '{}';

alter table public.collection_tasks
  add column if not exists account_id uuid references public.social_accounts(id) on delete set null;

create index if not exists account_profiles_updated_at_idx on public.account_profiles(updated_at desc);
create index if not exists content_strategies_strategy_type_idx on public.content_strategies(strategy_type);
create index if not exists content_strategies_account_id_idx on public.content_strategies(account_id);
create index if not exists content_strategies_strategy_date_idx on public.content_strategies(strategy_date desc);
create index if not exists collection_tasks_account_id_idx on public.collection_tasks(account_id);

comment on column public.social_accounts.account_role is 'Personal AI Ops account role. New canonical values: owned, competitor, inspiration. Legacy brand/personal values remain accepted for compatibility.';
comment on column public.account_profiles.cost is 'AI cost for the latest account intelligence run.';
comment on column public.content_strategies.daily_strategy is 'Strategy Agent output for daily operating plan.';
comment on column public.collection_tasks.account_id is 'Direct social_accounts relationship for collector tasks. Kept in sync from content_sources.social_account_id when tasks are created.';
