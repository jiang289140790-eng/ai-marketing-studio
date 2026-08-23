-- ============================================================================
-- G3 provider 注册表路由 v1 (Provider registry routing).
--
-- 在 G1 固定 provider 注册表之上建立服务端路由：浏览器仍然只能选择
-- 注册表内 mode/model（绝不能选择任意端点、模型、provider、工作流、回调或
-- 凭证——G1 既定契约不变），由服务端按注册表条目把每个请求路由到该 mode
-- 下 enabled 且 routing_priority 最小（确定性 tiebreak provider_id）的
-- provider 条目。provider 身份从规范请求起端到端落盘：
--   规范请求 → quote → 作业 → 认领 → 产物/事件，
-- worker 按 provider_id 解析 adapter 与密钥；产物血缘记录真实 provider。
--
-- 安全模型（与 G1/P17/P19 完全一致）：
--   - 全部对象仍在 ams_private，边界函数仍在 api 架构、security definer、
--     set search_path = ams_private, public；
--   - anon/authenticated 对 api.g1_* 零 EXECUTE；仅 service_role 可调用
--     （本迁移不新增任何函数，无新增 ACL 面）；
--   - 显式批准仍精确绑定 quote → provider/model/价格/预估最大费用：路由是
--     报价/提交时的一次性决策，绝不自动切换 provider（自动回退会在批准后
--     突破预算绑定，fail closed 保留 G1 的「绝不重复付费提交」不变式）。
--     注册表 enabled/priority 是运维侧的故障切换手段：禁用某 provider 后，
--     后续请求自动路由到下一个 enabled 条目；已绑定 quote 因路由变化在
--     provider 调用前失效（G1_QUOTE_STALE），零付费动作。
--   - 本迁移是前向的：不修改历史迁移；既有作业/产物数据保留
--     （provider_id 列缺省 'bailian' 回填，与 G1 实装语义一致）。
-- ============================================================================

-- ---- 1. 注册表路由优先级（每个 mode 内唯一；1 = 最高优先）----
alter table ams_private.g1_generation_provider_registry_v1
  add column if not exists routing_priority integer not null default 100
    check (routing_priority between 1 and 1000);

alter table ams_private.g1_generation_provider_registry_v1
  add column if not exists registry_version integer not null default 1 check (registry_version >= 1),
  add column if not exists display_name text not null default 'Provider' check (char_length(display_name) between 1 and 80),
  add column if not exists estimated_latency_seconds_min integer not null default 30 check (estimated_latency_seconds_min >= 0),
  add column if not exists estimated_latency_seconds_max integer not null default 120 check (estimated_latency_seconds_max >= estimated_latency_seconds_min),
  add column if not exists health_status text not null default 'available' check (health_status in ('available','degraded','unavailable')),
  add column if not exists fallback_eligible boolean not null default true;

-- 既有 G1 固定条目（每 mode 唯一一条）回填为最高优先。
update ams_private.g1_generation_provider_registry_v1
   set routing_priority = 1,
       display_name = '百炼',
       estimated_latency_seconds_min = case when mode = 'image' then 15 else 60 end,
       estimated_latency_seconds_max = case when mode = 'image' then 60 else 300 end
 where provider_id = 'bailian' and routing_priority = 100;

-- A previously deployed staging migration registered the provisional
-- provider identity `autodl`. Preserve those rows for historical job and
-- artifact lineage, but remove them from every future routing/fallback
-- candidate before enabling the accepted `autodl-comfyui` identity below.
-- Existing audit data therefore keeps its original provider_id while new
-- work sees one canonical AutoDL provider only.
update ams_private.g1_generation_provider_registry_v1
   set enabled = false,
       health_status = 'unavailable',
       fallback_eligible = false
 where provider_id = 'autodl';

insert into ams_private.g1_generation_provider_registry_v1
  (provider_id, mode, model_name, model_version, enabled, price_cny_min, price_cny_max,
   max_prompt_chars, max_negative_prompt_chars, allowed_aspect_ratios,
   max_duration_seconds, allowed_resolutions, reference_required, max_artifact_bytes,
   routing_priority, registry_version, display_name,
   estimated_latency_seconds_min, estimated_latency_seconds_max, health_status, fallback_eligible,
   adapter_kind, route_priority, estimated_latency_seconds, pricing_status, configuration)
values
  ('autodl-comfyui', 'image', 'ams-g3-image-v1', 1, true, 0.0100, 0.2500,
   2000, 500, '["1:1","4:3","3:4","16:9","9:16"]'::jsonb,
   0, '[]'::jsonb, false, 20971520,
   2, 1, 'AutoDL / ComfyUI', 20, 90, 'available', true,
   'comfyui', 30, 60, 'estimated',
   '{"workflow_id":"ams-g3-image-v1","contract":"g3_autodl_comfyui_image_v1"}'::jsonb)
on conflict (provider_id, mode) do update set
  model_name = excluded.model_name,
  model_version = excluded.model_version,
  enabled = excluded.enabled,
  price_cny_min = excluded.price_cny_min,
  price_cny_max = excluded.price_cny_max,
  allowed_aspect_ratios = excluded.allowed_aspect_ratios,
  routing_priority = excluded.routing_priority,
  registry_version = excluded.registry_version,
  display_name = excluded.display_name,
  estimated_latency_seconds_min = excluded.estimated_latency_seconds_min,
  estimated_latency_seconds_max = excluded.estimated_latency_seconds_max,
  health_status = excluded.health_status,
  adapter_kind = excluded.adapter_kind,
  route_priority = excluded.route_priority,
  estimated_latency_seconds = excluded.estimated_latency_seconds,
  pricing_status = excluded.pricing_status,
  configuration = excluded.configuration,
  fallback_eligible = excluded.fallback_eligible;

-- The service-role registry read exposes only currently selectable entries.
-- Disabled legacy rows remain queryable by owner for audit/lineage, but they
-- cannot leak into browser routing choices.
create or replace function api.g1_get_provider_registry()
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.provider_id, t.mode), '[]'::jsonb)
  from ams_private.g1_generation_provider_registry_v1 t
  where t.enabled is true;
$$;

-- Reconcile the earlier staging artifact trigger with the accepted G3 job
-- contract. The routed provider/model identity is persisted on the job; an
-- optional attempt snapshot may repeat that identity but may never override
-- it. Disabled historical providers remain valid only for completing work
-- that was already bound to their exact registry row.
create or replace function ams_private.g3_bind_artifact_provider_v1()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_state jsonb;
  v_provider text;
  v_model text;
  v_version integer;
  v_mode text;
  v_state_version integer;
begin
  select a.provider_state, j.provider_id, j.model_name, j.model_version, j.mode
    into v_state, v_provider, v_model, v_version, v_mode
  from ams_private.g1_generation_attempts_v1 a
  join ams_private.g1_generation_jobs_v1 j on j.id = a.job_id
  where a.id = new.attempt_id and a.job_id = new.job_id;

  if v_provider is null or v_provider = '' or v_model is null or v_model = ''
    or v_version is null or v_version < 1
  then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end if;

  if coalesce(v_state ->> 'provider', '') <> ''
    and v_state ->> 'provider' is distinct from v_provider
  then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end if;
  if coalesce(v_state ->> 'model_name', '') <> ''
    and v_state ->> 'model_name' is distinct from v_model
  then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end if;
  if v_state ->> 'model_version' is not null then
    begin
      v_state_version := (v_state ->> 'model_version')::integer;
    exception when others then
      raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
    end;
    if v_state_version is distinct from v_version then
      raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
    end if;
  end if;

  if not exists (
    select 1
    from ams_private.g1_generation_provider_registry_v1 r
    where r.provider_id = v_provider
      and r.mode = v_mode
      and r.model_name = v_model
      and r.model_version = v_version
  ) then
    raise exception using errcode = 'P0001', message = 'G3_ARTIFACT_ROUTE_INVALID';
  end if;

  new.provider := v_provider;
  new.model_name := v_model;
  new.model_version := v_version;
  return new;
end;
$$;

create unique index if not exists g1_registry_mode_priority_uq
  on ams_private.g1_generation_provider_registry_v1 (mode, routing_priority);

-- ---- 2. 作业绑定 provider 身份（回填 'bailian' 与 G1 实装一致）----
alter table ams_private.g1_generation_jobs_v1
  add column if not exists provider_id text not null default 'bailian'
    check (provider_id ~ '^[a-z][a-z0-9-]{1,31}$');

alter table ams_private.g1_generation_quotes_v1
  add column if not exists route_snapshot jsonb not null default '{}'::jsonb;

alter table ams_private.g1_generation_jobs_v1
  add column if not exists route_snapshot jsonb not null default '{}'::jsonb;

-- ============================================================================
-- 3. 替换 g1_normalize_request：除 provider 选择段外与既有实现（G1 v1 +
-- P19 证据报价绑定合同 v1）完全一致。provider 选择改为注册表路由：
--   - 该 mode 下 enabled 且 routing_priority 最小者（确定性 tiebreak
--     provider_id）；
--   - 任何 enabled 条目缺失（空注册表或全部禁用）→ G1_MODEL_UNAVAILABLE
--     （fail closed，绝不猜测 provider）；
--   - 规范请求与返回值新增 provider_id，随请求 SHA-256 一并绑定：
--     注册表配置变化（禁用/增删/优先级调整）会使已绑定 quote 在 provider
--     调用前失效（G1_QUOTE_STALE），零付费动作。
-- ============================================================================
create or replace function ams_private.g1_normalize_request(p_user_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_project_id text;
  v_brief_id text;
  v_mode text;
  v_prompt text;
  v_negative_prompt text;
  v_aspect_ratio text;
  v_duration_seconds integer;
  v_resolution text;
  v_reference_asset_id text;
  v_cards_requested jsonb;
  v_evidence_requested jsonb;
  v_provider record;
  v_brief record;
  v_binding jsonb;
  v_cards jsonb;
  v_evidence jsonb;
  v_route_policy text;
  v_requested_provider_id text;
  v_candidates jsonb;
  v_fallback_provider_id text;
  v_selection_reason text;
  v_revision integer;
  v_canonical jsonb;
  v_sha text;
  v_ref_count integer;
  v_duration_raw text;
  v_allowed_aspects jsonb;
  v_allowed_resolutions jsonb;
begin
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception using errcode = 'P0001', message = 'G1_REQUEST_INVALID';
  end if;
  if p_request ->> 'schema_version' is distinct from 'g1_generation_request_v1' then
    raise exception using errcode = 'P0001', message = 'G1_SCHEMA_VERSION_MISMATCH';
  end if;
  v_project_id := p_request ->> 'project_id';
  v_brief_id := p_request ->> 'brief_id';
  v_mode := p_request ->> 'mode';
  v_prompt := btrim(coalesce(p_request ->> 'prompt', ''));
  v_negative_prompt := btrim(coalesce(p_request ->> 'negative_prompt', ''));
  v_aspect_ratio := nullif(btrim(coalesce(p_request ->> 'aspect_ratio', '')), '');
  v_resolution := nullif(btrim(coalesce(p_request ->> 'resolution', '')), '');
  v_reference_asset_id := nullif(btrim(coalesce(p_request ->> 'reference_asset_id', '')), '');
  v_duration_raw := p_request ->> 'duration_seconds';
  v_cards_requested := p_request -> 'knowledge_card_ids';
  v_evidence_requested := p_request -> 'evidence_ids';
  v_route_policy := coalesce(nullif(btrim(p_request ->> 'route_policy'), ''), 'recommended');
  v_requested_provider_id := nullif(btrim(coalesce(p_request ->> 'provider_id', '')), '');

  if v_project_id is null or v_project_id !~ '^prj-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'G1_PROJECT_ID_INVALID';
  end if;
  if v_brief_id is null or v_brief_id !~ '^brief-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'G1_BRIEF_ID_INVALID';
  end if;
  if v_mode is null or v_mode not in ('image', 'video_t2v', 'video_i2v') then
    raise exception using errcode = 'P0001', message = 'G1_MODE_INVALID';
  end if;
  if char_length(v_prompt) < 1 or char_length(v_prompt) > 2000 then
    raise exception using errcode = 'P0001', message = 'G1_PROMPT_BOUNDS';
  end if;
  if char_length(v_negative_prompt) > 500 then
    raise exception using errcode = 'P0001', message = 'G1_NEGATIVE_PROMPT_BOUNDS';
  end if;
  if v_route_policy not in ('recommended', 'lowest_cost', 'fastest', 'specified_provider') then
    raise exception using errcode = 'P0001', message = 'G3_ROUTE_POLICY_INVALID';
  end if;
  if v_route_policy = 'specified_provider'
    and (v_requested_provider_id is null or v_requested_provider_id !~ '^[a-z][a-z0-9-]{1,31}$')
  then
    raise exception using errcode = 'P0001', message = 'G3_PROVIDER_ID_INVALID';
  end if;
  if v_route_policy <> 'specified_provider' and v_requested_provider_id is not null then
    raise exception using errcode = 'P0001', message = 'G3_PROVIDER_OVERRIDE_FORBIDDEN';
  end if;

  -- G3 注册表路由：该 mode 下 enabled 且 routing_priority 最小（确定性
  -- tiebreak provider_id）；无任何 enabled 条目 → fail closed。禁用条目被
  -- 跳过而非报错——注册表 enabled/priority 是运维侧故障切换手段。
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider_id', r.provider_id,
    'display_name', r.display_name,
    'model_name', r.model_name,
    'model_version', r.model_version,
    'registry_version', r.registry_version,
    'price_cny_min', r.price_cny_min,
    'price_cny_max', r.price_cny_max,
    'estimated_latency_seconds_min', r.estimated_latency_seconds_min,
    'estimated_latency_seconds_max', r.estimated_latency_seconds_max,
    'health_status', r.health_status,
    'fallback_eligible', r.fallback_eligible
  ) order by r.routing_priority, r.provider_id), '[]'::jsonb)
  into v_candidates
  from ams_private.g1_generation_provider_registry_v1 r
  where r.mode = v_mode and r.enabled is true and r.health_status <> 'unavailable';

  select * into v_provider
  from ams_private.g1_generation_provider_registry_v1 r
  where r.mode = v_mode and r.enabled is true and r.health_status <> 'unavailable'
    and (v_route_policy <> 'specified_provider' or r.provider_id = v_requested_provider_id)
  order by
    case when v_route_policy = 'lowest_cost' then r.price_cny_max end asc,
    case when v_route_policy = 'fastest' then r.estimated_latency_seconds_max end asc,
    r.routing_priority asc,
    r.provider_id asc
  limit 1;
  if v_provider is null then
    raise exception using errcode = 'P0001', message = 'G1_MODEL_UNAVAILABLE';
  end if;

  select r.provider_id into v_fallback_provider_id
  from ams_private.g1_generation_provider_registry_v1 r
  where r.mode = v_mode and r.enabled is true and r.health_status <> 'unavailable'
    and r.fallback_eligible is true and r.provider_id <> v_provider.provider_id
    -- A fallback is part of the explicit approval. It may never raise the
    -- approved maximum cost selected for the primary route.
    and r.price_cny_max <= v_provider.price_cny_max
  order by r.routing_priority, r.provider_id
  limit 1;
  v_selection_reason := case v_route_policy
    when 'lowest_cost' then '按批准能力中的最低费用上限选择'
    when 'fastest' then '按批准能力中的最短预计延迟选择'
    when 'specified_provider' then '按用户指定的已注册 Provider 选择'
    else '按服务端推荐优先级与健康状态选择'
  end;
  if char_length(v_prompt) > v_provider.max_prompt_chars
    or char_length(v_negative_prompt) > v_provider.max_negative_prompt_chars
  then
    raise exception using errcode = 'P0001', message = 'G1_PROMPT_BOUNDS';
  end if;

  -- 画幅：image 缺省 1:1，video 缺省 16:9；必须落在注册表允许列表内。
  v_allowed_aspects := v_provider.allowed_aspect_ratios;
  if v_aspect_ratio is null then
    v_aspect_ratio := case when v_mode = 'image' then '1:1' else '16:9' end;
  end if;
  if not v_allowed_aspects @> to_jsonb(v_aspect_ratio) then
    raise exception using errcode = 'P0001', message = 'G1_ASPECT_RATIO_INVALID';
  end if;

  -- 时长/分辨率：仅 video 适用；缺省 5 秒 / 720p。
  if v_mode = 'image' then
    if v_duration_raw is not null or v_resolution is not null then
      raise exception using errcode = 'P0001', message = 'G1_FIELD_NOT_APPLICABLE';
    end if;
    v_duration_seconds := null;
    v_resolution := null;
  else
    if v_duration_raw is null then
      v_duration_seconds := 5;
    else
      if v_duration_raw !~ '^[1-9][0-9]*$' then
        raise exception using errcode = 'P0001', message = 'G1_DURATION_BOUNDS';
      end if;
      v_duration_seconds := v_duration_raw::integer;
    end if;
    if v_duration_seconds < 1 or v_duration_seconds > v_provider.max_duration_seconds then
      raise exception using errcode = 'P0001', message = 'G1_DURATION_BOUNDS';
    end if;
    if v_resolution is null then
      v_resolution := '720p';
    end if;
    v_allowed_resolutions := v_provider.allowed_resolutions;
    if not v_allowed_resolutions @> to_jsonb(v_resolution) then
      raise exception using errcode = 'P0001', message = 'G1_RESOLUTION_INVALID';
    end if;
  end if;

  -- 引用素材：仅 video_i2v 必需且必须为已批准图片素材；其余 mode 禁用。
  if v_mode = 'video_i2v' then
    if v_reference_asset_id is null
      or v_reference_asset_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception using errcode = 'P0001', message = 'G1_REFERENCE_ASSET_REQUIRED';
    end if;
    if not exists (
      select 1 from public.assets a
      where a.id = v_reference_asset_id::uuid and a.user_id = p_user_id and a.type = 'image'
        and coalesce(a.workflow -> 'asset_context' ->> 'approval', '') = 'approved'
    ) then
      raise exception using errcode = 'P0001', message = 'G1_REFERENCE_ASSET_REJECTED';
    end if;
  else
    if v_reference_asset_id is not null then
      raise exception using errcode = 'P0001', message = 'G1_FIELD_NOT_APPLICABLE';
    end if;
  end if;

  -- Brief：必须存在、属于当前项目且可被选择（pending_review / approved）。
  select b.payload, b.brief_version into v_brief
  from ams_private.p19_briefs_v1 b
  where b.user_id = p_user_id and b.project_id = v_project_id and b.brief_id = v_brief_id
  order by b.brief_version desc, b.id asc
  limit 1;
  if v_brief is null then
    raise exception using errcode = 'P0001', message = 'G1_BRIEF_NOT_FOUND';
  end if;
  if coalesce(v_brief.payload ->> 'status', '') not in ('approved', 'pending_review') then
    raise exception using errcode = 'P0001', message = 'G1_BRIEF_NOT_SELECTABLE';
  end if;
  if coalesce(v_brief.payload ->> 'fingerprint', '') !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'G1_BRIEF_FINGERPRINT_INVALID';
  end if;

  select max(project_version) into v_revision
  from ams_private.p19_research_projects_v1
  where user_id = p_user_id and project_id = v_project_id;
  if v_revision is null then
    raise exception using errcode = 'P0001', message = 'G1_PROJECT_NOT_FOUND';
  end if;

  -- 知识卡/证据绑定：P19 证据报价绑定合同 v1（详见 g1_resolve_evidence_binding）：
  -- 请求可省略（缺省 = Brief 引用集；证据缺省 = 从被引卡 evidence_links 派生的
  -- 权威集）；提供时必须与 Brief 引用集/权威集精确相等（规范排序）。缺失、重复、
  -- 畸形、跨项目或未引用全部在报价前 fail closed。
  v_binding := ams_private.g1_resolve_evidence_binding(
    p_user_id, v_project_id, v_cards_requested,
    v_brief.payload -> 'knowledge_citation_ids',
    v_brief.payload -> 'evidence_provenance',
    v_evidence_requested);
  v_cards := v_binding -> 'knowledge_card_ids';
  v_evidence := v_binding -> 'evidence_ids';

  v_canonical := jsonb_build_object(
    'schema_version', 'g1_generation_request_v1',
    'user_id', p_user_id::text,
    'project_id', v_project_id,
    'brief_id', v_brief_id,
    'brief_version', v_brief.brief_version,
    'brief_fingerprint', v_brief.payload ->> 'fingerprint',
    'project_revision', v_revision,
    'mode', v_mode,
    'provider_id', v_provider.provider_id,
    'route_policy', v_route_policy,
    'registry_version', v_provider.registry_version,
    'model_name', v_provider.model_name,
    'model_version', v_provider.model_version,
    'prompt', v_prompt,
    'negative_prompt', v_negative_prompt,
    'aspect_ratio', v_aspect_ratio,
    'duration_seconds', v_duration_seconds,
    'resolution', v_resolution,
    'reference_asset_id', v_reference_asset_id,
    'reference_asset_sha256', null,
    'knowledge_card_ids', v_cards,
    'evidence_ids', v_evidence
  );
  v_sha := encode(extensions.digest(convert_to(v_canonical::text, 'UTF8'), 'sha256'), 'hex');

  return jsonb_build_object(
    'request_sha256', v_sha,
    'canonical', v_canonical,
    'project_id', v_project_id,
    'brief_id', v_brief_id,
    'brief_version', v_brief.brief_version,
    'brief_fingerprint', v_brief.payload ->> 'fingerprint',
    'project_revision', v_revision,
    'mode', v_mode,
    'provider_id', v_provider.provider_id,
    'route_policy', v_route_policy,
    'registry_version', v_provider.registry_version,
    'route_candidates', v_candidates,
    'fallback_provider_id', v_fallback_provider_id,
    'selection_reason', v_selection_reason,
    'estimated_latency_seconds_min', v_provider.estimated_latency_seconds_min,
    'estimated_latency_seconds_max', v_provider.estimated_latency_seconds_max,
    'model_name', v_provider.model_name,
    'model_version', v_provider.model_version,
    'prompt', v_prompt,
    'negative_prompt', v_negative_prompt,
    'aspect_ratio', v_aspect_ratio,
    'duration_seconds', v_duration_seconds,
    'resolution', v_resolution,
    'reference_asset_id', v_reference_asset_id,
    'knowledge_card_ids', v_cards,
    'evidence_ids', v_evidence,
    'price_cny_min', v_provider.price_cny_min,
    'price_cny_max', v_provider.price_cny_max,
    'max_artifact_bytes', v_provider.max_artifact_bytes
  );
end;
$$;

comment on function ams_private.g1_normalize_request(uuid, jsonb)
  is 'G3 provider 注册表路由 v1：为 mode 选择 enabled 且 routing_priority 最小（tiebreak provider_id）的注册表条目；provider 身份随规范请求 SHA-256 绑定，配置变化使已绑定 quote 在 provider 调用前失效。';

-- ============================================================================
-- 4. 报价 payload 使用路由结果 provider（替换硬编码 'bailian'）
-- ============================================================================
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
  order by created_at desc
  limit 1;
  if v_existing.id is not null then
    return jsonb_build_object(
      'ok', true,
      'outcome', 'reused',
      'quote', v_existing.payload || jsonb_build_object('quote_fingerprint', v_existing.quote_fingerprint)
    );
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
    'route_policy', v_norm ->> 'route_policy',
    'registry_version', (v_norm ->> 'registry_version')::integer,
    'route_candidates', v_norm -> 'route_candidates',
    'fallback_provider_id', v_norm ->> 'fallback_provider_id',
    'selection_reason', v_norm ->> 'selection_reason',
    'estimated_latency_seconds_min', (v_norm ->> 'estimated_latency_seconds_min')::integer,
    'estimated_latency_seconds_max', (v_norm ->> 'estimated_latency_seconds_max')::integer,
    'model_name', v_norm ->> 'model_name',
    'model_version', (v_norm ->> 'model_version')::integer,
    'price_cny_min', (v_norm ->> 'price_cny_min')::numeric,
    'price_cny_max', (v_norm ->> 'price_cny_max')::numeric,
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
    'will_use_storage', true,
    'will_write', true,
    'will_pay', true,
    'will_execute', true
  );
  v_fingerprint := encode(extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  insert into ams_private.g1_generation_quotes_v1
    (id, user_id, project_id, request_sha256, quote_fingerprint, mode, model_name,
     payload, price_cny_min, price_cny_max, expires_at, route_snapshot)
  values
    (v_quote_id, p_user_id, v_norm ->> 'project_id', v_norm ->> 'request_sha256', v_fingerprint,
     v_norm ->> 'mode', v_norm ->> 'model_name', v_payload,
     (v_norm ->> 'price_cny_min')::numeric, (v_norm ->> 'price_cny_max')::numeric, v_expires_at,
     jsonb_build_object(
       'schema_version', 'g3_route_snapshot_v1',
       'registry_version', (v_norm ->> 'registry_version')::integer,
       'route_policy', v_norm ->> 'route_policy',
       'candidates', v_norm -> 'route_candidates',
       'selected_provider_id', v_norm ->> 'provider_id',
       'fallback_provider_id', v_norm ->> 'fallback_provider_id',
       'selection_reason', v_norm ->> 'selection_reason'))
  on conflict (user_id, request_sha256) do nothing;

  select * into v_existing
  from ams_private.g1_generation_quotes_v1
  where user_id = p_user_id and request_sha256 = v_norm ->> 'request_sha256'
  order by created_at desc
  limit 1;
  return jsonb_build_object(
    'ok', true,
    'outcome', 'created',
    'quote', v_existing.payload || jsonb_build_object('quote_fingerprint', v_existing.quote_fingerprint)
  );
end;
$$;

comment on function api.g1_quote_request(uuid, jsonb)
  is 'G1 immutable bounded quote routed by the provider registry (service-role only).';

-- ============================================================================
-- 5. 显式批准 + 幂等提交：作业落盘路由结果 provider
-- ============================================================================
create or replace function api.g1_approve_submit(
  p_user_id uuid,
  p_idempotency_key text,
  p_request jsonb,
  p_approval jsonb,
  p_expected_revision integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_norm jsonb;
  v_quote ams_private.g1_generation_quotes_v1;
  v_quote_id text;
  v_estimated numeric;
  v_expires_at timestamptz;
  v_source text;
  v_existing ams_private.g1_generation_jobs_v1;
  v_job_id text;
  v_attempt_id text;
  v_approval jsonb;
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) < 1
    or char_length(p_idempotency_key) > 200
  then
    raise exception using errcode = 'P0001', message = 'G1_IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_approval is null or jsonb_typeof(p_approval) <> 'object' then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_INVALID';
  end if;

  v_norm := ams_private.g1_normalize_request(p_user_id, p_request);
  v_quote_id := p_approval ->> 'quote_id';
  if v_quote_id is null or v_quote_id !~ '^g1q-[0-9a-f]{24}$' then
    raise exception using errcode = 'P0001', message = 'G1_QUOTE_NOT_FOUND';
  end if;

  select * into v_quote
  from ams_private.g1_generation_quotes_v1
  where id = v_quote_id and user_id = p_user_id;
  if v_quote.id is null then
    raise exception using errcode = 'P0001', message = 'G1_QUOTE_NOT_FOUND';
  end if;

  -- 幂等优先（任何 quote 到期/修订变化都不得阻断重放或产生第二个作业/尝试/付费动作）：
  -- 同 key + 同规范请求 → 精确重放既有作业；同 key + 不同规范请求 → 计费前有界冲突，
  -- 且冲突判定先于 quote 过期/项目修订过期检查。比较以当前规范请求 SHA-256 为准
  -- （approval 引用的 quote 可能属于旧请求）。
  select * into v_existing
  from ams_private.g1_generation_jobs_v1
  where user_id = p_user_id and project_id = v_quote.project_id and idempotency_key = p_idempotency_key;
  if v_existing.id is not null then
    if v_existing.request_sha256 is distinct from v_norm ->> 'request_sha256' then
      raise exception using errcode = 'P0001', message = 'G1_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'ok', true,
      'outcome', 'replayed',
      'job', ams_private.g1_job_summary(v_existing.id)
    );
  end if;

  -- 任何 prompt/model/provider 路由/引用/Brief/项目修订变化都会在 provider 调用之前使 quote 失效。
  if v_quote.request_sha256 is distinct from v_norm ->> 'request_sha256' then
    raise exception using errcode = 'P0001', message = 'G1_QUOTE_STALE';
  end if;
  if v_quote.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'G1_QUOTE_EXPIRED';
  end if;
  if p_expected_revision is not null
    and p_expected_revision <> (v_quote.payload ->> 'project_revision')::integer
  then
    raise exception using errcode = 'P0001', message = 'G1_PROJECT_REVISION_STALE';
  end if;
  if p_approval ->> 'project_id' is not null
    and p_approval ->> 'project_id' <> v_quote.project_id
  then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
  end if;
  if p_approval ->> 'quote_fingerprint' is not null
    and p_approval ->> 'quote_fingerprint' <> v_quote.quote_fingerprint
  then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
  end if;
  if p_approval ->> 'request_fingerprint' is not null
    and p_approval ->> 'request_fingerprint' <> v_quote.request_sha256
  then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
  end if;

  begin
    v_estimated := (p_approval ->> 'estimated_max_cost_cny')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
  end;
  if v_estimated is null or v_estimated <= 0 or v_estimated > v_quote.price_cny_max then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
  end if;
  if p_approval ->> 'expires_at' is null then
    v_expires_at := v_quote.expires_at;
  else
    begin
      v_expires_at := (p_approval ->> 'expires_at')::timestamptz;
    exception when others then
      raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
    end;
    if v_expires_at <= now() or v_expires_at > v_quote.expires_at then
      raise exception using errcode = 'P0001', message = 'G1_APPROVAL_MISMATCH';
    end if;
  end if;
  v_source := btrim(coalesce(p_approval ->> 'source', 'browser'));
  if char_length(v_source) < 1 or char_length(v_source) > 40 then
    raise exception using errcode = 'P0001', message = 'G1_APPROVAL_INVALID';
  end if;

  v_approval := jsonb_build_object(
    'schema_version', 'g1_approval_v1',
    'user_id', p_user_id::text,
    'project_id', v_quote.project_id,
    'quote_id', v_quote.id,
    'quote_fingerprint', v_quote.quote_fingerprint,
    'request_fingerprint', v_quote.request_sha256,
    'estimated_max_cost_cny', v_estimated,
    'expires_at', v_expires_at,
    'approved_at', now(),
    'source', v_source
  );

  v_job_id := 'g1j-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
  insert into ams_private.g1_generation_jobs_v1
    (id, user_id, project_id, idempotency_key, request_sha256, quote_id, quote_fingerprint,
     approval, request, quote, mode, provider_id, model_name, model_version, status, attempt_count,
     max_attempts, brief_id, brief_version, brief_fingerprint, project_revision,
     knowledge_card_ids, evidence_ids, reference_asset_id, route_snapshot)
  values
    (v_job_id, p_user_id, v_quote.project_id, p_idempotency_key, v_quote.request_sha256,
     v_quote.id, v_quote.quote_fingerprint, v_approval, v_norm -> 'canonical', v_quote.payload,
     v_norm ->> 'mode', v_norm ->> 'provider_id', v_norm ->> 'model_name', (v_norm ->> 'model_version')::integer,
     'queued', 1, 2,
     v_norm ->> 'brief_id', (v_norm ->> 'brief_version')::integer, v_norm ->> 'brief_fingerprint',
     (v_norm ->> 'project_revision')::integer,
     v_norm -> 'knowledge_card_ids', v_norm -> 'evidence_ids',
     v_norm ->> 'reference_asset_id', v_quote.route_snapshot)
  on conflict (user_id, project_id, idempotency_key) do nothing;

  select * into v_existing
  from ams_private.g1_generation_jobs_v1
  where user_id = p_user_id and project_id = v_quote.project_id and idempotency_key = p_idempotency_key;
  if v_existing.id is null then
    raise exception using errcode = 'P0001', message = 'G1_JOB_CREATE_FAILED';
  end if;
  -- 并发同 key 且请求不一致（规范请求 SHA 为准）→ 计费前冲突。
  if v_existing.request_sha256 is distinct from v_norm ->> 'request_sha256' then
    raise exception using errcode = 'P0001', message = 'G1_IDEMPOTENCY_CONFLICT';
  end if;
  if v_existing.id <> v_job_id then
    -- 并发同 key：另一会话已创建 → 精确重放。
    return jsonb_build_object(
      'ok', true,
      'outcome', 'replayed',
      'job', ams_private.g1_job_summary(v_existing.id)
    );
  end if;

  v_attempt_id := 'g1a-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
  insert into ams_private.g1_generation_attempts_v1 (id, job_id, attempt_no, state)
  values (v_attempt_id, v_job_id, 1, 'queued');
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (v_job_id, v_attempt_id, 'job.created',
    jsonb_build_object('quote_id', v_quote.id, 'mode', v_norm ->> 'mode',
      'provider_id', v_norm ->> 'provider_id', 'model_name', v_norm ->> 'model_name'));

  return jsonb_build_object(
    'ok', true,
    'outcome', 'applied',
    'job', ams_private.g1_job_summary(v_job_id)
  );
end;
$$;

comment on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer)
  is 'G1 explicit approval + idempotent paid job creation routed by the provider registry (service-role only).';

-- ============================================================================
-- 6. 作业只读：暴露 provider 身份
-- ============================================================================
create or replace function ams_private.g1_job_summary(p_job_id text)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select jsonb_build_object(
    'id', j.id,
    'user_id', j.user_id::text,
    'project_id', j.project_id,
    'status', j.status,
    'mode', j.mode,
    'provider_id', j.provider_id,
    'model_name', j.model_name,
    'model_version', j.model_version,
    'attempt_count', j.attempt_count,
    'max_attempts', j.max_attempts,
    'brief_id', j.brief_id,
    'brief_version', j.brief_version,
    'brief_fingerprint', j.brief_fingerprint,
    'project_revision', j.project_revision,
    'request_sha256', j.request_sha256,
    'quote_id', j.quote_id,
    'quote_fingerprint', j.quote_fingerprint,
    'quote', j.quote,
    'route_snapshot', j.route_snapshot,
    'approval', j.approval,
    'request', j.request,
    'knowledge_card_ids', j.knowledge_card_ids,
    'evidence_ids', j.evidence_ids,
    'reference_asset_id', j.reference_asset_id,
    'diagnostics', j.diagnostics,
    'artifact_count', (select count(*)::integer from ams_private.g1_generation_artifacts_v1 a where a.job_id = j.id),
    'latest_artifact', (
      select jsonb_build_object('id', a2.id, 'artifact_version', a2.artifact_version, 'mime_type', a2.mime_type,
        'byte_size', a2.byte_size, 'content_sha256', a2.content_sha256, 'created_at', a2.created_at)
      from ams_private.g1_generation_artifacts_v1 a2
      where a2.job_id = j.id
      order by a2.artifact_version desc
      limit 1
    ),
    'created_at', j.created_at,
    'updated_at', j.updated_at
  )
  from ams_private.g1_generation_jobs_v1 j
  where j.id = p_job_id;
$$;

create or replace function api.g1_list_jobs(p_user_id uuid, p_project_id text, p_limit integer default 20)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', j.id, 'project_id', j.project_id, 'status', j.status, 'mode', j.mode,
      'provider_id', j.provider_id,
      'model_name', j.model_name, 'model_version', j.model_version,
      'brief_id', j.brief_id, 'brief_version', j.brief_version,
      'attempt_count', j.attempt_count, 'max_attempts', j.max_attempts,
      'diagnostics', j.diagnostics,
      'route_snapshot', j.route_snapshot,
      'artifact_count', (select count(*)::integer from ams_private.g1_generation_artifacts_v1 a where a.job_id = j.id),
      'created_at', j.created_at, 'updated_at', j.updated_at
    ) order by j.created_at desc
  ), '[]'::jsonb)
  from (
    select * from ams_private.g1_generation_jobs_v1 jj
    where jj.user_id = p_user_id
      and (p_project_id is null or jj.project_id = p_project_id)
    order by jj.created_at desc
    limit greatest(1, least(50, coalesce(p_limit, 20)))
  ) j;
$$;

-- ============================================================================
-- 7. Worker 认领：返回路由结果 provider（worker 按 provider_id 解析 adapter）
-- ============================================================================
create or replace function api.g1_claim_jobs(
  p_worker_id text,
  p_max_jobs integer default 1,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_lease interval;
  v_claim record;
  v_job record;
  v_result jsonb := '[]'::jsonb;
  v_count integer;
  v_resume boolean;
begin
  if p_worker_id is null or char_length(p_worker_id) < 1 or char_length(p_worker_id) > 64 then
    raise exception using errcode = 'P0001', message = 'G1_WORKER_ID_INVALID';
  end if;
  if p_max_jobs is null or p_max_jobs < 1 or p_max_jobs > 10 then
    raise exception using errcode = 'P0001', message = 'G1_CLAIM_BOUNDS';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_BOUNDS';
  end if;
  v_lease := make_interval(secs => p_lease_seconds);

  -- 1) 过期 lease 对账（原子；崩溃/重启安全）。
  for v_claim in
    select at.id as attempt_id, at.job_id, at.provider_state
    from ams_private.g1_generation_attempts_v1 at
    where at.state = 'claimed' and at.lease_expires_at is not null and at.lease_expires_at < now()
    for update skip locked
  loop
    if coalesce(v_claim.provider_state ->> 'phase', '') <> 'pre_submit' then
      -- worker 从未进入提交窗口：持久化状态证明无已接受的付费作业 → 安全重排。
      update ams_private.g1_generation_attempts_v1 at
      set state = 'queued', claimed_by = null, lease_expires_at = null,
          diagnostics = '{}'::jsonb
      where at.id = v_claim.attempt_id and at.state = 'claimed';
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'claim.requeued_safe',
        jsonb_build_object('reason', 'lease_expired_before_provider_submission'));
    else
      -- 提交窗口已开始但任务 id 未落盘：无法证明 → fail closed。
      update ams_private.g1_generation_attempts_v1 at
      set state = 'ambiguous', claimed_by = null, lease_expires_at = null,
          diagnostics = coalesce(at.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_AMBIGUOUS_SUBMISSION')
      where at.id = v_claim.attempt_id and at.state = 'claimed';
      update ams_private.g1_generation_jobs_v1 j
      set status = 'needs_attention', updated_at = now()
      where j.id = v_claim.job_id and j.status not in ('completed', 'failed');
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'claim.ambiguous',
        jsonb_build_object('reason', 'lease_expired_with_ambiguous_submission_state'));
    end if;
  end loop;

  -- submitted/running 且 lease 过期：有 task id → 仅轮询恢复；无 → ambiguous。
  for v_claim in
    select at.id as attempt_id, at.job_id, at.provider_task_id
    from ams_private.g1_generation_attempts_v1 at
    where at.state in ('submitted', 'running')
      and at.lease_expires_at is not null and at.lease_expires_at < now()
    for update skip locked
  loop
    if v_claim.provider_task_id is not null then
      update ams_private.g1_generation_attempts_v1 at
      set claimed_by = null, lease_expires_at = now(), polled_at = now()
      where at.id = v_claim.attempt_id and at.state in ('submitted', 'running');
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'poll.resume',
        jsonb_build_object('reason', 'lease_expired_polling_same_provider_task'));
    else
      update ams_private.g1_generation_attempts_v1 at
      set state = 'ambiguous', claimed_by = null, lease_expires_at = null,
          diagnostics = coalesce(at.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_AMBIGUOUS_SUBMISSION')
      where at.id = v_claim.attempt_id and at.state in ('submitted', 'running');
      update ams_private.g1_generation_jobs_v1 j
      set status = 'needs_attention', updated_at = now()
      where j.id = v_claim.job_id and j.status not in ('completed', 'failed');
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'claim.ambiguous',
        jsonb_build_object('reason', 'provider_task_id_missing_after_submission'));
    end if;
  end loop;

  -- 2) 认领：queued 尝试（新提交）与可恢复轮询（同一 task id，绝不重新提交）。
  for v_claim in
    select at.id as attempt_id, at.job_id, at.attempt_no,
           (at.provider_task_id is not null) as resume
    from ams_private.g1_generation_attempts_v1 at
    join ams_private.g1_generation_jobs_v1 j on j.id = at.job_id
    where (
      (at.state = 'queued' and j.status = 'queued')
      or (at.state in ('submitted', 'running') and at.lease_expires_at <= now()
          and at.provider_task_id is not null and j.status = 'running')
    )
    order by at.created_at asc, at.id asc
    limit greatest(1, least(10, p_max_jobs))
    for update skip locked
  loop
    -- 认领前重新校验持久化绑定：最新 Brief 指纹/状态、项目修订、知识卡/证据存在性。
    select count(*) into v_count
    from ams_private.g1_generation_jobs_v1 jj
    where jj.id = v_claim.job_id
      and (
        select b.payload ->> 'fingerprint'
        from ams_private.p19_briefs_v1 b
        where b.user_id = jj.user_id and b.project_id = jj.project_id and b.brief_id = jj.brief_id
        order by b.brief_version desc, b.id asc
        limit 1
      ) = jj.brief_fingerprint
      and (
        select coalesce(b2.payload ->> 'status', '')
        from ams_private.p19_briefs_v1 b2
        where b2.user_id = jj.user_id and b2.project_id = jj.project_id and b2.brief_id = jj.brief_id
        order by b2.brief_version desc, b2.id asc
        limit 1
      ) in ('approved', 'pending_review')
      and (
        select max(project_version) from ams_private.p19_research_projects_v1
        where user_id = jj.user_id and project_id = jj.project_id
      ) = jj.project_revision;
    if v_count = 0 then
      update ams_private.g1_generation_jobs_v1 jj
      set status = 'failed', updated_at = now(),
          diagnostics = coalesce(jj.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_BRIEF_REVISION_STALE')
      where jj.id = v_claim.job_id and jj.status not in ('completed', 'failed');
      update ams_private.g1_generation_attempts_v1 at
      set state = 'failed', completed_at = now(),
          diagnostics = coalesce(at.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_BRIEF_REVISION_STALE')
      where at.id = v_claim.attempt_id and at.state not in ('succeeded', 'failed', 'ambiguous');
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'job.failed',
        jsonb_build_object('code', 'G1_BRIEF_REVISION_STALE'));
      continue;
    end if;

    select count(*) into v_count
    from ams_private.g1_generation_jobs_v1 jj,
         jsonb_array_elements_text(jj.knowledge_card_ids) as t(value)
    where jj.id = v_claim.job_id and not exists (
      select 1 from ams_private.p19_knowledge_cards_v1 kc
      where kc.user_id = jj.user_id and kc.project_id = jj.project_id and kc.knowledge_id = t.value
    );
    if v_count > 0 then
      update ams_private.g1_generation_jobs_v1 jj
      set status = 'failed', updated_at = now(),
          diagnostics = coalesce(jj.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_BINDING_MISSING')
      where jj.id = v_claim.job_id and jj.status not in ('completed', 'failed');
      update ams_private.g1_generation_attempts_v1 at
      set state = 'failed', completed_at = now(),
          diagnostics = coalesce(at.diagnostics, '{}'::jsonb)
            || jsonb_build_object('code', 'G1_BINDING_MISSING')
      where at.id = v_claim.attempt_id and at.state not in ('succeeded', 'failed', 'ambiguous');
      insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
      values (v_claim.job_id, v_claim.attempt_id, 'job.failed',
        jsonb_build_object('code', 'G1_BINDING_MISSING'));
      continue;
    end if;

    v_resume := v_claim.resume;
    update ams_private.g1_generation_attempts_v1 at
    set state = case when v_resume then at.state else 'claimed' end,
        claimed_by = p_worker_id,
        lease_expires_at = now() + v_lease, claimed_at = now()
    where at.id = v_claim.attempt_id and at.job_id = v_claim.job_id
      and (
        at.state = 'queued'
        or (at.state in ('submitted', 'running') and at.provider_task_id is not null)
      );
    if not found then
      continue;
    end if;

    select j6.request, j6.quote, j6.route_snapshot, j6.mode, j6.provider_id, j6.model_name, j6.model_version,
           j6.user_id::text as user_id, j6.project_id, j6.brief_id, j6.brief_version,
           j6.brief_fingerprint, j6.project_revision, j6.reference_asset_id,
           j6.knowledge_card_ids, j6.evidence_ids, j6.id as job_id,
           (select coalesce(max(a.artifact_version), 0) + 1
            from ams_private.g1_generation_artifacts_v1 a where a.job_id = j6.id) as next_artifact_version
    into v_job
    from ams_private.g1_generation_jobs_v1 j6
    where j6.id = v_claim.job_id;

    insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
    values (v_claim.job_id, v_claim.attempt_id,
      case when v_resume then 'poll.claimed_resume' else 'attempt.claimed' end,
      jsonb_build_object('worker_id', p_worker_id));

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'job_id', v_claim.job_id,
      'attempt_id', v_claim.attempt_id,
      'attempt_no', v_claim.attempt_no,
      'resume', v_resume,
      'provider_id', v_job.provider_id,
      'provider_task_id', (
        select at2.provider_task_id from ams_private.g1_generation_attempts_v1 at2
        where at2.id = v_claim.attempt_id
      ),
      'next_artifact_version', v_job.next_artifact_version,
      'request', v_job.request,
      'quote', v_job.quote,
      'route_snapshot', v_job.route_snapshot,
      'mode', v_job.mode,
      'model_name', v_job.model_name,
      'model_version', v_job.model_version,
      'user_id', v_job.user_id,
      'project_id', v_job.project_id,
      'brief_id', v_job.brief_id,
      'brief_version', v_job.brief_version,
      'brief_fingerprint', v_job.brief_fingerprint,
      'project_revision', v_job.project_revision,
      'reference_asset_id', v_job.reference_asset_id,
      'knowledge_card_ids', v_job.knowledge_card_ids,
      'evidence_ids', v_job.evidence_ids
    ));
  end loop;

  return jsonb_build_object('ok', true, 'claimed', v_result);
end;
$$;

-- ============================================================================
-- 8. 产物血缘：记录路由结果 provider（替换硬编码 'bailian'）
-- ============================================================================
create or replace function api.g1_complete_attempt(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_artifact jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.g1_generation_attempts_v1;
  v_job ams_private.g1_generation_jobs_v1;
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
  if p_artifact is null or jsonb_typeof(p_artifact) <> 'object' then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end if;
  if p_artifact ->> 'schema_version' is distinct from 'g1_artifact_v1' then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end if;
  begin
    v_sha := p_artifact ->> 'content_sha256';
    v_mime := p_artifact ->> 'mime_type';
    v_bytes := (p_artifact ->> 'byte_size')::bigint;
    v_path := p_artifact ->> 'storage_path';
    v_source_url := nullif(p_artifact ->> 'source_url', '');
    v_usage := coalesce(p_artifact -> 'usage', '{}'::jsonb);
    v_cost := (p_artifact ->> 'cost_cny')::numeric;
    v_width := (p_artifact ->> 'width')::integer;
    v_height := (p_artifact ->> 'height')::integer;
    v_duration := (p_artifact ->> 'duration_seconds')::numeric;
  exception when others then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_INVALID';
  end;
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_HASH_INVALID';
  end if;
  if v_mime is null or v_mime !~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_MIME_INVALID';
  end if;
  if v_bytes is null or v_bytes < 1 or v_bytes > 536870912 then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_SIZE_INVALID';
  end if;
  if v_width is not null and (v_width < 1 or v_width > 16384) then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_DIMENSIONS_INVALID';
  end if;
  if v_height is not null and (v_height < 1 or v_height > 16384) then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_DIMENSIONS_INVALID';
  end if;
  if v_duration is not null and (v_duration < 0 or v_duration > 86400) then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_DURATION_INVALID';
  end if;
  if v_source_url is not null and (char_length(v_source_url) > 500 or v_source_url !~ '^https?://') then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_SOURCE_INVALID';
  end if;
  if v_usage is not null and octet_length(v_usage::text) > 4096 then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_USAGE_TOO_LARGE';
  end if;
  if v_cost is not null and (v_cost < 0 or v_cost > 100000) then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_COST_INVALID';
  end if;
  if v_path is null or char_length(v_path) < 1 or char_length(v_path) > 300 then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_PATH_INVALID';
  end if;

  select * into v_row
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if v_row.state not in ('submitted', 'running') then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_STATE_INVALID';
  end if;
  if v_row.claimed_by is distinct from p_worker_id or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now()
  then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_LOST';
  end if;
  if v_row.provider_task_id is null then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_TASK_MISSING';
  end if;

  select * into v_job from ams_private.g1_generation_jobs_v1 where id = p_job_id;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'G1_JOB_NOT_FOUND';
  end if;

  -- MIME 必须与 mode 匹配（图片任务只能产出图片，视频任务只能产出视频）。
  if v_job.mode = 'image' and v_mime !~ '^image/' then
    raise exception using errcode = 'P0001', message = 'G1_MIME_MISMATCH';
  end if;
  if v_job.mode <> 'image' and v_mime !~ '^video/' then
    raise exception using errcode = 'P0001', message = 'G1_MIME_MISMATCH';
  end if;

  -- 私有确定性路径：{user}/{project}/{job}/v{version}/{sha12}.{ext}。
  v_next := (select coalesce(max(a.artifact_version), 0) + 1
             from ams_private.g1_generation_artifacts_v1 a where a.job_id = p_job_id);
  v_path_pattern := '^' || v_job.user_id::text || '/prj-[0-9a-f]{24}/g1j-[0-9a-f]{24}/v'
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
     v_width, v_height, v_duration, v_path, v_row.provider_task_id, v_job.model_name,
     v_job.model_version, v_job.provider_id,
     encode(extensions.digest(convert_to(coalesce(v_job.request ->> 'prompt', ''), 'UTF8'), 'sha256'), 'hex'),
     v_job.brief_id, v_job.brief_version, v_job.brief_fingerprint,
     v_job.knowledge_card_ids, v_job.evidence_ids, v_job.reference_asset_id,
     v_source_url, v_usage, v_cost);

  update ams_private.g1_generation_attempts_v1 at
  set state = 'succeeded', downloaded_sha256 = v_sha, mime_type = v_mime,
      byte_size = v_bytes, width = v_width, height = v_height,
      duration_seconds = v_duration, usage = v_usage, cost_cny = v_cost,
      completed_at = now(), lease_expires_at = null, claimed_by = null
  where at.id = p_attempt_id and at.job_id = p_job_id;

  update ams_private.g1_generation_jobs_v1 j
  set status = 'completed', updated_at = now()
  where j.id = p_job_id and j.status not in ('completed', 'failed');

  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'artifact.created',
    jsonb_build_object('artifact_id', v_artifact_id, 'artifact_version', v_next,
      'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
      'provider_id', v_job.provider_id));
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'job.completed',
    jsonb_build_object('artifact_version', v_next));

  return jsonb_build_object('ok', true, 'artifact',
    jsonb_build_object('id', v_artifact_id, 'artifact_version', v_next,
      'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
      'storage_path', v_path));
end;
$$;

-- ============================================================================
-- 9. 既有已付费 provider task 恢复：上下文携带 provider_id；产物血缘按作业
-- ============================================================================
create or replace function api.g1_get_ambiguous_recovery_context(
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
    'provider_id', v_job.provider_id,
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

create or replace function api.g1_recover_ambiguous_attempt(
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
     v_job.model_version, v_job.provider_id,
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
      'provider_id', v_job.provider_id, 'recovered', true));
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'job.completed',
    jsonb_build_object('artifact_version', v_next, 'recovered', true));

  return jsonb_build_object('ok', true, 'artifact', jsonb_build_object(
    'id', v_artifact_id, 'artifact_version', v_next,
    'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
    'storage_path', v_path));
end;
$$;

-- ============================================================================
-- 10. Approved pre-submit fallback. This is the only mutable route action and
-- is legal only before reportPoll(pre_submit), provider task persistence or
-- cost. The fallback identity is taken from the immutable quote snapshot.
-- ============================================================================
create or replace function api.g3_switch_provider_pre_submit(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_from_provider_id text,
  p_to_provider_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_job ams_private.g1_generation_jobs_v1;
  v_attempt ams_private.g1_generation_attempts_v1;
  v_provider ams_private.g1_generation_provider_registry_v1;
  v_candidate jsonb;
begin
  if p_reason not in ('adapter_unavailable','api_key_missing','endpoint_missing','capability_unavailable') then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_REASON_INVALID';
  end if;
  select * into v_job from ams_private.g1_generation_jobs_v1 where id = p_job_id for update;
  select * into v_attempt from ams_private.g1_generation_attempts_v1
    where id = p_attempt_id and job_id = p_job_id for update;
  if v_job.id is null or v_attempt.id is null then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_TARGET_NOT_FOUND';
  end if;
  if v_job.provider_id is distinct from p_from_provider_id
    or v_job.route_snapshot ->> 'fallback_provider_id' is distinct from p_to_provider_id
  then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_NOT_APPROVED';
  end if;
  select candidate into v_candidate
  from jsonb_array_elements(coalesce(v_job.route_snapshot -> 'candidates', '[]'::jsonb)) candidate
  where candidate ->> 'provider_id' = p_to_provider_id
  limit 1;
  if v_candidate is null then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_NOT_APPROVED';
  end if;
  -- A freshly claimed attempt is still backed by a queued job until
  -- g1_mark_provider_submitted opens the provider window. Both queued and
  -- running are safe here only while the attempt remains claimed and has no
  -- provider state/task identity.
  if v_job.status not in ('queued', 'running') or v_attempt.state <> 'claimed'
    or v_attempt.claimed_by is distinct from p_worker_id
    or v_attempt.provider_task_id is not null
    or coalesce(v_attempt.provider_state ->> 'phase', '') <> ''
  then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_WINDOW_CLOSED';
  end if;
  select * into v_provider
  from ams_private.g1_generation_provider_registry_v1 r
  where r.provider_id = p_to_provider_id and r.mode = v_job.mode
    and r.enabled is true and r.health_status <> 'unavailable' and r.fallback_eligible is true;
  if v_provider is null then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_UNAVAILABLE';
  end if;
  -- The live registry must still be byte-for-byte compatible with the
  -- approved candidate snapshot. A changed model/version/price/latency is a
  -- new commercial route and requires a fresh quote instead of fallback.
  if v_candidate ->> 'model_name' is distinct from v_provider.model_name
    or (v_candidate ->> 'model_version')::integer is distinct from v_provider.model_version
    or (v_candidate ->> 'registry_version')::integer is distinct from v_provider.registry_version
    or (v_candidate ->> 'price_cny_min')::numeric is distinct from v_provider.price_cny_min
    or (v_candidate ->> 'price_cny_max')::numeric is distinct from v_provider.price_cny_max
    or (v_candidate ->> 'estimated_latency_seconds_min')::integer is distinct from v_provider.estimated_latency_seconds_min
    or (v_candidate ->> 'estimated_latency_seconds_max')::integer is distinct from v_provider.estimated_latency_seconds_max
    or v_provider.price_cny_max > (v_job.quote ->> 'estimated_max_cost_cny')::numeric
  then
    raise exception using errcode = 'P0001', message = 'G3_FALLBACK_REGISTRY_DRIFT';
  end if;

  update ams_private.g1_generation_jobs_v1
  set provider_id = v_candidate ->> 'provider_id',
      model_name = v_candidate ->> 'model_name',
      model_version = (v_candidate ->> 'model_version')::integer,
      updated_at = now()
  where id = p_job_id;
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'route.fallback_selected', jsonb_build_object(
    'from_provider_id', p_from_provider_id,
    'to_provider_id', p_to_provider_id,
    'reason', p_reason,
    'phase', 'pre_submit'));
  return jsonb_build_object('ok', true, 'provider_id', v_candidate ->> 'provider_id',
    'model_name', v_candidate ->> 'model_name',
    'model_version', (v_candidate ->> 'model_version')::integer);
end;
$$;

-- ============================================================================
-- 11. ACL 收尾：既有函数权限（revoke public/anon/
--     authenticated；grant service_role）已在前序迁移确立，create or replace
--     不改变函数 ACL。此处显式复述关键边界以保持迁移可独立审计。
-- ============================================================================
revoke all on function api.g1_quote_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function api.g1_claim_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function api.g1_complete_attempt(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function api.g1_list_jobs(uuid, text, integer) from public, anon, authenticated;
revoke all on function api.g1_get_ambiguous_recovery_context(text, text, text) from public, anon, authenticated;
revoke all on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function ams_private.g1_normalize_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function ams_private.g1_job_summary(text) from public, anon, authenticated;
revoke all on function api.g3_switch_provider_pre_submit(text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function api.g1_quote_request(uuid, jsonb) to service_role;
grant execute on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer) to service_role;
grant execute on function api.g1_claim_jobs(text, integer, integer) to service_role;
grant execute on function api.g1_complete_attempt(text, text, text, jsonb) to service_role;
grant execute on function api.g1_list_jobs(uuid, text, integer) to service_role;
grant execute on function api.g1_get_ambiguous_recovery_context(text, text, text) to service_role;
grant execute on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb) to service_role;
grant execute on function ams_private.g1_normalize_request(uuid, jsonb) to service_role;
grant execute on function ams_private.g1_job_summary(text) to service_role;
grant execute on function api.g3_switch_provider_pre_submit(text, text, text, text, text, text) to service_role;

comment on function api.g1_claim_jobs(text, integer, integer) is
  'G1 worker claim/lease with binding re-validation and routed provider identity (service-role only).';
comment on function api.g1_complete_attempt(text, text, text, jsonb) is
  'G1 worker artifact completion with lineage binding to the routed provider (service-role only).';
comment on function api.g1_list_jobs(uuid, text, integer) is
  'G1 user-scoped job list with routed provider identity (service-role only).';
comment on function api.g1_get_ambiguous_recovery_context(text, text, text) is
  'G1 read-only recovery context with routed provider identity (service-role only).';
comment on function api.g1_recover_ambiguous_attempt(text, text, text, text, text, jsonb) is
  'G1 atomic artifact recovery for an already-succeeded provider task; never submits provider work (service-role only).';
