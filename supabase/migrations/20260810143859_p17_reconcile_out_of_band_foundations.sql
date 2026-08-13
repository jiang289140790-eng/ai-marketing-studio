-- P17-A4: reconcile five production objects created outside migration history.
-- Existing objects are fingerprinted before any reconciliation.  Drift aborts
-- the transaction; only wholly absent objects are constructed below.
--
-- Function drift is checked with a deterministic, cross-environment semantic
-- contract (not a raw fingerprint): the raw fingerprint hashed owner / ACL
-- grantor / pg_get_functiondef formatting, which differ between PostgreSQL 17
-- environments even for identical semantics (fresh replay bb7fa324… vs staging
-- d06d8f82…).  The contract below compares catalog attributes that are stable
-- across environments plus a normalized body text, and fails closed on any
-- attribute that is not explicitly compared (see p17_contract_matches).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema public;
create extension if not exists vector with schema public;

create or replace function pg_temp.p17_table_fingerprint(target regclass)
returns text
language sql
set search_path = pg_catalog, public, extensions
as $function$
  select encode(extensions.digest(jsonb_build_object(
    'table',jsonb_build_object(
      'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
      'persistence',c.relpersistence,'rls',c.relrowsecurity,
      'force_rls',c.relforcerowsecurity,'replica_identity',c.relreplident,
      'comment',obj_description(c.oid)
    ),
    'columns',coalesce((
      select jsonb_agg(to_jsonb(x) order by ordinal_position) from (
        select a.attnum ordinal_position,a.attname column_name,
          format_type(a.atttypid,a.atttypmod) type_name,
          not a.attnotnull nullable,pg_get_expr(d.adbin,d.adrelid) default_expr,
          a.attidentity::text identity_kind,a.attgenerated::text generated_kind,
          col_description(a.attrelid,a.attnum) comment
        from pg_attribute a
        left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
      ) x
    ),'[]'::jsonb),
    'constraints',coalesce((
      select jsonb_agg(to_jsonb(x) order by constraint_name) from (
        select con.conname constraint_name,con.contype::text constraint_type,
          con.convalidated,con.condeferrable,con.condeferred,
          pg_get_constraintdef(con.oid,true) definition
        from pg_constraint con where con.conrelid=c.oid
      ) x
    ),'[]'::jsonb),
    'indexes',coalesce((
      select jsonb_agg(to_jsonb(x) order by index_name) from (
        select i.relname index_name,ix.indisunique,ix.indisprimary,
          ix.indisvalid,ix.indisready,pg_get_indexdef(i.oid) definition
        from pg_index ix join pg_class i on i.oid=ix.indexrelid
        where ix.indrelid=c.oid
      ) x
    ),'[]'::jsonb),
    'triggers',coalesce((
      select jsonb_agg(to_jsonb(x) order by trigger_name) from (
        select t.tgname trigger_name,t.tgenabled::text enabled,
          pg_get_triggerdef(t.oid,true) definition
        from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal
      ) x
    ),'[]'::jsonb),
    'policies',coalesce((
      select jsonb_agg(to_jsonb(x) order by policyname) from (
        select p.policyname,p.permissive,p.roles::text roles,p.cmd,p.qual,p.with_check
        from pg_policies p where p.schemaname='public' and p.tablename=c.relname
      ) x
    ),'[]'::jsonb),
    'acl',coalesce((
      select jsonb_agg(to_jsonb(x) order by grantee,privilege_type) from (
        select coalesce(grantee.rolname,'PUBLIC') grantee,grantor.rolname grantor,
          a.privilege_type,a.is_grantable
        from aclexplode(c.relacl) a
        left join pg_roles grantee on grantee.oid=a.grantee
        join pg_roles grantor on grantor.oid=a.grantor
      ) x
    ),'[]'::jsonb)
  )::text,'sha256'),'hex')
  from pg_class c where c.oid=target;
$function$;

-- Deterministic semantic normalization helpers (stable across PostgreSQL 17
-- environments; any drift in the compared attributes fails the migration).

-- search_path: order-preserving canonical form; '' for an explicit-empty
-- setting.  PostgreSQL 17 stores the explicit-empty search_path (written
-- `set search_path to ''`) in proconfig as `search_path=""` — a quoted-empty
-- element.  `""` and bare-empty are the same explicit-empty contract, so the
-- quoted-empty element is dropped like a bare-empty one.  A missing
-- search_path, `public`, or any other real path element is never normalized
-- to empty (fail-closed).
create or replace function pg_temp.p17_normalize_search_path(setting text)
returns text
language sql
immutable
as $function$
  select coalesce((select string_agg(trim(x), ',' order by ord)
    from unnest(string_to_array(coalesce(setting, ''), ',')) with ordinality as t(x, ord)
    where trim(x) <> '' and trim(x) <> '""'), '');
$function$;

-- Body text: tokenized normalization.  Unquoted words (keywords / unquoted
-- identifiers) are lowercased; comments (line, nested block) and whitespace
-- runs collapse to a single space; string literals ('...' with '' escape,
-- E'...' backslash escapes, $tag$...$tag$ dollar quotes), quoted identifiers
-- ("..." with "" escape) and operators are preserved verbatim.  Formatting
-- differences (comment placement, keyword case, spacing, dollar-quote tags)
-- therefore compare equal, while semantic differences inside literals
-- ('A' vs 'a', `--`/`/* */` inside a string, "Col" vs "col", dollar-quoted
-- content) are never flattened (fail-closed).
create or replace function pg_temp.p17_normalize_body(body text)
returns text
language plpgsql
immutable
as $function$
declare
  b text := coalesce(body, '');
  n int := length(b);
  i int := 1;
  j int;
  k int;
  depth int;
  tag text;
  out text := '';
begin
  while i <= n loop
    -- whitespace run -> single space
    if substr(b, i, 1) ~ '[[:space:]]' then
      while i <= n and substr(b, i, 1) ~ '[[:space:]]' loop
        i := i + 1;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- line comment -> single space
    if substr(b, i, 1) = '-' and substr(b, i + 1, 1) = '-' then
      while i <= n and substr(b, i, 1) <> chr(10) loop
        i := i + 1;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- block comment (nested) -> single space
    if substr(b, i, 1) = '/' and substr(b, i + 1, 1) = '*' then
      depth := 0;
      while i <= n loop
        if substr(b, i, 1) = '/' and substr(b, i + 1, 1) = '*' then
          depth := depth + 1;
          i := i + 2;
        elsif substr(b, i, 1) = '*' and substr(b, i + 1, 1) = '/' then
          depth := depth - 1;
          i := i + 2;
          exit when depth = 0;
        else
          i := i + 1;
        end if;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- dollar-quoted string: $tag$ ... $tag$ (tag optional) -> verbatim
    if substr(b, i, 1) = '$' then
      j := i + 1;
      while j <= n and substr(b, j, 1) ~ '[A-Za-z0-9_]' loop
        j := j + 1;
      end loop;
      if j <= n and substr(b, j, 1) = '$' then
        tag := substr(b, i, j - i + 1);
        k := j + 1;
        while k <= n - length(tag) + 1 and substr(b, k, length(tag)) <> tag loop
          k := k + 1;
        end loop;
        if k <= n - length(tag) + 1 then
          out := out || substr(b, i, k + length(tag) - i);
          i := k + length(tag);
          continue;
        end if;
      end if;
      -- not a dollar-quote opener: fall through, the '$' stays verbatim
    end if;
    -- single-quoted string: '...' with '' escape (backslash escape in E'...')
    if substr(b, i, 1) = '''' then
      j := i + 1;
      while j <= n loop
        if substr(b, j, 1) = '\' then
          j := j + 2;
        elsif substr(b, j, 1) = '''' then
          if substr(b, j + 1, 1) = '''' then
            j := j + 2;
          else
            exit;
          end if;
        else
          j := j + 1;
        end if;
      end loop;
      if j <= n then
        out := out || substr(b, i, j - i + 1);
        i := j + 1;
        continue;
      end if;
      -- unterminated string: keep the quote verbatim and rescan
    end if;
    -- double-quoted identifier: "..." with "" escape -> verbatim
    if substr(b, i, 1) = '"' then
      j := i + 1;
      while j <= n loop
        if substr(b, j, 1) = '"' then
          if substr(b, j + 1, 1) = '"' then
            j := j + 2;
          else
            exit;
          end if;
        else
          j := j + 1;
        end if;
      end loop;
      if j <= n then
        out := out || substr(b, i, j - i + 1);
        i := j + 1;
        continue;
      end if;
    end if;
    -- unquoted word (keyword / unquoted identifier) -> lowercase
    if substr(b, i, 1) ~ '[A-Za-z_]' then
      j := i + 1;
      while j <= n and substr(b, j, 1) ~ '[A-Za-z0-9_$]' loop
        j := j + 1;
      end loop;
      out := out || lower(substr(b, i, j - i));
      i := j;
      continue;
    end if;
    -- anything else (operators, digits, punctuation): verbatim
    out := out || substr(b, i, 1);
    i := i + 1;
  end loop;
  return btrim(out);
end
$function$;

-- Canonical body texts of the two reconciled functions.  These must stay in
-- sync with the CREATE FUNCTION bodies in the $functions$ block below: the
-- $verify$ block compares each live function body against them, so a future
-- edit that changes only one of the two copies fails the migration instead of
-- silently passing (fail-closed by construction).
create or replace function pg_temp.p17_expected_set_updated_at_body()
returns text
language sql
immutable
as $function$
  select 'begin
  new.updated_at = now();
  return new;
end;';
$function$;

create or replace function pg_temp.p17_expected_match_knowledge_entries_body()
returns text
language sql
immutable
as $function$
  select '  select
    knowledge_entries.id,
    knowledge_entries.type,
    knowledge_entries.title,
    knowledge_entries.content,
    knowledge_entries.metadata,
    1 - (knowledge_entries.embedding <=> query_embedding) as similarity
  from public.knowledge_entries
  where knowledge_entries.embedding is not null
    and (filter_type is null or knowledge_entries.type = filter_type)
  order by knowledge_entries.embedding <=> query_embedding
  limit match_count;';
$function$;

-- Semantic function contract comparison.  Returns an empty array when the
-- function matches the contract, otherwise the list of mismatch descriptions.
--
-- Compared (must match exactly): identity signature, result type, language,
-- security definer, leakproof, volatility, parallel safety, an explicitly set
-- search_path (normalized), normalized body text, and — when p_execute_roles
-- is non-empty — EXECUTE for every listed role plus PUBLIC (owner/grantor
-- names are environment noise and are deliberately not compared).
--
-- Fail-closed properties:
--   - missing function                -> mismatch
--   - no explicit search_path         -> mismatch (caller-inherited search
--     path is not the same contract as search_path='')
--   - any GUC setting other than
--     search_path in proconfig        -> mismatch
--   - EXECUTE revoked from a listed
--     role or from PUBLIC             -> mismatch
create or replace function pg_temp.p17_contract_matches(
  target regprocedure,
  p_identity text,
  p_result text,
  p_language text,
  p_security_definer boolean,
  p_leakproof boolean,
  p_volatility text,
  p_parallel text,
  p_search_path text,
  p_body text,
  p_execute_roles text[]
) returns text[]
language plpgsql
set search_path = pg_catalog, public, extensions
as $function$
declare
  p pg_proc;
  l pg_language;
  mismatches text[] := '{}'::text[];
  setting text;
  setting_name text;
  found_search_path boolean := false;
  actual_search_path text := null;
  role_name text;
begin
  if target is null then
    return array['function missing'];
  end if;
  select * into p from pg_proc where oid = target;
  if not found then
    return array['function missing'];
  end if;
  select * into l from pg_language where oid = p.prolang;
  if pg_get_function_identity_arguments(p.oid) is distinct from p_identity then
    mismatches := mismatches || format('signature: got [%s] want [%s]', pg_get_function_identity_arguments(p.oid), p_identity);
  end if;
  if pg_get_function_result(p.oid) is distinct from p_result then
    mismatches := mismatches || format('result: got [%s] want [%s]', pg_get_function_result(p.oid), p_result);
  end if;
  if l.lanname is distinct from p_language then
    mismatches := mismatches || format('language: got [%s] want [%s]', l.lanname, p_language);
  end if;
  if p.prosecdef is distinct from p_security_definer then
    mismatches := mismatches || format('security_definer: got [%s] want [%s]', p.prosecdef, p_security_definer);
  end if;
  if p.proleakproof is distinct from p_leakproof then
    mismatches := mismatches || format('leakproof: got [%s] want [%s]', p.proleakproof, p_leakproof);
  end if;
  if p.provolatile::text is distinct from p_volatility then
    mismatches := mismatches || format('volatility: got [%s] want [%s]', p.provolatile::text, p_volatility);
  end if;
  if p.proparallel::text is distinct from p_parallel then
    mismatches := mismatches || format('parallel: got [%s] want [%s]', p.proparallel::text, p_parallel);
  end if;
  foreach setting in array coalesce(p.proconfig, '{}'::text[]) loop
    setting_name := split_part(setting, '=', 1);
    if setting_name = 'search_path' then
      found_search_path := true;
      actual_search_path := substring(setting from length('search_path=') + 1);
    else
      mismatches := mismatches || format('unexpected setting [%s]', setting_name);
    end if;
  end loop;
  if not found_search_path then
    mismatches := mismatches || format('search_path: not explicitly set, want [%s]', p_search_path);
  elsif pg_temp.p17_normalize_search_path(actual_search_path)
        is distinct from pg_temp.p17_normalize_search_path(p_search_path) then
    mismatches := mismatches || format('search_path: got [%s] want [%s]',
      pg_temp.p17_normalize_search_path(actual_search_path), pg_temp.p17_normalize_search_path(p_search_path));
  end if;
  if pg_temp.p17_normalize_body(p.prosrc) is distinct from p_body then
    mismatches := mismatches || format('body: got [%s] want [%s]', pg_temp.p17_normalize_body(p.prosrc), p_body);
  end if;
  foreach role_name in array coalesce(p_execute_roles, '{}'::text[]) loop
    if role_name <> 'public' and not has_function_privilege(role_name, p.oid, 'EXECUTE') then
      mismatches := mismatches || format('permission: role [%s] cannot execute', role_name);
    end if;
  end loop;
  if 'public' = any(coalesce(p_execute_roles, '{}'::text[]))
     and not exists (
       select 1 from pg_proc q where q.oid = p.oid and (
         q.proacl is null or exists (select 1 from aclexplode(q.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
       )
     ) then
    mismatches := mismatches || 'permission: PUBLIC cannot execute';
  end if;
  return mismatches;
end
$function$;

do $preflight$
declare
  item record;
  actual text;
  mismatches text[];
begin
  for item in select * from (values
    ('account_intelligence_reports','ba61d41a5dcf21e9c9b594baa22c2074dee8f982e34be1e93453e8cbcf9a4647'),
    ('content_memory','9521099ca4b4bb80feab1ec18bb2718756b0940cc5d41d321d77705f36539393'),
    ('insights','3fbda47d2c6c5e929eb3e33de358f8395a6a41a12538068049a93972d7422291'),
    ('knowledge_entries','a7c752396100e522e40568e536be5586e07562dccb19b24b97825935c2e8f888'),
    ('strategy_memory','7c7308e9243507e0bb01bc3dcb9898e6826c76e27d3081eac83bb7761ee8fbf8')
  ) expected(object_name,fingerprint)
  loop
    if to_regclass('public.'||item.object_name) is not null then
      actual:=pg_temp.p17_table_fingerprint(to_regclass('public.'||item.object_name));
      if actual<>item.fingerprint then
        raise exception using errcode='P0001',message='P17_A4_EXISTING_TABLE_DRIFT',
          detail=format('object=%s expected=%s actual=%s',item.object_name,item.fingerprint,actual);
      end if;
    end if;
  end loop;

  -- Function semantic contract for pre-existing out-of-band objects.
  -- EXECUTE permissions are reconciled by the idempotent grants below, so the
  -- preflight contract intentionally does not require any specific grants
  -- (p_execute_roles = '{}'); the post-reconciliation $verify$ block below
  -- enforces the full permission contract.
  if to_regprocedure('public.set_knowledge_entries_updated_at()') is not null then
    mismatches := pg_temp.p17_contract_matches(to_regprocedure('public.set_knowledge_entries_updated_at()'),
      '', 'trigger', 'plpgsql', false, false, 'v', 'u', '',
      pg_temp.p17_normalize_body(pg_temp.p17_expected_set_updated_at_body()), '{}'::text[]);
    if array_length(mismatches, 1) > 0 then
      raise exception using errcode='P0001',message='P17_A4_EXISTING_FUNCTION_DRIFT',
        detail='object=set_knowledge_entries_updated_at '||array_to_string(mismatches,'; ');
    end if;
  end if;
  if to_regprocedure('public.match_knowledge_entries(vector,integer,text)') is not null then
    mismatches := pg_temp.p17_contract_matches(to_regprocedure('public.match_knowledge_entries(vector,integer,text)'),
      'query_embedding vector, match_count integer, filter_type text',
      'TABLE(id uuid, type text, title text, content text, metadata jsonb, similarity double precision)',
      'sql', false, false, 's', 'u', 'pg_catalog,public',
      pg_temp.p17_normalize_body(pg_temp.p17_expected_match_knowledge_entries_body()), '{}'::text[]);
    if array_length(mismatches, 1) > 0 then
      raise exception using errcode='P0001',message='P17_A4_EXISTING_FUNCTION_DRIFT',
        detail='object=match_knowledge_entries '||array_to_string(mismatches,'; ');
    end if;
  end if;
end
$preflight$;

create table if not exists public.knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  type text not null constraint knowledge_entries_type_check check (type=any(array[
    'account'::text,'character'::text,'content'::text,'strategy'::text,
    'insight'::text,'campaign'::text,'workflow'::text,'asset'::text,
    'research'::text,'content_memory'::text,'strategy_memory'::text,
    'research_report'::text,'content_opportunity'::text,
    'account_intelligence_report'::text])),
  title text not null,
  content text not null,
  embedding vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.content_memory (
  id uuid primary key default gen_random_uuid(),
  content_type text not null constraint content_memory_content_type_check check (content_type=any(array[
    'hook'::text,'title'::text,'cta'::text,'body_structure'::text,
    'visual_template'::text,'posting_time'::text])),
  pattern text not null,
  examples jsonb not null default '[]'::jsonb,
  success_rate numeric(4,3),
  platform text not null,
  account_id text,
  character_id text,
  tags text[] not null default array[]::text[],
  source text not null default 'agent'::text constraint content_memory_source_check check (
    source=any(array['manual'::text,'analysis'::text,'agent'::text])),
  created_at timestamptz not null default now()
);

create table if not exists public.strategy_memory (
  id uuid primary key default gen_random_uuid(),
  strategy_name text not null,
  strategy_type text not null constraint strategy_memory_strategy_type_check check (
    strategy_type=any(array['campaign'::text,'content'::text,'account'::text,'character'::text,'platform'::text])),
  description text not null,
  goal text not null,
  execution_period daterange,
  status text not null default 'planned'::text constraint strategy_memory_status_check check (
    status=any(array['planned'::text,'active'::text,'completed'::text,'failed'::text,'paused'::text])),
  results jsonb not null default '{}'::jsonb,
  cost_summary jsonb not null default '{}'::jsonb,
  lessons_learned text,
  effectiveness_rating integer constraint strategy_memory_effectiveness_rating_check check (
    effectiveness_rating>=1 and effectiveness_rating<=5),
  campaign_id text,
  account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.insights (
  id uuid primary key default gen_random_uuid(),
  source_type text not null constraint insights_source_type_check check (
    source_type=any(array['research'::text,'analysis'::text,'comment'::text,'user_feedback'::text,'system'::text])),
  source_id text,
  insight_text text not null,
  confidence numeric(3,2) not null default 0.70 constraint insights_confidence_check check (
    confidence>=0::numeric and confidence<=1::numeric),
  tags text[] not null default array[]::text[],
  campaign_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.account_intelligence_reports (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.social_accounts(id) on delete set null,
  platform text not null,
  username text not null,
  depth text not null default 'standard'::text constraint account_intelligence_reports_depth_check check (
    depth=any(array['quick'::text,'standard'::text,'deep'::text])),
  status text not null default 'completed'::text constraint account_intelligence_reports_status_check check (
    status=any(array['running'::text,'completed'::text,'failed'::text])),
  source_runs jsonb not null default '[]'::jsonb,
  content_samples jsonb not null default '[]'::jsonb,
  modality_summary jsonb not null default '{}'::jsonb,
  interaction_summary jsonb not null default '{}'::jsonb,
  account_brain jsonb not null default '{}'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  error_message text,
  knowledge_entry_id uuid references public.knowledge_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $functions$
begin
  if to_regprocedure('public.set_knowledge_entries_updated_at()') is null then
    execute $sql$
      create function public.set_knowledge_entries_updated_at()
      returns trigger
      language plpgsql
      set search_path to ''
      as $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
    $sql$;
  end if;
  if to_regprocedure('public.match_knowledge_entries(vector,integer,text)') is null then
    execute $sql$
      create function public.match_knowledge_entries(
        query_embedding vector,match_count integer default 5,filter_type text default null::text)
      returns table(id uuid,type text,title text,content text,metadata jsonb,similarity double precision)
      language sql stable
      set search_path to pg_catalog, public
      as $function$
  select
    knowledge_entries.id,
    knowledge_entries.type,
    knowledge_entries.title,
    knowledge_entries.content,
    knowledge_entries.metadata,
    1 - (knowledge_entries.embedding <=> query_embedding) as similarity
  from public.knowledge_entries
  where knowledge_entries.embedding is not null
    and (filter_type is null or knowledge_entries.type = filter_type)
  order by knowledge_entries.embedding <=> query_embedding
  limit match_count;
$function$;
    $sql$;
  end if;
end
$functions$;

create index if not exists idx_knowledge_entries_type on public.knowledge_entries using btree(type);
create index if not exists idx_knowledge_entries_metadata on public.knowledge_entries using gin(metadata);
create index if not exists idx_knowledge_entries_title_trgm on public.knowledge_entries using gin(title gin_trgm_ops);
create index if not exists idx_knowledge_entries_content_trgm on public.knowledge_entries using gin(content gin_trgm_ops);
create index if not exists idx_knowledge_entries_embedding on public.knowledge_entries using ivfflat(embedding vector_cosine_ops) with(lists=100) where embedding is not null;
create index if not exists idx_content_memory_type_platform on public.content_memory using btree(content_type,platform);
create index if not exists idx_content_memory_tags on public.content_memory using gin(tags);
create index if not exists idx_strategy_memory_type_status on public.strategy_memory using btree(strategy_type,status);
create index if not exists idx_insights_source_type on public.insights using btree(source_type);
create index if not exists idx_insights_tags on public.insights using gin(tags);
create index if not exists idx_account_intelligence_reports_account_id on public.account_intelligence_reports using btree(account_id);
create index if not exists idx_account_intelligence_reports_created_at on public.account_intelligence_reports using btree(created_at desc);
create index if not exists idx_account_intelligence_reports_platform_username on public.account_intelligence_reports using btree(platform,username);

do $trigger$
begin
  if not exists(select 1 from pg_trigger where tgrelid='public.knowledge_entries'::regclass and tgname='trg_knowledge_entries_updated_at' and not tgisinternal) then
    create trigger trg_knowledge_entries_updated_at before update on public.knowledge_entries
      for each row execute function public.set_knowledge_entries_updated_at();
  end if;
end
$trigger$;

alter table public.knowledge_entries enable row level security;
alter table public.content_memory enable row level security;
alter table public.strategy_memory enable row level security;
alter table public.insights enable row level security;
alter table public.account_intelligence_reports enable row level security;

do $policies$
declare t text;
begin
  foreach t in array array['knowledge_entries','content_memory','strategy_memory','insights','account_intelligence_reports'] loop
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='authenticated_read_'||t) then
      execute format('create policy %I on public.%I for select to authenticated using (true)','authenticated_read_'||t,t);
    end if;
    if not exists(select 1 from pg_policies where schemaname='public' and tablename=t and policyname='service_role_full_access_'||t) then
      execute format('create policy %I on public.%I for all to service_role using (true) with check (true)','service_role_full_access_'||t,t);
    end if;
  end loop;
end
$policies$;

revoke all on table public.knowledge_entries,public.content_memory,public.strategy_memory,public.insights,public.account_intelligence_reports from public;
grant all on table public.knowledge_entries,public.content_memory,public.strategy_memory,public.insights,public.account_intelligence_reports to postgres,anon,authenticated,service_role;
grant execute on function public.set_knowledge_entries_updated_at() to public,postgres,anon,authenticated,service_role;
grant execute on function public.match_knowledge_entries(vector,integer,text) to public,postgres,anon,authenticated,service_role;

do $verify$
declare item record; actual text; mismatches text[];
begin
  for item in select * from (values
    ('account_intelligence_reports','ba61d41a5dcf21e9c9b594baa22c2074dee8f982e34be1e93453e8cbcf9a4647'),
    ('content_memory','9521099ca4b4bb80feab1ec18bb2718756b0940cc5d41d321d77705f36539393'),
    ('insights','3fbda47d2c6c5e929eb3e33de358f8395a6a41a12538068049a93972d7422291'),
    ('knowledge_entries','a7c752396100e522e40568e536be5586e07562dccb19b24b97825935c2e8f888'),
    ('strategy_memory','7c7308e9243507e0bb01bc3dcb9898e6826c76e27d3081eac83bb7761ee8fbf8')
  ) expected(object_name,fingerprint)
  loop
    actual:=pg_temp.p17_table_fingerprint(to_regclass('public.'||item.object_name));
    if actual is distinct from item.fingerprint then
      raise exception using errcode='P0001',message='P17_A4_TABLE_FINGERPRINT_MISMATCH',detail=format('object=%s expected=%s actual=%s',item.object_name,item.fingerprint,actual);
    end if;
  end loop;
  -- Post-reconciliation function contract: semantics + full EXECUTE contract
  -- (postgres, anon, authenticated, service_role and PUBLIC all executable).
  mismatches := pg_temp.p17_contract_matches(to_regprocedure('public.set_knowledge_entries_updated_at()'),
    '', 'trigger', 'plpgsql', false, false, 'v', 'u', '',
    pg_temp.p17_normalize_body(pg_temp.p17_expected_set_updated_at_body()),
    '{postgres,anon,authenticated,service_role,public}'::text[]);
  if array_length(mismatches, 1) > 0 then
    raise exception using errcode='P0001',message='P17_A4_FUNCTION_CONTRACT_MISMATCH',
      detail='object=set_knowledge_entries_updated_at '||array_to_string(mismatches,'; ');
  end if;
  mismatches := pg_temp.p17_contract_matches(to_regprocedure('public.match_knowledge_entries(vector,integer,text)'),
    'query_embedding vector, match_count integer, filter_type text',
    'TABLE(id uuid, type text, title text, content text, metadata jsonb, similarity double precision)',
    'sql', false, false, 's', 'u', 'pg_catalog,public',
    pg_temp.p17_normalize_body(pg_temp.p17_expected_match_knowledge_entries_body()),
    '{postgres,anon,authenticated,service_role,public}'::text[]);
  if array_length(mismatches, 1) > 0 then
    raise exception using errcode='P0001',message='P17_A4_FUNCTION_CONTRACT_MISMATCH',
      detail='object=match_knowledge_entries '||array_to_string(mismatches,'; ');
  end if;
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector' and e.extversion='0.8.2' and n.nspname='public')
     or not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm' and e.extversion='1.6' and n.nspname='public')
     or not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto' and e.extversion='1.3' and n.nspname='extensions') then
    raise exception using errcode='P0001',message='P17_A4_EXTENSION_DRIFT';
  end if;
end
$verify$;
