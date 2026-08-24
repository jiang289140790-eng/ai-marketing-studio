-- A completed assistant turn is not a completed task. When the native Agent
-- created a deterministic plan during the turn, preserve the bound task and
-- leave the thread waiting for confirmation while closing only the generation.
create or replace function api.harness_apply_generation_event_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text,
  p_event_id text, p_event_type text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_delivery ams_private.harness_generation_deliveries_v1%rowtype;
declare v_message jsonb;
declare v_parent_id text;
declare v_content text;
declare v_current_task_id text;
begin
  if exists (select 1 from ams_private.harness_generation_event_receipts_v1 where event_id=p_event_id) then
    return jsonb_build_object('applied',true,'replayed',true,'eventId',p_event_id);
  end if;
  select * into v_delivery from ams_private.harness_generation_deliveries_v1
  where thread_id=p_thread_id and generation_id=p_generation_id and request_id=p_request_id and user_id=p_user_id
  for update;
  if not found then raise exception 'delivery_not_found' using errcode='P0002'; end if;
  if exists (select 1 from ams_private.harness_generation_event_receipts_v1 where event_id=p_event_id) then
    return jsonb_build_object('applied',true,'replayed',true,'eventId',p_event_id);
  end if;
  if v_delivery.status in ('completed','failed','stopped') then
    insert into ams_private.harness_generation_event_receipts_v1(event_id,thread_id,generation_id,event_type)
      values(p_event_id,p_thread_id,p_generation_id,p_event_type) on conflict do nothing;
    return jsonb_build_object('applied',false,'ignored',true,'terminalStatus',v_delivery.status,'eventId',p_event_id);
  end if;
  select id into v_parent_id from ams_private.harness_messages_v1
    where thread_id=p_thread_id and request_id=p_request_id and role='user' limit 1;

  if p_event_type='generation_started' then
    update ams_private.harness_generation_deliveries_v1 set status='running',updated_at=now()
      where thread_id=p_thread_id and generation_id=p_generation_id;
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,'task_progress',
      jsonb_build_object('state','generating'),null,null);
  elsif p_event_type='assistant_text_delta' then
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,'assistant_text_delta',p_payload,null,null);
  elsif p_event_type='assistant_text_completed' then
    v_content := coalesce(p_payload->>'content','');
    v_message := api.harness_append_message_v1(p_user_id,p_thread_id,p_request_id || ':assistant','assistant','text','completed',
      v_content,jsonb_build_object('nativeSeq',p_payload->'nativeSeq'),null,null,v_parent_id);
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,'assistant_text_completed',
      jsonb_build_object('messageId',v_message->>'id','nativeSeq',p_payload->'nativeSeq'),null,v_message->>'id');
  elsif p_event_type in ('tool_call_started','tool_call_completed') then
    v_message := api.harness_append_message_v1(
      p_user_id,p_thread_id,p_event_id || ':message','tool',
      case when p_event_type='tool_call_started' then 'tool_call' else 'tool_result' end,
      'completed',
      case when p_event_type='tool_call_started' then 'Tool Call' else 'Tool Result' end,
      p_payload,null,null,v_parent_id
    );
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,p_event_type,p_payload,null,null);
  elsif p_event_type in ('generation_completed','generation_stopped','generation_failed') then
    update ams_private.harness_generation_deliveries_v1 set
      status=case p_event_type when 'generation_completed' then 'completed' when 'generation_stopped' then 'stopped' else 'failed' end,
      last_error_code=case when p_event_type='generation_failed' then left(coalesce(p_payload->>'code','GENERATION_FAILED'),120) else null end,
      completed_at=coalesce(completed_at,now()),updated_at=now()
    where thread_id=p_thread_id and generation_id=p_generation_id;
    select current_task_id into v_current_task_id from ams_private.harness_threads_v1
      where id=p_thread_id and user_id=p_user_id;
    perform api.harness_release_generation_v1(p_user_id,p_thread_id,p_generation_id,
      case
        when p_event_type='generation_completed' and v_current_task_id is not null then 'waiting_confirmation'
        when p_event_type='generation_completed' then 'completed'
        when p_event_type='generation_stopped' then 'stopped'
        else 'failed'
      end,
      not (p_event_type='generation_completed' and v_current_task_id is not null));
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,
      case when p_event_type='generation_failed' then 'error'
        when p_event_type='generation_completed' then 'task_progress' else p_event_type end,
      case when p_event_type='generation_failed' then
        jsonb_build_object('code',coalesce(p_payload->>'code','GENERATION_FAILED'),'message','Assistant generation failed. Please retry.')
      when p_event_type='generation_completed' and v_current_task_id is not null then jsonb_build_object('state','waiting_confirmation')
      when p_event_type='generation_completed' then jsonb_build_object('state','completed') else p_payload end,
      v_current_task_id,null);
  else raise exception 'unsupported_generation_event'; end if;
  insert into ams_private.harness_generation_event_receipts_v1(event_id,thread_id,generation_id,event_type)
    values(p_event_id,p_thread_id,p_generation_id,p_event_type);
  return jsonb_build_object('applied',true,'eventId',p_event_id);
end $$;

revoke all on function api.harness_apply_generation_event_v1(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function api.harness_apply_generation_event_v1(uuid,text,text,text,text,text,jsonb) to service_role;
