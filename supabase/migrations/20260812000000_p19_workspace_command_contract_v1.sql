-- P19: local workspace command contract tables and server-only database boundary
-- (future authorized staging writes).
--
-- This migration only adds new P19 objects: tables inside ams_private and
-- server-only functions inside the existing api schema. It does not modify,
-- weaken, or re-grant any accepted P17 RLS/GRANT/default-ACL/view contract, and it
-- exposes no Data API surface: no client role receives any privilege on the
-- ams_private tables (RLS enabled and forced), and anon/authenticated have zero
-- EXECUTE on the api boundary functions.
--
-- The browser never writes here directly. The intended writer is the local,
-- not-yet-deployed Edge Function boundary supabase/functions/p19-workspace-command
-- (service-role server side only), which verifies the JWT subject, requires an
-- accepted staging access role, and applies only allowlisted versioned commands
-- with complete payload/revision/hash/flag/binding/idempotency validation.
--
-- Command application is recorded in p19_command_ledger_v1 keyed by
-- (user_id, idempotency_key) so replays are idempotent and bounded diagnostics
-- are retained. Payload hashes are computed and validated atomically inside the
-- boundary as the exact SHA-256 of PostgreSQL's canonical JSONB textual form
-- (extensions.digest over convert_to(payload::text,'UTF8')) -- the same digest
-- the CHECK constraints use; the server never compares JSON.stringify output to
-- payload::text.
--
-- Deployment precondition (recorded, not changed here): before the Edge Function
-- is deployed, the hosting stack's PostgREST configuration must include the api
-- schema in its exposed schema list (e.g. Supabase CLI [api] schemas) so the
-- service-role client can invoke these functions by name. ams_private itself is
-- never added to any exposed schema.

create table ams_private.p19_research_projects_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  project_version integer not null check (project_version > 0),
  schema_version text not null check (schema_version = 'p19_research_project_v1'),
  status text not null check (status in ('active', 'archived')),
  topic text not null check (length(btrim(topic)) between 1 and 5000),
  objective text not null check (length(btrim(objective)) between 1 and 5000),
  audience text not null check (length(btrim(audience)) between 1 and 200),
  channel text not null check (length(btrim(channel)) between 1 and 200),
  constraints jsonb not null check (jsonb_typeof(constraints) = 'array'
    and jsonb_array_length(constraints) between 0 and 20),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, project_version),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.p19_evidence_records_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  evidence_id text not null check (length(btrim(evidence_id)) between 1 and 200),
  schema_version text not null check (schema_version = 'p19_evidence_record_v1'),
  source_url text not null check (length(btrim(source_url)) between 1 and 1000),
  label text not null check (length(btrim(label)) between 1 and 200),
  platform text not null check (length(btrim(platform)) between 1 and 80),
  content_text text not null check (length(content_text) <= 5000),
  recorded_at timestamptz not null,
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  media_metadata jsonb check (media_metadata is null
    or (jsonb_typeof(media_metadata) = 'object' and octet_length(media_metadata::text) <= 8192)),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, evidence_id),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.p19_analyses_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  analysis_id text not null check (length(btrim(analysis_id)) between 1 and 200),
  schema_version text not null check (schema_version = 'p19_analysis_v1'),
  kind text not null check (kind = 'deterministic_local'),
  rule_ids jsonb not null check (jsonb_typeof(rule_ids) = 'array'
    and jsonb_array_length(rule_ids) between 1 and 20),
  provenance jsonb not null check (jsonb_typeof(provenance) = 'object'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, analysis_id),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.p19_knowledge_cards_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  knowledge_id text not null check (length(btrim(knowledge_id)) between 1 and 200),
  knowledge_version integer not null check (knowledge_version > 0),
  schema_version text not null check (schema_version = 'content_knowledge_card_v1'),
  source_observations jsonb not null check (jsonb_typeof(source_observations) = 'object'),
  evidence_links jsonb not null check (jsonb_typeof(evidence_links) = 'array' and jsonb_array_length(evidence_links) between 1 and 100),
  trust_status text not null check (length(btrim(trust_status)) between 1 and 80),
  validation_status text not null check (length(btrim(validation_status)) between 1 and 80),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, knowledge_id, knowledge_version),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.p19_briefs_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  brief_id text not null check (length(btrim(brief_id)) between 1 and 200),
  brief_version integer not null check (brief_version > 0),
  brief_schema_version text not null check (brief_schema_version = 'ams_content_brief_v1'),
  brief_status text not null check (brief_status in ('pending_review', 'approved', 'returned')),
  decision_snapshot jsonb not null check (jsonb_typeof(decision_snapshot) = 'object'),
  knowledge_citation_ids jsonb not null check (jsonb_typeof(knowledge_citation_ids) = 'array' and jsonb_array_length(knowledge_citation_ids) between 1 and 100),
  evidence_provenance jsonb not null check (jsonb_typeof(evidence_provenance) = 'object'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, brief_id, brief_version),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at),
  check (
    (brief_status = 'pending_review'
      and decision_snapshot = '{"value":"pending","source":"none","decided_by":"none","decided_at":"none"}'::jsonb)
    or
    (brief_status in ('approved', 'returned')
      and decision_snapshot ->> 'value' in ('approved', 'return_for_revision')
      and decision_snapshot ->> 'source' = 'local_manual'
      and length(btrim(decision_snapshot ->> 'decided_by')) between 1 and 200
      and length(btrim(decision_snapshot ->> 'decided_at')) between 1 and 200)
  )
);

create table ams_private.p19_handoff_packages_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  package_id text not null check (package_id ~ '^handoff-pkg-[0-9a-f]{24}$'),
  package_version integer not null check (package_version = 1),
  schema_version text not null check (schema_version = 'ams_external_handoff_package_v1'),
  brief_id text not null check (length(btrim(brief_id)) between 1 and 200),
  brief_version integer not null check (brief_version > 0),
  status text not null check (status = 'ready_for_external_import'),
  payload_label text not null check (payload_label = 'local_external_generation_handoff_package'),
  execution_flags jsonb not null,
  human_decision jsonb not null,
  source_trace jsonb not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, package_id, package_version),
  unique (user_id, brief_id, brief_version, package_id),
  check (execution_flags = '{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}'::jsonb),
  check (jsonb_typeof(human_decision) = 'object'
    and human_decision ->> 'value' = 'approved'
    and human_decision ->> 'source' = 'local_manual'
    and length(btrim(human_decision ->> 'decided_by')) between 1 and 200
    and length(btrim(human_decision ->> 'decided_at')) between 1 and 200),
  check (jsonb_typeof(source_trace) = 'object'
    and source_trace ->> 'origin' = 'local_bridge'
    and source_trace ->> 'created_from' = 'approved_content_brief'),
  check (payload @> jsonb_build_object(
    'id', package_id,
    'version', package_version,
    'schema_version', schema_version,
    'status', status,
    'payload_label', payload_label,
    'execution_flags', execution_flags,
    'human_decision', human_decision,
    'source_trace', source_trace,
    'brief_provenance', jsonb_build_object('brief_id', brief_id, 'brief_version', brief_version)
  )),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex'))
);

create table ams_private.p19_command_ledger_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 200),
  command text not null check (length(btrim(command)) between 1 and 100),
  entity_type text not null check (length(btrim(entity_type)) between 1 and 80),
  entity_id text not null check (length(btrim(entity_id)) between 1 and 200),
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  status text not null check (status in ('applied', 'rejected')),
  request_summary jsonb not null check (jsonb_typeof(request_summary) = 'object' and octet_length(request_summary::text) <= 8192),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  expected_base_version integer check (expected_base_version is null or expected_base_version > 0),
  expected_entity_fingerprint text check (expected_entity_fingerprint is null or expected_entity_fingerprint ~ '^[0-9a-f]{64}$'),
  diagnostics jsonb not null check (jsonb_typeof(diagnostics) = 'object' and octet_length(diagnostics::text) <= 8192),
  applied_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

-- Exact per-user/per-project serialization row.  This table is not business
-- data and is never exposed; SELECT ... FOR UPDATE on the composite primary key
-- serializes every mutation for one logical project without blocking unrelated
-- users or projects and also works before the first project revision exists.
create table ams_private.p19_project_locks_v1 (
  user_id uuid not null references auth.users(id) on delete restrict,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

alter table ams_private.p19_research_projects_v1 enable row level security;
alter table ams_private.p19_research_projects_v1 force row level security;
alter table ams_private.p19_evidence_records_v1 enable row level security;
alter table ams_private.p19_evidence_records_v1 force row level security;
alter table ams_private.p19_analyses_v1 enable row level security;
alter table ams_private.p19_analyses_v1 force row level security;
alter table ams_private.p19_knowledge_cards_v1 enable row level security;
alter table ams_private.p19_knowledge_cards_v1 force row level security;
alter table ams_private.p19_briefs_v1 enable row level security;
alter table ams_private.p19_briefs_v1 force row level security;
alter table ams_private.p19_handoff_packages_v1 enable row level security;
alter table ams_private.p19_handoff_packages_v1 force row level security;
alter table ams_private.p19_command_ledger_v1 enable row level security;
alter table ams_private.p19_command_ledger_v1 force row level security;
alter table ams_private.p19_project_locks_v1 enable row level security;
alter table ams_private.p19_project_locks_v1 force row level security;

revoke all on table
  ams_private.p19_research_projects_v1,
  ams_private.p19_evidence_records_v1,
  ams_private.p19_analyses_v1,
  ams_private.p19_knowledge_cards_v1,
  ams_private.p19_briefs_v1,
  ams_private.p19_handoff_packages_v1,
  ams_private.p19_command_ledger_v1,
  ams_private.p19_project_locks_v1
from public, anon, authenticated;

comment on table ams_private.p19_research_projects_v1 is 'P19 local research projects for the future authorized staging write contract. No client grants; service-role function writes only.';
comment on table ams_private.p19_evidence_records_v1 is 'P19 bounded evidence records (metadata only, never raw media bytes). No client grants.';
comment on table ams_private.p19_analyses_v1 is 'P19 deterministic_local analyses with explicit rules and provenance. No client grants.';
comment on table ams_private.p19_knowledge_cards_v1 is 'P19 validated content_knowledge_card_v1 cards bound to project evidence. No client grants.';
comment on table ams_private.p19_briefs_v1 is 'P19 reviewable content briefs with approved/return_for_revision local_manual decisions. No client grants.';
comment on table ams_private.p19_handoff_packages_v1 is 'P19 ams_external_handoff_package_v1 records; creation requires an approved current brief revision. No client grants.';
comment on table ams_private.p19_command_ledger_v1 is 'P19 idempotent command ledger with bounded diagnostics. No client grants.';
comment on table ams_private.p19_project_locks_v1 is 'P19 exact per-user/project transaction serialization rows. No client grants and no business payload.';

-- ============================================================================
-- P19 server-only database boundary (api schema).
--
-- These security-definer functions are the only path into the ams_private P19
-- tables. anon and ordinary authenticated have zero EXECUTE (revoked below);
-- only service_role (the server function) and postgres (migration runner and
-- SQL tests) can invoke them. ams_private is never exposed to the Data API.
--
-- Every write is one atomic unit in one transaction:
--   1. canonical JSONB hash validation (exact digest of payload::text, the same
--      digest the CHECK constraints use; a client-declared hash must match it);
--   2. idempotency reservation -- INSERT ... ON CONFLICT (user_id,
--      idempotency_key) DO NOTHING. Exactly one concurrent request with a given
--      key proceeds; every other request replays the recorded ledger row and
--      never mutates;
--   3. the guarded mutation. Project revisions are version-guarded: a write
--      whose expected base version does not equal the latest stored revision
--      fails (P19_PROJECT_REVISION_STALE, mapped by the server adapter to the
--      bounded public code PROJECT_REVISION_STALE / HTTP 409) and never branches
--      from an older revision. Latest-revision reads order by project_version
--      desc with the uuid primary key as the stable tie breaker.
--   4. the archive boundary. Once a project's latest revision is archived, every
--      mutating write (project.update, evidence/analysis/card/Brief/handoff
--      create+update, evidence removal) is rejected with P19_PROJECT_ARCHIVED so
--      the archived snapshot can never be revived; the archive transition itself
--      (active -> archived) is the only write allowed, and archiving an
--      already-archived project is an idempotent bounded no-op that writes no
--      new revision. The read-only boundary (p19_get_project /
--      p19_list_project_entities / lineage.audit) may still read an archived
--      project.
-- ============================================================================

create function api.p19_staging_role(p_user_id uuid)
returns text
language sql
security definer
set search_path = ams_private, public
as $$
  select access_role
  from ams_private.staging_access_v1
  where user_id = p_user_id and enabled = true
  order by created_at desc
  limit 1;
$$;

create function api.p19_get_project(p_user_id uuid, p_project_id text)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select payload
  from ams_private.p19_research_projects_v1
  where user_id = p_user_id and project_id = p_project_id
  order by project_version desc, id asc
  limit 1;
$$;

create function api.p19_list_project_entities(p_user_id uuid, p_project_id text)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select jsonb_build_object(
    'evidence', coalesce((
      select jsonb_agg(payload order by created_at asc, id asc)
      from ams_private.p19_evidence_records_v1
      where user_id = p_user_id and project_id = p_project_id
    ), '[]'::jsonb),
    'analyses', coalesce((
      select jsonb_agg(payload order by created_at asc, id asc)
      from ams_private.p19_analyses_v1
      where user_id = p_user_id and project_id = p_project_id
    ), '[]'::jsonb),
    'cards', coalesce((
      select jsonb_agg(payload order by created_at asc, id asc)
      from ams_private.p19_knowledge_cards_v1
      where user_id = p_user_id and project_id = p_project_id
    ), '[]'::jsonb),
    'brief', (
      select payload
      from ams_private.p19_briefs_v1
      where user_id = p_user_id and project_id = p_project_id
      order by brief_version desc, id asc
      limit 1
    ),
    'handoff', (
      select payload
      from ams_private.p19_handoff_packages_v1
      where user_id = p_user_id and project_id = p_project_id
      order by created_at desc, id asc
      limit 1
    )
  );
$$;

create function api.p19_apply_entity_write(
  p_user_id uuid,
  p_idempotency_key text,
  p_command text,
  p_entity_type text,
  p_entity_id text,
  p_request_summary jsonb,
  p_table text,
  p_payload jsonb,
  p_declared_sha text,
  p_expected_base_version integer,
  p_expected_entity_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_sha text;
  v_request_sha text;
  v_reserved uuid;
  v_ledger jsonb;
  v_row uuid;
  v_latest integer;
  v_project_status text;
  v_archiving boolean;
  v_project_id text;
  v_current_entity_fingerprint text;
  v_entity_exists boolean := false;
begin
  -- 1) canonical JSONB hash: the exact digest of payload::text used by the
  --    CHECK constraints; a client-declared hash must match it atomically.
  v_sha := encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
  if p_declared_sha is not null and p_declared_sha <> v_sha then
    raise exception using errcode = 'P0001', message = 'P19_PAYLOAD_HASH_MISMATCH';
  end if;
  v_request_sha := encode(extensions.digest(convert_to(
    jsonb_build_object('command', p_command, 'entity_type', p_entity_type,
      'request_summary', p_request_summary, 'expected_base_version', p_expected_base_version,
      'expected_entity_fingerprint', p_expected_entity_fingerprint)::text,
    'UTF8'
  ), 'sha256'), 'hex');

  -- Every supported mutation is bound to one exact logical project.  Acquire
  -- its composite lock before idempotency, latest-state reads, revision checks,
  -- or entity writes.  Unknown tables and malformed bindings fail before any
  -- ledger row or lock row is created.
  if p_table = 'p19_research_projects_v1' then
    v_project_id := p_payload ->> 'id';
  elsif p_table in (
    'p19_evidence_records_v1', 'p19_analyses_v1', 'p19_knowledge_cards_v1',
    'p19_briefs_v1', 'p19_handoff_packages_v1'
  ) then
    v_project_id := p_payload ->> 'project_id';
  else
    raise exception using errcode = 'P0001', message = 'P19_UNKNOWN_TABLE';
  end if;
  if v_project_id is null or v_project_id !~ '^prj-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'P19_PROJECT_ID_INVALID';
  end if;
  insert into ams_private.p19_project_locks_v1 (user_id, project_id)
  values (p_user_id, v_project_id)
  on conflict (user_id, project_id) do nothing;
  perform 1 from ams_private.p19_project_locks_v1
  where user_id = p_user_id and project_id = v_project_id
  for update;

  -- 2) atomic idempotency reservation BEFORE any business mutation. Concurrent requests
  --    with the same (user_id, idempotency_key) block here; exactly one
  --    proceeds, the rest replay the recorded ledger row.
  insert into ams_private.p19_command_ledger_v1
    (user_id, idempotency_key, command, entity_type, entity_id, project_id, status,
     request_summary, request_sha256, expected_base_version, expected_entity_fingerprint, diagnostics)
  values (p_user_id, p_idempotency_key, p_command, p_entity_type, p_entity_id, v_project_id, 'applied',
          p_request_summary, v_request_sha, p_expected_base_version, p_expected_entity_fingerprint, '{}'::jsonb)
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_reserved;

  if v_reserved is null then
    select to_jsonb(t) into v_ledger
    from ams_private.p19_command_ledger_v1 t
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_ledger ->> 'command' is distinct from p_command
      or v_ledger ->> 'entity_type' is distinct from p_entity_type
      or v_ledger ->> 'entity_id' is distinct from p_entity_id
      or v_ledger ->> 'project_id' is distinct from v_project_id
      or v_ledger -> 'request_summary' is distinct from p_request_summary
      or v_ledger ->> 'request_sha256' is distinct from v_request_sha
      or (v_ledger ->> 'expected_base_version')::integer is distinct from p_expected_base_version
      or v_ledger ->> 'expected_entity_fingerprint' is distinct from p_expected_entity_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'P19_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'ledger', v_ledger);
  end if;

  -- 3) archive boundary BEFORE the mutation: any write against an archived
  --    project is rejected (the archived snapshot can never be revived), except
  --    the archive transition itself (active -> archived). Entity writes bind
  --    to p_payload ->> 'project_id'; project writes bind to p_payload ->> 'id'.
  --    Only known P19 tables are checked: an unknown table must still fail
  --    closed with P19_UNKNOWN_TABLE, never a misattributed archive error.
  v_archiving := (p_table = 'p19_research_projects_v1' and p_payload ->> 'status' = 'archived');
  if not v_archiving and p_table in (
    'p19_research_projects_v1', 'p19_evidence_records_v1', 'p19_analyses_v1',
    'p19_knowledge_cards_v1', 'p19_briefs_v1', 'p19_handoff_packages_v1'
  ) then
    select status into v_project_status
    from ams_private.p19_research_projects_v1
    where user_id = p_user_id
      and project_id = v_project_id
    order by project_version desc, id asc
    limit 1;
    if v_project_status = 'archived' then
      raise exception using errcode = 'P0001', message = 'P19_PROJECT_ARCHIVED';
    end if;
  end if;

  -- 4) Exact optimistic entity snapshot guard.  The caller binds an update to
  --    the fingerprint it read; creates require absence.  This check runs
  --    under the project lock, immediately before the write.
  if p_table = 'p19_evidence_records_v1' then
    select payload ->> 'fingerprint' into v_current_entity_fingerprint
    from ams_private.p19_evidence_records_v1
    where user_id = p_user_id and project_id = v_project_id and evidence_id = p_entity_id;
    v_entity_exists := found;
  elsif p_table = 'p19_analyses_v1' then
    select payload ->> 'fingerprint' into v_current_entity_fingerprint
    from ams_private.p19_analyses_v1
    where user_id = p_user_id and project_id = v_project_id and analysis_id = p_entity_id;
    v_entity_exists := found;
  elsif p_table = 'p19_knowledge_cards_v1' then
    select payload ->> 'fingerprint' into v_current_entity_fingerprint
    from ams_private.p19_knowledge_cards_v1
    where user_id = p_user_id and project_id = v_project_id and knowledge_id = p_entity_id
      and knowledge_version = (p_payload ->> 'version')::integer;
    v_entity_exists := found;
  elsif p_table = 'p19_briefs_v1' then
    select payload ->> 'fingerprint' into v_current_entity_fingerprint
    from ams_private.p19_briefs_v1
    where user_id = p_user_id and project_id = v_project_id and brief_id = p_entity_id
      and brief_version = (p_payload ->> 'version')::integer;
    v_entity_exists := found;
  elsif p_table = 'p19_handoff_packages_v1' then
    select payload ->> 'fingerprint' into v_current_entity_fingerprint
    from ams_private.p19_handoff_packages_v1
    where user_id = p_user_id and project_id = v_project_id and package_id = p_entity_id
      and package_version = (p_payload ->> 'version')::integer;
    v_entity_exists := found;
  end if;

  if p_table <> 'p19_research_projects_v1' then
    if (p_expected_entity_fingerprint is null and v_entity_exists)
      or (p_expected_entity_fingerprint is not null and (
        not v_entity_exists or v_current_entity_fingerprint is distinct from p_expected_entity_fingerprint
      ))
    then
      raise exception using errcode = 'P0001', message = 'P19_ENTITY_REVISION_STALE';
    end if;
  end if;

  -- 5) the guarded mutation (single transaction: any failure rolls back the
  --    reservation together with the mutation).
  if p_table = 'p19_research_projects_v1' then
    -- archiving an already-archived project is an idempotent bounded no-op:
    -- no new revision is written.
    if v_archiving then
      select status into v_project_status
      from ams_private.p19_research_projects_v1
      where user_id = p_user_id and project_id = p_payload ->> 'id'
      order by project_version desc, id asc
      limit 1;
      if v_project_status = 'archived' then
        return jsonb_build_object(
          'outcome', 'applied',
          'entity', jsonb_build_object('type', p_entity_type, 'id', p_entity_id),
          'already_archived', true
        );
      end if;
    end if;
    if p_expected_base_version is not null then
      select max(project_version) into v_latest
      from ams_private.p19_research_projects_v1
      where user_id = p_user_id and project_id = p_payload ->> 'id';
      if v_latest is null or v_latest <> p_expected_base_version then
        raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
      end if;
    else
      perform 1
      from ams_private.p19_research_projects_v1
      where user_id = p_user_id and project_id = p_payload ->> 'id'
      limit 1;
      if found then
        raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
      end if;
    end if;
    insert into ams_private.p19_research_projects_v1
      (user_id, project_id, project_version, schema_version, status, topic, objective,
       audience, channel, constraints, payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'id', (p_payload ->> 'version')::integer,
      p_payload ->> 'schema_version', p_payload ->> 'status',
      btrim(p_payload ->> 'topic'), btrim(p_payload ->> 'objective'),
      btrim(p_payload ->> 'audience'), btrim(p_payload ->> 'channel'),
      coalesce(p_payload -> 'constraints', '[]'::jsonb),
      p_payload, v_sha
    )
    on conflict (user_id, project_id, project_version) do nothing
    returning id into v_row;
    if v_row is null then
      raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
    end if;
  elsif p_table = 'p19_evidence_records_v1' then
    insert into ams_private.p19_evidence_records_v1
      (user_id, project_id, evidence_id, schema_version, source_url, label, platform,
       content_text, recorded_at, provenance, media_metadata, payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'project_id', p_payload ->> 'id',
      p_payload ->> 'schema_version',
      btrim(p_payload ->> 'source_url'), btrim(p_payload ->> 'label'),
      btrim(p_payload ->> 'platform'), p_payload ->> 'content_text',
      (p_payload ->> 'recorded_at')::timestamptz,
      coalesce(nullif(p_payload -> 'provenance', 'null'::jsonb), '{}'::jsonb),
      nullif(p_payload -> 'media_metadata', 'null'::jsonb),
      p_payload, v_sha
    )
    on conflict (user_id, project_id, evidence_id) do update set
      payload = excluded.payload,
      payload_sha256 = excluded.payload_sha256,
      source_url = excluded.source_url,
      label = excluded.label,
      platform = excluded.platform,
      content_text = excluded.content_text,
      recorded_at = excluded.recorded_at,
      provenance = excluded.provenance,
      media_metadata = excluded.media_metadata,
      updated_at = now()
    returning id into v_row;
  elsif p_table = 'p19_analyses_v1' then
    insert into ams_private.p19_analyses_v1
      (user_id, project_id, analysis_id, schema_version, kind, rule_ids, provenance,
       payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'project_id', p_payload ->> 'id',
      p_payload ->> 'schema_version', p_payload ->> 'kind',
      coalesce(p_payload -> 'rule_ids', '[]'::jsonb),
      coalesce(nullif(p_payload -> 'provenance', 'null'::jsonb), '{}'::jsonb),
      p_payload, v_sha
    )
    on conflict (user_id, project_id, analysis_id) do update set
      payload = excluded.payload,
      payload_sha256 = excluded.payload_sha256,
      kind = excluded.kind,
      rule_ids = excluded.rule_ids,
      provenance = excluded.provenance,
      updated_at = now()
    returning id into v_row;
  elsif p_table = 'p19_knowledge_cards_v1' then
    insert into ams_private.p19_knowledge_cards_v1
      (user_id, project_id, knowledge_id, knowledge_version, schema_version,
       source_observations, evidence_links, trust_status, validation_status,
       payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'project_id', p_payload ->> 'id',
      (p_payload ->> 'version')::integer, p_payload ->> 'schema_version',
      coalesce(nullif(p_payload -> 'source_observations', 'null'::jsonb), '{}'::jsonb),
      coalesce(p_payload -> 'evidence_links', '[]'::jsonb),
      btrim(p_payload ->> 'trust_status'), btrim(p_payload ->> 'validation_status'),
      p_payload, v_sha
    )
    on conflict (user_id, project_id, knowledge_id, knowledge_version) do update set
      payload = excluded.payload,
      payload_sha256 = excluded.payload_sha256,
      source_observations = excluded.source_observations,
      evidence_links = excluded.evidence_links,
      trust_status = excluded.trust_status,
      validation_status = excluded.validation_status,
      updated_at = now()
    returning id into v_row;
  elsif p_table = 'p19_briefs_v1' then
    insert into ams_private.p19_briefs_v1
      (user_id, project_id, brief_id, brief_version, brief_schema_version, brief_status,
       decision_snapshot, knowledge_citation_ids, evidence_provenance,
       payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'project_id', p_payload ->> 'id',
      (p_payload ->> 'version')::integer, p_payload ->> 'schema_version',
      p_payload ->> 'status',
      case
        when p_payload -> 'review' -> 'decision' is not null
         and (p_payload -> 'review' -> 'decision') ->> 'value' is not null
          then p_payload -> 'review' -> 'decision'
        else '{"value":"pending","source":"none","decided_by":"none","decided_at":"none"}'::jsonb
      end,
      coalesce(p_payload -> 'knowledge_citation_ids', '[]'::jsonb),
      coalesce(nullif(p_payload -> 'evidence_provenance', 'null'::jsonb), '{}'::jsonb),
      p_payload, v_sha
    )
    on conflict (user_id, project_id, brief_id, brief_version) do update set
      payload = excluded.payload,
      payload_sha256 = excluded.payload_sha256,
      brief_status = excluded.brief_status,
      decision_snapshot = excluded.decision_snapshot,
      knowledge_citation_ids = excluded.knowledge_citation_ids,
      evidence_provenance = excluded.evidence_provenance,
      updated_at = now()
    returning id into v_row;
  elsif p_table = 'p19_handoff_packages_v1' then
    insert into ams_private.p19_handoff_packages_v1
      (user_id, project_id, package_id, package_version, schema_version, brief_id, brief_version,
       status, payload_label, execution_flags, human_decision, source_trace,
       payload, payload_sha256)
    values (
      p_user_id, p_payload ->> 'project_id', p_payload ->> 'id', (p_payload ->> 'version')::integer,
      p_payload ->> 'schema_version',
      p_payload -> 'brief_provenance' ->> 'brief_id',
      (p_payload -> 'brief_provenance' ->> 'brief_version')::integer,
      p_payload ->> 'status', p_payload ->> 'payload_label',
      coalesce(p_payload -> 'execution_flags', '{}'::jsonb),
      coalesce(nullif(p_payload -> 'human_decision', 'null'::jsonb), '{}'::jsonb),
      coalesce(nullif(p_payload -> 'source_trace', 'null'::jsonb), '{}'::jsonb),
      p_payload, v_sha
    )
    on conflict (user_id, package_id, package_version) do update set
      payload = excluded.payload,
      payload_sha256 = excluded.payload_sha256,
      brief_id = excluded.brief_id,
      brief_version = excluded.brief_version,
      status = excluded.status,
      payload_label = excluded.payload_label,
      execution_flags = excluded.execution_flags,
      human_decision = excluded.human_decision,
      source_trace = excluded.source_trace
    returning id into v_row;
  else
    raise exception using errcode = 'P0001', message = 'P19_UNKNOWN_TABLE';
  end if;

  return jsonb_build_object(
    'outcome', 'applied',
    'entity', jsonb_build_object('type', p_entity_type, 'id', p_entity_id)
  );
end;
$$;

create function api.p19_remove_evidence(
  p_user_id uuid,
  p_idempotency_key text,
  p_command text,
  p_request_summary jsonb,
  p_project_id text,
  p_evidence_id text,
  p_expected_entity_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_reserved uuid;
  v_ledger jsonb;
  v_project_status text;
  v_sha text;
  v_current_entity_fingerprint text;
begin
  if p_project_id is null or p_project_id !~ '^prj-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'P19_PROJECT_ID_INVALID';
  end if;
  if p_evidence_id is null or p_evidence_id !~ '^ev-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'P19_EVIDENCE_ID_INVALID';
  end if;
  v_sha := encode(extensions.digest(convert_to(
    jsonb_build_object('command', p_command, 'entity_type', 'evidence',
      'request_summary', p_request_summary, 'expected_base_version', null,
      'expected_entity_fingerprint', p_expected_entity_fingerprint)::text,
    'UTF8'
  ), 'sha256'), 'hex');
  insert into ams_private.p19_project_locks_v1 (user_id, project_id)
  values (p_user_id, p_project_id)
  on conflict (user_id, project_id) do nothing;
  perform 1 from ams_private.p19_project_locks_v1
  where user_id = p_user_id and project_id = p_project_id
  for update;

  insert into ams_private.p19_command_ledger_v1
    (user_id, idempotency_key, command, entity_type, entity_id, project_id, status,
     request_summary, request_sha256, expected_base_version, expected_entity_fingerprint, diagnostics)
  values (p_user_id, p_idempotency_key, p_command, 'evidence', p_evidence_id, p_project_id, 'applied',
          p_request_summary, v_sha, null, p_expected_entity_fingerprint, '{}'::jsonb)
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_reserved;

  if v_reserved is null then
    select to_jsonb(t) into v_ledger
    from ams_private.p19_command_ledger_v1 t
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_ledger ->> 'command' is distinct from p_command
      or v_ledger ->> 'entity_type' is distinct from 'evidence'
      or v_ledger ->> 'entity_id' is distinct from p_evidence_id
      or v_ledger ->> 'project_id' is distinct from p_project_id
      or v_ledger -> 'request_summary' is distinct from p_request_summary
      or v_ledger ->> 'request_sha256' is distinct from v_sha
      or v_ledger ->> 'expected_base_version' is not null
      or v_ledger ->> 'expected_entity_fingerprint' is distinct from p_expected_entity_fingerprint
    then
      raise exception using errcode = 'P0001', message = 'P19_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('outcome', 'replayed', 'ledger', v_ledger);
  end if;

  -- Archive boundary: removal is a mutation, so it is rejected on an archived
  -- project (the archived snapshot can never be revived).
  select status into v_project_status
  from ams_private.p19_research_projects_v1
  where user_id = p_user_id and project_id = p_project_id
  order by project_version desc, id asc
  limit 1;
  if v_project_status = 'archived' then
    raise exception using errcode = 'P0001', message = 'P19_PROJECT_ARCHIVED';
  end if;

  select payload ->> 'fingerprint' into v_current_entity_fingerprint
  from ams_private.p19_evidence_records_v1
  where user_id = p_user_id and project_id = p_project_id and evidence_id = p_evidence_id;
  if not found or p_expected_entity_fingerprint is null
    or v_current_entity_fingerprint is distinct from p_expected_entity_fingerprint
  then
    raise exception using errcode = 'P0001', message = 'P19_ENTITY_REVISION_STALE';
  end if;

  -- Deletion binds to the LOGICAL evidence_id, never the generated uuid pk.
  -- Prune the exact dependent chain before removing the source so the server
  -- boundary preserves the same binding invariant as the local workspace.
  delete from ams_private.p19_handoff_packages_v1 h
  where h.user_id = p_user_id and h.project_id = p_project_id
    and exists (
      select 1
      from ams_private.p19_briefs_v1 b
      where b.user_id = p_user_id and b.project_id = p_project_id
        and b.brief_id = h.brief_id and b.brief_version = h.brief_version
        and exists (
          select 1 from jsonb_array_elements_text(b.knowledge_citation_ids) citation(card_id)
          where citation.card_id in (
            select c.knowledge_id
            from ams_private.p19_knowledge_cards_v1 c
            where c.user_id = p_user_id and c.project_id = p_project_id
              and c.payload ->> 'analysis_id' in (
                select a.analysis_id
                from ams_private.p19_analyses_v1 a
                where a.user_id = p_user_id and a.project_id = p_project_id
                  and a.payload ->> 'evidence_id' = p_evidence_id
              )
          )
        )
    );

  delete from ams_private.p19_briefs_v1 b
  where b.user_id = p_user_id and b.project_id = p_project_id
    and exists (
      select 1 from jsonb_array_elements_text(b.knowledge_citation_ids) citation(card_id)
      where citation.card_id in (
        select c.knowledge_id
        from ams_private.p19_knowledge_cards_v1 c
        where c.user_id = p_user_id and c.project_id = p_project_id
          and c.payload ->> 'analysis_id' in (
            select a.analysis_id
            from ams_private.p19_analyses_v1 a
            where a.user_id = p_user_id and a.project_id = p_project_id
              and a.payload ->> 'evidence_id' = p_evidence_id
          )
      )
    );

  delete from ams_private.p19_knowledge_cards_v1 c
  where c.user_id = p_user_id and c.project_id = p_project_id
    and c.payload ->> 'analysis_id' in (
      select a.analysis_id
      from ams_private.p19_analyses_v1 a
      where a.user_id = p_user_id and a.project_id = p_project_id
        and a.payload ->> 'evidence_id' = p_evidence_id
    );

  delete from ams_private.p19_analyses_v1
  where user_id = p_user_id and project_id = p_project_id
    and payload ->> 'evidence_id' = p_evidence_id;

  delete from ams_private.p19_evidence_records_v1
  where user_id = p_user_id and project_id = p_project_id and evidence_id = p_evidence_id;

  if not found then
    raise exception using errcode = 'P0001', message = 'P19_EVIDENCE_NOT_FOUND';
  end if;

  return jsonb_build_object(
    'outcome', 'applied',
    'entity', jsonb_build_object('type', 'evidence', 'id', p_evidence_id)
  );
end;
$$;

-- Client roles have zero EXECUTE on the boundary (fail closed); only the
-- service-role server client may invoke these functions.
revoke all on function
  api.p19_staging_role(uuid),
  api.p19_get_project(uuid, text),
  api.p19_list_project_entities(uuid, text),
  api.p19_apply_entity_write(uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text),
  api.p19_remove_evidence(uuid, text, text, jsonb, text, text, text)
from public, anon, authenticated;

grant execute on function
  api.p19_staging_role(uuid),
  api.p19_get_project(uuid, text),
  api.p19_list_project_entities(uuid, text),
  api.p19_apply_entity_write(uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text),
  api.p19_remove_evidence(uuid, text, text, jsonb, text, text, text)
to service_role;

comment on function api.p19_staging_role(uuid) is 'P19 server-only boundary: staging access role from the private allowlist. Zero EXECUTE for anon/authenticated.';
comment on function api.p19_get_project(uuid, text) is 'P19 server-only boundary: latest project revision read (project_version desc, id tie breaker). Zero EXECUTE for anon/authenticated.';
comment on function api.p19_list_project_entities(uuid, text) is 'P19 server-only boundary: bounded entity reads for one project. Zero EXECUTE for anon/authenticated.';
comment on function api.p19_apply_entity_write(uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text) is 'P19 server-only boundary: atomic canonical-hash validation + exact entity snapshot guard + idempotency reservation + guarded mutation in one transaction. Zero EXECUTE for anon/authenticated.';
comment on function api.p19_remove_evidence(uuid, text, text, jsonb, text, text, text) is 'P19 server-only boundary: idempotent evidence removal bound to the exact entity fingerprint; rejected with PROJECT_ARCHIVED or ENTITY_REVISION_STALE when the snapshot changed. Zero EXECUTE for anon/authenticated.';
