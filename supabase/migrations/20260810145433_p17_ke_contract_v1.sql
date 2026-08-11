create table ams_private.ke_knowledge_cards_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  knowledge_id text not null check (length(btrim(knowledge_id)) between 1 and 200),
  knowledge_version integer not null check (knowledge_version > 0),
  schema_version text not null check (length(btrim(schema_version)) between 1 and 200),
  source_identity jsonb not null check (jsonb_typeof(source_identity) = 'object'),
  evidence_refs jsonb not null check (jsonb_typeof(evidence_refs) = 'array' and jsonb_array_length(evidence_refs) between 1 and 100),
  trust_status text not null check (length(btrim(trust_status)) between 1 and 80),
  validation_status text not null check (length(btrim(validation_status)) between 1 and 80),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, knowledge_id, knowledge_version),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.ke_content_briefs_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  brief_id text not null check (length(btrim(brief_id)) between 1 and 200),
  brief_version integer not null check (brief_version > 0),
  brief_schema_version text not null check (length(btrim(brief_schema_version)) between 1 and 200),
  brief_status text not null check (brief_status in ('pending_review', 'approved', 'returned')),
  decision_snapshot jsonb not null check (jsonb_typeof(decision_snapshot) = 'object'),
  knowledge_citation_ids jsonb not null check (jsonb_typeof(knowledge_citation_ids) = 'array' and jsonb_array_length(knowledge_citation_ids) between 1 and 100),
  evidence_provenance jsonb not null check (jsonb_typeof(evidence_provenance) = 'object'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 262144),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, brief_id, brief_version),
  check (payload_sha256 = encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')),
  check (updated_at >= created_at)
);

create table ams_private.ke_handoff_packages_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
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

alter table ams_private.ke_knowledge_cards_v1 enable row level security;
alter table ams_private.ke_knowledge_cards_v1 force row level security;
alter table ams_private.ke_content_briefs_v1 enable row level security;
alter table ams_private.ke_content_briefs_v1 force row level security;
alter table ams_private.ke_handoff_packages_v1 enable row level security;
alter table ams_private.ke_handoff_packages_v1 force row level security;

create policy ke_knowledge_cards_v1_read_own_staging on ams_private.ke_knowledge_cards_v1
for select to authenticated using ((select auth.uid()) = user_id and ams_private.is_staging_user('viewer'));
create policy ke_content_briefs_v1_read_own_staging on ams_private.ke_content_briefs_v1
for select to authenticated using ((select auth.uid()) = user_id and ams_private.is_staging_user('viewer'));
create policy ke_handoff_packages_v1_read_own_staging on ams_private.ke_handoff_packages_v1
for select to authenticated using ((select auth.uid()) = user_id and ams_private.is_staging_user('viewer'));

revoke all on table ams_private.ke_knowledge_cards_v1, ams_private.ke_content_briefs_v1, ams_private.ke_handoff_packages_v1 from public, anon, authenticated;
grant select on table ams_private.ke_knowledge_cards_v1, ams_private.ke_content_briefs_v1, ams_private.ke_handoff_packages_v1 to authenticated;

create view api.ke_knowledge_cards_v1 with (security_invoker = true) as
select id, knowledge_id, knowledge_version, schema_version, source_identity, evidence_refs,
       trust_status, validation_status, payload, payload_sha256, created_at, updated_at
from ams_private.ke_knowledge_cards_v1;

create view api.ke_content_briefs_v1 with (security_invoker = true) as
select id, brief_id, brief_version, brief_schema_version, brief_status, decision_snapshot,
       knowledge_citation_ids, evidence_provenance, payload, payload_sha256, created_at, updated_at
from ams_private.ke_content_briefs_v1
where brief_status = 'approved';

create view api.ke_handoff_manifest_v1 with (security_invoker = true) as
select id, package_id, package_version, schema_version, brief_id, brief_version, status, payload_label,
       execution_flags, human_decision ->> 'source' as decision_source,
       human_decision ->> 'decided_by' as decided_by, human_decision ->> 'decided_at' as decided_at,
       source_trace, payload_sha256, created_at
from ams_private.ke_handoff_packages_v1;

create view api.ke_handoff_package_detail_v1 with (security_invoker = true) as
select id, package_id, package_version, schema_version, brief_id, brief_version, status, payload_label,
       execution_flags, human_decision, source_trace, payload, payload_sha256, created_at
from ams_private.ke_handoff_packages_v1;

revoke all on table api.ke_knowledge_cards_v1, api.ke_content_briefs_v1, api.ke_handoff_manifest_v1, api.ke_handoff_package_detail_v1 from public, anon, authenticated;
grant usage on schema api to authenticated;
grant select on table api.ke_knowledge_cards_v1, api.ke_content_briefs_v1, api.ke_handoff_manifest_v1, api.ke_handoff_package_detail_v1 to authenticated;
