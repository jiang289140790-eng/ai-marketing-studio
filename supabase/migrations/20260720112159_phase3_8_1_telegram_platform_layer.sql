-- Phase 3.8.1: Telegram Platform Connection Layer.
-- Personal AI Ops Workspace only: no billing, subscriptions, workspaces, or SaaS tenant changes.

alter table public.platform_connections
  add column if not exists auth_type text not null default 'manual',
  add column if not exists permissions jsonb not null default '[]',
  add column if not exists expires_at timestamptz,
  add column if not exists error_message text,
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists disconnected_at timestamptz,
  add column if not exists last_used_at timestamptz;

alter table public.platform_credentials
  add column if not exists oauth_secret text,
  add column if not exists token_type text,
  add column if not exists scopes jsonb not null default '[]',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists updated_at timestamptz not null default now();

create index if not exists platform_connections_auth_type_idx on public.platform_connections(auth_type);
create index if not exists platform_connections_last_used_at_idx on public.platform_connections(last_used_at desc);
create index if not exists platform_connections_metadata_gin_idx on public.platform_connections using gin (metadata);
create index if not exists platform_credentials_metadata_gin_idx on public.platform_credentials using gin (metadata);

revoke all on public.platform_credentials from anon;
revoke all on public.platform_credentials from authenticated;

grant select, insert, update, delete on public.platform_connections to authenticated;
