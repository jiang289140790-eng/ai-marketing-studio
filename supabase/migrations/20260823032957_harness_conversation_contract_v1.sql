-- Harness conversation contract v1. Staging rollout only.
-- The private schema is authoritative; clients reach it through the authenticated
-- harness-command gateway and never receive service-role credentials.

create schema if not exists ams_private;

create table ams_private.harness_threads_v1 (
  id text primary key default ('thr_' || gen_random_uuid()::text),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null,
  project_id text,
  title text,
  status text not null default 'active'
    check (status in ('active', 'generating', 'waiting_confirmation', 'executing', 'completed', 'failed', 'blocked', 'stopped')),
  current_task_id text,
  native_session_id text,
  active_generation_id text,
  active_generation_lease_until timestamptz,
  stop_requested_at timestamptz,
  create_request_id text not null,
  latest_event_cursor bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  schema_version integer not null default 1 check (schema_version = 1),
  unique (user_id, workspace_id, create_request_id)
);

create table ams_private.harness_generation_requests_v1 (
  thread_id text not null references ams_private.harness_threads_v1(id) on delete cascade,
  generation_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null,
  status text not null check (status in ('active','active_recovered','completed','failed','stopped','waiting_confirmation','executing','blocked')),
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (thread_id, generation_id)
);

create table ams_private.harness_messages_v1 (
  id text primary key default ('msg_' || gen_random_uuid()::text),
  thread_id text not null references ams_private.harness_threads_v1(id) on delete cascade,
  task_id text,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null,
  project_id text,
  sequence bigint not null,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  kind text not null check (kind in ('text', 'plan', 'tool_call', 'tool_result', 'approval', 'progress', 'evidence', 'analysis', 'knowledge', 'brief', 'artifact', 'error')),
  status text not null default 'completed'
    check (status in ('accepted', 'streaming', 'completed', 'failed', 'blocked', 'stopped')),
  content text,
  structured_payload jsonb not null default '{}'::jsonb,
  request_id text not null,
  client_message_id text,
  parent_message_id text references ams_private.harness_messages_v1(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  error_message text,
  schema_version integer not null default 1 check (schema_version = 1),
  unique (thread_id, sequence),
  unique (thread_id, request_id)
);

create sequence ams_private.harness_event_cursor_v1;

create table ams_private.harness_events_v1 (
  id text primary key default ('evt_' || gen_random_uuid()::text),
  cursor bigint not null default nextval('ams_private.harness_event_cursor_v1'),
  thread_id text not null references ams_private.harness_threads_v1(id) on delete cascade,
  task_id text,
  message_id text references ams_private.harness_messages_v1(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null,
  request_id text not null,
  event_type text not null check (event_type in (
    'assistant_text_delta', 'assistant_text_completed', 'plan_created',
    'tool_call_started', 'tool_call_completed', 'approval_requested',
    'task_progress', 'task_completed', 'task_partial', 'task_failed', 'task_blocked', 'task_cancelled',
    'evidence_result', 'analysis_result', 'knowledge_result', 'brief_result', 'artifact_result',
    'error', 'generation_stopped'
  )),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  schema_version integer not null default 1 check (schema_version = 1),
  unique (thread_id, cursor),
  unique (thread_id, request_id)
);

create index harness_threads_v1_owner_idx
  on ams_private.harness_threads_v1 (user_id, workspace_id, updated_at desc);
create index harness_messages_v1_page_idx
  on ams_private.harness_messages_v1 (thread_id, sequence);
create index harness_messages_v1_task_idx
  on ams_private.harness_messages_v1 (task_id) where task_id is not null;
create index harness_events_v1_replay_idx
  on ams_private.harness_events_v1 (thread_id, cursor);
create index harness_events_v1_task_idx
  on ams_private.harness_events_v1 (task_id) where task_id is not null;

alter table ams_private.harness_threads_v1 enable row level security;
alter table ams_private.harness_threads_v1 force row level security;
alter table ams_private.harness_generation_requests_v1 enable row level security;
alter table ams_private.harness_generation_requests_v1 force row level security;
alter table ams_private.harness_messages_v1 enable row level security;
alter table ams_private.harness_messages_v1 force row level security;
alter table ams_private.harness_events_v1 enable row level security;
alter table ams_private.harness_events_v1 force row level security;

create policy harness_threads_v1_owner_all
  on ams_private.harness_threads_v1
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy harness_messages_v1_owner_all
  on ams_private.harness_messages_v1
  for all to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from ams_private.harness_threads_v1 t
      where t.id = thread_id and t.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from ams_private.harness_threads_v1 t
      where t.id = thread_id and t.user_id = (select auth.uid())
    )
  );

create policy harness_events_v1_owner_select
  on ams_private.harness_events_v1
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from ams_private.harness_threads_v1 t
      where t.id = thread_id and t.user_id = (select auth.uid())
    )
  );

-- Events are append-only for authenticated callers. The gateway service role is
-- responsible for projection writes after it has validated thread ownership.
revoke insert, update, delete on ams_private.harness_events_v1 from authenticated;
revoke all on sequence ams_private.harness_event_cursor_v1 from anon, authenticated;
revoke all on ams_private.harness_threads_v1 from anon;
revoke all on ams_private.harness_generation_requests_v1 from anon, authenticated;
revoke all on ams_private.harness_messages_v1 from anon;
revoke all on ams_private.harness_events_v1 from anon;

comment on table ams_private.harness_threads_v1 is
  'Authoritative Harness conversation threads, schema v1.';
comment on table ams_private.harness_messages_v1 is
  'Versioned persisted message envelopes; secrets and authorization headers are forbidden.';
comment on table ams_private.harness_events_v1 is
  'Append-only replayable conversation event stream with stable cursors.';

create schema if not exists api;

create or replace function api.harness_create_thread_v1(
  p_user_id uuid,
  p_workspace_id text,
  p_project_id text,
  p_request_id text,
  p_title text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread ams_private.harness_threads_v1%rowtype;
begin
  if p_user_id is null or btrim(coalesce(p_workspace_id, '')) <> 'ai-marketing-studio-staging'
    or nullif(btrim(p_request_id), '') is null then
    raise exception 'invalid_thread_request' using errcode = '22023';
  end if;

  insert into ams_private.harness_threads_v1 (
    user_id, workspace_id, project_id, title, create_request_id
  ) values (
    p_user_id, btrim(p_workspace_id), nullif(btrim(p_project_id), ''),
    nullif(left(btrim(p_title), 200), ''), left(btrim(p_request_id), 200)
  )
  on conflict (user_id, workspace_id, create_request_id) do update
    set updated_at = ams_private.harness_threads_v1.updated_at
  returning * into v_thread;

  return jsonb_build_object(
    'threadId', v_thread.id,
    'createdAt', v_thread.created_at,
    'currentTaskId', v_thread.current_task_id,
    'eventCursor', v_thread.latest_event_cursor,
    'schemaVersion', v_thread.schema_version
  );
end;
$$;

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
      'title', t.title, 'status', t.status, 'createdAt', t.created_at,
      'updatedAt', t.updated_at, 'schemaVersion', t.schema_version
    ),
    'currentTaskId', t.current_task_id,
    'nativeSessionId', t.native_session_id,
    'eventCursor', t.latest_event_cursor,
    'permission', 'owner',
    'actions', jsonb_build_object(
      'sendMessage', t.status <> 'blocked',
      'stopGeneration', t.active_generation_id is not null,
      'cancelTask', t.current_task_id is not null
    )
  )
  from ams_private.harness_threads_v1 t
  where t.id = p_thread_id and t.user_id = p_user_id;
$$;

create or replace function api.harness_get_thread_by_task_v1(
  p_user_id uuid,
  p_task_id text
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('threadId', t.id, 'currentTaskId', t.current_task_id)
  from ams_private.harness_threads_v1 t
  where t.user_id = p_user_id and t.current_task_id = p_task_id
    and t.workspace_id = 'ai-marketing-studio-staging'
  order by t.updated_at desc
  limit 1;
$$;

create or replace function api.harness_append_message_v1(
  p_user_id uuid,
  p_thread_id text,
  p_request_id text,
  p_role text,
  p_kind text,
  p_status text,
  p_content text default null,
  p_structured_payload jsonb default '{}'::jsonb,
  p_task_id text default null,
  p_client_message_id text default null,
  p_parent_message_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread ams_private.harness_threads_v1%rowtype;
  v_message ams_private.harness_messages_v1%rowtype;
  v_sequence bigint;
begin
  if nullif(btrim(p_request_id), '') is null then
    raise exception 'invalid_message_request' using errcode = '22023';
  end if;

  select * into v_thread
  from ams_private.harness_threads_v1
  where id = p_thread_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'thread_not_found' using errcode = 'P0002';
  end if;

  select * into v_message
  from ams_private.harness_messages_v1
  where thread_id = p_thread_id and request_id = left(btrim(p_request_id), 200);
  if found then
    return to_jsonb(v_message) || jsonb_build_object('replayed', true);
  end if;

  select coalesce(max(sequence), 0) + 1 into v_sequence
  from ams_private.harness_messages_v1 where thread_id = p_thread_id;

  insert into ams_private.harness_messages_v1 (
    thread_id, task_id, user_id, workspace_id, project_id, sequence,
    role, kind, status, content, structured_payload, request_id,
    client_message_id, parent_message_id, completed_at
  ) values (
    p_thread_id, nullif(btrim(p_task_id), ''), p_user_id, v_thread.workspace_id,
    v_thread.project_id, v_sequence, p_role, p_kind, p_status,
    nullif(p_content, ''), coalesce(p_structured_payload, '{}'::jsonb),
    left(btrim(p_request_id), 200), nullif(left(btrim(p_client_message_id), 200), ''),
    nullif(btrim(p_parent_message_id), ''),
    case when p_status = 'completed' then now() else null end
  ) returning * into v_message;

  update ams_private.harness_threads_v1
  set updated_at = now() where id = p_thread_id;
  return to_jsonb(v_message) || jsonb_build_object('replayed', false);
end;
$$;

create or replace function api.harness_list_messages_v1(
  p_user_id uuid,
  p_thread_id text,
  p_after_sequence bigint default 0,
  p_limit integer default 100
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with page as (
    select m.*
    from ams_private.harness_messages_v1 m
    join ams_private.harness_threads_v1 t on t.id = m.thread_id
    where m.thread_id = p_thread_id and t.user_id = p_user_id
      and m.sequence > greatest(coalesce(p_after_sequence, 0), 0)
    order by m.sequence asc
    limit least(greatest(coalesce(p_limit, 100), 1), 200)
  )
  select jsonb_build_object(
    'messages', coalesce(jsonb_agg(to_jsonb(page) order by sequence), '[]'::jsonb),
    'nextCursor', coalesce(max(sequence), greatest(coalesce(p_after_sequence, 0), 0))
  ) from page;
$$;

create or replace function api.harness_append_event_v1(
  p_user_id uuid,
  p_thread_id text,
  p_request_id text,
  p_event_type text,
  p_payload jsonb default '{}'::jsonb,
  p_task_id text default null,
  p_message_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread ams_private.harness_threads_v1%rowtype;
  v_event ams_private.harness_events_v1%rowtype;
begin
  select * into v_thread from ams_private.harness_threads_v1
  where id = p_thread_id and user_id = p_user_id for update;
  if not found then raise exception 'thread_not_found' using errcode = 'P0002'; end if;

  select * into v_event from ams_private.harness_events_v1
  where thread_id = p_thread_id and request_id = left(btrim(p_request_id), 200);
  if found then return to_jsonb(v_event) || jsonb_build_object('replayed', true); end if;

  insert into ams_private.harness_events_v1 (
    thread_id, task_id, message_id, user_id, workspace_id, request_id, event_type, payload
  ) values (
    p_thread_id, nullif(btrim(p_task_id), ''), nullif(btrim(p_message_id), ''),
    p_user_id, v_thread.workspace_id, left(btrim(p_request_id), 200), p_event_type, coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_event;

  update ams_private.harness_threads_v1
  set latest_event_cursor = v_event.cursor, updated_at = now()
  where id = p_thread_id;
  return to_jsonb(v_event) || jsonb_build_object('replayed', false);
end;
$$;

create or replace function api.harness_list_events_v1(
  p_user_id uuid,
  p_thread_id text,
  p_after_cursor bigint default 0,
  p_limit integer default 200
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with page as (
    select e.* from ams_private.harness_events_v1 e
    join ams_private.harness_threads_v1 t on t.id = e.thread_id
    where e.thread_id = p_thread_id and t.user_id = p_user_id
      and e.cursor > greatest(coalesce(p_after_cursor, 0), 0)
    order by e.cursor asc
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  )
  select jsonb_build_object(
    'events', coalesce(jsonb_agg(to_jsonb(page) order by cursor), '[]'::jsonb),
    'nextCursor', coalesce(max(cursor), greatest(coalesce(p_after_cursor, 0), 0))
  ) from page;
$$;

create or replace function api.harness_complete_message_v1(
  p_user_id uuid,
  p_thread_id text,
  p_message_id text,
  p_status text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_message ams_private.harness_messages_v1%rowtype;
begin
  update ams_private.harness_messages_v1 m set
    status = p_status,
    completed_at = now()
  from ams_private.harness_threads_v1 t
  where m.id = p_message_id and m.thread_id = p_thread_id
    and t.id = m.thread_id and t.user_id = p_user_id
  returning m.* into v_message;
  if not found then raise exception 'message_not_found' using errcode = 'P0002'; end if;
  return to_jsonb(v_message);
end;
$$;

create or replace function api.harness_project_task_event_v1(
  p_user_id uuid,
  p_task jsonb,
  p_gateway_event text,
  p_event_at timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_id text := p_task ->> 'id';
  v_state text := p_task ->> 'state';
  v_updated text := p_task ->> 'updated_at';
  v_thread ams_private.harness_threads_v1%rowtype;
  v_message jsonb;
  v_step record;
  v_step_plan jsonb;
  v_step_state text;
  v_call jsonb;
  v_result jsonb;
  v_ref text;
  v_artifact jsonb;
  v_entity jsonb;
  v_kind text;
  v_event_type text;
begin
  if p_user_id is null or v_task_id is null or v_updated is null or p_event_at is null then
    raise exception 'invalid_task_projection' using errcode = '22023';
  end if;
  select * into v_thread from ams_private.harness_threads_v1
  where user_id = p_user_id and current_task_id = v_task_id
    and workspace_id = 'ai-marketing-studio-staging'
    and project_id is not distinct from nullif(p_task #>> '{request,project_id}', '')
  order by updated_at desc limit 1;
  if not found then return jsonb_build_object('projected', false, 'reason', 'thread_not_bound'); end if;

  if v_state = 'planned' then
    v_message := api.harness_append_message_v1(
      p_user_id, v_thread.id, v_task_id || ':plan:' || v_updated, 'assistant', 'plan', 'completed',
      coalesce(p_task #>> '{plan,workflow_title}', '执行计划已生成'), coalesce(p_task->'plan', '{}'::jsonb),
      v_task_id, null, null
    );
    perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_message->>'id') || ':plan', 'plan_created',
      jsonb_build_object('messageId', v_message->>'id', 'plan', p_task->'plan'), v_task_id, v_message->>'id');
    if exists (select 1 from jsonb_each(coalesce(p_task #> '{plan,approvals}', '{}'::jsonb)) a where a.value = 'true'::jsonb) then
      perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_message->>'id') || ':approval', 'approval_requested',
        jsonb_build_object('messageId', v_message->>'id', 'taskId', v_task_id, 'approval', p_task #> '{plan,approvals}'), v_task_id, v_message->>'id');
    end if;
  end if;

  for v_step in select key, value from jsonb_each(coalesce(p_task->'step_states', '{}'::jsonb)) loop
    if coalesce(v_step.value->>'state', '') not in ('running','succeeded','reused','failed','blocked') then continue; end if;
    v_step_state := v_step.value->>'state';
    if v_step_state = 'running' and v_state = 'cancelled' then v_step_state := 'cancelled'; end if;
    if v_step_state = 'running' and v_state = 'partial' then v_step_state := 'blocked'; end if;
    if v_step_state = 'running' and v_state = 'failed' then v_step_state := 'failed'; end if;
    select value into v_step_plan from jsonb_array_elements(coalesce(p_task #> '{plan,steps}', '[]'::jsonb))
      where value->>'step' = v_step.key or value->>'id' = v_step.key limit 1;
    v_call := api.harness_append_message_v1(
      p_user_id, v_thread.id, v_task_id || ':step:' || v_step.key || ':call', 'tool', 'tool_call',
      case when v_step_state = 'running' then 'streaming' else 'completed' end,
      coalesce(v_step_plan->>'title', v_step_plan->>'operation', v_step.key),
      jsonb_build_object('stepId', v_step.key, 'operation', v_step_plan->>'operation'), v_task_id, null, null
    );
    perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_call->>'id') || ':started', 'tool_call_started',
      jsonb_build_object('messageId', v_call->>'id', 'stepId', v_step.key, 'operation', v_step_plan->>'operation'), v_task_id, v_call->>'id');
    if v_step_state <> 'running' then
      perform api.harness_complete_message_v1(p_user_id, v_thread.id, v_call->>'id',
        case v_step_state when 'failed' then 'failed' when 'blocked' then 'blocked' when 'cancelled' then 'stopped' else 'completed' end);
      v_result := api.harness_append_message_v1(
        p_user_id, v_thread.id, v_task_id || ':step:' || v_step.key || ':result:' || v_updated, 'tool', 'tool_result',
        case v_step_state when 'failed' then 'failed' when 'blocked' then 'blocked' when 'cancelled' then 'stopped' else 'completed' end,
        coalesce(v_step_plan->>'title', v_step_plan->>'operation', v_step.key) || ': ' || v_step_state,
        jsonb_build_object('stepId', v_step.key, 'operation', v_step_plan->>'operation', 'state', v_step_state, 'result', v_step.value), v_task_id, null, v_call->>'id'
      );
      perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_result->>'id') || ':completed', 'tool_call_completed',
        jsonb_build_object('messageId', v_result->>'id', 'stepId', v_step.key, 'state', v_step_state), v_task_id, v_result->>'id');
    end if;
  end loop;

  v_event_type := case v_state when 'failed' then 'task_failed' when 'blocked' then 'task_blocked'
    when 'cancelled' then 'task_cancelled' when 'succeeded' then 'task_completed' when 'reused' then 'task_completed'
    when 'partial' then 'task_partial' else 'task_progress' end;
  v_message := api.harness_append_message_v1(
    p_user_id, v_thread.id, v_task_id || ':snapshot:' || v_updated, 'system',
    case when v_state in ('failed','blocked','cancelled','partial') then 'error' when v_event_type = 'task_completed' then 'artifact' else 'progress' end,
    case when v_state = 'failed' then 'failed' when v_state in ('blocked','partial') then 'blocked' when v_state = 'cancelled' then 'stopped' else 'completed' end,
    '任务状态：' || v_state, jsonb_build_object('state', v_state, 'updatedAt', v_updated, 'error', p_task->'error'),
    v_task_id, null, null
  );
  perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_message->>'id') || ':' || v_event_type, v_event_type,
    jsonb_build_object('messageId', v_message->>'id', 'state', v_state, 'updatedAt', v_updated), v_task_id, v_message->>'id');

  if v_event_type in ('task_completed','task_partial','task_failed','task_blocked','task_cancelled') then
    update ams_private.harness_messages_v1
    set status = case when v_state = 'cancelled' then 'stopped' when v_state in ('partial','blocked') then 'blocked' when v_state = 'failed' then 'failed' else 'completed' end,
        completed_at = coalesce(completed_at, now())
    where thread_id = v_thread.id and task_id = v_task_id and kind = 'tool_call' and status = 'streaming';

    for v_artifact in select value from jsonb_array_elements(coalesce(p_task #> '{result,artifact_entities}', '[]'::jsonb)) loop
      v_ref := v_artifact->>'id'; v_entity := null; v_kind := null;
      case v_artifact->>'type'
        when 'evidence' then select payload, 'evidence' into v_entity, v_kind from ams_private.p19_evidence_records_v1 where user_id=p_user_id and project_id=p_task #>> '{request,project_id}' and payload->>'id'=v_ref order by created_at desc limit 1;
        when 'analysis' then select payload, 'analysis' into v_entity, v_kind from ams_private.p19_analyses_v1 where user_id=p_user_id and project_id=p_task #>> '{request,project_id}' and payload->>'id'=v_ref order by created_at desc limit 1;
        when 'card' then select payload, 'knowledge' into v_entity, v_kind from ams_private.p19_knowledge_cards_v1 where user_id=p_user_id and project_id=p_task #>> '{request,project_id}' and payload->>'id'=v_ref order by created_at desc limit 1;
        when 'brief' then select payload, 'brief' into v_entity, v_kind from ams_private.p19_briefs_v1 where user_id=p_user_id and project_id=p_task #>> '{request,project_id}' and payload->>'id'=v_ref order by created_at desc limit 1;
        when 'handoff' then select payload, 'artifact' into v_entity, v_kind from ams_private.p19_handoff_packages_v1 where user_id=p_user_id and project_id=p_task #>> '{request,project_id}' and payload->>'id'=v_ref order by created_at desc limit 1;
        else continue;
      end case;
      if v_entity is not null then
        v_result := api.harness_append_message_v1(p_user_id, v_thread.id, v_task_id || ':result:' || v_ref, 'assistant', v_kind, 'completed', v_kind || ' 已生成', v_entity, v_task_id, null, null);
        perform api.harness_append_event_v1(p_user_id, v_thread.id, (v_result->>'id') || ':result',
          case v_kind when 'evidence' then 'evidence_result' when 'analysis' then 'analysis_result' when 'knowledge' then 'knowledge_result' when 'brief' then 'brief_result' else 'artifact_result' end,
          jsonb_build_object('messageId', v_result->>'id', 'result', v_entity), v_task_id, v_result->>'id');
      end if;
    end loop;
  end if;

  update ams_private.harness_threads_v1 set
    status = case when v_state in ('succeeded','reused') then 'completed' when v_state='failed' then 'failed' when v_state in ('blocked','partial') then 'blocked' when v_state='cancelled' then 'stopped' when v_state='planned' then 'waiting_confirmation' else 'executing' end,
    updated_at = now()
  where id = v_thread.id;
  return jsonb_build_object('projected', true, 'threadId', v_thread.id, 'taskId', v_task_id, 'state', v_state);
end;
$$;

create or replace function api.harness_set_thread_runtime_v1(
  p_user_id uuid,
  p_thread_id text,
  p_status text,
  p_native_session_id text default null,
  p_current_task_id text default null,
  p_active_generation_id text default null,
  p_clear_current_task boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_thread ams_private.harness_threads_v1%rowtype;
begin
  update ams_private.harness_threads_v1 set
    status = p_status,
    native_session_id = coalesce(nullif(btrim(p_native_session_id), ''), native_session_id),
    current_task_id = case when p_clear_current_task then null else coalesce(nullif(btrim(p_current_task_id), ''), current_task_id) end,
    active_generation_id = nullif(btrim(p_active_generation_id), ''),
    active_generation_lease_until = case when nullif(btrim(p_active_generation_id), '') is null then null else now() + interval '15 minutes' end,
    stop_requested_at = case when p_active_generation_id is null then null else stop_requested_at end,
    updated_at = now()
  where id = p_thread_id and user_id = p_user_id
  returning * into v_thread;
  if not found then raise exception 'thread_not_found' using errcode = 'P0002'; end if;
  return to_jsonb(v_thread);
end;
$$;

create or replace function api.harness_claim_generation_v1(
  p_user_id uuid,
  p_thread_id text,
  p_generation_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thread ams_private.harness_threads_v1%rowtype;
  v_request ams_private.harness_generation_requests_v1%rowtype;
begin
  select * into v_thread from ams_private.harness_threads_v1
  where id = p_thread_id and user_id = p_user_id and workspace_id = 'ai-marketing-studio-staging'
  for update;
  if not found then raise exception 'thread_not_found' using errcode = 'P0002'; end if;

  select * into v_request from ams_private.harness_generation_requests_v1
  where thread_id = p_thread_id and generation_id = p_generation_id;
  if found and v_request.status not in ('active','active_recovered') then
    return jsonb_build_object('claimed', false, 'reason', 'generation_replayed', 'status', v_request.status);
  end if;
  if found and v_request.lease_until >= now() then
    return jsonb_build_object('claimed', false, 'reason', 'generation_active');
  end if;
  if v_thread.active_generation_id is not null and v_thread.active_generation_lease_until >= now()
    and v_thread.active_generation_id <> p_generation_id then
    return jsonb_build_object('claimed', false, 'reason', 'generation_active');
  end if;

  insert into ams_private.harness_generation_requests_v1(thread_id,generation_id,user_id,workspace_id,status,lease_until)
  values (p_thread_id,p_generation_id,p_user_id,'ai-marketing-studio-staging','active',now()+interval '15 minutes')
  on conflict (thread_id,generation_id) do update set status='active_recovered', lease_until=excluded.lease_until;
  update ams_private.harness_threads_v1 set active_generation_id=p_generation_id,
    active_generation_lease_until=now()+interval '15 minutes', stop_requested_at=null, status='generating', updated_at=now()
  where id=p_thread_id;
  return jsonb_build_object('claimed', true, 'generationId', p_generation_id, 'recovered', v_request.generation_id is not null);
end;
$$;

create or replace function api.harness_release_generation_v1(
  p_user_id uuid,
  p_thread_id text,
  p_generation_id text,
  p_status text,
  p_clear_current_task boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_thread ams_private.harness_threads_v1%rowtype;
begin
  update ams_private.harness_threads_v1 set
    status = p_status,
    current_task_id = case when p_clear_current_task then null else current_task_id end,
    active_generation_id = null,
    active_generation_lease_until = null,
    stop_requested_at = null,
    updated_at = now()
  where id = p_thread_id and user_id = p_user_id and active_generation_id = p_generation_id
  returning * into v_thread;
  if found then
    update ams_private.harness_generation_requests_v1
    set status = case when p_status in ('active','generating') then 'executing' else p_status end,
        lease_until = null, completed_at = now()
    where thread_id=p_thread_id and generation_id=p_generation_id and user_id=p_user_id;
  end if;
  return jsonb_build_object('released', found, 'status', case when found then v_thread.status else null end);
end;
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
  update ams_private.harness_threads_v1 set stop_requested_at = now(), updated_at = now()
  where id = p_thread_id and user_id = p_user_id and active_generation_id is not null
  returning * into v_thread;
  if not found then
    if not exists (select 1 from ams_private.harness_threads_v1 where id = p_thread_id and user_id = p_user_id) then
      raise exception 'thread_not_found' using errcode = 'P0002';
    end if;
    return jsonb_build_object('accepted', false, 'reason', 'no_active_generation');
  end if;
  return jsonb_build_object('accepted', true, 'generationId', v_thread.active_generation_id);
end;
$$;

revoke all on function api.harness_create_thread_v1(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function api.harness_get_thread_v1(uuid, text) from public, anon, authenticated;
revoke all on function api.harness_get_thread_by_task_v1(uuid, text) from public, anon, authenticated;
revoke all on function api.harness_append_message_v1(uuid, text, text, text, text, text, text, jsonb, text, text, text) from public, anon, authenticated;
revoke all on function api.harness_list_messages_v1(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function api.harness_append_event_v1(uuid, text, text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function api.harness_list_events_v1(uuid, text, bigint, integer) from public, anon, authenticated;
revoke all on function api.harness_complete_message_v1(uuid, text, text, text) from public, anon, authenticated;
revoke all on function api.harness_project_task_event_v1(uuid, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function api.harness_set_thread_runtime_v1(uuid, text, text, text, text, text, boolean) from public, anon, authenticated;
revoke all on function api.harness_claim_generation_v1(uuid, text, text) from public, anon, authenticated;
revoke all on function api.harness_release_generation_v1(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function api.harness_request_stop_v1(uuid, text) from public, anon, authenticated;

grant execute on function api.harness_create_thread_v1(uuid, text, text, text, text) to service_role;
grant execute on function api.harness_get_thread_v1(uuid, text) to service_role;
grant execute on function api.harness_get_thread_by_task_v1(uuid, text) to service_role;
grant execute on function api.harness_append_message_v1(uuid, text, text, text, text, text, text, jsonb, text, text, text) to service_role;
grant execute on function api.harness_list_messages_v1(uuid, text, bigint, integer) to service_role;
grant execute on function api.harness_append_event_v1(uuid, text, text, text, jsonb, text, text) to service_role;
grant execute on function api.harness_list_events_v1(uuid, text, bigint, integer) to service_role;
grant execute on function api.harness_complete_message_v1(uuid, text, text, text) to service_role;
grant execute on function api.harness_project_task_event_v1(uuid, jsonb, text, timestamptz) to service_role;
grant execute on function api.harness_set_thread_runtime_v1(uuid, text, text, text, text, text, boolean) to service_role;
grant execute on function api.harness_claim_generation_v1(uuid, text, text) to service_role;
grant execute on function api.harness_release_generation_v1(uuid, text, text, text, boolean) to service_role;
grant execute on function api.harness_request_stop_v1(uuid, text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'harness-thread-attachments', 'harness-thread-attachments', false, 26214400,
  array['image/jpeg','image/png','image/webp','video/mp4','application/pdf','text/plain','text/markdown','text/csv','application/json']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function api.harness_can_access_thread_v1(p_thread_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from ams_private.harness_threads_v1
    where id = p_thread_id and user_id = auth.uid()
  );
$$;
revoke all on function api.harness_can_access_thread_v1(text) from public, anon;
grant execute on function api.harness_can_access_thread_v1(text) to authenticated;

create policy harness_thread_attachments_owner_select
on storage.objects for select to authenticated
using (
  bucket_id = 'harness-thread-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and api.harness_can_access_thread_v1((storage.foldername(name))[2])
);
create policy harness_thread_attachments_owner_insert
on storage.objects for insert to authenticated
with check (
  bucket_id = 'harness-thread-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and api.harness_can_access_thread_v1((storage.foldername(name))[2])
);
create policy harness_thread_attachments_owner_delete
on storage.objects for delete to authenticated
using (
  bucket_id = 'harness-thread-attachments'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and api.harness_can_access_thread_v1((storage.foldername(name))[2])
);
