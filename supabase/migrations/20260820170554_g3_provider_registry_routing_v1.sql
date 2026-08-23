-- G3 provider registry and deterministic routing contract.
--
-- This forward migration keeps every provider endpoint and credential outside
-- the database.  The browser may choose only a registered provider id or one
-- of the bounded routing strategies.  The selected route and every fallback
-- candidate become part of the immutable canonical request fingerprint.

alter table ams_private.g1_generation_provider_registry_v1
  add column if not exists adapter_kind text not null default 'bailian'
    check (adapter_kind in ('bailian', 'comfyui')),
  add column if not exists route_priority integer not null default 100
    check (route_priority between 1 and 10000),
  add column if not exists estimated_latency_seconds integer
    check (estimated_latency_seconds is null or estimated_latency_seconds between 1 and 86400),
  add column if not exists pricing_status text not null default 'estimated'
    check (pricing_status in ('fixed', 'estimated', 'unknown')),
  add column if not exists configuration jsonb not null default '{}'::jsonb;

update ams_private.g1_generation_provider_registry_v1
set adapter_kind = 'bailian',
    route_priority = case mode when 'image' then 10 else 20 end,
    estimated_latency_seconds = case mode when 'image' then 45 else 300 end,
    pricing_status = 'estimated',
    configuration = jsonb_build_object('contract', 'dashscope_v1')
where provider_id = 'bailian';

insert into ams_private.g1_generation_provider_registry_v1
  (provider_id, mode, model_name, model_version, enabled,
   price_cny_min, price_cny_max, max_prompt_chars, max_negative_prompt_chars,
   allowed_aspect_ratios, max_duration_seconds, allowed_resolutions,
   reference_required, max_artifact_bytes, adapter_kind, route_priority,
   estimated_latency_seconds, pricing_status, configuration)
values
  ('autodl', 'image', 'emma-s1-sdxl-t2i', 1, true,
   0.0500, 1.5000, 2000, 500,
   '["1:1","4:3","3:4","16:9","9:16"]'::jsonb,
   0, '[]'::jsonb, false, 20971520,
   'comfyui', 30, 90, 'estimated',
   '{"workflow_id":"emma-s1-sdxl-t2i","contract":"comfyui_prompt_v1"}'::jsonb),
  ('autodl', 'video_i2v', 'wan-remix-i2v', 1, true,
   0.5000, 8.0000, 2000, 500,
   '["16:9","9:16","1:1"]'::jsonb,
   10, '["720p"]'::jsonb, true, 536870912,
   'comfyui', 30, 150, 'estimated',
   '{"workflow_id":"wan-remix-i2v","contract":"comfyui_prompt_v1"}'::jsonb)
on conflict (provider_id, mode) do update
set model_name = excluded.model_name,
    model_version = excluded.model_version,
    adapter_kind = excluded.adapter_kind,
    route_priority = excluded.route_priority,
    estimated_latency_seconds = excluded.estimated_latency_seconds,
    pricing_status = excluded.pricing_status,
    configuration = excluded.configuration;

-- Preserve the accepted P19 Evidence/Knowledge/Brief binding implementation.
alter function ams_private.g1_normalize_request(uuid, jsonb)
  rename to g1_normalize_request_p19_v1;

create function ams_private.g1_normalize_request(p_user_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_provider_id text := btrim(coalesce(p_request ->> 'provider_id', 'auto'));
  v_strategy text := btrim(coalesce(p_request ->> 'route_strategy', 'balanced'));
  v_base jsonb;
  v_provider record;
  v_candidates jsonb;
  v_canonical jsonb;
  v_sha text;
begin
  if v_provider_id <> 'auto' and v_provider_id !~ '^[a-z][a-z0-9-]{1,31}$' then
    raise exception using errcode = 'P0001', message = 'G3_PROVIDER_ID_INVALID';
  end if;
  if v_strategy not in ('balanced', 'fastest', 'lowest_cost') then
    raise exception using errcode = 'P0001', message = 'G3_ROUTE_STRATEGY_INVALID';
  end if;

  -- The accepted P19 implementation remains the only source of identity,
  -- revision and lineage validation.  G3 only adds routing after it succeeds.
  v_base := ams_private.g1_normalize_request_p19_v1(
    p_user_id,
    p_request - 'provider_id' - 'route_strategy'
  );

  select p.* into v_provider
  from ams_private.g1_generation_provider_registry_v1 p
  where p.enabled is true
    and p.mode = v_base ->> 'mode'
    and (v_provider_id = 'auto' or p.provider_id = v_provider_id)
    and char_length(v_base ->> 'prompt') <= p.max_prompt_chars
    and char_length(coalesce(v_base ->> 'negative_prompt', '')) <= p.max_negative_prompt_chars
    and p.allowed_aspect_ratios @> to_jsonb(v_base ->> 'aspect_ratio')
    and (
      p.mode = 'image'
      or (
        (v_base ->> 'duration_seconds')::integer <= p.max_duration_seconds
        and p.allowed_resolutions @> to_jsonb(v_base ->> 'resolution')
      )
    )
  order by
    case when v_strategy = 'lowest_cost' and p.pricing_status <> 'unknown' then p.price_cny_max end asc nulls last,
    case when v_strategy = 'fastest' then p.estimated_latency_seconds end asc nulls last,
    p.route_priority asc,
    p.provider_id asc
  limit 1;

  if v_provider is null then
    raise exception using errcode = 'P0001', message = 'G3_PROVIDER_UNAVAILABLE';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'provider_id', c.provider_id,
      'adapter_kind', c.adapter_kind,
      'model_name', c.model_name,
      'model_version', c.model_version,
      'price_cny_min', c.price_cny_min,
      'price_cny_max', c.price_cny_max,
      'pricing_status', c.pricing_status,
      'estimated_latency_seconds', c.estimated_latency_seconds,
      'workflow_id', c.configuration ->> 'workflow_id',
      'max_artifact_bytes', c.max_artifact_bytes
    ) order by
      case when c.provider_id = v_provider.provider_id then 0 else 1 end,
      case when v_strategy = 'lowest_cost' and c.pricing_status <> 'unknown' then c.price_cny_max end asc nulls last,
      case when v_strategy = 'fastest' then c.estimated_latency_seconds end asc nulls last,
      c.route_priority asc,
      c.provider_id asc), '[]'::jsonb)
  into v_candidates
  from ams_private.g1_generation_provider_registry_v1 c
  where c.enabled is true
    and c.mode = v_base ->> 'mode'
    and (v_provider_id = 'auto' or c.provider_id = v_provider_id)
    and char_length(v_base ->> 'prompt') <= c.max_prompt_chars
    and char_length(coalesce(v_base ->> 'negative_prompt', '')) <= c.max_negative_prompt_chars
    and c.allowed_aspect_ratios @> to_jsonb(v_base ->> 'aspect_ratio')
    and (
      c.mode = 'image'
      or (
        (v_base ->> 'duration_seconds')::integer <= c.max_duration_seconds
        and c.allowed_resolutions @> to_jsonb(v_base ->> 'resolution')
      )
    );

  if jsonb_array_length(v_candidates) < 1 then
    raise exception using errcode = 'P0001', message = 'G3_ROUTE_EMPTY';
  end if;

  v_canonical := (v_base -> 'canonical') || jsonb_build_object(
    'provider_id', v_provider.provider_id,
    'adapter_kind', v_provider.adapter_kind,
    'route_strategy', v_strategy,
    'route_candidates', v_candidates,
    'model_name', v_provider.model_name,
    'model_version', v_provider.model_version
  );
  v_sha := encode(extensions.digest(convert_to(v_canonical::text, 'UTF8'), 'sha256'), 'hex');

  return (v_base - 'canonical' - 'request_sha256'
    - 'model_name' - 'model_version' - 'price_cny_min' - 'price_cny_max'
    - 'max_artifact_bytes') || jsonb_build_object(
      'request_sha256', v_sha,
      'canonical', v_canonical,
      'provider_id', v_provider.provider_id,
      'adapter_kind', v_provider.adapter_kind,
      'route_strategy', v_strategy,
      'route_candidates', v_candidates,
      'model_name', v_provider.model_name,
      'model_version', v_provider.model_version,
      'price_cny_min', v_provider.price_cny_min,
      'price_cny_max', v_provider.price_cny_max,
      'pricing_status', v_provider.pricing_status,
      'estimated_latency_seconds', v_provider.estimated_latency_seconds,
      'max_artifact_bytes', v_provider.max_artifact_bytes
    );
end;
$$;

create or replace function api.g1_quote_request(p_user_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_norm jsonb;
  v_existing ams_private.g1_generation_quotes_v1;
  v_quote_id text;
  v_expires_at timestamptz;
  v_payload jsonb;
  v_fingerprint text;
begin
  v_norm := ams_private.g1_normalize_request(p_user_id, p_request);
  select * into v_existing
  from ams_private.g1_generation_quotes_v1
  where user_id = p_user_id and request_sha256 = v_norm ->> 'request_sha256'
  order by created_at desc limit 1;
  if v_existing.id is not null then
    return jsonb_build_object('ok', true, 'outcome', 'reused',
      'quote', v_existing.payload || jsonb_build_object('quote_fingerprint', v_existing.quote_fingerprint));
  end if;

  v_quote_id := 'g1q-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
  v_expires_at := now() + interval '30 minutes';
  v_payload := jsonb_build_object(
    'schema_version', 'g1_quote_v1',
    'quote_id', v_quote_id,
    'user_id', p_user_id::text,
    'project_id', v_norm ->> 'project_id',
    'mode', v_norm ->> 'mode',
    'provider', v_norm ->> 'provider_id',
    'adapter_kind', v_norm ->> 'adapter_kind',
    'route_strategy', v_norm ->> 'route_strategy',
    'route_candidates', v_norm -> 'route_candidates',
    'model_name', v_norm ->> 'model_name',
    'model_version', (v_norm ->> 'model_version')::integer,
    'price_cny_min', (v_norm ->> 'price_cny_min')::numeric,
    'price_cny_max', (v_norm ->> 'price_cny_max')::numeric,
    'pricing_status', v_norm ->> 'pricing_status',
    'estimated_latency_seconds', (v_norm ->> 'estimated_latency_seconds')::integer,
    'estimated_max_cost_cny', (v_norm ->> 'price_cny_max')::numeric,
    'expires_at', v_expires_at,
    'request_sha256', v_norm ->> 'request_sha256',
    'brief_id', v_norm ->> 'brief_id',
    'brief_version', (v_norm ->> 'brief_version')::integer,
    'brief_fingerprint', v_norm ->> 'brief_fingerprint',
    'project_revision', (v_norm ->> 'project_revision')::integer,
    'knowledge_card_ids', v_norm -> 'knowledge_card_ids',
    'evidence_ids', v_norm -> 'evidence_ids',
    'reference_asset_id', v_norm ->> 'reference_asset_id',
    'will_use_storage', true, 'will_write', true,
    'will_pay', true, 'will_execute', true
  );
  v_fingerprint := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into ams_private.g1_generation_quotes_v1
    (id, user_id, project_id, request_sha256, quote_fingerprint, mode, model_name,
     payload, price_cny_min, price_cny_max, expires_at)
  values
    (v_quote_id, p_user_id, v_norm ->> 'project_id', v_norm ->> 'request_sha256', v_fingerprint,
     v_norm ->> 'mode', v_norm ->> 'model_name', v_payload,
     (v_norm ->> 'price_cny_min')::numeric, (v_norm ->> 'price_cny_max')::numeric, v_expires_at)
  on conflict (user_id, request_sha256) do nothing;

  select * into v_existing
  from ams_private.g1_generation_quotes_v1
  where user_id = p_user_id and request_sha256 = v_norm ->> 'request_sha256'
  order by created_at desc limit 1;
  return jsonb_build_object('ok', true, 'outcome', 'created',
    'quote', v_existing.payload || jsonb_build_object('quote_fingerprint', v_existing.quote_fingerprint));
end;
$$;

revoke all on function ams_private.g1_normalize_request_p19_v1(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function ams_private.g1_normalize_request(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function ams_private.g1_normalize_request_p19_v1(uuid, jsonb) to service_role;
grant execute on function ams_private.g1_normalize_request(uuid, jsonb) to service_role;

comment on function ams_private.g1_normalize_request(uuid, jsonb)
  is 'G3 deterministic provider routing wrapper; immutable route is included in request fingerprint.';

-- The accepted G1 completion RPC predates multiple providers and writes the
-- job's primary model.  Bind every new artifact to the exact provider/model
-- persisted on the successful attempt instead.  Missing or forged route
-- identity fails closed before the artifact row is inserted.
create function ams_private.g3_bind_artifact_provider_v1()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_state jsonb;
  v_request jsonb;
  v_job_model text;
  v_job_version integer;
  v_mode text;
  v_provider text;
  v_model text;
  v_version integer;
begin
  select a.provider_state, j.request, j.model_name, j.model_version, j.mode
  into v_state, v_request, v_job_model, v_job_version, v_mode
  from ams_private.g1_generation_attempts_v1 a
  join ams_private.g1_generation_jobs_v1 j on j.id = a.job_id
  where a.id = new.attempt_id and a.job_id = new.job_id;

  v_provider := btrim(coalesce(v_state ->> 'provider', ''));
  v_model := btrim(coalesce(v_state ->> 'model_name', ''));

  -- Historical G1 jobs predate immutable route_candidates and persisted only
  -- the provider/model on the job itself.  Preserve those accepted jobs without
  -- weakening G3: every routed G3 job must carry the exact successful attempt
  -- identity, while a legacy job may bind only to its original Bailian model.
  if v_provider = '' or v_model = '' or v_state ->> 'model_version' is null then
    if jsonb_typeof(v_request -> 'route_candidates') = 'array' then
      raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
    end if;
    v_provider := 'bailian';
    v_model := v_job_model;
    v_version := v_job_version;
  else
  begin
    v_version := (v_state ->> 'model_version')::integer;
  exception when others then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end;
  end if;

  if v_provider = '' or v_model = '' or v_version < 1
    or not exists (
      select 1
      from ams_private.g1_generation_provider_registry_v1 r
      where r.provider_id = v_provider
        and r.mode = v_mode
        and r.model_name = v_model
        and r.model_version = v_version
    )
  then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end if;

  new.provider := v_provider;
  new.model_name := v_model;
  new.model_version := v_version;
  return new;
end;
$$;

create trigger g3_bind_artifact_provider_v1
before insert on ams_private.g1_generation_artifacts_v1
for each row execute function ams_private.g3_bind_artifact_provider_v1();

revoke all on function ams_private.g3_bind_artifact_provider_v1()
  from public, anon, authenticated;

comment on function ams_private.g3_bind_artifact_provider_v1()
  is 'G3 fail-closed artifact lineage binding to the exact successful provider attempt.';
