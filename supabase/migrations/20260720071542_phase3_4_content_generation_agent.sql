alter table public.content_library
  add column if not exists model text,
  add column if not exists cost numeric(12, 6) not null default 0,
  add column if not exists duration_ms integer not null default 0,
  add column if not exists hashtags text[] not null default '{}',
  add column if not exists cta text;

create index if not exists content_library_model_idx on public.content_library(model);
create index if not exists content_library_prompt_id_idx on public.content_library(prompt_id);
