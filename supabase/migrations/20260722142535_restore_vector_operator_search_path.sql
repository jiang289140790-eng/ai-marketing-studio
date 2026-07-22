-- The vector extension currently lives in public, so the fixed function path
-- must include public for the <=> operator while remaining deterministic.
alter function public.match_knowledge_entries(vector, integer, text)
  set search_path = pg_catalog, public;
