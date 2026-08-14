-- Harness H4: keep the project revision guard in the same transaction and
-- under the same per-project row lock as the existing P19 entity mutation.
-- This is a forward-only wrapper; it does not change tables, RLS, policies,
-- grants for browser roles, or the semantics of the accepted v1 boundary.

create or replace function api.p19_get_command_replay(
  p_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
stable
security definer
set search_path = ams_private, public
as $$
  select to_jsonb(t)
  from ams_private.p19_command_ledger_v1 t
  where t.user_id = p_user_id
    and t.idempotency_key = p_idempotency_key
  limit 1
$$;

revoke all on function api.p19_get_command_replay(uuid, text)
from public, anon, authenticated;

grant execute on function api.p19_get_command_replay(uuid, text)
to service_role;

comment on function api.p19_get_command_replay(uuid, text)
is 'Service-role-only exact idempotency replay lookup used before mutable project-state reads.';

create or replace function api.p19_apply_entity_write_v2(
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
  p_expected_entity_fingerprint text default null,
  p_expected_project_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_project_id text;
  v_latest integer;
  v_request_sha text;
  v_ledger jsonb;
begin
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
  perform 1
  from ams_private.p19_project_locks_v1
  where user_id = p_user_id and project_id = v_project_id
  for update;

  -- Exact retries replay before the optimistic project-revision guard. This
  -- also closes the race where an Edge preflight saw no ledger but the first
  -- request committed before its retry reached this transaction.
  v_request_sha := encode(extensions.digest(convert_to(
    jsonb_build_object('command', p_command, 'entity_type', p_entity_type,
      'request_summary', p_request_summary, 'expected_base_version', p_expected_base_version,
      'expected_entity_fingerprint', p_expected_entity_fingerprint)::text,
    'UTF8'
  ), 'sha256'), 'hex');
  select to_jsonb(t) into v_ledger
  from ams_private.p19_command_ledger_v1 t
  where t.user_id = p_user_id and t.idempotency_key = p_idempotency_key;
  if v_ledger is not null then
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

  if p_expected_project_revision is not null then
    if p_expected_project_revision < 1 then
      raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
    end if;
    select max(project_version) into v_latest
    from ams_private.p19_research_projects_v1
    where user_id = p_user_id and project_id = v_project_id;
    if v_latest is null or v_latest <> p_expected_project_revision then
      raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
    end if;
  end if;

  return api.p19_apply_entity_write(
    p_user_id,
    p_idempotency_key,
    p_command,
    p_entity_type,
    p_entity_id,
    p_request_summary,
    p_table,
    p_payload,
    p_declared_sha,
    p_expected_base_version,
    p_expected_entity_fingerprint
  );
end;
$$;

revoke all on function api.p19_apply_entity_write_v2(
  uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text, integer
) from public, anon, authenticated;

grant execute on function api.p19_apply_entity_write_v2(
  uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text, integer
) to service_role;

comment on function api.p19_apply_entity_write_v2(
  uuid, text, text, text, text, jsonb, text, jsonb, text, integer, text, integer
) is 'Harness/P19 server-only boundary: atomically validates the expected project revision under the existing project lock before invoking the accepted entity write contract. Zero EXECUTE for anon/authenticated.';

-- Durable, service-only receipts close the paid-call response-loss window.
-- The provider response is written before it crosses the Edge boundary; an
-- exact retry replays the receipt instead of charging or executing again.
create table if not exists ams_private.p22_paid_operation_replays_v1 (
  user_id uuid not null,
  reservation_id uuid not null,
  provider text not null check (provider in ('apify', 'qwen')),
  operation text not null check (char_length(operation) between 1 and 80),
  sequence integer not null check (sequence between 0 and 20),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'claimed' check (state in ('claimed', 'completed', 'failed')),
  lease_expires_at timestamptz not null default (now() + interval '15 minutes'),
  failure_code text check (failure_code is null or char_length(failure_code) between 1 and 80),
  result_json jsonb check (result_json is null or octet_length(result_json::text) <= 2097152),
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (user_id, reservation_id)
);

alter table ams_private.p22_paid_operation_replays_v1 enable row level security;
alter table ams_private.p22_paid_operation_replays_v1 force row level security;
revoke all on ams_private.p22_paid_operation_replays_v1 from public, anon, authenticated;

create or replace function api.p22_claim_paid_operation_replay(
  p_user_id uuid, p_reservation_id uuid, p_provider text, p_operation text,
  p_sequence integer, p_request_sha256 text
)
returns text
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.p22_paid_operation_replays_v1%rowtype;
  v_inserted integer;
begin
  if p_request_sha256 is null or p_request_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_REQUEST_INVALID';
  end if;
  insert into ams_private.p22_paid_operation_replays_v1
    (user_id, reservation_id, provider, operation, sequence, request_sha256)
  values (p_user_id, p_reservation_id, p_provider, p_operation, p_sequence, p_request_sha256)
  on conflict (user_id, reservation_id) do nothing;
  get diagnostics v_inserted = row_count;
  select * into v_row from ams_private.p22_paid_operation_replays_v1
  where user_id = p_user_id and reservation_id = p_reservation_id
  for update;
  if v_row.provider is distinct from p_provider
    or v_row.operation is distinct from p_operation
    or v_row.sequence is distinct from p_sequence
    or v_row.request_sha256 is distinct from p_request_sha256 then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_IDENTITY_CONFLICT';
  end if;
  if v_inserted = 1 then return 'claimed'; end if;
  if v_row.state = 'completed' then return 'already_completed'; end if;
  if v_row.state = 'failed' or v_row.lease_expires_at <= now() then
    update ams_private.p22_paid_operation_replays_v1
    set state = 'claimed', lease_expires_at = now() + interval '15 minutes',
        failure_code = null, result_json = null, completed_at = null
    where user_id = p_user_id and reservation_id = p_reservation_id;
    return 'reclaimed';
  end if;
  return 'already_claimed';
end;
$$;

create or replace function api.p22_get_paid_operation_replay(
  p_user_id uuid, p_reservation_id uuid, p_provider text, p_operation text,
  p_sequence integer, p_request_sha256 text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.p22_paid_operation_replays_v1%rowtype;
begin
  select * into v_row
  from ams_private.p22_paid_operation_replays_v1
  where user_id = p_user_id and reservation_id = p_reservation_id;
  if not found then return null; end if;
  if v_row.provider is distinct from p_provider
    or v_row.operation is distinct from p_operation
    or v_row.sequence is distinct from p_sequence
    or v_row.request_sha256 is distinct from p_request_sha256 then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_IDENTITY_CONFLICT';
  end if;
  if v_row.state <> 'completed' then return null; end if;
  return v_row.result_json;
end;
$$;

create or replace function api.p22_complete_paid_operation_replay(
  p_user_id uuid, p_reservation_id uuid, p_provider text, p_operation text,
  p_sequence integer, p_request_sha256 text, p_result_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_existing ams_private.p22_paid_operation_replays_v1%rowtype;
begin
  if p_result_json is null or octet_length(p_result_json::text) > 2097152 then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_RESULT_INVALID';
  end if;
  update ams_private.p22_paid_operation_replays_v1
  set state = 'completed', result_json = p_result_json, completed_at = now(),
      failure_code = null, lease_expires_at = now()
  where user_id = p_user_id and reservation_id = p_reservation_id
    and provider = p_provider and operation = p_operation and sequence = p_sequence
    and request_sha256 = p_request_sha256 and state = 'claimed' and result_json is null;
  select * into v_existing
  from ams_private.p22_paid_operation_replays_v1
  where user_id = p_user_id and reservation_id = p_reservation_id;
  if v_existing.provider is distinct from p_provider
    or v_existing.operation is distinct from p_operation
    or v_existing.sequence is distinct from p_sequence
    or v_existing.request_sha256 is distinct from p_request_sha256
    or v_existing.result_json is distinct from p_result_json then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_IDENTITY_CONFLICT';
  end if;
  return v_existing.result_json;
end;
$$;

create or replace function api.p22_fail_paid_operation_replay(
  p_user_id uuid, p_reservation_id uuid, p_provider text, p_operation text,
  p_sequence integer, p_request_sha256 text, p_failure_code text
)
returns text
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.p22_paid_operation_replays_v1%rowtype;
begin
  if p_failure_code is null or p_failure_code !~ '^[A-Z][A-Z0-9_]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_FAILURE_INVALID';
  end if;
  select * into v_row from ams_private.p22_paid_operation_replays_v1
  where user_id = p_user_id and reservation_id = p_reservation_id for update;
  if not found or v_row.provider is distinct from p_provider
    or v_row.operation is distinct from p_operation
    or v_row.sequence is distinct from p_sequence
    or v_row.request_sha256 is distinct from p_request_sha256 then
    raise exception using errcode = 'P0001', message = 'P22_PAID_REPLAY_IDENTITY_CONFLICT';
  end if;
  if v_row.state = 'completed' then return 'completed'; end if;
  update ams_private.p22_paid_operation_replays_v1
  set state = 'failed', failure_code = p_failure_code, lease_expires_at = now()
  where user_id = p_user_id and reservation_id = p_reservation_id;
  return 'failed';
end;
$$;

revoke all on function api.p22_claim_paid_operation_replay(uuid, uuid, text, text, integer, text)
from public, anon, authenticated;
revoke all on function api.p22_get_paid_operation_replay(uuid, uuid, text, text, integer, text)
from public, anon, authenticated;
revoke all on function api.p22_complete_paid_operation_replay(uuid, uuid, text, text, integer, text, jsonb)
from public, anon, authenticated;
revoke all on function api.p22_fail_paid_operation_replay(uuid, uuid, text, text, integer, text, text)
from public, anon, authenticated;
grant execute on function api.p22_claim_paid_operation_replay(uuid, uuid, text, text, integer, text) to service_role;
grant execute on function api.p22_get_paid_operation_replay(uuid, uuid, text, text, integer, text) to service_role;
grant execute on function api.p22_complete_paid_operation_replay(uuid, uuid, text, text, integer, text, jsonb) to service_role;
grant execute on function api.p22_fail_paid_operation_replay(uuid, uuid, text, text, integer, text, text) to service_role;
