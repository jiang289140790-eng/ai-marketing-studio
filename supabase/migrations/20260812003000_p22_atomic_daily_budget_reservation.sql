-- P22: conservative, project-wide daily budget reservations for staging-only
-- assisted research. The function is a server boundary: browser roles have no
-- schema usage and no EXECUTE privilege.

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
  v_limit constant numeric(12,4) := 10.0000;
  v_reserved numeric(12,4);
  v_existing public.cost_records%rowtype;
begin
  if p_user_id is null then
    raise exception 'P22_USER_ID_REQUIRED';
  end if;
  if v_provider not in ('apify', 'qwen') then
    raise exception 'P22_PROVIDER_INVALID';
  end if;
  if p_amount_cny is null or p_amount_cny <= 0 or p_amount_cny > v_limit
     or scale(p_amount_cny) > 4 then
    raise exception 'P22_AMOUNT_INVALID';
  end if;
  if p_reservation_id is null then
    raise exception 'P22_RESERVATION_ID_REQUIRED';
  end if;

  -- Reservation identity is serialized before the provider/day lock, so even
  -- a cross-provider retry cannot create two rows with one reservation id.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('p22_reservation_v1'),
    pg_catalog.hashtext(p_reservation_id::text)
  );

  -- One lock per provider and UTC day. Hash collisions can only serialize extra
  -- callers; they cannot weaken the cap.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('p22_daily_budget_v1'),
    pg_catalog.hashtext(v_provider || ':' || v_today::text)
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
      'schema_version', 'p22_budget_status_v1',
      'reservation_id', p_reservation_id,
      'provider', v_provider,
      'budget_date_utc', v_today,
      'reserved_cny', v_reserved,
      'daily_limit_cny', v_limit,
      'remaining_cny', v_limit - v_reserved,
      'outcome', 'already_reserved'
    );
  end if;

  select coalesce(sum(amount), 0) into v_reserved
  from public.cost_records
  where cost_date = v_today
    and metadata->>'schema_version' = 'p22_budget_reservation_v1'
    and metadata->>'provider' = v_provider;

  if v_reserved + p_amount_cny > v_limit then
    raise exception 'P22_DAILY_BUDGET_EXCEEDED';
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
      'status', 'reserved_conservative_cap'
    )
  );

  v_reserved := v_reserved + p_amount_cny;
  return pg_catalog.jsonb_build_object(
    'schema_version', 'p22_budget_status_v1',
    'reservation_id', p_reservation_id,
    'provider', v_provider,
    'budget_date_utc', v_today,
    'reserved_cny', v_reserved,
    'daily_limit_cny', v_limit,
    'remaining_cny', v_limit - v_reserved,
    'outcome', 'reserved'
  );
end;
$function$;

revoke all on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) from public, anon, authenticated;
grant execute on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) to service_role;

comment on function api.p22_reserve_daily_budget(uuid,text,numeric,uuid) is
  'P22 server-only atomic UTC daily budget reservation. Conservative reservations are never released automatically.';
