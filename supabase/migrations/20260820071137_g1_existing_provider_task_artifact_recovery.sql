-- G1: recover an already-paid, already-terminal provider task without another
-- provider submission. This forward-only contract is intentionally narrow:
-- only an existing ambiguous video attempt with the exact persisted provider
-- task id may be completed, and only service_role may call the recovery RPCs.

create or replace function ams_private.g1_block_terminal_attempt_mutation()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_TERMINAL_IMMUTABLE';
  end if;

  if tg_op = 'UPDATE' and old.state in ('succeeded', 'failed', 'ambiguous') then
    -- The sole terminal-state exception is an evidence-backed recovery of the
    -- same ambiguous provider task. The immutable identity columns must remain
    -- byte-for-byte equal and the matching immutable artifact must already have
    -- been inserted in this transaction by the service-role-only recovery RPC.
    if old.state = 'ambiguous'
      and new.state = 'succeeded'
      and new.id = old.id
      and new.job_id = old.job_id
      and new.attempt_no = old.attempt_no
      and new.provider_task_id is not distinct from old.provider_task_id
      and new.created_at = old.created_at
      and new.claimed_at is not distinct from old.claimed_at
      and new.submitted_at is not distinct from old.submitted_at
      and new.claimed_by is null
      and new.lease_expires_at is null
      and new.downloaded_sha256 ~ '^[0-9a-f]{64}$'
      and new.mime_type ~ '^video/'
      and new.byte_size between 1 and 536870912
      and exists (
        select 1
        from ams_private.g1_generation_artifacts_v1 ar
        where ar.job_id = old.job_id
          and ar.attempt_id = old.id
          and ar.provider_task_id = old.provider_task_id
          and ar.content_sha256 = new.downloaded_sha256
          and ar.mime_type = new.mime_type
          and ar.byte_size = new.byte_size
      )
    then
      return new;
    end if;

    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_TERMINAL_IMMUTABLE';
  end if;
  return new;
end;
$$;

create function api.g1_get_ambiguous_recovery_context(
  p_job_id text,
  p_attempt_id text,
  p_provider_task_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_job ams_private.g1_generation_jobs_v1;
  v_attempt ams_private.g1_generation_attempts_v1;
  v_next integer;
begin
  if p_job_id is null or p_job_id !~ '^g1j-[0-9a-f]{24}$'
    or p_attempt_id is null or p_attempt_id !~ '^g1a-[0-9a-f]{24}$'
    or p_provider_task_id is null or char_length(p_provider_task_id) not between 1 and 200
  then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_IDENTITY_INVALID';
  end if;

  select * into v_job
  from ams_private.g1_generation_jobs_v1
  where id = p_job_id;

  select * into v_attempt
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;

  if v_job.id is null or v_attempt.id is null then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_TARGET_NOT_FOUND';
  end if;
  if v_job.status <> 'needs_attention' or v_attempt.state <> 'ambiguous' then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_STATE_INVALID';
  end if;
  if v_job.mode not in ('video_t2v', 'video_i2v') then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_MODE_INVALID';
  end if;
  if v_attempt.provider_task_id is distinct from p_provider_task_id then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_PROVIDER_TASK_MISMATCH';
  end if;
  if exists (
    select 1 from ams_private.g1_generation_artifacts_v1 ar
    where ar.job_id = p_job_id or ar.attempt_id = p_attempt_id
  ) then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_ARTIFACT_EXISTS';
  end if;

  v_next := (select coalesce(max(ar.artifact_version), 0) + 1
             from ams_private.g1_generation_artifacts_v1 ar
             where ar.job_id = p_job_id);

  return jsonb_build_object(
    'ok', true,
    'job_id', v_job.id,
    'attempt_id', v_attempt.id,
    'attempt_no', v_attempt.attempt_no,
    'provider_task_id', v_attempt.provider_task_id,
    'next_artifact_version', v_next,
    'mode', v_job.mode,
    'model_name', v_job.model_name,
    'model_version', v_job.model_version,
    'user_id', v_job.user_id,
    'project_id', v_job.project_id,
    'brief_id', v_job.brief_id,
    'brief_version', v_job.brief_version,
    'brief_fingerprint', v_job.brief_fingerprint,
    'knowledge_card_ids', v_job.knowledge_card_ids,
    'evidence_ids', v_job.evidence_ids,
    'reference_asset_id', v_job.reference_asset_id,
    'request', v_job.request,
    'quote', v_job.quote
  );
end;
$$;

create function api.g1_recover_ambiguous_attempt(
  p_job_id text,
  p_attempt_id text,
  p_provider_task_id text,
  p_worker_id text,
  p_provider_status text,
  p_artifact jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_job ams_private.g1_generation_jobs_v1;
  v_attempt ams_private.g1_generation_attempts_v1;
  v_sha text;
  v_mime text;
  v_bytes bigint;
  v_width integer;
  v_height integer;
  v_duration numeric;
  v_path text;
  v_source_url text;
  v_usage jsonb;
  v_cost numeric;
  v_next integer;
  v_artifact_id text;
  v_path_pattern text;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 64 then
    raise exception using errcode = 'P0001', message = 'G1_WORKER_ID_INVALID';
  end if;
  if p_provider_status is distinct from 'SUCCEEDED' then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_PROVIDER_NOT_SUCCEEDED';
  end if;
  if p_artifact is null or jsonb_typeof(p_artifact) <> 'object'
    or p_artifact ->> 'schema_version' is distinct from 'g1_artifact_v1'
  then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end if;

  begin
    v_sha := p_artifact ->> 'content_sha256';
    v_mime := p_artifact ->> 'mime_type';
    v_bytes := (p_artifact ->> 'byte_size')::bigint;
    v_width := (p_artifact ->> 'width')::integer;
    v_height := (p_artifact ->> 'height')::integer;
    v_duration := (p_artifact ->> 'duration_seconds')::numeric;
    v_path := p_artifact ->> 'storage_path';
    v_source_url := nullif(p_artifact ->> 'source_url', '');
    v_usage := coalesce(p_artifact -> 'usage', '{}'::jsonb);
    v_cost := (p_artifact ->> 'cost_cny')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end;

  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$'
    or v_mime is null or v_mime !~ '^video/[a-z0-9.+-]+$'
    or v_bytes is null or v_bytes not between 1 and 536870912
    or v_path is null or char_length(v_path) not between 1 and 300
    or (v_width is not null and v_width not between 1 and 16384)
    or (v_height is not null and v_height not between 1 and 16384)
    or (v_duration is not null and (v_duration < 0 or v_duration > 86400))
    or (v_source_url is not null and (char_length(v_source_url) > 500 or v_source_url !~ '^https?://'))
    or octet_length(v_usage::text) > 4096
    or (v_cost is not null and (v_cost < 0 or v_cost > 100000))
  then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end if;

  select * into v_job
  from ams_private.g1_generation_jobs_v1
  where id = p_job_id
  for update;

  select * into v_attempt
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id
  for update;

  if v_job.id is null or v_attempt.id is null then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_TARGET_NOT_FOUND';
  end if;
  if v_job.status <> 'needs_attention' or v_attempt.state <> 'ambiguous' then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_STATE_INVALID';
  end if;
  if v_job.mode not in ('video_t2v', 'video_i2v') then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_MODE_INVALID';
  end if;
  if v_attempt.provider_task_id is distinct from p_provider_task_id then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_PROVIDER_TASK_MISMATCH';
  end if;
  if exists (
    select 1 from ams_private.g1_generation_artifacts_v1 ar
    where ar.job_id = p_job_id or ar.attempt_id = p_attempt_id
  ) then
    raise exception using errcode = 'P0001', message = 'G1_RECOVERY_ARTIFACT_EXISTS';
  end if;

  v_next := (select coalesce(max(ar.artifact_version), 0) + 1
             from ams_private.g1_generation_artifacts_v1 ar
             where ar.job_id = p_job_id);
  v_path_pattern := '^' || v_job.user_id::text || '/' || v_job.project_id || '/' || v_job.id || '/v'
    || v_next || '/[0-9a-f]{12}\.[a-z0-9]{2,8}$';
  if v_path !~ v_path_pattern then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_PATH_INVALID';
  end if;

  v_artifact_id := 'g1x-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
  insert into ams_private.g1_generation_artifacts_v1
    (id, job_id, attempt_id, artifact_version, content_sha256, mime_type, byte_size,
     width, height, duration_seconds, storage_path, provider_task_id, model_name,
     model_version, provider, prompt_sha256, brief_id, brief_version, brief_fingerprint,
     knowledge_card_ids, evidence_ids, reference_asset_id, source_url, usage, cost_cny)
  values
    (v_artifact_id, p_job_id, p_attempt_id, v_next, v_sha, v_mime, v_bytes,
     v_width, v_height, v_duration, v_path, v_attempt.provider_task_id, v_job.model_name,
     v_job.model_version, 'bailian',
     encode(extensions.digest(convert_to(coalesce(v_job.request ->> 'prompt', ''), 'UTF8'), 'sha256'), 'hex'),
     v_job.brief_id, v_job.brief_version, v_job.brief_fingerprint,
     v_job.knowledge_card_ids, v_job.evidence_ids, v_job.reference_asset_id,
     v_source_url, v_usage, v_cost);

  update ams_private.g1_generation_attempts_v1 at
  set state = 'succeeded', provider_status = 'SUCCEEDED',
      provider_state = coalesce(at.provider_state, '{}'::jsonb)
        || jsonb_build_object('recovery', jsonb_build_object(
          'status', 'succeeded', 'provider_task_id', p_provider_task_id,
          'recovered_by', p_worker_id, 'recovered_at', now())),
      downloaded_sha256 = v_sha, mime_type = v_mime, byte_size = v_bytes,
      width = v_width, height = v_height, duration_seconds = v_duration,
      usage = v_usage, cost_cny = v_cost, completed_at = now(),
      lease_expires_at = null, claimed_by = null,
      diagnostics = coalesce(at.diagnostics, '{}'::jsonb)
        || jsonb_build_object('recovery_status', 'succeeded')
  where at.id = p_attempt_id and at.job_id = p_job_id;

  update ams_private.g1_generation_jobs_v1 j
  set status = 'completed', updated_at = now(),
      diagnostics = coalesce(j.diagnostics, '{}'::jsonb)
        || jsonb_build_object('recovery_status', 'succeeded')
  where j.id = p_job_id;

  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'attempt.recovery_succeeded',
    jsonb_build_object('from_state', 'ambiguous', 'provider_task_id', p_provider_task_id,
      'provider_status', p_provider_status, 'worker_id', p_worker_id));
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'artifact.created',
    jsonb_build_object('artifact_id', v_artifact_id, 'artifact_version', v_next,
      'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
      'recovered', true));
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'job.completed',
    jsonb_build_object('artifact_version', v_next, 'recovered', true));

  return jsonb_build_object('ok', true, 'artifact', jsonb_build_object(
    'id', v_artifact_id, 'artifact_version', v_next,
    'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
    'storage_path', v_path));
end;
$$;

revoke all on function api.g1_get_ambiguous_recovery_context(text, text, text)
  from public, anon, authenticated;
revoke all on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function api.g1_get_ambiguous_recovery_context(text, text, text)
  to service_role;
grant execute on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb)
  to service_role;

comment on function api.g1_get_ambiguous_recovery_context(text, text, text) is
  'G1 read-only context for recovery of the exact existing ambiguous provider task (service-role only).';
comment on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb) is
  'G1 atomic artifact recovery for an already-succeeded provider task; never submits provider work (service-role only).';
