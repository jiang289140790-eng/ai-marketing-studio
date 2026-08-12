-- P26: remove the P22 project-wide UTC daily provider caps while retaining
-- service-role-only, idempotent cost reservations for auditability.

create or replace function api.p22_reserve_daily_budget(
  p_user_id uuid,
  p_provider text,
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
  v_today date := (clock_timestamp() at time zone 'UTC')::date;
  v_reserved numeric(12,4);
  v_existing public.cost_records%rowtype;
begin
  if p_user_id is null then
    raise exception 'P22_USER_ID_REQUIRED';
  end if;
  if v_provider not in ('apify', 'qwen') then
    raise exception 'P22_PROVIDER_INVALID';
  end if;
  -- Keep a bounded single-call reservation; only the cumulative daily cap is
  -- removed. Current callers reserve CNY 2 for Apify and CNY 1 for Qwen.
  if p_amount_cny is null or p_amount_cny <= 0 or p_amount_cny > 10.0000
     or scale(p_amount_cny) > 4 then
    raise exception 'P22_AMOUNT_INVALID';
  end if;
  if p_reservation_id is null then
    raise exception 'P22_RESERVATION_ID_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('p22_reservation_v1'),
    pg_catalog.hashtext(p_reservation_id::text)
  );

  select * into v_existing
  from public.cost_records
  where metadata->>'schema_version' = 'p22_budget_reservation_v1'
    and metadata->>'reservation_id' = p_reservation_id::text
  order by created_at asc, id asc
  limit 1;

  if found then
    if v_existing.user_id <> p_user_id
       or v_existing.cost_date <> v_today
       or v_existing.metadata->>'provider' <> v_provider
       or v_existing.amount <> p_amount_cny then
      raise exception 'P22_RESERVATION_CONFLICT';
    end if;
    select coalesce(sum(amount), 0) into v_reserved
    from public.cost_records
    where cost_date = v_today
      and metadata->>'schema_version' = 'p22_budget_reservation_v1'
      and metadata->>'provider' = v_provider;
    return pg_catalog.jsonb_build_object(
      'schema_version', 'p26_provider_cost_tracking_v1',
      'reservation_id', p_reservation_id,
      'provider', v_provider,
      'cost_date_utc', v_today,
      'recorded_cny', v_reserved,
      'daily_cap_enabled', false,
      'outcome', 'already_recorded'
    );
  end if;

  insert into public.cost_records (
    user_id, cost_date, category, source, amount, revenue, metadata
  ) values (
    p_user_id,
    v_today,
    case when v_provider = 'qwen' then 'ai' else 'api' end,
    'p22:' || v_provider,
    p_amount_cny,
    0,
    pg_catalog.jsonb_build_object(
      'schema_version', 'p22_budget_reservation_v1',
      'reservation_id', p_reservation_id,
      'provider', v_provider,
      'currency', 'CNY',
      'status', 'recorded_without_daily_cap'
    )
  );

  select coalesce(sum(amount), 0) into v_reserved
  from public.cost_records
  where cost_date = v_today
    and metadata->>'schema_version' = 'p22_budget_reservation_v1'
    and metadata->>'provider' = v_provider;

  return pg_catalog.jsonb_build_object(
    'schema_version', 'p26_provider_cost_tracking_v1',
    'reservation_id', p_reservation_id,
    'provider', v_provider,
    'cost_date_utc', v_today,
    'recorded_cny', v_reserved,
    'daily_cap_enabled', false,
    'outcome', 'recorded'
  );
end;
$function$;

revoke all on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) from public, anon, authenticated;
grant execute on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) to service_role;

comment on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) is
  'Server-only idempotent provider cost recording. No cumulative daily cap; single-call amount remains bounded.';
