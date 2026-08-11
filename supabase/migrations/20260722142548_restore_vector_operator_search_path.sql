-- The vector extension currently lives in public, so the fixed function path
-- must include public for the <=> operator while remaining deterministic.
do $migration$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='match_knowledge_entries'
  ) then
    execute 'alter function public.match_knowledge_entries(vector, integer, text) set search_path = pg_catalog, public';
  end if;
end
$migration$;
