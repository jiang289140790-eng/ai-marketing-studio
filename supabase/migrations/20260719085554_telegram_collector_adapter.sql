alter table public.content_sources
  drop constraint if exists content_sources_source_type_check;

alter table public.content_sources
  add constraint content_sources_source_type_check
  check (source_type in ('competitor_account', 'channel', 'keyword', 'hashtag', 'rss', 'manual', 'telegram'));

alter table public.content_sources
  add column if not exists channel text,
  add column if not exists username text,
  add column if not exists last_message_id text,
  add column if not exists sync_time timestamptz;

alter table public.collection_runs
  add column if not exists duration_ms integer not null default 0;

create index if not exists content_sources_channel_idx on public.content_sources(channel);
create index if not exists content_sources_username_idx on public.content_sources(username);
