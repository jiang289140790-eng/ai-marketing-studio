-- ============================================================================
-- G1 P19 证据报价绑定最终合并 (evidence quote binding) v1。
--
-- 一个前向迁移，仅替换/扩展 G1 请求归一化边界的证据绑定段（P19 事故
-- `G1_BINDING_MISMATCH` 修复）：历史 P19 Brief 的 `evidence_provenance`
-- 只有 `created_from`/`local_only`/`statement`/`store`，没有 `evidence_ids`，
-- 旧归一化把缺失字段当作 `[]` 处理，导致生成页面正确派生的证据集合与空集比较
-- 确定性失败。
--
-- 新合同（权威证据集从被引知识卡确定性派生）：
--   1) 有效卡片集 = 请求 `knowledge_card_ids`（提供时）或 Brief
--      `knowledge_citation_ids`（省略时）；必须为数组、有界(1..100)、非空、
--      无重复、每个身份为规范 `kc-<24 lowercase hex>`；
--   2) 有效卡片集与 Brief 卡片集经规范排序后必须相等（请求侧重复在去重前拒绝）；
--   3) 每张被引卡加载同用户/同项目的最新持久化行；任一缺失 → G1_BINDING_MISSING；
--   4) 读取每张卡完整 `evidence_links` 数组与每个 `source_ref`：每条必须是对象、
--      `source_ref` 必须为规范 `ev-<24 lowercase hex>`，且每条 source_ref 必须
--      存在于同用户/同项目（缺失/畸形/重复入参/歧义/跨项目 → 报价前 fail closed）；
--   5) 权威证据集 = 全部卡片 `source_ref` 经规范排序 + 跨卡合法重复去重
--      （有界 1..1000）；
--   6) Brief 显式 `evidence_provenance.evidence_ids`（键存在时）必须规范集合
--      精确等于权威证据集；字段缺失（历史 P19 Brief）时直接采用权威集，
--      绝不把缺失视为空集；
--   7) 请求显式 `evidence_ids`（提供时）必须规范集合精确等于权威集（重复在
--      去重前拒绝）；省略时自动绑定权威集。
--
-- 行为保持：Brief 指纹/修订、Provider 隔离、幂等、报价、批准、提交顺序与全部
-- 既有 G1 失败码（G1_BINDING_INVALID / G1_BINDING_MISMATCH / G1_BINDING_MISSING）
-- 均不变；不修改任何表结构、RLS、GRANT、历史数据或历史迁移。g1_quote_request
-- 与 g1_approve_submit 经由替换后的 g1_normalize_request 在 provider 调用前
-- fail closed。
-- ============================================================================

-- ---- 1. 证据绑定解析辅助函数（报价边界共享；全部 fail closed）----
create or replace function ams_private.g1_resolve_evidence_binding(
  p_user_id uuid,
  p_project_id text,
  p_cards_requested jsonb,
  p_brief_cards jsonb,
  p_brief_provenance jsonb,
  p_evidence_requested jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_cards_raw jsonb;
  v_cards jsonb;
  v_cards_brief jsonb;
  v_card record;
  v_refs jsonb;
  v_derived jsonb;
  v_evidence jsonb;
  v_has_explicit boolean;
  v_count integer;
begin
  -- 1) 有效卡片集：请求提供时用请求数组，省略时用 Brief 引用的卡片数组；
  --    数组、有界(1..100)、非空、规范身份、无重复（重复在去重前拒绝）。
  v_cards_raw := coalesce(p_cards_requested, p_brief_cards);
  if jsonb_typeof(v_cards_raw) <> 'array'
    or jsonb_array_length(v_cards_raw) < 1
    or jsonb_array_length(v_cards_raw) > 100
  then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_cards_raw) as t(value)
    where t.value is null or t.value !~ '^kc-[0-9a-f]{24}$'
  ) then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  select count(*) into v_count
  from (
    select t.value from jsonb_array_elements_text(v_cards_raw) as t(value)
    group by t.value having count(*) > 1
  ) dup;
  if v_count > 0 then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  select jsonb_agg(value order by value) into v_cards
  from jsonb_array_elements_text(v_cards_raw) as t(value);

  -- 2) 有效卡片集与 Brief 卡片集规范排序后必须相等。Brief 侧不去重：
  --    Brief 自带重复引用时任何请求都无法相等 → fail closed。
  if p_brief_cards is null or jsonb_typeof(p_brief_cards) <> 'array' then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  select jsonb_agg(value order by value) into v_cards_brief
  from jsonb_array_elements_text(p_brief_cards) as t(value);
  if v_cards is distinct from v_cards_brief then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISMATCH';
  end if;

  -- 3) 每张被引卡必须存在同用户/同项目持久化行（跨项目/缺失 → MISSING）。
  select count(*) into v_count
  from jsonb_array_elements_text(v_cards) as t(value)
  where not exists (
    select 1 from ams_private.p19_knowledge_cards_v1 kc
    where kc.user_id = p_user_id and kc.project_id = p_project_id
      and kc.knowledge_id = t.value
  );
  if v_count > 0 then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISSING';
  end if;

  -- 4)+5) 读取每张卡（最新持久化版本）的完整 evidence_links：每条必须是对象、
  --    source_ref 必须为规范 ev- 身份；权威证据集 = 全部 source_ref 规范排序
  --    + 跨卡合法重复去重（有界 1..1000）。
  v_refs := '[]'::jsonb;
  for v_card in
    select kc.evidence_links
    from (
      select distinct on (kc2.knowledge_id) kc2.knowledge_id, kc2.evidence_links
      from ams_private.p19_knowledge_cards_v1 kc2
      where kc2.user_id = p_user_id and kc2.project_id = p_project_id
        and kc2.knowledge_id in (
          select value from jsonb_array_elements_text(v_cards) as t(value)
        )
      order by kc2.knowledge_id asc, kc2.knowledge_version desc, kc2.id asc
    ) kc
    order by kc.knowledge_id asc
  loop
    if jsonb_typeof(v_card.evidence_links) <> 'array'
      or jsonb_array_length(v_card.evidence_links) < 1
      or jsonb_array_length(v_card.evidence_links) > 100
    then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    select count(*) into v_count
    from jsonb_array_elements(v_card.evidence_links) as l(link)
    where jsonb_typeof(l.link) <> 'object'
      or l.link ->> 'source_ref' is null
      or l.link ->> 'source_ref' !~ '^ev-[0-9a-f]{24}$';
    if v_count > 0 then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    v_refs := v_refs || (
      select jsonb_agg(l.link ->> 'source_ref')
      from jsonb_array_elements(v_card.evidence_links) as l(link)
    );
  end loop;
  select jsonb_agg(value order by value) into v_derived
  from (
    select distinct t.value
    from jsonb_array_elements_text(v_refs) as t(value)
  ) d;
  if v_derived is null
    or jsonb_array_length(v_derived) < 1
    or jsonb_array_length(v_derived) > 1000
  then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  select count(*) into v_count
  from jsonb_array_elements_text(v_derived) as t(value)
  where not exists (
    select 1 from ams_private.p19_evidence_records_v1 ev
    where ev.user_id = p_user_id and ev.project_id = p_project_id
      and ev.evidence_id = t.value
  );
  if v_count > 0 then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISSING';
  end if;

  -- 6) Brief 显式 provenance：键存在时规范集合必须精确等于权威集；
  --    缺失（历史 P19 Brief）→ 采用权威集，绝不视为空集。
  if p_brief_provenance is not null and jsonb_typeof(p_brief_provenance) <> 'object' then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  v_has_explicit := p_brief_provenance is not null
    and jsonb_typeof(p_brief_provenance) = 'object'
    and p_brief_provenance ? 'evidence_ids';
  if v_has_explicit then
    v_evidence := p_brief_provenance -> 'evidence_ids';
    if jsonb_typeof(v_evidence) <> 'array'
      or jsonb_array_length(v_evidence) < 1
      or jsonb_array_length(v_evidence) > 1000
    then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_evidence) as t(value)
      where t.value is null or t.value !~ '^ev-[0-9a-f]{24}$'
    ) then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    select count(*) into v_count
    from (
      select t.value from jsonb_array_elements_text(v_evidence) as t(value)
      group by t.value having count(*) > 1
    ) dup;
    if v_count > 0 then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    select jsonb_agg(value order by value) into v_evidence
    from (
      select distinct t.value from jsonb_array_elements_text(v_evidence) as t(value)
    ) d;
    if v_evidence is distinct from v_derived then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_MISMATCH';
    end if;
  end if;

  -- 7) 请求显式 evidence_ids：提供时规范集合必须精确等于权威集（重复在去重前
  --    拒绝）；省略时自动绑定权威集。
  if p_evidence_requested is not null then
    v_evidence := p_evidence_requested;
    if jsonb_typeof(v_evidence) <> 'array'
      or jsonb_array_length(v_evidence) < 1
      or jsonb_array_length(v_evidence) > 1000
    then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_evidence) as t(value)
      where t.value is null or t.value !~ '^ev-[0-9a-f]{24}$'
    ) then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    select count(*) into v_count
    from (
      select t.value from jsonb_array_elements_text(v_evidence) as t(value)
      group by t.value having count(*) > 1
    ) dup;
    if v_count > 0 then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
    end if;
    select jsonb_agg(value order by value) into v_evidence
    from (
      select distinct t.value from jsonb_array_elements_text(v_evidence) as t(value)
    ) d;
    if v_evidence is distinct from v_derived then
      raise exception using errcode = 'P0001', message = 'G1_BINDING_MISMATCH';
    end if;
  else
    v_evidence := v_derived;
  end if;

  return jsonb_build_object('knowledge_card_ids', v_cards, 'evidence_ids', v_evidence);
end;
$$;

comment on function ams_private.g1_resolve_evidence_binding(uuid, text, jsonb, jsonb, jsonb, jsonb)
  is 'G1 P19 证据报价绑定：从被引知识卡 evidence_links[].source_ref 派生权威证据集；Brief/请求显式集合必须精确匹配；缺失/畸形/重复/跨项目全部报价前 fail closed。';

-- ============================================================================
-- 2. 替换 g1_normalize_request：除知识卡/证据绑定段外与 G1 v1 完全一致，
--    （Brief 指纹/修订、Provider 隔离、有界字段、引用素材、规范请求 SHA-256
--    与全部既有失败码不变）。
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

  select * into v_provider
  from ams_private.g1_generation_provider_registry_v1
  where provider_id = 'bailian' and mode = v_mode;
  if v_provider is null then
    raise exception using errcode = 'P0001', message = 'G1_MODEL_UNAVAILABLE';
  end if;
  if v_provider.enabled is not true then
    raise exception using errcode = 'P0001', message = 'G1_MODEL_DISABLED';
  end if;
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
  is 'G1 规范请求归一化（P19 证据报价绑定合同 v1）：知识卡/证据绑定段由被引卡 evidence_links 派生权威证据集；缺失/重复/畸形/跨项目在报价前 fail closed。';
