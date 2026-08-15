-- Harness final closeout: a new Brief revision is guarded by the latest
-- persisted revision of the same logical Brief while the existing project
-- lock is held.  This changes no table, RLS, grant, Auth, or browser role.

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
  v_latest_brief_version integer;
  v_latest_brief_fingerprint text;
  v_incoming_brief_version integer;
  v_inner_expected_fingerprint text := p_expected_entity_fingerprint;
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
  perform 1 from ams_private.p19_project_locks_v1
  where user_id = p_user_id and project_id = v_project_id
  for update;

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

  -- Brief writes are always versioned online mutations.  Unlike legacy
  -- browser-compatible entity writes, they must never omit the exact project
  -- revision guard.
  if p_table = 'p19_briefs_v1'
    and (p_expected_project_revision is null or p_expected_project_revision < 1)
  then
    raise exception using errcode = 'P0001', message = 'P19_PROJECT_REVISION_STALE';
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

  if p_table = 'p19_briefs_v1' then
    if p_payload ->> 'id' is distinct from p_entity_id
      or coalesce(p_payload ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$'
      or coalesce(p_payload ->> 'version', '') !~ '^[1-9][0-9]*$'
    then
      raise exception using errcode = 'P0001', message = 'P19_ENTITY_REVISION_STALE';
    end if;
    v_incoming_brief_version := (p_payload ->> 'version')::integer;
    select brief_version, payload ->> 'fingerprint'
      into v_latest_brief_version, v_latest_brief_fingerprint
    from ams_private.p19_briefs_v1
    where user_id = p_user_id
      and project_id = v_project_id
      and brief_id = p_entity_id
    order by brief_version desc, id asc
    limit 1;

    if v_latest_brief_version is null then
      if p_expected_entity_fingerprint is not null or v_incoming_brief_version <> 1 then
        raise exception using errcode = 'P0001', message = 'P19_ENTITY_REVISION_STALE';
      end if;
      v_inner_expected_fingerprint := null;
    else
      if p_expected_entity_fingerprint is null
        or p_expected_entity_fingerprint is distinct from v_latest_brief_fingerprint
        or v_incoming_brief_version not in (v_latest_brief_version, v_latest_brief_version + 1)
      then
        raise exception using errcode = 'P0001', message = 'P19_ENTITY_REVISION_STALE';
      end if;
      -- The accepted v1 writer still guards same-version replacement.  A
      -- next-version insert has no same-version row, so the latest-revision
      -- comparison above is its complete entity guard under this lock.
      if v_incoming_brief_version = v_latest_brief_version + 1 then
        v_inner_expected_fingerprint := null;
      end if;
    end if;
  end if;

  return api.p19_apply_entity_write(
    p_user_id, p_idempotency_key, p_command, p_entity_type, p_entity_id,
    p_request_summary, p_table, p_payload, p_declared_sha,
    p_expected_base_version, v_inner_expected_fingerprint
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
) is 'Service-role-only P19 boundary with atomic project revision and latest logical Brief revision guards.';
