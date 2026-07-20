alter table public.content_analysis
  add column if not exists content_id uuid references public.viral_contents(id) on delete cascade,
  add column if not exists analysis_result jsonb not null default '{}',
  add column if not exists recommendation text,
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists usage jsonb not null default '{}',
  add column if not exists cost numeric(12, 6) not null default 0,
  add column if not exists duration_ms integer not null default 0;

update public.content_analysis
set content_id = viral_content_id
where content_id is null and viral_content_id is not null;

create index if not exists content_analysis_content_id_idx on public.content_analysis(content_id);
create index if not exists content_analysis_provider_idx on public.content_analysis(provider);
create index if not exists content_analysis_model_idx on public.content_analysis(model);
