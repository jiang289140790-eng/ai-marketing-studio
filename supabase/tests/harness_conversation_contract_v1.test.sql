begin;

do $$
declare
  owner_id uuid := '00000000-0000-4000-8000-000000000101';
  other_id uuid := '00000000-0000-4000-8000-000000000102';
  created jsonb;
  replay jsonb;
  message jsonb;
  message_replay jsonb;
  event_one jsonb;
  event_two jsonb;
  history jsonb;
  events jsonb;
  thread_id text;
  fn text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
  values
    (owner_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'thread-owner@example.invalid', '', now(), now()),
    (other_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'thread-other@example.invalid', '', now(), now())
  on conflict (id) do nothing;

  foreach fn in array array[
    'api.harness_create_thread_v1(uuid,text,text,text,text)',
    'api.harness_get_thread_v1(uuid,text)',
    'api.harness_get_thread_by_task_v1(uuid,text)',
    'api.harness_append_message_v1(uuid,text,text,text,text,text,text,jsonb,text,text,text)',
    'api.harness_list_messages_v1(uuid,text,bigint,integer)',
    'api.harness_append_event_v1(uuid,text,text,text,jsonb,text,text)',
    'api.harness_list_events_v1(uuid,text,bigint,integer)',
    'api.harness_complete_message_v1(uuid,text,text,text)',
    'api.harness_project_task_event_v1(uuid,jsonb,text,timestamp with time zone)',
    'api.harness_set_thread_runtime_v1(uuid,text,text,text,text,text,boolean)',
    'api.harness_claim_generation_v1(uuid,text,text)',
    'api.harness_release_generation_v1(uuid,text,text,text,boolean)',
    'api.harness_request_stop_v1(uuid,text)'
    ,'api.harness_prepare_generation_delivery_v1(uuid,text,text,text)'
    ,'api.harness_claim_and_prepare_generation_v1(uuid,text,text,text)'
    ,'api.harness_ack_generation_delivery_v1(uuid,text,text,text,text)'
    ,'api.harness_fail_generation_delivery_v1(uuid,text,text,text,text)'
    ,'api.harness_close_generation_delivery_v1(uuid,text,text,text,text)'
    ,'api.harness_apply_generation_event_v1(uuid,text,text,text,text,text,jsonb)'
  ] loop
    if has_function_privilege('anon', fn, 'execute')
      or has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'client role can execute %', fn;
    end if;
    if not has_function_privilege('service_role', fn, 'execute') then
      raise exception 'service_role cannot execute %', fn;
    end if;
  end loop;

  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_threads_v1'::regclass) then
    raise exception 'thread RLS must be enabled and forced';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_generation_requests_v1'::regclass) then
    raise exception 'generation request RLS must be enabled and forced';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_generation_deliveries_v1'::regclass) then
    raise exception 'generation delivery RLS must be enabled and forced';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_generation_event_receipts_v1'::regclass) then
    raise exception 'generation event receipt RLS must be enabled and forced';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_messages_v1'::regclass) then
    raise exception 'message RLS must be enabled and forced';
  end if;
  if not (select relrowsecurity and relforcerowsecurity
          from pg_class where oid = 'ams_private.harness_events_v1'::regclass) then
    raise exception 'event RLS must be enabled and forced';
  end if;
  if (select public from storage.buckets where id = 'harness-thread-attachments') is distinct from false then
    raise exception 'thread attachment bucket must be private';
  end if;
  if has_function_privilege('anon', 'api.harness_can_access_thread_v1(text)', 'execute')
    or not has_function_privilege('authenticated', 'api.harness_can_access_thread_v1(text)', 'execute') then
    raise exception 'attachment ownership helper ACL is invalid';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'harness_thread_attachments_owner_%') <> 3 then
    raise exception 'attachment storage policies are incomplete';
  end if;

  begin
    perform api.harness_create_thread_v1(owner_id, 'workspace-a', 'project-a', 'cross-workspace', 'Denied');
    raise exception 'cross-workspace thread creation succeeded';
  exception when sqlstate '22023' then null;
  end;
  created := api.harness_create_thread_v1(owner_id, 'ai-marketing-studio-staging', 'project-a', 'create-1', 'Conversation');
  replay := api.harness_create_thread_v1(owner_id, 'ai-marketing-studio-staging', 'project-a', 'create-1', 'Ignored replay title');
  thread_id := created->>'threadId';
  if thread_id is null or replay->>'threadId' <> thread_id then
    raise exception 'thread request idempotency failed';
  end if;
  if api.harness_get_thread_v1(other_id, thread_id) is not null then
    raise exception 'cross-user thread read succeeded';
  end if;

  message := api.harness_append_message_v1(
    owner_id, thread_id, 'message-1', 'user', 'text', 'completed',
    'hello', '{}'::jsonb, null, 'client-1', null
  );
  message_replay := api.harness_append_message_v1(
    owner_id, thread_id, 'message-1', 'user', 'text', 'completed',
    'must not overwrite', '{}'::jsonb, null, 'client-1', null
  );
  if message->>'id' <> message_replay->>'id'
    or message_replay->>'content' <> 'hello' then
    raise exception 'message request idempotency failed';
  end if;
  perform api.harness_complete_message_v1(owner_id, thread_id, message->>'id', 'completed');

  perform api.harness_append_message_v1(
    owner_id, thread_id, 'message-2', 'assistant', 'text', 'completed',
    'real response', '{}'::jsonb, null, null, message->>'id'
  );
  history := api.harness_list_messages_v1(owner_id, thread_id, 0, 100);
  if jsonb_array_length(history->'messages') <> 2
    or (history->'messages'->0->>'sequence')::bigint <> 1
    or (history->'messages'->1->>'sequence')::bigint <> 2 then
    raise exception 'stable message history failed';
  end if;
  if jsonb_array_length((api.harness_list_messages_v1(other_id, thread_id, 0, 100))->'messages') <> 0 then
    raise exception 'cross-user message read succeeded';
  end if;

  event_one := api.harness_append_event_v1(
    owner_id, thread_id, 'event-1', 'assistant_text_delta', jsonb_build_object('delta', 'real'), null, null
  );
  event_two := api.harness_append_event_v1(
    owner_id, thread_id, 'event-2', 'assistant_text_completed', jsonb_build_object('messageId', message->>'id'), null, message->>'id'
  );
  if (event_two->>'cursor')::bigint <= (event_one->>'cursor')::bigint then
    raise exception 'event cursor is not monotonic';
  end if;
  events := api.harness_list_events_v1(owner_id, thread_id, (event_one->>'cursor')::bigint, 100);
  if jsonb_array_length(events->'events') <> 1
    or events->'events'->0->>'event_type' <> 'assistant_text_completed' then
    raise exception 'cursor replay failed';
  end if;
  if jsonb_array_length((api.harness_list_events_v1(other_id, thread_id, 0, 100))->'events') <> 0 then
    raise exception 'cross-user event read succeeded';
  end if;

  if not ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-1'))->>'claimed')::boolean then
    raise exception 'first generation claim failed';
  end if;
  if ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-2'))->>'claimed')::boolean then
    raise exception 'concurrent generation claim succeeded';
  end if;
  if not ((api.harness_request_stop_v1(owner_id, thread_id))->>'accepted')::boolean then
    raise exception 'active generation stop was not accepted';
  end if;
  if (select current_task_id from ams_private.harness_threads_v1 where id = thread_id) is not null then
    raise exception 'assistant stop must not create or cancel a task';
  end if;
  if not ((api.harness_release_generation_v1(owner_id, thread_id, 'generation-1', 'stopped', true))->>'released')::boolean then
    raise exception 'generation release failed';
  end if;

  if not ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-expired'))->>'claimed')::boolean then
    raise exception 'expired lease test generation claim failed';
  end if;
  update ams_private.harness_threads_v1
  set active_generation_lease_until = now() - interval '1 minute'
  where id = thread_id;
  if ((api.harness_get_thread_v1(owner_id, thread_id)->'actions'->>'stopGeneration')::boolean) then
    raise exception 'expired generation remained stoppable';
  end if;
  if not ((api.harness_get_thread_v1(owner_id, thread_id)->'actions'->>'sendMessage')::boolean) then
    raise exception 'expired generation kept the composer disabled';
  end if;
  if ((api.harness_request_stop_v1(owner_id, thread_id))->>'accepted')::boolean then
    raise exception 'expired generation stop was accepted';
  end if;
  if not ((api.harness_release_generation_v1(owner_id, thread_id, 'generation-expired', 'failed', true))->>'released')::boolean then
    raise exception 'expired generation cleanup failed';
  end if;

  if ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-1'))->>'claimed')::boolean then
    raise exception 'completed request id reclaimed after release';
  end if;
  if (api.harness_claim_generation_v1(owner_id, thread_id, 'generation-1'))->>'reason' <> 'generation_replayed' then
    raise exception 'completed request replay outcome missing';
  end if;

  if not ((api.harness_claim_and_prepare_generation_v1(owner_id,thread_id,'generation-delivery','request-delivery'))->>'claimed')::boolean then
    raise exception 'atomic generation delivery claim failed';
  end if;
  if not exists (select 1 from ams_private.harness_generation_deliveries_v1 d
      where d.thread_id=(created->>'threadId') and d.generation_id='generation-delivery' and d.status='pending') then
    raise exception 'claim returned before delivery state was persisted';
  end if;
  perform api.harness_ack_generation_delivery_v1(owner_id,thread_id,'generation-delivery','request-delivery','gdl-contract-test');
  if (select d.status from ams_private.harness_generation_deliveries_v1 d
      where d.thread_id=(created->>'threadId') and d.generation_id='generation-delivery') <> 'accepted' then
    raise exception 'gateway acknowledgement was not persisted';
  end if;
  perform api.harness_fail_generation_delivery_v1(owner_id,thread_id,'generation-delivery','request-delivery','DELIVERY_TEST_FAILURE');
  if (select active_generation_id from ams_private.harness_threads_v1 where id=thread_id) is not null then
    raise exception 'delivery failure did not immediately release generation';
  end if;
  if not ((api.harness_claim_and_prepare_generation_v1(owner_id,thread_id,'generation-terminal','request-terminal'))->>'claimed')::boolean then
    raise exception 'terminal guard generation claim failed';
  end if;
  perform api.harness_ack_generation_delivery_v1(owner_id,thread_id,'generation-terminal','request-terminal','gdl-terminal-test');
  perform api.harness_apply_generation_event_v1(owner_id,thread_id,'generation-terminal','request-terminal',
    'event-terminal-completed','generation_completed','{}'::jsonb);
  perform api.harness_apply_generation_event_v1(owner_id,thread_id,'generation-terminal','request-terminal',
    'event-terminal-late-failure','generation_failed',jsonb_build_object('code','LATE_FAILURE'));
  if (select d.status from ams_private.harness_generation_deliveries_v1 d
      where d.thread_id=(created->>'threadId') and d.generation_id='generation-terminal') <> 'completed' then
    raise exception 'late callback regressed completed delivery';
  end if;
  if (select count(*) from ams_private.harness_generation_event_receipts_v1 r
      where r.thread_id=(created->>'threadId') and r.generation_id='generation-terminal') <> 2 then
    raise exception 'generation event receipts are not durable and idempotent';
  end if;

  if not ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-confirm'))->>'claimed')::boolean then
    raise exception 'confirm generation claim failed';
  end if;
  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'executing', 'native-1', 'ht-00000000-0000-4000-8000-000000000299', 'generation-confirm', false);
  if not ((api.harness_release_generation_v1(owner_id, thread_id, 'generation-confirm', 'executing', false))->>'released')::boolean then
    raise exception 'confirm generation was not durably released';
  end if;
  update ams_private.harness_generation_requests_v1 g set lease_until=now()-interval '1 hour'
  where g.thread_id=created->>'threadId' and g.generation_id='generation-confirm';
  if ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-confirm'))->>'claimed')::boolean then
    raise exception 'expired lease reclaimed a durably completed confirm request';
  end if;
  if (select current_task_id from ams_private.harness_threads_v1 where id=thread_id) <> 'ht-00000000-0000-4000-8000-000000000299' then
    raise exception 'confirm replay cleared or changed current task';
  end if;

  if not ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-plan'))->>'claimed')::boolean then
    raise exception 'plan generation claim failed';
  end if;
  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'waiting_confirmation', 'native-1', 'ht-00000000-0000-4000-8000-000000000298', 'generation-plan', false);
  if not ((api.harness_release_generation_v1(owner_id, thread_id, 'generation-plan', 'waiting_confirmation', false))->>'released')::boolean then
    raise exception 'plan generation was not durably released';
  end if;
  update ams_private.harness_generation_requests_v1 g set lease_until=now()-interval '1 hour'
  where g.thread_id=created->>'threadId' and g.generation_id='generation-plan';
  if ((api.harness_claim_generation_v1(owner_id, thread_id, 'generation-plan'))->>'claimed')::boolean then
    raise exception 'expired lease reclaimed a durably completed plan request';
  end if;
  if (select current_task_id from ams_private.harness_threads_v1 where id=thread_id) <> 'ht-00000000-0000-4000-8000-000000000298' then
    raise exception 'plan replay cleared or changed current task';
  end if;

  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'executing', 'native-1', 'ht-00000000-0000-4000-8000-000000000201', null, false);
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000201','state','running','updated_at','2026-08-23T10:00:00Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),
    'plan',jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('step','st-1','operation','evidence.search')),'approvals','{}'::jsonb),
    'step_states',jsonb_build_object('st-1',jsonb_build_object('state','running'))
  ), 'step_state', '2026-08-23T10:00:00Z');
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000201','state','succeeded','updated_at','2026-08-23T10:00:01Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),
    'plan',jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('step','st-1','operation','evidence.search')),'approvals','{}'::jsonb),
    'step_states',jsonb_build_object('st-1',jsonb_build_object('state','succeeded')),
    'result',jsonb_build_object('artifact_refs','[]'::jsonb)
  ), 'succeeded', '2026-08-23T10:00:01Z');
  if exists (select 1 from ams_private.harness_messages_v1 m where m.thread_id=created->>'threadId' and kind='tool_call' and status='streaming') then
    raise exception 'terminal projection left a streaming tool call';
  end if;
  if not exists (select 1 from ams_private.harness_events_v1 e where e.thread_id=created->>'threadId' and event_type='task_completed' and task_id='ht-00000000-0000-4000-8000-000000000201') then
    raise exception 'server task completion projection missing';
  end if;

  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'executing', 'native-1', 'ht-00000000-0000-4000-8000-000000000202', null, false);
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000202','state','running','updated_at','2026-08-23T10:00:02Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),
    'plan',jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('step','st-1','operation','evidence.search')),'approvals','{}'::jsonb),
    'step_states',jsonb_build_object('st-1',jsonb_build_object('state','running'))
  ), 'step_state', '2026-08-23T10:00:02Z');
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000202','state','cancelled','updated_at','2026-08-23T10:00:03Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),
    'plan',jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('step','st-1','operation','evidence.search')),'approvals','{}'::jsonb),
    'step_states',jsonb_build_object('st-1',jsonb_build_object('state','running'))
  ), 'cancelled', '2026-08-23T10:00:03Z');
  if exists (select 1 from ams_private.harness_messages_v1 m where m.thread_id=created->>'threadId' and m.task_id='ht-00000000-0000-4000-8000-000000000202' and kind='tool_call' and status='streaming') then
    raise exception 'cancelled projection left a streaming tool call';
  end if;
  if (select status from ams_private.harness_threads_v1 t where t.id=created->>'threadId') <> 'stopped' then raise exception 'cancelled task did not stop thread'; end if;

  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'executing', 'native-1', 'ht-00000000-0000-4000-8000-000000000203', null, false);
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000203','state','running','updated_at','2026-08-23T10:00:03.500Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),
    'plan',jsonb_build_object('steps',jsonb_build_array(jsonb_build_object('step','st-orphan','operation','evidence.search')),'approvals','{}'::jsonb),
    'step_states',jsonb_build_object('st-orphan',jsonb_build_object('state','running'))
  ), 'step_state', '2026-08-23T10:00:03.500Z');
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000203','state','partial','updated_at','2026-08-23T10:00:04Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),'plan',jsonb_build_object('steps','[]'::jsonb,'approvals','{}'::jsonb),
    'step_states','{}'::jsonb,'result',jsonb_build_object('artifact_refs','[]'::jsonb,'artifact_entities','[]'::jsonb)
  ), 'partial', '2026-08-23T10:00:04Z');
  if (select status from ams_private.harness_threads_v1 t where t.id=created->>'threadId') <> 'blocked' then raise exception 'partial task was falsely completed'; end if;
  if not exists (select 1 from ams_private.harness_events_v1 where task_id='ht-00000000-0000-4000-8000-000000000203' and event_type='task_partial') then raise exception 'partial event missing'; end if;
  if exists (select 1 from ams_private.harness_messages_v1 where task_id='ht-00000000-0000-4000-8000-000000000203' and kind='tool_call' and status='streaming') then raise exception 'partial terminal omitted-step snapshot left an older streaming tool call'; end if;

  perform api.harness_set_thread_runtime_v1(owner_id, thread_id, 'executing', 'native-1', 'ht-00000000-0000-4000-8000-000000000204', null, false);
  perform api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000204','state','succeeded','updated_at','2026-08-23T10:00:04.500Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','project-a'),'step_states','{}'::jsonb,
    'result',jsonb_build_object('artifact_entities',jsonb_build_array(jsonb_build_object('type','unknown','id','attacker-controlled','secret','must-not-project')))
  ), 'succeeded', '2026-08-23T10:00:04.500Z');
  if exists (select 1 from ams_private.harness_messages_v1 where task_id='ht-00000000-0000-4000-8000-000000000204' and structured_payload->>'secret'='must-not-project') then raise exception 'unknown callback artifact type was projected without an authoritative table lookup'; end if;

  if ((api.harness_project_task_event_v1(owner_id, jsonb_build_object(
    'id','ht-00000000-0000-4000-8000-000000000203','state','succeeded','updated_at','2026-08-23T10:00:05Z',
    'request',jsonb_build_object('user_id',owner_id,'project_id','other-project'),'step_states','{}'::jsonb
  ), 'succeeded', '2026-08-23T10:00:05Z'))->>'projected')::boolean then raise exception 'project-mismatched callback projected'; end if;
end;
$$;

rollback;
