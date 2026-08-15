-- P22/Harness: bind each paid logical operation to its exact canonical request
-- before the provider can be called. This is private, service-role-only state.

create table ams_private.p22_paid_operation_bindings_v1 (
  binding_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  operation text not null,
  sequence integer not null,
  idempotency_key text not null,
  request_sha256 text not null,
  reservation_id uuid not null unique,
  amount_cny numeric(12,4) not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint p22_paid_operation_provider_valid
    check (provider in ('apify', 'qwen')),
  constraint p22_paid_operation_operation_valid
    check (operation ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint p22_paid_operation_sequence_valid
    check (sequence between 0 and 31),
  constraint p22_paid_operation_idempotency_key_valid
    check (char_length(idempotency_key) between 1 and 200 and idempotency_key = btrim(idempotency_key)),
  constraint p22_paid_operation_request_sha256_valid
    check (request_sha256 ~ '^[0-9a-f]{64}$'),
  constraint p22_paid_operation_amount_valid
    check (amount_cny > 0 and amount_cny <= 10.0000 and scale(amount_cny) <= 4),
  constraint p22_paid_operation_identity_unique
    unique (user_id, provider, operation, sequence, idempotency_key)
);

alter table ams_private.p22_paid_operation_bindings_v1 enable row level security;
alter table ams_private.p22_paid_operation_bindings_v1 force row level security;

revoke all on table ams_private.p22_paid_operation_bindings_v1 from public, anon, authenticated;
grant select on table ams_private.p22_paid_operation_bindings_v1 to service_role;

-- The already-applied first Harness revision introduced durable replay rows.
-- Their original idempotency keys cannot be reversed from reservation_id, so
-- retain each immutable request under a bounded legacy key. The claim RPC also
-- matches reservation_id, allowing an exact retry to remain terminal while a
-- different request fails closed. Copy before retiring the superseded objects.
do $migration$
begin
  if to_regclass('ams_private.p22_paid_operation_replays_v1') is not null then
    if exists (
      select 1 from ams_private.p22_paid_operation_replays_v1
      where provider not in ('apify', 'qwen')
         or operation !~ '^[a-z][a-z0-9_]{0,63}$'
         or sequence < 0 or sequence > 31
         or request_sha256 !~ '^[0-9a-f]{64}$'
    ) then
      raise exception 'P22_LEGACY_REPLAY_INVALID';
    end if;

    insert into ams_private.p22_paid_operation_bindings_v1 (
      user_id, provider, operation, sequence, idempotency_key,
      request_sha256, reservation_id, amount_cny, created_at
    )
    select
      user_id,
      provider,
      operation,
      sequence,
      'legacy:' || reservation_id::text,
      request_sha256,
      reservation_id,
      case provider when 'apify' then 2.0000 else 1.0000 end,
      claimed_at
    from ams_private.p22_paid_operation_replays_v1;
  end if;
end;
$migration$;

drop function if exists api.p22_claim_paid_operation_replay(uuid,uuid,text,text,integer,text);
drop function if exists api.p22_get_paid_operation_replay(uuid,uuid,text,text,integer,text);
drop function if exists api.p22_complete_paid_operation_replay(uuid,uuid,text,text,integer,text,jsonb);
drop function if exists api.p22_fail_paid_operation_replay(uuid,uuid,text,text,integer,text,text);
drop table if exists ams_private.p22_paid_operation_replays_v1;

create or replace function api.p22_claim_paid_operation(
  p_user_id uuid,
  p_provider text,
  p_operation text,
  p_sequence integer,
  p_idempotency_key text,
  p_request_sha256 text,
  p_amount_cny numeric,
  p_reservation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_provider text := lower(btrim(coalesce(p_provider, '')));
  v_operation text := lower(btrim(coalesce(p_operation, '')));
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_request_sha256 text := lower(btrim(coalesce(p_request_sha256, '')));
  v_existing ams_private.p22_paid_operation_bindings_v1%rowtype;
  v_cost jsonb;
begin
  if p_user_id is null then raise exception 'P22_USER_ID_REQUIRED'; end if;
  if v_provider not in ('apify', 'qwen') then raise exception 'P22_PROVIDER_INVALID'; end if;
  if v_operation !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'P22_OPERATION_INVALID'; end if;
  if p_sequence is null or p_sequence < 0 or p_sequence > 31 then raise exception 'P22_SEQUENCE_INVALID'; end if;
  if char_length(v_key) < 1 or char_length(v_key) > 200 or v_key <> p_idempotency_key then
    raise exception 'P22_IDEMPOTENCY_KEY_INVALID';
  end if;
  if v_request_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'P22_REQUEST_SHA256_INVALID'; end if;
  if p_amount_cny is null or p_amount_cny <= 0 or p_amount_cny > 10.0000 or scale(p_amount_cny) > 4 then
    raise exception 'P22_AMOUNT_INVALID';
  end if;
  if p_reservation_id is null then raise exception 'P22_RESERVATION_ID_REQUIRED'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('p22_paid_operation_binding_v1'),
    pg_catalog.hashtext(p_user_id::text || E'\n' || v_provider || E'\n' || v_operation || E'\n' || p_sequence::text || E'\n' || v_key)
  );

  select * into v_existing
  from ams_private.p22_paid_operation_bindings_v1
  where user_id = p_user_id
    and provider = v_provider
    and operation = v_operation
    and sequence = p_sequence
    and idempotency_key = v_key;

  if found then
    if v_existing.request_sha256 <> v_request_sha256
       or v_existing.reservation_id <> p_reservation_id
       or v_existing.amount_cny <> p_amount_cny then
      raise exception 'P22_IDEMPOTENCY_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'schema_version', 'p22_paid_operation_binding_v1',
      'outcome', 'already_claimed',
      'reservation_id', v_existing.reservation_id,
      'request_sha256', v_existing.request_sha256
    );
  end if;

  select * into v_existing
  from ams_private.p22_paid_operation_bindings_v1
  where reservation_id = p_reservation_id;

  if found then
    if v_existing.user_id <> p_user_id
       or v_existing.provider <> v_provider
       or v_existing.operation <> v_operation
       or v_existing.sequence <> p_sequence
       or v_existing.request_sha256 <> v_request_sha256
       or v_existing.amount_cny <> p_amount_cny then
      raise exception 'P22_IDEMPOTENCY_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'schema_version', 'p22_paid_operation_binding_v1',
      'outcome', 'already_claimed',
      'reservation_id', v_existing.reservation_id,
      'request_sha256', v_existing.request_sha256
    );
  end if;

  v_cost := api.p22_reserve_daily_budget(
    p_user_id,
    v_provider,
    p_amount_cny,
    p_reservation_id
  );

  -- A cost row created before this binding contract cannot prove which request
  -- it represented. Fail closed without attaching the caller's payload to it.
  if v_cost->>'outcome' <> 'recorded' then
    return pg_catalog.jsonb_build_object(
      'schema_version', 'p22_paid_operation_binding_v1',
      'outcome', 'legacy_already_recorded',
      'reservation_id', p_reservation_id
    );
  end if;

  insert into ams_private.p22_paid_operation_bindings_v1 (
    user_id, provider, operation, sequence, idempotency_key,
    request_sha256, reservation_id, amount_cny
  ) values (
    p_user_id, v_provider, v_operation, p_sequence, v_key,
    v_request_sha256, p_reservation_id, p_amount_cny
  );

  return pg_catalog.jsonb_build_object(
    'schema_version', 'p22_paid_operation_binding_v1',
    'outcome', 'claimed',
    'reservation_id', p_reservation_id,
    'request_sha256', v_request_sha256,
    'cost', v_cost
  );
end;
$function$;

revoke all on function api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid)
  from public, anon, authenticated;
grant execute on function api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid)
  to service_role;

comment on table ams_private.p22_paid_operation_bindings_v1 is
  'Service-only immutable binding between a paid P22 logical operation and its canonical request SHA-256.';
comment on function api.p22_claim_paid_operation(uuid,text,text,integer,text,text,numeric,uuid) is
  'Atomically binds a canonical paid request and records its bounded provider cost. Same request is terminal; different request conflicts.';
