-- Recover expired Harness generations and make lease validity authoritative.
-- This is intentionally limited to staging conversation state; it does not
-- create tasks or invoke the model/provider.

update ams_private.harness_generation_requests_v1
set status = 'failed',
    lease_until = null,
    completed_at = coalesce(completed_at, now())
where status in ('active', 'active_recovered')
  and lease_until < now();

update ams_private.harness_threads_v1
set status = 'failed',
    active_generation_id = null,
    active_generation_lease_until = null,
    stop_requested_at = null,
    updated_at = now()
where active_generation_id is not null
  and active_generation_lease_until < now();

create or replace function api.harness_get_thread_v1(
  p_user_id uuid,
  p_thread_id text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'thread', jsonb_build_object(
      'id', t.id, 'workspaceId', t.workspace_id, 'projectId', t.project_id,
      'title', t.title,
      'status', case
        when t.active_generation_id is not null
          and t.active_generation_lease_until < now()
          and t.status = 'generating' then 'failed'
        else t.status
      end,
      'createdAt', t.created_at, 'updatedAt', t.updated_at,
      'schemaVersion', t.schema_version
    ),
    'currentTaskId', t.current_task_id,
    'nativeSessionId', t.native_session_id,
    'eventCursor', t.latest_event_cursor,
    'permission', 'owner',
    'actions', jsonb_build_object(
      'sendMessage', t.status <> 'blocked' and not (
        t.active_generation_id is not null
        and t.active_generation_lease_until >= now()
      ),
      'stopGeneration', t.active_generation_id is not null
        and t.active_generation_lease_until >= now(),
      'cancelTask', t.current_task_id is not null
    )
  )
  from ams_private.harness_threads_v1 t
  where t.id = p_thread_id and t.user_id = p_user_id;
$$;

create or replace function api.harness_request_stop_v1(
  p_user_id uuid,
  p_thread_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_thread ams_private.harness_threads_v1%rowtype;
begin
  update ams_private.harness_threads_v1
  set stop_requested_at = now(), updated_at = now()
  where id = p_thread_id
    and user_id = p_user_id
    and active_generation_id is not null
    and active_generation_lease_until >= now()
  returning * into v_thread;
  if not found then
    if not exists (
      select 1 from ams_private.harness_threads_v1
      where id = p_thread_id and user_id = p_user_id
    ) then
      raise exception 'thread_not_found' using errcode = 'P0002';
    end if;
    return jsonb_build_object('accepted', false, 'reason', 'no_active_generation');
  end if;
  return jsonb_build_object(
    'accepted', true,
    'generationId', v_thread.active_generation_id
  );
end;
$$;

revoke all on function api.harness_get_thread_v1(uuid, text) from public, anon, authenticated;
revoke all on function api.harness_request_stop_v1(uuid, text) from public, anon, authenticated;
grant execute on function api.harness_get_thread_v1(uuid, text) to service_role;
grant execute on function api.harness_request_stop_v1(uuid, text) to service_role;
