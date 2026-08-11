create table ams_private.vg_lineage_nodes_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  package_id text not null check (package_id ~ '^handoff-pkg-[0-9a-f]{24}$'),
  node_type text not null check (node_type in ('handoff_import', 'campaign_draft', 'review_worksheet', 'review_decision', 'generation_plan', 'readiness', 'preparation', 'signoff_ledger')),
  record_id text not null check (length(btrim(record_id)) between 1 and 200),
  snapshot_schema_version text not null check (length(btrim(snapshot_schema_version)) between 1 and 200),
  source_state text not null check (source_state in ('current', 'invalid', 'stale')),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 262144),
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, package_id, node_type, record_id),
  unique (user_id, package_id, node_type, record_id, source_state),
  check (snapshot_sha256 = encode(extensions.digest(convert_to(snapshot::text, 'UTF8'), 'sha256'), 'hex'))
);

create table ams_private.vg_lineage_edges_v1 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  package_id text not null check (package_id ~ '^handoff-pkg-[0-9a-f]{24}$'),
  from_type text not null,
  from_record_id text not null check (length(btrim(from_record_id)) between 1 and 200),
  to_type text not null,
  to_record_id text not null check (length(btrim(to_record_id)) between 1 and 200),
  edge_kind text not null,
  source_fingerprint text not null check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, package_id, from_type, from_record_id, to_type, to_record_id, edge_kind),
  foreign key (user_id, package_id, from_type, from_record_id)
    references ams_private.vg_lineage_nodes_v1(user_id, package_id, node_type, record_id) on delete restrict,
  foreign key (user_id, package_id, to_type, to_record_id)
    references ams_private.vg_lineage_nodes_v1(user_id, package_id, node_type, record_id) on delete restrict,
  check ((from_type, to_type, edge_kind) in (
    ('handoff_import', 'campaign_draft', 'import_to_draft'),
    ('campaign_draft', 'review_worksheet', 'draft_to_review'),
    ('review_worksheet', 'review_decision', 'review_to_decision'),
    ('review_worksheet', 'generation_plan', 'review_to_plan'),
    ('generation_plan', 'readiness', 'plan_to_readiness'),
    ('readiness', 'preparation', 'readiness_to_preparation'),
    ('preparation', 'signoff_ledger', 'preparation_to_ledger')
  ))
);

alter table ams_private.vg_lineage_nodes_v1 enable row level security;
alter table ams_private.vg_lineage_nodes_v1 force row level security;
alter table ams_private.vg_lineage_edges_v1 enable row level security;
alter table ams_private.vg_lineage_edges_v1 force row level security;

create policy vg_lineage_nodes_v1_read_own_staging on ams_private.vg_lineage_nodes_v1
for select to authenticated using ((select auth.uid()) = user_id and ams_private.is_staging_user('viewer'));
create policy vg_lineage_edges_v1_read_own_staging on ams_private.vg_lineage_edges_v1
for select to authenticated using ((select auth.uid()) = user_id and ams_private.is_staging_user('viewer'));

revoke all on table ams_private.vg_lineage_nodes_v1, ams_private.vg_lineage_edges_v1 from public, anon, authenticated;
grant select on table ams_private.vg_lineage_nodes_v1, ams_private.vg_lineage_edges_v1 to authenticated;

create view api.vg_lineage_audit_v1 with (security_invoker = true) as
with packages as (
  select distinct user_id, package_id from ams_private.vg_lineage_nodes_v1
), node_stats as (
  select p.user_id, p.package_id,
    count(*) filter (where n.node_type = 'handoff_import') as import_count,
    count(*) filter (where n.node_type = 'campaign_draft') as draft_count,
    count(*) filter (where n.node_type = 'review_worksheet') as review_count,
    count(*) filter (where n.node_type = 'review_decision') as decision_count,
    count(*) filter (where n.node_type = 'generation_plan') as plan_count,
    count(*) filter (where n.node_type = 'readiness') as readiness_count,
    count(*) filter (where n.node_type = 'preparation') as preparation_count,
    count(*) filter (where n.node_type = 'signoff_ledger') as ledger_count,
    bool_or(n.source_state <> 'current') as invalid_source,
    bool_or(n.node_type = 'handoff_import' and not (
      n.snapshot ->> 'schema_version' = 'ams_external_handoff_package_v1'
      and n.snapshot -> 'execution_flags' = '{"generation_executed":false,"routing_executed":false,"network_executed":false,"publish_executed":false}'::jsonb
    )) as invalid_handoff
  from packages p
  join ams_private.vg_lineage_nodes_v1 n using (user_id, package_id)
  group by p.user_id, p.package_id
), edge_stats as (
  select p.user_id, p.package_id,
    count(*) filter (where e.edge_kind = 'import_to_draft') as import_draft_edges,
    count(*) filter (where e.edge_kind = 'draft_to_review') as draft_review_edges,
    count(*) filter (where e.edge_kind = 'review_to_decision') as review_decision_edges,
    count(*) filter (where e.edge_kind = 'review_to_plan') as review_plan_edges,
    count(*) filter (where e.edge_kind = 'plan_to_readiness') as plan_readiness_edges,
    count(*) filter (where e.edge_kind = 'readiness_to_preparation') as readiness_preparation_edges,
    count(*) filter (where e.edge_kind = 'preparation_to_ledger') as preparation_ledger_edges
  from packages p
  left join ams_private.vg_lineage_edges_v1 e using (user_id, package_id)
  group by p.user_id, p.package_id
), evaluated as (
  select n.*, e.import_draft_edges, e.draft_review_edges, e.review_decision_edges, e.review_plan_edges,
    e.plan_readiness_edges, e.readiness_preparation_edges, e.preparation_ledger_edges,
    case
      when n.invalid_source or n.invalid_handoff then 'INVALID_SOURCE'
      when n.import_count <> 1 or n.draft_count > 1 or n.review_count > 1 or n.decision_count > 1 or n.plan_count > 1
        or n.readiness_count > 1 or n.preparation_count > 1 or n.ledger_count > 1
        or (n.draft_count = 0 and (n.review_count + n.decision_count + n.plan_count + n.readiness_count + n.preparation_count + n.ledger_count) > 0)
        or (n.review_count = 0 and (n.decision_count + n.plan_count + n.readiness_count + n.preparation_count + n.ledger_count) > 0)
        or (n.decision_count = 0 and (n.plan_count + n.readiness_count + n.preparation_count + n.ledger_count) > 0)
        or (n.plan_count = 0 and (n.readiness_count + n.preparation_count + n.ledger_count) > 0)
        or (n.readiness_count = 0 and (n.preparation_count + n.ledger_count) > 0)
        or (n.preparation_count = 0 and n.ledger_count > 0)
        or (n.draft_count = 1 and e.import_draft_edges <> 1)
        or (n.review_count = 1 and e.draft_review_edges <> 1)
        or (n.decision_count = 1 and e.review_decision_edges <> 1)
        or (n.plan_count = 1 and e.review_plan_edges <> 1)
        or (n.readiness_count = 1 and e.plan_readiness_edges <> 1)
        or (n.preparation_count = 1 and e.readiness_preparation_edges <> 1)
        or (n.ledger_count = 1 and e.preparation_ledger_edges <> 1)
        then 'BROKEN'
      when n.draft_count < 1 or n.review_count < 1 or n.decision_count < 1 or n.plan_count < 1 or n.readiness_count < 1
        or n.preparation_count < 1 or n.ledger_count < 1 then 'PARTIAL'
      else 'COMPLETE'
    end as audit_state
  from node_stats n
  join edge_stats e using (user_id, package_id)
)
select package_id, audit_state,
  case audit_state when 'INVALID_SOURCE' then 3 when 'BROKEN' then 2 when 'PARTIAL' then 1 else 0 end as severity,
  import_count, draft_count, review_count, decision_count, plan_count, readiness_count, preparation_count, ledger_count,
  jsonb_strip_nulls(jsonb_build_object(
    'invalid_source', case when invalid_source or invalid_handoff then true end,
    'duplicate_or_misbound', case when audit_state = 'BROKEN' then true end,
    'incomplete', case when audit_state = 'PARTIAL' then true end
  )) as reasons
from evaluated;

revoke all on table api.vg_lineage_audit_v1 from public, anon, authenticated;
grant select on table api.vg_lineage_audit_v1 to authenticated;
