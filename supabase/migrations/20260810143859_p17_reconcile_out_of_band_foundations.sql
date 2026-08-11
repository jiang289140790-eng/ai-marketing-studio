-- P17-A4: reconcile five production objects created outside migration history.
-- Existing objects are fingerprinted before any reconciliation.  Drift aborts
-- the transaction; only wholly absent objects are constructed below.

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

create or replace function pg_temp.p17_function_fingerprint(target regprocedure)
returns text
language sql
set search_path = pg_catalog, public, extensions
as $function$
  select encode(extensions.digest(jsonb_build_object(
    'owner',pg_get_userbyid(p.proowner),
    'arguments',pg_get_function_identity_arguments(p.oid),
    'result',pg_get_function_result(p.oid),'language',l.lanname,
    'security_definer',p.prosecdef,'leakproof',p.proleakproof,
    'volatility',p.provolatile::text,'parallel',p.proparallel::text,
    'config',p.proconfig,'definition',pg_get_functiondef(p.oid),
    'acl',coalesce((
      select jsonb_agg(to_jsonb(x) order by grantee,privilege_type) from (
        select coalesce(grantee.rolname,'PUBLIC') grantee,grantor.rolname grantor,
          a.privilege_type,a.is_grantable
        from aclexplode(p.proacl) a
        left join pg_roles grantee on grantee.oid=a.grantee
        join pg_roles grantor on grantor.oid=a.grantor
      ) x
    ),'[]'::jsonb)
  )::text,'sha256'),'hex')
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=target;
$function$;

do $preflight$
declare
  item record;
  actual text;
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

  if to_regprocedure('public.set_knowledge_entries_updated_at()') is not null
     and pg_temp.p17_function_fingerprint(to_regprocedure('public.set_knowledge_entries_updated_at()'))
       <> 'dfdbb17dafcfb26975df9144dd1d50feb120177600fc87f411e5c6cf6b76d703' then
    raise exception using errcode='P0001',message='P17_A4_EXISTING_FUNCTION_DRIFT',detail='object=set_knowledge_entries_updated_at';
  end if;
  if to_regprocedure('public.match_knowledge_entries(vector,integer,text)') is not null
     and pg_temp.p17_function_fingerprint(to_regprocedure('public.match_knowledge_entries(vector,integer,text)'))
       <> '517cf39d12bf8e0371f6b1192e7fd5fbf1df91d7636e13967bd3aa7bd1df943f' then
    raise exception using errcode='P0001',message='P17_A4_EXISTING_FUNCTION_DRIFT',detail='object=match_knowledge_entries';
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
declare item record; actual text;
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
  actual:=pg_temp.p17_function_fingerprint(to_regprocedure('public.set_knowledge_entries_updated_at()'));
  if actual<>'dfdbb17dafcfb26975df9144dd1d50feb120177600fc87f411e5c6cf6b76d703' then
    raise exception using errcode='P0001',message='P17_A4_FUNCTION_FINGERPRINT_MISMATCH',detail='object=set_knowledge_entries_updated_at actual='||coalesce(actual,'null');
  end if;
  actual:=pg_temp.p17_function_fingerprint(to_regprocedure('public.match_knowledge_entries(vector,integer,text)'));
  if actual<>'517cf39d12bf8e0371f6b1192e7fd5fbf1df91d7636e13967bd3aa7bd1df943f' then
    raise exception using errcode='P0001',message='P17_A4_FUNCTION_FINGERPRINT_MISMATCH',detail='object=match_knowledge_entries actual='||coalesce(actual,'null');
  end if;
  if not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector' and e.extversion='0.8.2' and n.nspname='public')
     or not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm' and e.extversion='1.6' and n.nspname='public')
     or not exists(select 1 from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto' and e.extversion='1.3' and n.nspname='extensions') then
    raise exception using errcode='P0001',message='P17_A4_EXTENSION_DRIFT';
  end if;
end
$verify$;
