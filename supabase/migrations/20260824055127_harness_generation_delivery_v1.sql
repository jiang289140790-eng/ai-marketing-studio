create table ams_private.harness_generation_deliveries_v1 (
  thread_id text not null references ams_private.harness_threads_v1(id) on delete cascade,
  generation_id text not null,
  request_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id text not null check (workspace_id = 'ai-marketing-studio-staging'),
  status text not null check (status in ('pending','accepted','running','completed','failed','stopped')),
  gateway_delivery_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (thread_id, generation_id),
  unique (thread_id, request_id),
  foreign key (thread_id, generation_id)
    references ams_private.harness_generation_requests_v1(thread_id, generation_id) on delete cascade
);

alter table ams_private.harness_generation_deliveries_v1 enable row level security;
alter table ams_private.harness_generation_deliveries_v1 force row level security;
revoke all on ams_private.harness_generation_deliveries_v1 from public, anon, authenticated;
grant select, insert, update on ams_private.harness_generation_deliveries_v1 to service_role;

create table ams_private.harness_generation_event_receipts_v1 (
  event_id text primary key,
  thread_id text not null,
  generation_id text not null,
  event_type text not null,
  applied_at timestamptz not null default now(),
  foreign key (thread_id,generation_id)
    references ams_private.harness_generation_deliveries_v1(thread_id,generation_id) on delete cascade
);
alter table ams_private.harness_generation_event_receipts_v1 enable row level security;
alter table ams_private.harness_generation_event_receipts_v1 force row level security;
revoke all on ams_private.harness_generation_event_receipts_v1 from public,anon,authenticated;
grant select,insert on ams_private.harness_generation_event_receipts_v1 to service_role;

create or replace function api.harness_prepare_generation_delivery_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_delivery ams_private.harness_generation_deliveries_v1%rowtype;
begin
  if not exists (
    select 1 from ams_private.harness_generation_requests_v1
    where thread_id=p_thread_id and generation_id=p_generation_id and user_id=p_user_id
      and status in ('active','active_recovered')
  ) then raise exception 'generation_not_active' using errcode='P0002'; end if;

  insert into ams_private.harness_generation_deliveries_v1(
    thread_id,generation_id,request_id,user_id,workspace_id,status,attempt_count
  ) values (
    p_thread_id,p_generation_id,p_request_id,p_user_id,'ai-marketing-studio-staging','pending',1
  ) on conflict (thread_id,generation_id) do update set
    attempt_count=ams_private.harness_generation_deliveries_v1.attempt_count+1,
    updated_at=now()
  returning * into v_delivery;
  return jsonb_build_object('prepared',true,'status',v_delivery.status,'attemptCount',v_delivery.attempt_count);
end $$;

create or replace function api.harness_claim_and_prepare_generation_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_claim jsonb; v_delivery jsonb; v_status text;
begin
  v_claim := api.harness_claim_generation_v1(p_user_id,p_thread_id,p_generation_id);
  if coalesce((v_claim->>'claimed')::boolean,false) then
    v_delivery := api.harness_prepare_generation_delivery_v1(p_user_id,p_thread_id,p_generation_id,p_request_id);
    return v_claim || jsonb_build_object('delivery',v_delivery);
  end if;
  select status into v_status from ams_private.harness_generation_deliveries_v1
    where thread_id=p_thread_id and generation_id=p_generation_id and request_id=p_request_id and user_id=p_user_id;
  return v_claim || jsonb_build_object('deliveryStatus',v_status);
end $$;

create or replace function api.harness_ack_generation_delivery_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text, p_gateway_delivery_id text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_delivery ams_private.harness_generation_deliveries_v1%rowtype;
begin
  update ams_private.harness_generation_deliveries_v1 set
    status=case when status='pending' then 'accepted' else status end,
    gateway_delivery_id=coalesce(gateway_delivery_id,p_gateway_delivery_id),
    accepted_at=coalesce(accepted_at,now()), updated_at=now()
  where thread_id=p_thread_id and generation_id=p_generation_id and request_id=p_request_id and user_id=p_user_id
    and (gateway_delivery_id is null or gateway_delivery_id=p_gateway_delivery_id)
  returning * into v_delivery;
  if not found then raise exception 'delivery_not_found_or_mismatch' using errcode='P0002'; end if;
  return jsonb_build_object('acknowledged',true,'status',v_delivery.status,'deliveryId',v_delivery.gateway_delivery_id);
end $$;

create or replace function api.harness_fail_generation_delivery_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text, p_error_code text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_released jsonb;
begin
  update ams_private.harness_generation_deliveries_v1 set status='failed',
    last_error_code=left(coalesce(p_error_code,'GENERATION_DELIVERY_FAILED'),120),
    completed_at=coalesce(completed_at,now()), updated_at=now()
  where thread_id=p_thread_id and generation_id=p_generation_id and request_id=p_request_id and user_id=p_user_id
    and status not in ('completed','stopped');
  v_released := api.harness_release_generation_v1(p_user_id,p_thread_id,p_generation_id,'failed',true);
  perform api.harness_append_event_v1(p_user_id,p_thread_id,p_request_id || ':delivery_failed','error',
    jsonb_build_object('code',left(coalesce(p_error_code,'GENERATION_DELIVERY_FAILED'),120),
      'message','Assistant delivery failed before execution. Please retry.'),null,null);
  return jsonb_build_object('failed',true,'released',coalesce(v_released->'released','false'::jsonb));
end $$;

create or replace function api.harness_close_generation_delivery_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text, p_status text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('completed','stopped') then raise exception 'delivery_terminal_status_invalid'; end if;
  update ams_private.harness_generation_deliveries_v1 set status=p_status,
    completed_at=coalesce(completed_at,now()),updated_at=now()
  where thread_id=p_thread_id and generation_id=p_generation_id and request_id=p_request_id and user_id=p_user_id;
  return jsonb_build_object('closed',found,'status',p_status);
end $$;

create or replace function api.harness_apply_generation_event_v1(
  p_user_id uuid, p_thread_id text, p_generation_id text, p_request_id text,
  p_event_id text, p_event_type text, p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_delivery ams_private.harness_generation_deliveries_v1%rowtype;
declare v_message jsonb;
declare v_parent_id text;
declare v_content text;
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
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,p_event_type,p_payload,null,null);
  elsif p_event_type in ('generation_completed','generation_stopped','generation_failed') then
    update ams_private.harness_generation_deliveries_v1 set
      status=case p_event_type when 'generation_completed' then 'completed' when 'generation_stopped' then 'stopped' else 'failed' end,
      last_error_code=case when p_event_type='generation_failed' then left(coalesce(p_payload->>'code','GENERATION_FAILED'),120) else null end,
      completed_at=coalesce(completed_at,now()),updated_at=now()
    where thread_id=p_thread_id and generation_id=p_generation_id;
    perform api.harness_release_generation_v1(p_user_id,p_thread_id,p_generation_id,
      case p_event_type when 'generation_completed' then 'completed' when 'generation_stopped' then 'stopped' else 'failed' end,true);
    perform api.harness_append_event_v1(p_user_id,p_thread_id,p_event_id,
      case when p_event_type='generation_failed' then 'error'
        when p_event_type='generation_completed' then 'task_progress' else p_event_type end,
      case when p_event_type='generation_failed' then
        jsonb_build_object('code',coalesce(p_payload->>'code','GENERATION_FAILED'),'message','Assistant generation failed. Please retry.')
      when p_event_type='generation_completed' then jsonb_build_object('state','completed') else p_payload end,null,null);
  else raise exception 'unsupported_generation_event'; end if;
  insert into ams_private.harness_generation_event_receipts_v1(event_id,thread_id,generation_id,event_type)
    values(p_event_id,p_thread_id,p_generation_id,p_event_type);
  return jsonb_build_object('applied',true,'eventId',p_event_id);
end $$;

revoke all on function api.harness_prepare_generation_delivery_v1(uuid,text,text,text) from public,anon,authenticated;
revoke all on function api.harness_claim_and_prepare_generation_v1(uuid,text,text,text) from public,anon,authenticated;
revoke all on function api.harness_ack_generation_delivery_v1(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function api.harness_fail_generation_delivery_v1(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function api.harness_close_generation_delivery_v1(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function api.harness_apply_generation_event_v1(uuid,text,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function api.harness_prepare_generation_delivery_v1(uuid,text,text,text) to service_role;
grant execute on function api.harness_claim_and_prepare_generation_v1(uuid,text,text,text) to service_role;
grant execute on function api.harness_ack_generation_delivery_v1(uuid,text,text,text,text) to service_role;
grant execute on function api.harness_fail_generation_delivery_v1(uuid,text,text,text,text) to service_role;
grant execute on function api.harness_close_generation_delivery_v1(uuid,text,text,text,text) to service_role;
grant execute on function api.harness_apply_generation_event_v1(uuid,text,text,text,text,text,jsonb) to service_role;
