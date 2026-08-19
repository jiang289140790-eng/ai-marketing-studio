-- ============================================================================
-- G1 百炼图片/视频生成执行层 (Bailian generation execution layer) v1.
--
-- 一个前向迁移，为私有生成作业/尝试/产物/追加式事件建立服务端契约：
--   - 固定 provider 注册表（服务端所有，浏览器只能选择注册表内 mode/model，
--     不能选择任意端点、模型、provider、工作流、回调或凭证）；
--   - 有界 quote（不可变 quote 指纹 + 规范请求 SHA-256 + 到期时间）；
--   - 显式批准对象（绑定用户、项目、精确 quote 指纹、请求指纹、预估最大费用
--     与到期时间；任何 prompt/model/引用/Brief/修订变化都会在任何 provider
--     调用之前使 quote 失效）；
--   - 幂等作业契约（同 key + 同规范请求 → 重放既有作业；同 key + 不同请求 →
--     在计费之前有界冲突）；
--   - worker claim/lease、心跳、provider 提交、轮询、成功/失败与有界重试；
--   - 私有产物路径（用户/项目/作业/版本）+ 精确 Brief 版本/知识卡/证据绑定；
--   - 终态不可变（触发器）与追加式事件。
--
-- 安全模型与已验收 P17/P19 一致：
--   - 全部表位于 ams_private（P17 已 revoke public/anon/authenticated）；
--   - 全部边界函数位于 api schema，security definer，
--     set search_path = ams_private, public；
--   - anon/authenticated 对每个 api.g1_* 零 EXECUTE；仅 service_role 可调用；
--   - 不修改 Auth、既有 RLS/GRANT 语义、既有业务数据或历史迁移；
--   - 浏览器永远只通过 g1-generation-command Edge Function（service-role 客户端）
--     调用这些边界；任何浏览器直接 RPC 都会失败关闭。
-- ============================================================================

-- ---- 0. 私有 Storage bucket（无公开策略：浏览器只能拿到短时签名 URL） ----
insert into storage.buckets (id, name, public, file_size_limit)
values ('g1-generation-artifacts', 'g1-generation-artifacts', false, 536870912)
on conflict (id) do nothing;

-- ============================================================================
-- 1. 固定 provider 注册表（服务端所有，浏览器只读）
-- ============================================================================
create table if not exists ams_private.g1_generation_provider_registry_v1 (
  provider_id text not null check (provider_id ~ '^[a-z][a-z0-9-]{1,31}$'),
  mode text not null check (mode in ('image', 'video_t2v', 'video_i2v')),
  model_name text not null check (model_name ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),
  model_version integer not null default 1 check (model_version >= 1),
  enabled boolean not null default true,
  price_cny_min numeric(12,4) not null check (price_cny_min >= 0),
  price_cny_max numeric(12,4) not null check (price_cny_max >= price_cny_min),
  max_prompt_chars integer not null check (max_prompt_chars between 1 and 4000),
  max_negative_prompt_chars integer not null default 0 check (max_negative_prompt_chars >= 0),
  allowed_aspect_ratios jsonb not null default '[]'::jsonb,
  max_duration_seconds integer not null default 0 check (max_duration_seconds >= 0),
  allowed_resolutions jsonb not null default '[]'::jsonb,
  reference_required boolean not null default false,
  max_artifact_bytes bigint not null default 536870912 check (max_artifact_bytes between 1024 and 536870912),
  created_at timestamptz not null default now(),
  primary key (provider_id, mode)
);

-- 固定初始 provider/models（Baseline 精确指定；费用为有界估算区间，仅用于
-- 显式批准前的费用预览，绝不经由此表触发任何真实调用）。
insert into ams_private.g1_generation_provider_registry_v1
  (provider_id, mode, model_name, model_version, enabled, price_cny_min, price_cny_max,
   max_prompt_chars, max_negative_prompt_chars, allowed_aspect_ratios,
   max_duration_seconds, allowed_resolutions, reference_required, max_artifact_bytes)
values
  ('bailian', 'image', 'qwen-image-2.0', 1, true, 0.0200, 0.3000,
   2000, 500, '["1:1","4:3","3:4","16:9","9:16","21:9"]'::jsonb,
   0, '[]'::jsonb, false, 20971520),
  ('bailian', 'video_t2v', 'happyhorse-1.0-t2v', 1, true, 0.5000, 8.0000,
   2000, 500, '["16:9","9:16","1:1"]'::jsonb,
   10, '["720p","1080p"]'::jsonb, false, 536870912),
  ('bailian', 'video_i2v', 'happyhorse-1.0-i2v', 1, true, 0.8000, 12.0000,
   2000, 500, '["16:9","9:16","1:1"]'::jsonb,
   10, '["720p","1080p"]'::jsonb, true, 536870912)
on conflict (provider_id, mode) do nothing;

-- ============================================================================
-- 2. 不可变 quote（同用户 + 同规范请求 → 复用同一 quote 指纹）
-- ============================================================================
create table if not exists ams_private.g1_generation_quotes_v1 (
  id text primary key check (id ~ '^g1q-[0-9a-f]{24}$'),
  user_id uuid not null,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  quote_fingerprint text not null check (quote_fingerprint ~ '^[0-9a-f]{64}$'),
  mode text not null check (mode in ('image', 'video_t2v', 'video_i2v')),
  model_name text not null,
  payload jsonb not null,
  price_cny_min numeric(12,4) not null check (price_cny_min >= 0),
  price_cny_max numeric(12,4) not null check (price_cny_max >= price_cny_min),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint g1_quotes_user_request_uq unique (user_id, request_sha256)
);

-- ============================================================================
-- 3. 私有生成作业
-- ============================================================================
create table if not exists ams_private.g1_generation_jobs_v1 (
  id text primary key check (id ~ '^g1j-[0-9a-f]{24}$'),
  user_id uuid not null,
  project_id text not null check (project_id ~ '^prj-[0-9a-f]{24}$'),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  quote_id text not null check (quote_id ~ '^g1q-[0-9a-f]{24}$'),
  quote_fingerprint text not null check (quote_fingerprint ~ '^[0-9a-f]{64}$'),
  approval jsonb not null,
  request jsonb not null,
  quote jsonb not null,
  mode text not null check (mode in ('image', 'video_t2v', 'video_i2v')),
  model_name text not null,
  model_version integer not null default 1 check (model_version >= 1),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'needs_attention')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 2 check (max_attempts between 1 and 5),
  brief_id text not null check (brief_id ~ '^brief-[0-9a-f]{24}$'),
  brief_version integer not null check (brief_version >= 1),
  brief_fingerprint text not null check (brief_fingerprint ~ '^[0-9a-f]{64}$'),
  project_revision integer not null check (project_revision >= 1),
  knowledge_card_ids jsonb not null default '[]'::jsonb,
  evidence_ids jsonb not null default '[]'::jsonb,
  reference_asset_id text,
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint g1_jobs_idempotency_uq unique (user_id, project_id, idempotency_key)
);

-- ============================================================================
-- 4. 生成尝试（lease 所有权；每次有界重试一个新 attempt 行）
-- ============================================================================
create table if not exists ams_private.g1_generation_attempts_v1 (
  id text primary key check (id ~ '^g1a-[0-9a-f]{24}$'),
  job_id text not null references ams_private.g1_generation_jobs_v1(id) on delete restrict,
  attempt_no integer not null check (attempt_no >= 1),
  state text not null default 'queued'
    check (state in ('queued', 'claimed', 'submitted', 'running', 'succeeded', 'failed', 'ambiguous')),
  lease_expires_at timestamptz,
  claimed_by text check (claimed_by is null or char_length(claimed_by) between 1 and 64),
  provider_task_id text check (provider_task_id is null or char_length(provider_task_id) between 1 and 200),
  provider_status text check (provider_status is null or char_length(provider_status) between 1 and 40),
  provider_state jsonb not null default '{}'::jsonb,
  downloaded_sha256 text check (downloaded_sha256 is null or downloaded_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size between 1 and 536870912),
  width integer check (width is null or width between 1 and 16384),
  height integer check (height is null or height between 1 and 16384),
  duration_seconds numeric(8,3) check (duration_seconds is null or duration_seconds between 0 and 86400),
  usage jsonb not null default '{}'::jsonb,
  cost_cny numeric(12,4) check (cost_cny is null or cost_cny between 0 and 100000),
  diagnostics jsonb not null default '{}'::jsonb,
  claimed_at timestamptz,
  submitted_at timestamptz,
  polled_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint g1_attempts_job_no_uq unique (job_id, attempt_no)
);

-- ============================================================================
-- 5. 私有产物（版本历史；绑定精确 Brief 版本 + 知识卡/证据身份）
-- ============================================================================
create table if not exists ams_private.g1_generation_artifacts_v1 (
  id text primary key check (id ~ '^g1x-[0-9a-f]{24}$'),
  job_id text not null references ams_private.g1_generation_jobs_v1(id) on delete restrict,
  attempt_id text not null references ams_private.g1_generation_attempts_v1(id) on delete restrict,
  artifact_version integer not null check (artifact_version >= 1),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null,
  byte_size bigint not null check (byte_size between 1 and 536870912),
  width integer check (width is null or width between 1 and 16384),
  height integer check (height is null or height between 1 and 16384),
  duration_seconds numeric(8,3) check (duration_seconds is null or duration_seconds between 0 and 86400),
  storage_path text not null,
  provider_task_id text not null check (char_length(provider_task_id) between 1 and 200),
  model_name text not null,
  model_version integer not null check (model_version >= 1),
  provider text not null default 'bailian',
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  brief_id text not null check (brief_id ~ '^brief-[0-9a-f]{24}$'),
  brief_version integer not null check (brief_version >= 1),
  brief_fingerprint text not null check (brief_fingerprint ~ '^[0-9a-f]{64}$'),
  knowledge_card_ids jsonb not null default '[]'::jsonb,
  evidence_ids jsonb not null default '[]'::jsonb,
  reference_asset_id text,
  source_url text check (source_url is null or (char_length(source_url) <= 500 and source_url ~ '^https?://')),
  usage jsonb not null default '{}'::jsonb,
  cost_cny numeric(12,4) check (cost_cny is null or cost_cny between 0 and 100000),
  created_at timestamptz not null default now(),
  constraint g1_artifacts_job_version_uq unique (job_id, artifact_version)
);

-- ============================================================================
-- 6. 追加式事件（只允许 insert）
-- ============================================================================
create table if not exists ams_private.g1_generation_events_v1 (
  id bigserial primary key,
  job_id text not null check (job_id ~ '^g1j-[0-9a-f]{24}$'),
  attempt_id text check (attempt_id is null or attempt_id ~ '^g1a-[0-9a-f]{24}$'),
  event text not null check (char_length(event) between 1 and 80),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists g1_generation_events_job_id_idx
  on ams_private.g1_generation_events_v1 (job_id, id);

-- 私有生成执行对象统一启用并强制 RLS。所有访问只经 service-role-only
-- SECURITY DEFINER RPC；不为 anon/authenticated/PUBLIC 创建任何直接策略。
alter table ams_private.g1_generation_provider_registry_v1 enable row level security;
alter table ams_private.g1_generation_provider_registry_v1 force row level security;
alter table ams_private.g1_generation_quotes_v1 enable row level security;
alter table ams_private.g1_generation_quotes_v1 force row level security;
alter table ams_private.g1_generation_jobs_v1 enable row level security;
alter table ams_private.g1_generation_jobs_v1 force row level security;
alter table ams_private.g1_generation_attempts_v1 enable row level security;
alter table ams_private.g1_generation_attempts_v1 force row level security;
alter table ams_private.g1_generation_artifacts_v1 enable row level security;
alter table ams_private.g1_generation_artifacts_v1 force row level security;
alter table ams_private.g1_generation_events_v1 enable row level security;
alter table ams_private.g1_generation_events_v1 force row level security;

-- ============================================================================
-- 7. 不可变性与追加式触发器
-- ============================================================================
create function ams_private.g1_block_events_mutation()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
begin
  raise exception using errcode = 'P0001', message = 'G1_EVENTS_APPEND_ONLY';
end;
$$;

create trigger g1_events_append_only
  before update or delete on ams_private.g1_generation_events_v1
  for each row execute function ams_private.g1_block_events_mutation();

create function ams_private.g1_block_terminal_job_mutation()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
begin
  if tg_op = 'DELETE'
    or (tg_op = 'UPDATE' and old.status in ('completed', 'failed'))
  then
    raise exception using errcode = 'P0001', message = 'G1_JOB_TERMINAL_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger g1_jobs_terminal_immutable
  before update or delete on ams_private.g1_generation_jobs_v1
  for each row execute function ams_private.g1_block_terminal_job_mutation();

create function ams_private.g1_block_terminal_attempt_mutation()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
begin
  if tg_op = 'DELETE'
    or (tg_op = 'UPDATE' and old.state in ('succeeded', 'failed', 'ambiguous'))
  then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_TERMINAL_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger g1_attempts_terminal_immutable
  before update or delete on ams_private.g1_generation_attempts_v1
  for each row execute function ams_private.g1_block_terminal_attempt_mutation();

create function ams_private.g1_block_artifact_mutation()
returns trigger
language plpgsql
security definer
set search_path = ams_private, public
as $$
begin
  raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_IMMUTABLE';
end;
$$;

create trigger g1_artifacts_immutable
  before update or delete on ams_private.g1_generation_artifacts_v1
  for each row execute function ams_private.g1_block_artifact_mutation();

-- ============================================================================
-- 8. 规范请求归一化（quote 与 submit 共用同一 fail-closed 校验路径）
--
-- 校验有界 prompt/negative prompt/画幅/时长/分辨率/引用素材/Brief 身份修订
-- 指纹/项目修订/来源知识卡与证据身份；任何缺失、重复、跨项目或过期绑定都会
-- fail closed。返回规范化 canonical 请求（固定键序的 jsonb）及其 SHA-256。
-- ============================================================================
create function ams_private.g1_normalize_request(p_user_id uuid, p_request jsonb)
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
  v_brief_cards jsonb;
  v_brief_evidence jsonb;
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

  -- 知识卡/证据绑定：请求可省略（缺省 = Brief 引用的集合）；提供时必须与
  -- Brief 精确引用集合相等（排序后逐元素比较），且每个身份存在且属于当前
  -- 项目。缺失、重复、跨项目或未引用全部 fail closed。
  v_brief_cards := coalesce(v_brief.payload -> 'knowledge_citation_ids', '[]'::jsonb);
  v_brief_evidence := coalesce(v_brief.payload -> 'evidence_provenance' -> 'evidence_ids', '[]'::jsonb);
  if v_cards_requested is not null then
    v_cards := v_cards_requested;
  else
    v_cards := v_brief_cards;
  end if;
  if v_evidence_requested is not null then
    v_evidence := v_evidence_requested;
  else
    v_evidence := v_brief_evidence;
  end if;
  if jsonb_typeof(v_cards) <> 'array' or jsonb_typeof(v_evidence) <> 'array' then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_cards) as t(value)
    where t.value !~ '^(kc|card)-[0-9a-f]{24}$'
  ) then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_evidence) as t(value)
    where t.value !~ '^ev-[0-9a-f]{24}$'
  ) then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_INVALID';
  end if;
  select jsonb_agg(value order by value) into v_cards
  from jsonb_array_elements_text(v_cards) as t(value);
  select jsonb_agg(value order by value) into v_evidence
  from jsonb_array_elements_text(v_evidence) as t(value);
  if v_cards is distinct from (
    select jsonb_agg(value order by value) from jsonb_array_elements_text(v_brief_cards) as t(value)
  ) then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISMATCH';
  end if;
  if v_evidence is distinct from (
    select jsonb_agg(value order by value) from jsonb_array_elements_text(v_brief_evidence) as t(value)
  ) then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISMATCH';
  end if;
  select count(*) into v_ref_count
  from jsonb_array_elements_text(v_cards) as t(value)
  where not exists (
    select 1 from ams_private.p19_knowledge_cards_v1 kc
    where kc.user_id = p_user_id and kc.project_id = v_project_id and kc.knowledge_id = t.value
  );
  if v_ref_count > 0 then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISSING';
  end if;
  select count(*) into v_ref_count
  from jsonb_array_elements_text(v_evidence) as t(value)
  where not exists (
    select 1 from ams_private.p19_evidence_records_v1 ev
    where ev.user_id = p_user_id and ev.project_id = v_project_id and ev.evidence_id = t.value
  );
  if v_ref_count > 0 then
    raise exception using errcode = 'P0001', message = 'G1_BINDING_MISSING';
  end if;

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

-- ============================================================================
-- 9. 只读注册表/引用素材（浏览器经 Edge Function 只读）
-- ============================================================================
create function api.g1_get_provider_registry()
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.provider_id, t.mode), '[]'::jsonb)
  from ams_private.g1_generation_provider_registry_v1 t;
$$;

create function api.g1_list_reference_assets(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id::text,
      'name', s.name,
      'type', s.type,
      'purpose', s.workflow -> 'asset_context' ->> 'purpose',
      'approval', s.workflow -> 'asset_context' ->> 'approval'
    ) order by s.created_at desc
  ), '[]'::jsonb)
  from (
    select a.id, a.name, a.type, a.workflow, a.created_at
    from public.assets a
    where a.user_id = p_user_id and a.type = 'image'
      and coalesce(a.workflow -> 'asset_context' ->> 'approval', '') = 'approved'
    order by a.created_at desc
    limit 50
  ) s;
$$;

-- ============================================================================
-- 10. 报价（不可变；同用户+同规范请求 → 复用既有 quote）
-- ============================================================================
create function api.g1_quote_request(p_user_id uuid, p_request jsonb)
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
    'provider', 'bailian',
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
     payload, price_cny_min, price_cny_max, expires_at)
  values
    (v_quote_id, p_user_id, v_norm ->> 'project_id', v_norm ->> 'request_sha256', v_fingerprint,
     v_norm ->> 'mode', v_norm ->> 'model_name', v_payload,
     (v_norm ->> 'price_cny_min')::numeric, (v_norm ->> 'price_cny_max')::numeric, v_expires_at)
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

-- ============================================================================
-- 11. 显式批准 + 幂等提交（任何变化都在 provider 调用之前使 quote 失效）
-- ============================================================================
create function api.g1_approve_submit(
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

  -- 任何 prompt/model/引用/Brief/项目修订变化都会在 provider 调用之前使 quote 失效。
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
     approval, request, quote, mode, model_name, model_version, status, attempt_count,
     max_attempts, brief_id, brief_version, brief_fingerprint, project_revision,
     knowledge_card_ids, evidence_ids, reference_asset_id)
  values
    (v_job_id, p_user_id, v_quote.project_id, p_idempotency_key, v_quote.request_sha256,
     v_quote.id, v_quote.quote_fingerprint, v_approval, v_norm -> 'canonical', v_quote.payload,
     v_norm ->> 'mode', v_norm ->> 'model_name', (v_norm ->> 'model_version')::integer,
     'queued', 1, 2,
     v_norm ->> 'brief_id', (v_norm ->> 'brief_version')::integer, v_norm ->> 'brief_fingerprint',
     (v_norm ->> 'project_revision')::integer,
     v_norm -> 'knowledge_card_ids', v_norm -> 'evidence_ids',
     v_norm ->> 'reference_asset_id')
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
    jsonb_build_object('quote_id', v_quote.id, 'mode', v_norm ->> 'mode', 'model_name', v_norm ->> 'model_name'));

  return jsonb_build_object(
    'ok', true,
    'outcome', 'applied',
    'job', ams_private.g1_job_summary(v_job_id)
  );
end;
$$;

-- ============================================================================
-- 12. 作业只读（浏览器/状态读取；用户隔离）
-- ============================================================================
create function ams_private.g1_job_summary(p_job_id text)
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

create function api.g1_get_job(p_user_id uuid, p_job_id text)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_job ams_private.g1_generation_jobs_v1;
  v_attempts jsonb;
  v_artifacts jsonb;
  v_events jsonb;
begin
  select * into v_job
  from ams_private.g1_generation_jobs_v1
  where id = p_job_id and user_id = p_user_id;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'G1_JOB_NOT_FOUND';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', at.id, 'attempt_no', at.attempt_no, 'state', at.state,
      'provider_task_id', at.provider_task_id, 'provider_status', at.provider_status,
      'provider_state', at.provider_state, 'diagnostics', at.diagnostics,
      'claimed_at', at.claimed_at, 'submitted_at', at.submitted_at,
      'polled_at', at.polled_at, 'completed_at', at.completed_at
    ) order by at.attempt_no asc), '[]'::jsonb)
  into v_attempts
  from ams_private.g1_generation_attempts_v1 at
  where at.job_id = p_job_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', ar.id, 'artifact_version', ar.artifact_version, 'content_sha256', ar.content_sha256,
      'mime_type', ar.mime_type, 'byte_size', ar.byte_size, 'width', ar.width, 'height', ar.height,
      'duration_seconds', ar.duration_seconds, 'storage_path', ar.storage_path,
      'provider_task_id', ar.provider_task_id, 'model_name', ar.model_name,
      'model_version', ar.model_version, 'provider', ar.provider, 'prompt_sha256', ar.prompt_sha256,
      'brief_id', ar.brief_id, 'brief_version', ar.brief_version, 'brief_fingerprint', ar.brief_fingerprint,
      'knowledge_card_ids', ar.knowledge_card_ids, 'evidence_ids', ar.evidence_ids,
      'reference_asset_id', ar.reference_asset_id, 'source_url', ar.source_url,
      'usage', ar.usage, 'cost_cny', ar.cost_cny, 'created_at', ar.created_at
    ) order by ar.artifact_version desc), '[]'::jsonb)
  into v_artifacts
  from ams_private.g1_generation_artifacts_v1 ar
  where ar.job_id = p_job_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'event', e.event, 'attempt_id', e.attempt_id,
      'payload', e.payload, 'created_at', e.created_at
    ) order by e.id desc), '[]'::jsonb)
  into v_events
  from (select * from ams_private.g1_generation_events_v1 e2
        where e2.job_id = p_job_id order by e2.id desc limit 50) e;
  return jsonb_build_object(
    'ok', true,
    'job', ams_private.g1_job_summary(p_job_id),
    'attempts', v_attempts,
    'artifacts', v_artifacts,
    'events', v_events
  );
end;
$$;

create function api.g1_list_jobs(p_user_id uuid, p_project_id text, p_limit integer default 20)
returns jsonb
language sql
security definer
set search_path = ams_private, public
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', j.id, 'project_id', j.project_id, 'status', j.status, 'mode', j.mode,
      'model_name', j.model_name, 'model_version', j.model_version,
      'brief_id', j.brief_id, 'brief_version', j.brief_version,
      'attempt_count', j.attempt_count, 'max_attempts', j.max_attempts,
      'diagnostics', j.diagnostics,
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

create function api.g1_get_artifact(p_user_id uuid, p_job_id text, p_artifact_id text)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'ok', true,
    'artifact', jsonb_build_object(
      'id', ar.id, 'job_id', ar.job_id, 'artifact_version', ar.artifact_version,
      'content_sha256', ar.content_sha256, 'mime_type', ar.mime_type, 'byte_size', ar.byte_size,
      'width', ar.width, 'height', ar.height, 'duration_seconds', ar.duration_seconds,
      'storage_path', ar.storage_path, 'provider_task_id', ar.provider_task_id,
      'model_name', ar.model_name, 'model_version', ar.model_version, 'provider', ar.provider,
      'prompt_sha256', ar.prompt_sha256, 'brief_id', ar.brief_id, 'brief_version', ar.brief_version,
      'brief_fingerprint', ar.brief_fingerprint, 'knowledge_card_ids', ar.knowledge_card_ids,
      'evidence_ids', ar.evidence_ids, 'reference_asset_id', ar.reference_asset_id,
      'source_url', ar.source_url, 'usage', ar.usage, 'cost_cny', ar.cost_cny, 'created_at', ar.created_at
    )
  ) into v_result
  from ams_private.g1_generation_artifacts_v1 ar
  join ams_private.g1_generation_jobs_v1 j on j.id = ar.job_id
  where ar.id = p_artifact_id and ar.job_id = p_job_id and j.user_id = p_user_id;

  if v_result is null then
    raise exception using errcode = 'P0001', message = 'G1_ARTIFACT_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

-- ============================================================================
-- 13. Worker 原子 RPC（仅 service_role 经私有 worker 调用）
--
-- Lease 过期对账规则（崩溃/重启安全，绝不重复付费提交）：
--   - claimed 且 lease 过期且 provider_state.phase <> 'pre_submit'
--     （worker 从未进入提交窗口）→ 安全重新排队（持久化状态证明无已接受的
--     付费作业）；
--   - claimed 且 lease 过期且 phase = 'pre_submit'（提交窗口已开始但任务 id
--     未落盘，无法证明）→ ambiguous / needs_attention，绝不自动重试；
--   - submitted/running 且 lease 过期且有 provider_task_id → 仅允许同一
--     provider task id 的轮询恢复（绝不重新提交）；
--   - 其余异常态 → ambiguous / needs_attention（fail closed）。
-- ============================================================================
create function api.g1_claim_jobs(
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

    select j6.request, j6.quote, j6.mode, j6.model_name, j6.model_version,
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
      'provider_task_id', (
        select at2.provider_task_id from ams_private.g1_generation_attempts_v1 at2
        where at2.id = v_claim.attempt_id
      ),
      'next_artifact_version', v_job.next_artifact_version,
      'request', v_job.request,
      'quote', v_job.quote,
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

create function api.g1_mark_provider_submitted(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_provider_task_id text,
  p_provider_state jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.g1_generation_attempts_v1;
begin
  if p_job_id is null or p_job_id !~ '^g1j-[0-9a-f]{24}$'
    or p_attempt_id is null or p_attempt_id !~ '^g1a-[0-9a-f]{24}$'
  then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if p_provider_task_id is null or char_length(p_provider_task_id) < 1
    or char_length(p_provider_task_id) > 200
  then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_TASK_INVALID';
  end if;
  if p_provider_state is not null and octet_length(p_provider_state::text) > 32768 then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_STATE_TOO_LARGE';
  end if;

  select * into v_row
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if v_row.state in ('succeeded', 'failed', 'ambiguous') then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_TERMINAL';
  end if;
  if v_row.claimed_by is distinct from p_worker_id or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now()
  then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_LOST';
  end if;
  if v_row.provider_task_id is not null and v_row.provider_task_id is distinct from p_provider_task_id then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_TASK_MISMATCH';
  end if;

  update ams_private.g1_generation_attempts_v1 at
  set state = 'submitted', provider_task_id = p_provider_task_id,
      provider_state = coalesce(p_provider_state, '{}'::jsonb), submitted_at = now(),
      lease_expires_at = now() + interval '5 minutes'
  where at.id = p_attempt_id and at.job_id = p_job_id
    and at.claimed_by = p_worker_id and at.state not in ('succeeded', 'failed', 'ambiguous');
  update ams_private.g1_generation_jobs_v1 j
  set status = 'running', updated_at = now()
  where j.id = p_job_id and j.status = 'queued';
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'provider.submitted',
    jsonb_build_object('provider_task_id', p_provider_task_id));
  return jsonb_build_object('ok', true, 'state', 'submitted');
end;
$$;

create function api.g1_heartbeat(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.g1_generation_attempts_v1;
begin
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 3600 then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_BOUNDS';
  end if;
  select * into v_row
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if v_row.state not in ('claimed', 'submitted', 'running') then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_STATE_INVALID';
  end if;
  if v_row.claimed_by is distinct from p_worker_id or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now()
  then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_LOST';
  end if;
  update ams_private.g1_generation_attempts_v1 at
  set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
  where at.id = p_attempt_id and at.job_id = p_job_id and at.claimed_by = p_worker_id;
  return jsonb_build_object('ok', true,
    'lease_expires_at', now() + make_interval(secs => p_lease_seconds));
end;
$$;

create function api.g1_report_poll(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_provider_status text,
  p_provider_state jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.g1_generation_attempts_v1;
begin
  if p_provider_status is null or char_length(p_provider_status) < 1
    or char_length(p_provider_status) > 40
  then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_STATUS_INVALID';
  end if;
  if p_provider_state is not null and octet_length(p_provider_state::text) > 32768 then
    raise exception using errcode = 'P0001', message = 'G1_PROVIDER_STATE_TOO_LARGE';
  end if;
  select * into v_row
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if v_row.state not in ('claimed', 'submitted', 'running') then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_STATE_INVALID';
  end if;
  if v_row.claimed_by is distinct from p_worker_id or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now()
  then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_LOST';
  end if;
  update ams_private.g1_generation_attempts_v1 at
  set provider_status = p_provider_status,
      provider_state = coalesce(p_provider_state, '{}'::jsonb),
      polled_at = now()
  where at.id = p_attempt_id and at.job_id = p_job_id and at.claimed_by = p_worker_id;
  return jsonb_build_object('ok', true);
end;
$$;

create function api.g1_complete_attempt(
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
     v_job.model_version, 'bailian',
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
      'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes));
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id, 'job.completed',
    jsonb_build_object('artifact_version', v_next));

  return jsonb_build_object('ok', true, 'artifact',
    jsonb_build_object('id', v_artifact_id, 'artifact_version', v_next,
      'content_sha256', v_sha, 'mime_type', v_mime, 'byte_size', v_bytes,
      'storage_path', v_path));
end;
$$;

create function api.g1_fail_attempt(
  p_job_id text,
  p_attempt_id text,
  p_worker_id text,
  p_code text,
  p_diagnostics jsonb default '{}'::jsonb,
  p_retry_eligible boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, public
as $$
declare
  v_row ams_private.g1_generation_attempts_v1;
  v_job ams_private.g1_generation_jobs_v1;
  v_next integer;
  v_attempt_id text;
begin
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{0,79}$' then
    raise exception using errcode = 'P0001', message = 'G1_FAILURE_CODE_INVALID';
  end if;
  if p_diagnostics is not null and octet_length(p_diagnostics::text) > 8192 then
    raise exception using errcode = 'P0001', message = 'G1_DIAGNOSTICS_TOO_LARGE';
  end if;
  select * into v_row
  from ams_private.g1_generation_attempts_v1
  where id = p_attempt_id and job_id = p_job_id;
  if v_row.id is null then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_NOT_FOUND';
  end if;
  if v_row.state in ('succeeded', 'failed', 'ambiguous') then
    raise exception using errcode = 'P0001', message = 'G1_ATTEMPT_TERMINAL';
  end if;
  if v_row.claimed_by is distinct from p_worker_id or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now()
  then
    raise exception using errcode = 'P0001', message = 'G1_LEASE_LOST';
  end if;

  select * into v_job from ams_private.g1_generation_jobs_v1 where id = p_job_id;
  if v_job.id is null then
    raise exception using errcode = 'P0001', message = 'G1_JOB_NOT_FOUND';
  end if;

  update ams_private.g1_generation_attempts_v1 at
  set state = case when p_retry_eligible then 'failed' else 'ambiguous' end,
      diagnostics = coalesce(p_diagnostics, '{}'::jsonb) || jsonb_build_object('code', p_code),
      completed_at = now(), lease_expires_at = null, claimed_by = null
  where at.id = p_attempt_id and at.job_id = p_job_id;

  if p_retry_eligible and v_job.attempt_count < v_job.max_attempts then
    v_next := v_job.attempt_count + 1;
    v_attempt_id := 'g1a-' || left(replace(gen_random_uuid()::text, '-', ''), 24);
    insert into ams_private.g1_generation_attempts_v1 (id, job_id, attempt_no, state)
    values (v_attempt_id, p_job_id, v_next, 'queued');
    update ams_private.g1_generation_jobs_v1 j
    set attempt_count = v_next, status = 'queued', updated_at = now(),
        diagnostics = coalesce(j.diagnostics, '{}'::jsonb) || jsonb_build_object('code', p_code)
    where j.id = p_job_id;
    insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
    values (p_job_id, p_attempt_id, 'attempt.retry_scheduled',
      jsonb_build_object('code', p_code, 'attempt_no', v_next));
    return jsonb_build_object('ok', true, 'outcome', 'retry_scheduled',
      'attempt_no', v_next, 'code', p_code);
  end if;

  update ams_private.g1_generation_jobs_v1 j
  set status = case when p_retry_eligible then 'failed' else 'needs_attention' end,
      updated_at = now(),
      diagnostics = coalesce(j.diagnostics, '{}'::jsonb) || jsonb_build_object('code', p_code)
  where j.id = p_job_id and j.status not in ('completed', 'failed');
  insert into ams_private.g1_generation_events_v1 (job_id, attempt_id, event, payload)
  values (p_job_id, p_attempt_id,
    case when p_retry_eligible then 'job.failed' else 'job.needs_attention' end,
    jsonb_build_object('code', p_code));
  return jsonb_build_object('ok', true,
    'outcome', case when p_retry_eligible then 'failed' else 'needs_attention' end,
    'code', p_code);
end;
$$;

-- ============================================================================
-- 14. ACL：anon/authenticated 零 EXECUTE；仅 service_role 可调用
-- ============================================================================
revoke all on function api.g1_get_provider_registry() from public, anon, authenticated;
revoke all on function api.g1_list_reference_assets(uuid) from public, anon, authenticated;
revoke all on function api.g1_quote_request(uuid, jsonb) from public, anon, authenticated;
revoke all on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke all on function api.g1_get_job(uuid, text) from public, anon, authenticated;
revoke all on function api.g1_list_jobs(uuid, text, integer) from public, anon, authenticated;
revoke all on function api.g1_get_artifact(uuid, text, text) from public, anon, authenticated;
revoke all on function api.g1_claim_jobs(text, integer, integer) from public, anon, authenticated;
revoke all on function api.g1_mark_provider_submitted(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function api.g1_heartbeat(text, text, text, integer) from public, anon, authenticated;
revoke all on function api.g1_report_poll(text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function api.g1_complete_attempt(text, text, text, jsonb) from public, anon, authenticated;
revoke all on function api.g1_fail_attempt(text, text, text, text, jsonb, boolean) from public, anon, authenticated;

grant execute on function api.g1_get_provider_registry() to service_role;
grant execute on function api.g1_list_reference_assets(uuid) to service_role;
grant execute on function api.g1_quote_request(uuid, jsonb) to service_role;
grant execute on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer) to service_role;
grant execute on function api.g1_get_job(uuid, text) to service_role;
grant execute on function api.g1_list_jobs(uuid, text, integer) to service_role;
grant execute on function api.g1_get_artifact(uuid, text, text) to service_role;
grant execute on function api.g1_claim_jobs(text, integer, integer) to service_role;
grant execute on function api.g1_mark_provider_submitted(text, text, text, text, jsonb) to service_role;
grant execute on function api.g1_heartbeat(text, text, text, integer) to service_role;
grant execute on function api.g1_report_poll(text, text, text, text, jsonb) to service_role;
grant execute on function api.g1_complete_attempt(text, text, text, jsonb) to service_role;
grant execute on function api.g1_fail_attempt(text, text, text, text, jsonb, boolean) to service_role;

comment on function api.g1_get_provider_registry() is 'G1 server-owned provider registry read (service-role only).';
comment on function api.g1_list_reference_assets(uuid) is 'G1 approved image reference assets for i2v (service-role only).';
comment on function api.g1_quote_request(uuid, jsonb) is 'G1 immutable bounded quote (service-role only).';
comment on function api.g1_approve_submit(uuid, text, jsonb, jsonb, integer) is 'G1 explicit approval + idempotent paid job creation (service-role only).';
comment on function api.g1_get_job(uuid, text) is 'G1 user-scoped job read with attempts/artifacts/events (service-role only).';
comment on function api.g1_list_jobs(uuid, text, integer) is 'G1 user-scoped job list (service-role only).';
comment on function api.g1_get_artifact(uuid, text, text) is 'G1 user-scoped artifact read for signed URL (service-role only).';
comment on function api.g1_claim_jobs(text, integer, integer) is 'G1 worker claim/lease with binding re-validation (service-role only).';
comment on function api.g1_mark_provider_submitted(text, text, text, text, jsonb) is 'G1 worker provider submission record (service-role only).';
comment on function api.g1_heartbeat(text, text, text, integer) is 'G1 worker lease heartbeat (service-role only).';
comment on function api.g1_report_poll(text, text, text, text, jsonb) is 'G1 worker polling progress (service-role only).';
comment on function api.g1_complete_attempt(text, text, text, jsonb) is 'G1 worker artifact completion with lineage binding (service-role only).';
comment on function api.g1_fail_attempt(text, text, text, text, jsonb, boolean) is 'G1 worker bounded failure with retry eligibility (service-role only).';
