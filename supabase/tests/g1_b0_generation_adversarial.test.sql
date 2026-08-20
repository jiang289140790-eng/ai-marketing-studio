-- G1-B0: 百炼生成执行层数据库对抗测试（在 p19-sql-integration 已回放全部迁移
-- 的隔离数据库上运行；postgres 身份，与已验收 P17/P19 测试同源）。
--
-- 覆盖（验收 #2）：
--   - anon / authenticated / public 对 api.g1_* 零 EXECUTE；service_role 有；
--   - quote 校验（有界字段/引用素材/Brief 修订指纹/项目修订/知识卡/证据绑定）；
--   - 不可变 quote：同规范请求复用同指纹；任何变化使 submit 前失效
--     （G1_QUOTE_STALE）；
--   - 显式批准对象精确绑定（quote 指纹/请求指纹/预估最大费用/到期时间），
--     任何不匹配 → G1_APPROVAL_MISMATCH（409 类，计费前失败）；
--   - 幂等：同 key + 同规范请求 → 重放；同 key + 不同请求 → 计费前冲突；
--   - 双用户/双项目隔离；过期修订（项目修订推进 → submit 与 claim 双双失败）；
--   - worker 全链路：claim → mark_provider_submitted → poll → complete；
--     lease 所有权（错误 worker / 过期 lease → G1_LEASE_LOST）；
--   - 终态不可变（作业/尝试/产物）与追加式事件；
--   - 有界重试（max_attempts=2）与 ambiguous（needs_attention，绝不自动重试）；
--   - lease 过期对账：pre_submit 前崩溃安全重排；pre_submit 后 ambiguous；
--     有 task id 仅轮询恢复（绝不重复提交）；
--   - 产物校验：路径/哈希/MIME/大小/血缘精确绑定。

begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'G1_B0_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','authenticated','authenticated','g1-a@example.invalid','{}','{}',now(),now(),false,false),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','authenticated','authenticated','g1-b@example.invalid','{}','{}',now(),now(),false,false);

-- 已批准引用素材（i2v 契约：assets.workflow->asset_context->>approval = 'approved'）。
insert into public.assets (user_id, name, type, workflow)
values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'G1 参考素材 A', 'image',
   jsonb_build_object('asset_context', jsonb_build_object('approval', 'approved', 'purpose', 'reference'))),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'G1 未批准素材', 'image',
   jsonb_build_object('asset_context', jsonb_build_object('approval', 'draft')));

do $$
<<g1_case>>
declare
  u1 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  u2 constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  p1 constant text := 'prj-111111111111111111111111';
  p2 constant text := 'prj-222222222222222222222222';
  e1 constant text := 'ev-111111111111111111111111';
  e2 constant text := 'ev-222222222222222222222222';
  kc1 constant text := 'kc-111111111111111111111111';
  kc2 constant text := 'kc-222222222222222222222222';
  b1 constant text := 'brief-111111111111111111111111';
  b2 constant text := 'brief-222222222222222222222222';
  fp1 constant text := repeat('a', 64);
  fp2 constant text := repeat('b', 64);
  fn text;
  payload jsonb;
  result jsonb;
  job jsonb;
  attempt_id text;
  job_id text;
  quote_id text;
  quote_fp text;
  request_sha text;
  req jsonb;
  approval jsonb;
  ref_asset_id text;
  v_count integer;
  v_state text;
  v_sr_ok text;
  v_sr_fp text;
  v_sr_cards jsonb;
  v_sr_evidence jsonb;
  v_before_events integer;
begin
  -- ---- 0. ACL：客户端角色零 EXECUTE；service_role 有 EXECUTE ----
  perform pg_temp.assert_true(not has_schema_privilege('anon', 'api', 'USAGE'), 'anon 可进入 api schema');
  perform pg_temp.assert_true(not has_schema_privilege('authenticated', 'api', 'USAGE'), 'authenticated 可进入 api schema');
  perform pg_temp.assert_true(has_schema_privilege('service_role', 'api', 'USAGE'), 'service_role 无法进入 api schema');
  foreach fn in array array[
    'api.g1_get_provider_registry()',
    'api.g1_list_reference_assets(uuid)',
    'api.g1_quote_request(uuid,jsonb)',
    'api.g1_approve_submit(uuid,text,jsonb,jsonb,integer)',
    'api.g1_get_job(uuid,text)',
    'api.g1_list_jobs(uuid,text,integer)',
    'api.g1_get_artifact(uuid,text,text)',
    'api.g1_claim_jobs(text,integer,integer)',
    'api.g1_mark_provider_submitted(text,text,text,text,jsonb)',
    'api.g1_heartbeat(text,text,text,integer)',
    'api.g1_report_poll(text,text,text,text,jsonb)',
    'api.g1_complete_attempt(text,text,text,jsonb)',
    'api.g1_fail_attempt(text,text,text,text,jsonb,boolean)',
    'api.g1_get_ambiguous_recovery_context(text,text,text)',
    'api.g1_recover_ambiguous_attempt(text,text,text,text,text,jsonb)'
  ] loop
    perform pg_temp.assert_true(not has_function_privilege('anon', fn, 'EXECUTE'), 'anon 可执行 ' || fn);
    perform pg_temp.assert_true(not has_function_privilege('authenticated', fn, 'EXECUTE'), 'authenticated 可执行 ' || fn);
    perform pg_temp.assert_true(not has_function_privilege('public', fn, 'EXECUTE'), 'public 可执行 ' || fn);
    perform pg_temp.assert_true(has_function_privilege('service_role', fn, 'EXECUTE'), 'service_role 无法执行 ' || fn);
  end loop;

  -- 内部 helper（g1_p19_evidence_quote_binding_acl_closeout）：存在、SECURITY
  -- DEFINER、search_path 有界；PUBLIC/anon/authenticated 零 EXECUTE；
  -- service_role 有 EXECUTE；属主 postgres 保留 owner 权利（proacl 显式化后
  -- 仍可执行，正式入口的属主上下文内部调用不受影响）。
  perform pg_temp.assert_true(
    to_regprocedure('ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)') is not null,
    'g1_resolve_evidence_binding 必须存在');
  perform pg_temp.assert_true(
    to_regprocedure('ams_private.g1_normalize_request(uuid,jsonb)') is not null,
    'g1_normalize_request 必须存在');
  perform pg_temp.assert_true(
    (select p.prosecdef and p.proconfig @> array['search_path=ams_private, public']
       from pg_proc p
      where p.oid = 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure),
    'g1_resolve_evidence_binding 必须保持 SECURITY DEFINER 且有界 search_path');
  perform pg_temp.assert_true(
    (select p.prosecdef and p.proconfig @> array['search_path=ams_private, public']
       from pg_proc p
      where p.oid = 'ams_private.g1_normalize_request(uuid,jsonb)'::regprocedure),
    'g1_normalize_request 必须保持 SECURITY DEFINER 且有界 search_path');
  perform pg_temp.assert_true(
    not has_function_privilege('public', 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE'),
    'PUBLIC/anon/authenticated 不得执行 g1_resolve_evidence_binding');
  perform pg_temp.assert_true(
    not has_function_privilege('public', 'ams_private.g1_normalize_request(uuid,jsonb)', 'EXECUTE')
      and not has_function_privilege('anon', 'ams_private.g1_normalize_request(uuid,jsonb)', 'EXECUTE')
      and not has_function_privilege('authenticated', 'ams_private.g1_normalize_request(uuid,jsonb)', 'EXECUTE'),
    'PUBLIC/anon/authenticated 不得执行 g1_normalize_request');
  perform pg_temp.assert_true(
    has_function_privilege('service_role', 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
      and has_function_privilege('service_role', 'ams_private.g1_normalize_request(uuid,jsonb)', 'EXECUTE'),
    'service_role 必须保留两个内部 helper 的 EXECUTE');
  perform pg_temp.assert_true(
    has_function_privilege('postgres', 'ams_private.g1_resolve_evidence_binding(uuid,text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
      and has_function_privilege('postgres', 'ams_private.g1_normalize_request(uuid,jsonb)', 'EXECUTE'),
    '属主 postgres 必须保留两个内部 helper 的 owner EXECUTE');

  -- ---- 1. 固定 provider 注册表（服务端所有；三模式精确存在）----
  result := api.g1_get_provider_registry();
  perform pg_temp.assert_true(jsonb_array_length(result) = 3, '注册表必须恰好 3 条（image/t2v/i2v）');
  perform pg_temp.assert_true(
    result @> '[{"provider_id":"bailian","mode":"image","model_name":"qwen-image-2.0"}]'
    and result @> '[{"provider_id":"bailian","mode":"video_t2v","model_name":"happyhorse-1.0-t2v"}]'
    and result @> '[{"provider_id":"bailian","mode":"video_i2v","model_name":"happyhorse-1.0-i2v"}]',
    '注册表必须包含 Baseline 指定的三个 model/mode');

  -- 引用素材列表：只返回已批准图片素材。
  result := api.g1_list_reference_assets(u1);
  perform pg_temp.assert_true(jsonb_array_length(result) = 1, '只应返回 1 个已批准引用素材');
  select id::text into ref_asset_id from public.assets where user_id = u1 and name = 'G1 参考素材 A';

  -- ---- 2. P19 种子：项目 + 证据 + 知识卡 + 待审核 Brief ----
  payload := jsonb_build_object(
    'id',p1,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','G1 生成项目','objective','验证生成执行层','audience','测试','channel','X',
    'constraints',jsonb_build_array());
  perform api.p19_apply_entity_write(u1,'g1-proj-create','project.create','project',p1,
    '{}'::jsonb,'p19_research_projects_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',p2,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','G1 隔离项目','objective','隔离','audience','测试','channel','X',
    'constraints',jsonb_build_array());
  perform api.p19_apply_entity_write(u2,'g1-proj-create-2','project.create','project',p2,
    '{}'::jsonb,'p19_research_projects_v1',payload,null,null);

  payload := jsonb_build_object(
    'id',e1,'project_id',p1,'schema_version','p19_evidence_record_v1',
    'source_url','https://example.com/g1/1','label','G1 证据','platform','manual',
    'content_text','G1 证据正文','recorded_at','2026-08-16T00:00:00Z',
    'provenance',jsonb_build_object('manual',true),'media_metadata','null'::jsonb,
    'version',1,'fingerprint',fp1,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1-ev-create','evidence.create','evidence',e1,
    '{}'::jsonb,'p19_evidence_records_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',e2,'project_id',p2,'schema_version','p19_evidence_record_v1',
    'source_url','https://example.com/g1/2','label','G1 隔离证据','platform','manual',
    'content_text','隔离','recorded_at','2026-08-16T00:00:00Z',
    'provenance',jsonb_build_object('manual',true),'media_metadata','null'::jsonb,
    'version',1,'fingerprint',fp2,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u2,'g1-ev-create-2','evidence.create','evidence',e2,
    '{}'::jsonb,'p19_evidence_records_v1',payload,null,null);

  payload := jsonb_build_object(
    'id',kc1,'project_id',p1,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','G1 卡正文'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','G1','evidence_type','post_text','source_ref',e1)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',fp1,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1-kc-create','card.create','card',kc1,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',kc2,'project_id',p2,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','隔离卡'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','隔离','evidence_type','post_text','source_ref',e2)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',fp2,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u2,'g1-kc-create-2','card.create','card',kc2,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);

  payload := jsonb_build_object(
    'id',b1,'project_id',p1,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 Brief','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc1),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object('local_only',true,'evidence_ids',jsonb_build_array(e1)),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b1,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',fp1,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1-brief-create','brief.assemble','brief',b1,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',b2,'project_id',p2,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 隔离 Brief','objective','隔离','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc2),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object('local_only',true,'evidence_ids',jsonb_build_array(e2)),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b2,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',fp2,'created_at','2026-08-16T00:00:00Z','updated_at','2026-08-16T00:00:00Z');
  perform api.p19_apply_entity_write(u2,'g1-brief-create-2','brief.assemble','brief',b2,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);

  -- ---- 3. quote：不可变、有界、绑定 Brief/知识卡/证据 ----
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','image','prompt','一只在森林里的猫','aspect_ratio','1:1');
  result := api.g1_quote_request(u1, req);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'quote 必须成功');
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  perform pg_temp.assert_true(quote_id ~ '^g1q-[0-9a-f]{24}$', 'quote_id 格式');
  perform pg_temp.assert_true(quote_fp ~ '^[0-9a-f]{64}$', 'quote 指纹必须为 64 位十六进制');
  perform pg_temp.assert_true(request_sha ~ '^[0-9a-f]{64}$', '请求 SHA-256 必须为 64 位十六进制');
  perform pg_temp.assert_true(result -> 'quote' ->> 'model_name' = 'qwen-image-2.0', 'image 模式必须绑定 qwen-image-2.0');
  perform pg_temp.assert_true((result -> 'quote' ->> 'price_cny_min')::numeric >= 0, '费用下限必须有界');
  perform pg_temp.assert_true((result -> 'quote' ->> 'price_cny_max')::numeric >= (result -> 'quote' ->> 'price_cny_min')::numeric, '费用上限 >= 下限');
  perform pg_temp.assert_true((result -> 'quote' ->> 'brief_version')::int = 1, 'quote 必须绑定 Brief 第 1 版');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'quote' -> 'knowledge_card_ids') = 1, 'quote 必须绑定 Brief 的知识卡集合');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'quote' -> 'evidence_ids') = 1, 'quote 必须绑定 Brief 的证据集合');
  perform pg_temp.assert_true(result -> 'quote' ->> 'will_pay' = 'true', 'quote 必须声明将发生付费执行');
  perform pg_temp.assert_true(result -> 'quote' ->> 'will_use_storage' = 'true', 'quote 必须声明私有存储写入');

  -- 同规范请求 → 复用同一不可变 quote 指纹。
  result := api.g1_quote_request(u1, req);
  perform pg_temp.assert_true(result -> 'quote' ->> 'quote_fingerprint' = quote_fp, '同请求必须复用同一 quote 指纹');

  -- 正式 G1 报价入口在 service_role 边界下仍完成项目读取/绑定/报价：内部
  -- ams_private helper 经 SECURITY DEFINER 以属主身份调用，EXECUTE 收窄不影响
  -- 正式路径（acl_closeout 迁移后行为不变）。set local role 在 DO 块内于本事务
  -- 生效；service_role 窗口内不调用 pg_temp 断言（避免临时 schema ACL 依赖），
  -- 结果先存入变量，reset role 恢复 postgres 后再统一断言。
  set local role service_role;
  result := api.g1_quote_request(u1, req);
  v_sr_ok := result ->> 'ok';
  v_sr_fp := result -> 'quote' ->> 'quote_fingerprint';
  v_sr_cards := result -> 'quote' -> 'knowledge_card_ids';
  v_sr_evidence := result -> 'quote' -> 'evidence_ids';
  reset role;
  perform pg_temp.assert_true(v_sr_ok = 'true', 'service_role 边界下 quote 必须成功');
  perform pg_temp.assert_true(v_sr_fp = quote_fp, 'service_role 边界下必须复用同一不可变 quote 指纹');
  perform pg_temp.assert_true(
    v_sr_cards = jsonb_build_array(kc1)
      and v_sr_evidence = jsonb_build_array(e1),
    'service_role 边界下 quote 必须完成知识卡/证据绑定');

  -- 有界校验：超长 prompt / 非法 mode / 非法画幅 / 不适用字段全部 fail closed。
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt',repeat('x', 2001)));
    raise exception 'G1_B0_ASSERT: 超长 prompt 被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_PROMPT_BOUNDS%', '超长 prompt 必须 G1_PROMPT_BOUNDS，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','猫','aspect_ratio','99:1'));
    raise exception 'G1_B0_ASSERT: 非法画幅被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ASPECT_RATIO_INVALID%', '非法画幅必须被拒绝，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','猫','duration_seconds',5));
    raise exception 'G1_B0_ASSERT: image 模式接受时长';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_FIELD_NOT_APPLICABLE%', 'image 模式必须拒绝时长，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','video_t2v','prompt','猫','reference_asset_id',ref_asset_id));
    raise exception 'G1_B0_ASSERT: t2v 接受引用素材';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_FIELD_NOT_APPLICABLE%', 't2v 必须拒绝引用素材，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','video_i2v','prompt','猫','reference_asset_id','00000000-0000-4000-8000-000000000000'));
    raise exception 'G1_B0_ASSERT: 未批准引用素材被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_REFERENCE_ASSET_REJECTED%', '未批准引用素材必须被拒绝，实际 ' || sqlerrm);
  end;
  -- 知识卡绑定：重复（去重前拒绝）/未引用/跨项目全部 fail closed。
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','猫',
      'knowledge_card_ids',jsonb_build_array(kc1, kc1)));
    raise exception 'G1_B0_ASSERT: 重复知识卡绑定被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_BINDING_INVALID%', '重复绑定必须在去重前拒绝，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_quote_request(u1, jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','猫',
      'knowledge_card_ids',jsonb_build_array(kc2)));
    raise exception 'G1_B0_ASSERT: 跨项目知识卡被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_BINDING_MISMATCH%', '跨项目绑定必须失败，实际 ' || sqlerrm);
  end;

  -- ---- 4. 显式批准 + 幂等提交 ----
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.2,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-submit-key-1', req, approval, 1);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'submit 必须成功');
  perform pg_temp.assert_true(result ->> 'outcome' = 'applied', '首次提交必须 applied');
  job_id := result -> 'job' ->> 'id';
  perform pg_temp.assert_true(job_id ~ '^g1j-[0-9a-f]{24}$', 'job_id 格式');
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'queued', '新作业必须 queued');
  perform pg_temp.assert_true(result -> 'job' -> 'approval' ->> 'source' = 'browser', '批准对象必须持久化 source');
  perform pg_temp.assert_true((result -> 'job' -> 'approval' ->> 'estimated_max_cost_cny')::numeric = 0.2, '批准对象必须持久化预估最大费用');
  perform pg_temp.assert_true(result -> 'job' ->> 'quote_fingerprint' = quote_fp, '作业必须绑定精确 quote 指纹');

  -- 精确重放：同 key + 同规范请求 → 返回既有作业，绝不重复创建。
  result := api.g1_approve_submit(u1, 'g1-submit-key-1', req, approval, 1);
  perform pg_temp.assert_true(result ->> 'outcome' = 'replayed', '精确重试必须 replayed');
  perform pg_temp.assert_true(result -> 'job' ->> 'id' = job_id, '重放必须返回同一作业');
  select count(*) into v_count from ams_private.g1_generation_jobs_v1 where id = job_id;
  perform pg_temp.assert_true(v_count = 1, '重放后必须仍只有 1 行作业');

  -- 同 key + 不同请求 → 计费前有界冲突。
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-1', jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','一只不同的猫'), approval, 1);
    raise exception 'G1_B0_ASSERT: 同 key 不同请求被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_IDEMPOTENCY_CONFLICT%', '同 key 不同请求必须 G1_IDEMPOTENCY_CONFLICT，实际 ' || sqlerrm);
  end;

  -- quote 到期（对抗优先级）：过期 quote 对全新 key 必须 G1_QUOTE_EXPIRED（计费前
  -- fail closed）；对既有 key，精确重放与冲突判定必须优先于到期/过期检查。
  update ams_private.g1_generation_quotes_v1
  set expires_at = now() - interval '1 second'
  where id = quote_id;
  begin
    perform api.g1_approve_submit(u1, 'g1-expired-new-key', req, approval, 1);
    raise exception 'G1_B0_ASSERT: 过期 quote 被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_QUOTE_EXPIRED%', '过期 quote 必须 G1_QUOTE_EXPIRED，实际 ' || sqlerrm);
  end;
  -- 同 key + 同请求 + 过期 quote → 仍精确重放（优先级：重放 > 到期），零新作业/尝试。
  result := api.g1_approve_submit(u1, 'g1-submit-key-1', req, approval, 1);
  perform pg_temp.assert_true(result ->> 'outcome' = 'replayed', '过期 quote 下同 key 同请求必须仍精确重放');
  perform pg_temp.assert_true(result -> 'job' ->> 'id' = job_id, '重放必须返回同一作业');
  select count(*) into v_count from ams_private.g1_generation_jobs_v1 where id = job_id;
  perform pg_temp.assert_true(v_count = 1, '重放后必须仍只有 1 行作业');
  -- 同 key + 不同请求 + 过期 quote → G1_IDEMPOTENCY_CONFLICT（冲突优先于到期与 stale）。
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-1', jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','一只在森林里的黑猫'), approval, 1);
    raise exception 'G1_B0_ASSERT: 同 key 不同请求（过期 quote）被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_IDEMPOTENCY_CONFLICT%', '同 key 不同请求必须优先 G1_IDEMPOTENCY_CONFLICT，实际 ' || sqlerrm);
  end;
  update ams_private.g1_generation_quotes_v1
  set expires_at = now() + interval '30 minutes'
  where id = quote_id;

  -- 批准对象精确绑定：quote 指纹 / 请求指纹 / 费用上限 / 到期时间任一变化 → 409 类失败。
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-2', req,
      jsonb_build_object('quote_id', quote_id, 'quote_fingerprint', repeat('0', 64),
        'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.2,
        'expires_at', now() + interval '10 minutes', 'source', 'browser'), 1);
    raise exception 'G1_B0_ASSERT: 错误 quote 指纹被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_APPROVAL_MISMATCH%', '错误 quote 指纹必须被拒绝，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-2', req,
      jsonb_build_object('quote_id', quote_id, 'quote_fingerprint', quote_fp,
        'request_fingerprint', request_sha, 'estimated_max_cost_cny', 99999,
        'expires_at', now() + interval '10 minutes', 'source', 'browser'), 1);
    raise exception 'G1_B0_ASSERT: 超上限费用被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_APPROVAL_MISMATCH%', '超上限预估费用必须被拒绝，实际 ' || sqlerrm);
  end;
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-2', req,
      jsonb_build_object('quote_id', quote_id, 'quote_fingerprint', quote_fp,
        'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.2,
        'expires_at', now() - interval '1 minute', 'source', 'browser'), 1);
    raise exception 'G1_B0_ASSERT: 过期批准被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_APPROVAL_MISMATCH%', '过期批准必须被拒绝，实际 ' || sqlerrm);
  end;

  -- 任何 prompt/引用变化使 quote 在 provider 调用之前失效（G1_QUOTE_STALE）。
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-2', jsonb_build_object(
      'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
      'mode','image','prompt','一只在森林里的猫（改了）'), approval, 1);
    raise exception 'G1_B0_ASSERT: 变化请求使用旧 quote 被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_QUOTE_STALE%', '变化请求必须 G1_QUOTE_STALE，实际 ' || sqlerrm);
  end;

  -- 调用方把 expected_revision 绑定错（当前项目修订未变，规范请求 SHA 未变）→
  -- G1_PROJECT_REVISION_STALE（计费前 fail closed）。
  begin
    perform api.g1_approve_submit(u1, 'g1-revbind-key', req, approval, 2);
    raise exception 'G1_B0_ASSERT: 错误 expected_revision 被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_PROJECT_REVISION_STALE%', '错误 expected_revision 必须 G1_PROJECT_REVISION_STALE，实际 ' || sqlerrm);
  end;

  -- 项目修订推进后，旧 quote 在 provider 调用前失效：规范请求 SHA 含项目修订，
  -- 修订变化与 prompt 变化同路径 → G1_QUOTE_STALE（不削弱修订安全，只是确定性的
  -- 精确失效码）。
  payload := jsonb_build_object(
    'id',p1,'version',2,'schema_version','p19_research_project_v1','status','active',
    'topic','G1 生成项目 v2','objective','验证生成执行层','audience','测试','channel','X',
    'constraints',jsonb_build_array());
  perform api.p19_apply_entity_write(u1,'g1-proj-update','project.update','project',p1,
    '{}'::jsonb,'p19_research_projects_v1',payload,null,1);
  begin
    perform api.g1_approve_submit(u1, 'g1-submit-key-2', req, approval, 1);
    raise exception 'G1_B0_ASSERT: 过期修订被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_QUOTE_STALE%', '修订推进后旧 quote 必须 G1_QUOTE_STALE，实际 ' || sqlerrm);
  end;
  -- 旧修订的已排队作业（g1-submit-key-1）在认领对账时安全失败（零 provider
  -- 调用），避免后续认领顺序受其影响。
  result := api.g1_claim_jobs('worker-a', 10, 300);
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 0, '过期修订作业不得被认领');
  result := api.g1_get_job(u1, (select id from ams_private.g1_generation_jobs_v1 where idempotency_key = 'g1-submit-key-1'));
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'failed', '过期修订作业必须 failed');
  perform pg_temp.assert_true(result -> 'job' -> 'diagnostics' ->> 'code' = 'G1_BRIEF_REVISION_STALE', '过期修订作业诊断必须为 G1_BRIEF_REVISION_STALE');

  -- 新请求（新 revision）重新报价并提交。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','video_t2v','prompt','海边日落视频','aspect_ratio','16:9','duration_seconds',5,'resolution','720p');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 8,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-submit-key-3', req, approval, 2);
  perform pg_temp.assert_true(result ->> 'outcome' = 'applied', '新 revision 提交必须 applied');
  job_id := result -> 'job' ->> 'id';

  -- ---- 5. Worker 全链路：claim → submitted → poll → complete ----
  result := api.g1_claim_jobs('worker-a', 1, 300);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'claim 必须成功');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 1, '必须恰好认领 1 个作业');
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  perform pg_temp.assert_true(result -> 'claimed' -> 0 ->> 'mode' = 'video_t2v', 'claim 必须返回精确 mode');
  perform pg_temp.assert_true(result -> 'claimed' -> 0 ->> 'resume' = 'false', '新提交 claim 不得标记 resume');

  -- 第二次 claim：无剩余作业（lease 未过期）。
  result := api.g1_claim_jobs('worker-b', 1, 300);
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 0, '已认领作业不得被再次认领');

  -- 错误 worker 提交 → G1_LEASE_LOST（lease 所有权）。
  begin
    perform api.g1_mark_provider_submitted(job_id, attempt_id, 'worker-b', 'task-1', '{}'::jsonb);
    raise exception 'G1_B0_ASSERT: 非租约持有者提交被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_LEASE_LOST%', '非租约持有者必须 G1_LEASE_LOST，实际 ' || sqlerrm);
  end;
  result := api.g1_mark_provider_submitted(job_id, attempt_id, 'worker-a', 'task-1',
    jsonb_build_object('phase','submitted','mode','video_t2v'));
  perform pg_temp.assert_true(result ->> 'state' = 'submitted', '提交记录必须进入 submitted');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'running', '作业必须进入 running');
  result := api.g1_report_poll(job_id, attempt_id, 'worker-a', 'RUNNING', '{}'::jsonb);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '轮询进度必须可记录');
  result := api.g1_heartbeat(job_id, attempt_id, 'worker-a', 300);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '心跳必须成功');

  -- 完成：产物路径必须精确匹配 {user}/{project}/{job}/v1/{sha12}.{ext}。
  result := api.g1_complete_attempt(job_id, attempt_id, 'worker-a', jsonb_build_object(
    'schema_version','g1_artifact_v1',
    'content_sha256', repeat('c', 64),
    'mime_type','video/mp4',
    'byte_size',2048,
    'width',1280,'height',720,'duration_seconds',5,
    'storage_path', u1::text || '/' || p1 || '/' || job_id || '/v1/cccccccccccc.mp4',
    'source_url','https://provider.example/result.mp4',
    'usage',jsonb_build_object('seconds',5),
    'cost_cny',0.9));
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'complete 必须成功');
  perform pg_temp.assert_true(result -> 'artifact' ->> 'artifact_version' = '1', '产物必须是第 1 版');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'completed', '作业必须 completed');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'artifacts') = 1, '必须恰好 1 个产物');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'brief_id' = b1, '产物必须绑定精确 Brief');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'brief_version' = '1', '产物必须绑定 Brief 第 1 版');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'brief_fingerprint' = fp1, '产物必须绑定 Brief 指纹');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'artifacts' -> 0 -> 'knowledge_card_ids') = 1, '产物必须绑定知识卡');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'artifacts' -> 0 -> 'evidence_ids') = 1, '产物必须绑定证据');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'provider_task_id' = 'task-1', '产物必须绑定 provider task 身份');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'prompt_sha256' ~ '^[0-9a-f]{64}$', '产物必须记录 prompt 指纹');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 ->> 'model_name' = 'happyhorse-1.0-t2v', '产物必须绑定模型');
  -- 事件追加：job.created/provider.submitted/poll/job.completed 都在。
  perform pg_temp.assert_true(jsonb_array_length(result -> 'events') >= 5, '追加式事件必须完整');

  -- 完成后的终态不可变。
  begin
    update ams_private.g1_generation_jobs_v1 set status = 'queued' where id = job_id;
    raise exception 'G1_B0_ASSERT: 终态作业被修改';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_JOB_TERMINAL_IMMUTABLE%', '终态作业必须不可变，实际 ' || sqlerrm);
  end;
  -- 事件追加式对抗：UPDATE/DELETE 一律 fail closed。WHERE 必须用表限定列
  -- g1_generation_events_v1.job_id 与已保存的作业 ID 比较，精确命中该作业的
  -- 事件行（消除 PL/pgSQL 变量 job_id 与列名的歧义，绝不全表/全行命中）。
  select count(*) into v_count
  from ams_private.g1_generation_events_v1
  where g1_generation_events_v1.job_id = g1_case.job_id;
  perform pg_temp.assert_true(v_count > 0, '作业必须已有追加事件供对抗');
  begin
    delete from ams_private.g1_generation_events_v1
    where g1_generation_events_v1.job_id = g1_case.job_id;
    raise exception 'G1_B0_ASSERT: 事件被删除';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_EVENTS_APPEND_ONLY%', '事件必须追加式，实际 ' || sqlerrm);
  end;
  begin
    update ams_private.g1_generation_events_v1
    set payload = '{}'::jsonb
    where g1_generation_events_v1.job_id = g1_case.job_id;
    raise exception 'G1_B0_ASSERT: 事件被修改';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_EVENTS_APPEND_ONLY%', '事件必须追加式，实际 ' || sqlerrm);
  end;

  -- 产物校验：哈希/MIME/路径不符全部 fail closed。
  begin
    perform api.g1_complete_attempt(job_id, (select id from ams_private.g1_generation_attempts_v1 where g1_generation_attempts_v1.job_id = g1_case.job_id order by attempt_no desc limit 1), 'worker-a', jsonb_build_object(
      'schema_version','g1_artifact_v1','content_sha256', repeat('d', 64), 'mime_type','video/mp4',
      'byte_size',1024,'storage_path', u1::text || '/' || p1 || '/' || job_id || '/v2/dddddddddddd.mp4'));
    raise exception 'G1_B0_ASSERT: 终态尝试再次完成被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ATTEMPT_STATE_INVALID%', '终态尝试必须以准确状态错误失败，实际 ' || sqlerrm);
  end;

  -- ---- 6. 双用户/双项目隔离 ----
  result := api.g1_list_jobs(u2, p2, 20);
  perform pg_temp.assert_true(jsonb_array_length(result) = 0, 'u2 的 p2 不得看到 u1 的作业');
  result := api.g1_list_jobs(u1, p2, 20);
  perform pg_temp.assert_true(jsonb_array_length(result) = 0, 'u1 的 p2 不得看到 p1 的作业');
  result := api.g1_list_jobs(u1, p1, 20);
  select count(*) into v_count
  from ams_private.g1_generation_jobs_v1 j
  where j.user_id = u1 and j.project_id = p1;
  perform pg_temp.assert_true(v_count > 0, 'u1 的 p1 必须至少存在一条自己的作业');
  perform pg_temp.assert_true(jsonb_array_length(result) = v_count, 'u1 的 p1 列表必须与准确持久化作业数一致');
  perform pg_temp.assert_true(not exists (
    select 1 from jsonb_array_elements(result) item
    where item ->> 'project_id' <> p1
  ), 'u1 的 p1 列表不得混入其他项目作业');
  begin
    perform api.g1_get_job(u2, job_id);
    raise exception 'G1_B0_ASSERT: u2 读取 u1 作业被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_JOB_NOT_FOUND%', '跨用户作业读取必须失败，实际 ' || sqlerrm);
  end;

  -- ---- 7. 有界重试与 ambiguous ----
  -- 新作业（image）：claim → provider 明确拒绝（可安全重试）→ 重试调度。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','image','prompt','重试测试图片','aspect_ratio','1:1');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.3,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-retry-key-1', req, approval, 2);
  job_id := result -> 'job' ->> 'id';
  result := api.g1_claim_jobs('worker-a', 1, 300);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  result := api.g1_fail_attempt(job_id, attempt_id, 'worker-a', 'G1_PROVIDER_REJECTED',
    jsonb_build_object('issues', jsonb_build_array('provider 明确拒绝（无已接受的付费作业）')), true);
  perform pg_temp.assert_true(result ->> 'outcome' = 'retry_scheduled', '可安全重试必须调度第 2 次尝试');
  perform pg_temp.assert_true(result ->> 'attempt_no' = '2', '重试必须是 attempt_no 2');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'queued', '重试调度后作业必须回到 queued');
  perform pg_temp.assert_true(result -> 'job' ->> 'attempt_count' = '2', 'attempt_count 必须为 2');
  -- 第 2 次尝试也被拒绝 → max_attempts 耗尽 → failed（终态）。
  result := api.g1_claim_jobs('worker-a', 1, 300);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  perform pg_temp.assert_true(result -> 'claimed' -> 0 ->> 'attempt_no' = '2', '第 2 次尝试必须被认领');
  result := api.g1_fail_attempt(job_id, attempt_id, 'worker-a', 'G1_PROVIDER_REJECTED', '{}'::jsonb, true);
  perform pg_temp.assert_true(result ->> 'outcome' = 'failed', '重试耗尽必须 failed');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'failed', '作业必须 failed');

  -- ambiguous（无法证明）：needs_attention，绝不自动重试。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','image','prompt','歧义测试图片','aspect_ratio','1:1');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.3,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-ambiguous-key-1', req, approval, 2);
  job_id := result -> 'job' ->> 'id';
  result := api.g1_claim_jobs('worker-a', 1, 300);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  result := api.g1_fail_attempt(job_id, attempt_id, 'worker-a', 'G1_PROVIDER_SUBMISSION_AMBIGUOUS', '{}'::jsonb, false);
  perform pg_temp.assert_true(result ->> 'outcome' = 'needs_attention', '歧义提交必须 needs_attention');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'needs_attention', '作业必须 needs_attention');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'attempts') = 1, '歧义后绝不自动调度新尝试');

  -- ---- 8. lease 过期对账（崩溃/重启安全）----
  -- 8a. claimed 且 lease 过期且未进入提交窗口（phase 非 pre_submit）→ 安全重排。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','image','prompt','崩溃安全测试','aspect_ratio','1:1');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.3,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-crash-key-1', req, approval, 2);
  job_id := result -> 'job' ->> 'id';
  result := api.g1_claim_jobs('worker-crash', 1, 60);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  update ams_private.g1_generation_attempts_v1
  set lease_expires_at = now() - interval '1 second', claimed_by = null
  where id = attempt_id;
  -- 无 pre_submit phase：claim 对账应安全重排回 queued。
  result := api.g1_claim_jobs('worker-b', 1, 300);
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 1, '安全重排后必须可再次认领');
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  -- 8b. claimed 且 lease 过期且 phase=pre_submit（提交窗口已开始）→ ambiguous。
  result := api.g1_report_poll(job_id, attempt_id, 'worker-b', 'pre_submit',
    jsonb_build_object('phase','pre_submit'));
  update ams_private.g1_generation_attempts_v1
  set lease_expires_at = now() - interval '1 second', claimed_by = null
  where id = attempt_id;
  result := api.g1_claim_jobs('worker-c', 1, 300);
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 0, 'pre_submit 歧义不得被认领');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'needs_attention', 'pre_submit 歧义必须 needs_attention');
  perform pg_temp.assert_true(result -> 'attempts' -> 0 ->> 'state' = 'ambiguous', '歧义尝试必须 ambiguous');

  -- 8c. submitted 且 lease 过期且有 task id → 仅轮询恢复（绝不重新提交）。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','image','prompt','轮询恢复测试','aspect_ratio','1:1');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 0.3,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-resume-key-1', req, approval, 2);
  job_id := result -> 'job' ->> 'id';
  result := api.g1_claim_jobs('worker-a', 1, 60);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  result := api.g1_mark_provider_submitted(job_id, attempt_id, 'worker-a', 'task-resume-1', '{}'::jsonb);
  update ams_private.g1_generation_attempts_v1
  set lease_expires_at = now() - interval '1 second', claimed_by = null
  where id = attempt_id;
  result := api.g1_claim_jobs('worker-b', 1, 300);
  perform pg_temp.assert_true(jsonb_array_length(result -> 'claimed') = 1, '同一 task id 必须可恢复轮询');
  perform pg_temp.assert_true(result -> 'claimed' -> 0 ->> 'resume' = 'true', '恢复认领必须标记 resume');
  perform pg_temp.assert_true(result -> 'claimed' -> 0 ->> 'provider_task_id' = 'task-resume-1', '恢复必须携带同一 provider task id');
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  -- 恢复 worker 轮询到成功 → complete（证明同一任务可完成且无重复提交）。
  result := api.g1_report_poll(job_id, attempt_id, 'worker-b', 'SUCCEEDED', '{}'::jsonb);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '恢复轮询进度必须可记录');
  result := api.g1_complete_attempt(job_id, attempt_id, 'worker-b', jsonb_build_object(
    'schema_version','g1_artifact_v1',
    'content_sha256', repeat('e', 64),
    'mime_type','image/png',
    'byte_size',1024,
    'width',1024,'height',1024,
    'storage_path', u1::text || '/' || p1 || '/' || job_id || '/v1/eeeeeeeeeeee.png'));
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '恢复后完成必须成功');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'completed', '恢复轮询作业必须 completed');

  -- ---- 9. artifact 读取（用户隔离 + 血缘）----
  result := api.g1_get_artifact(u1, job_id, result -> 'artifacts' -> 0 ->> 'id');
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '产物读取必须成功');
  perform pg_temp.assert_true(result -> 'artifact' ->> 'storage_path' like '%/v1/eeeeeeeeeeee.png', '产物路径必须精确');
  begin
    perform api.g1_get_artifact(u2, job_id, result -> 'artifact' ->> 'id');
    raise exception 'G1_B0_ASSERT: 跨用户产物读取被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ARTIFACT_NOT_FOUND%', '跨用户产物读取必须以准确有界错误失败，实际 ' || sqlerrm);
  end;

  -- ---- 10. i2v 全链路（引用素材必需且已批准）----
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','video_i2v','prompt','参考图生成视频','aspect_ratio','16:9','duration_seconds',5,
    'resolution','720p','reference_asset_id',ref_asset_id);
  result := api.g1_quote_request(u1, req);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'i2v quote 必须成功');
  perform pg_temp.assert_true(result -> 'quote' ->> 'model_name' = 'happyhorse-1.0-i2v', 'i2v 必须绑定 happyhorse-1.0-i2v');
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 12,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(u1, 'g1-i2v-key-1', req, approval, 2);
  perform pg_temp.assert_true(result ->> 'outcome' = 'applied', 'i2v 提交必须成功');
  job_id := result -> 'job' ->> 'id';
  perform pg_temp.assert_true(result -> 'job' ->> 'reference_asset_id' = ref_asset_id, '作业必须绑定引用素材');
  -- i2v 产物 MIME 必须为视频（G1_MIME_MISMATCH fail closed）。
  result := api.g1_claim_jobs('worker-a', 1, 300);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  result := api.g1_mark_provider_submitted(job_id, attempt_id, 'worker-a', 'task-i2v-1',
    jsonb_build_object('phase','submitted','reference_sha256', repeat('f', 64)));
  perform pg_temp.assert_true(result ->> 'state' = 'submitted', 'i2v 提交记录必须成功');
  begin
    perform api.g1_complete_attempt(job_id, attempt_id, 'worker-a', jsonb_build_object(
      'schema_version','g1_artifact_v1',
      'content_sha256', repeat('a', 64),
      'mime_type','image/png',
      'byte_size',1024,
      'storage_path', u1::text || '/' || p1 || '/' || job_id || '/v1/aaaaaaaaaaaa.png'));
    raise exception 'G1_B0_ASSERT: i2v 作业接受图片 MIME';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_MIME_MISMATCH%', '视频任务必须拒绝图片 MIME，实际 ' || sqlerrm);
  end;

  -- 非法路径必须在尝试仍可完成时真实命中路径校验，而不是被终态守卫提前截断。
  begin
    perform api.g1_complete_attempt(job_id, attempt_id, 'worker-a', jsonb_build_object(
      'schema_version','g1_artifact_v1',
      'content_sha256', repeat('a', 64),
      'mime_type','video/mp4',
      'byte_size',4096,
      'storage_path', u2::text || '/' || p1 || '/' || job_id || '/v1/aaaaaaaaaaaa.mp4'));
    raise exception 'G1_B0_ASSERT: 跨用户路径被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ARTIFACT_PATH_INVALID%', '非法路径必须以准确路径错误失败，实际 ' || sqlerrm);
  end;

  result := api.g1_complete_attempt(job_id, attempt_id, 'worker-a', jsonb_build_object(
    'schema_version','g1_artifact_v1',
    'content_sha256', repeat('a', 64),
    'mime_type','video/mp4',
    'byte_size',4096,
    'width',1280,'height',720,'duration_seconds',5,
    'storage_path', u1::text || '/' || p1 || '/' || job_id || '/v1/aaaaaaaaaaaa.mp4'));
  perform pg_temp.assert_true(result ->> 'ok' = 'true', 'i2v 完成必须成功');

  -- ---- 11. 已有 ambiguous 视频 task 的一次性 Artifact 回收 ----
  -- 本路径只处理已有 provider task id：不创建第二个 attempt，不重新 submit。
  req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p1,'brief_id',b1,
    'mode','video_t2v','prompt','已有任务回收测试','aspect_ratio','16:9',
    'duration_seconds',5,'resolution','720p');
  result := api.g1_quote_request(u1, req);
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  approval := jsonb_build_object(
    'quote_id', quote_id, 'quote_fingerprint', quote_fp,
    'request_fingerprint', request_sha, 'estimated_max_cost_cny', 8,
    'expires_at', now() + interval '10 minutes', 'source', 'browser');
  result := api.g1_approve_submit(
    u1, 'g1-existing-task-recovery-1', req, approval,
    (result -> 'quote' ->> 'project_revision')::integer);
  job_id := result -> 'job' ->> 'id';
  result := api.g1_claim_jobs('worker-recovery-seed', 1, 300);
  attempt_id := result -> 'claimed' -> 0 ->> 'attempt_id';
  perform api.g1_mark_provider_submitted(
    job_id, attempt_id, 'worker-recovery-seed', 'existing-provider-task-1',
    jsonb_build_object('phase','submitted','request_id','existing-request-1'));
  result := api.g1_fail_attempt(
    job_id, attempt_id, 'worker-recovery-seed', 'G1_PROVIDER_SUBMISSION_AMBIGUOUS',
    jsonb_build_object('issues',jsonb_build_array('旧 worker 未识别 Provider video_url')), false);
  perform pg_temp.assert_true(result ->> 'outcome' = 'needs_attention', '回收夹具必须先进入 needs_attention');

  select count(*) into v_before_events
  from ams_private.g1_generation_events_v1 e where e.job_id = g1_case.job_id;
  select knowledge_card_ids, evidence_ids into v_sr_cards, v_sr_evidence
  from ams_private.g1_generation_jobs_v1 j where j.id = g1_case.job_id;

  begin
    update ams_private.g1_generation_attempts_v1
    set state = 'succeeded'
    where g1_generation_attempts_v1.id = g1_case.attempt_id;
    raise exception 'G1_B0_ASSERT: 无 Artifact 的 ambiguous 尝试被直接改为成功';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ATTEMPT_TERMINAL_IMMUTABLE%', '任意终态修改必须失败，实际 ' || sqlerrm);
  end;

  begin
    perform api.g1_get_ambiguous_recovery_context(job_id, attempt_id, 'other-provider-task');
    raise exception 'G1_B0_ASSERT: 错误 Provider task 获得回收上下文';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_RECOVERY_PROVIDER_TASK_MISMATCH%', 'task 错绑必须失败，实际 ' || sqlerrm);
  end;

  result := api.g1_get_ambiguous_recovery_context(job_id, attempt_id, 'existing-provider-task-1');
  perform pg_temp.assert_true(result ->> 'job_id' = job_id, '回收上下文必须绑定准确 job');
  perform pg_temp.assert_true(result ->> 'attempt_id' = attempt_id, '回收上下文必须绑定准确 attempt');
  perform pg_temp.assert_true(result ->> 'provider_task_id' = 'existing-provider-task-1', '回收上下文必须绑定准确 Provider task');
  perform pg_temp.assert_true(result ->> 'mode' = 'video_t2v', '回收上下文只能是准确视频模式');
  perform pg_temp.assert_true(result -> 'knowledge_card_ids' = v_sr_cards, '回收上下文必须继承完整 Knowledge 集合');
  perform pg_temp.assert_true(result -> 'evidence_ids' = v_sr_evidence, '回收上下文必须继承完整 Evidence 集合');

  begin
    perform api.g1_recover_ambiguous_attempt(
      job_id, attempt_id, 'existing-provider-task-1', 'worker-recovery', 'SUCCEEDED',
      jsonb_build_object(
        'schema_version','g1_artifact_v1','content_sha256',repeat('f',64),
        'mime_type','video/mp4','byte_size',8192,'width',1280,'height',720,
        'duration_seconds',5,'storage_path',u1::text || '/' || p2 || '/' || job_id || '/v1/ffffffffffff.mp4',
        'usage','{}'::jsonb,'cost_cny',null));
    raise exception 'G1_B0_ASSERT: 跨项目 Artifact 路径被接受';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_ARTIFACT_PATH_INVALID%', '跨项目路径必须准确失败，实际 ' || sqlerrm);
  end;
  select count(*) into v_count
  from ams_private.g1_generation_artifacts_v1 ar
  where ar.job_id = g1_case.job_id;
  perform pg_temp.assert_true(v_count = 0, '失败的恢复事务不得留下 Artifact');

  result := api.g1_recover_ambiguous_attempt(
    job_id, attempt_id, 'existing-provider-task-1', 'worker-recovery', 'SUCCEEDED',
    jsonb_build_object(
      'schema_version','g1_artifact_v1','content_sha256',repeat('f',64),
      'mime_type','video/mp4','byte_size',8192,'width',1280,'height',720,
      'duration_seconds',5,'storage_path',u1::text || '/' || p1 || '/' || job_id || '/v1/ffffffffffff.mp4',
      'usage','{}'::jsonb,'cost_cny',null));
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '准确现有 task 回收必须成功');
  result := api.g1_get_job(u1, job_id);
  perform pg_temp.assert_true(result -> 'job' ->> 'status' = 'completed', '回收后 job 必须 completed');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'attempts') = 1, '回收不得创建第二个 attempt');
  perform pg_temp.assert_true(result -> 'attempts' -> 0 ->> 'id' = attempt_id, '必须完成原 ambiguous attempt');
  perform pg_temp.assert_true(result -> 'attempts' -> 0 ->> 'state' = 'succeeded', '原 ambiguous attempt 必须转为 succeeded');
  perform pg_temp.assert_true(jsonb_array_length(result -> 'artifacts') = 1, '回收必须恰好创建一个 Artifact');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 -> 'knowledge_card_ids' = v_sr_cards, 'Artifact 必须继承准确 Knowledge 集合');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 -> 'evidence_ids' = v_sr_evidence, 'Artifact 必须继承准确 Evidence 集合');
  perform pg_temp.assert_true(result -> 'artifacts' -> 0 -> 'cost_cny' = 'null'::jsonb, 'Provider 未返回费用时必须保持 null');
  select count(*) into v_count
  from ams_private.g1_generation_events_v1 e
  where e.job_id = g1_case.job_id;
  perform pg_temp.assert_true(v_count = v_before_events + 3, '必须保留旧事件并只追加三条恢复事件');

  begin
    perform api.g1_recover_ambiguous_attempt(
      job_id, attempt_id, 'existing-provider-task-1', 'worker-recovery', 'SUCCEEDED',
      jsonb_build_object(
        'schema_version','g1_artifact_v1','content_sha256',repeat('f',64),
        'mime_type','video/mp4','byte_size',8192,
        'storage_path',u1::text || '/' || p1 || '/' || job_id || '/v2/ffffffffffff.mp4'));
    raise exception 'G1_B0_ASSERT: 已回收任务被重复恢复';
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    perform pg_temp.assert_true(sqlerrm like '%G1_RECOVERY_STATE_INVALID%', '重复恢复必须在写入前失败，实际 ' || sqlerrm);
  end;
  select count(*) into v_count
  from ams_private.g1_generation_artifacts_v1 ar
  where ar.job_id = g1_case.job_id;
  perform pg_temp.assert_true(v_count = 1, '重复恢复后仍必须只有一个 Artifact');
end $$;

-- ============================================================================
-- P19 证据报价绑定合同（g1_p19_evidence_quote_binding_v1）对抗矩阵：
--   - 历史 Brief（evidence_provenance 无 evidence_ids）+ 三卡/三证据 → 成功；
--   - 显式 provenance 精确匹配成功；子集/重复 → MISMATCH/INVALID；
--   - 请求卡片/证据缺失、空、重复、畸形、跨项目、错用户全部报价前 fail closed；
--   - 卡含合法重复声明（同卡多链接同一证据）与多证据链接均按权威集处理；
--   - 卡片最新持久化版本决定权威集（旧版本链接绝不参与）；
--   - 全部失败路径零作业/尝试/产物/事件（零 submit → 零 Provider/付费/Storage）。
-- ============================================================================
create function pg_temp.expect_quote_error(
  p_user uuid, p_project text, p_brief text,
  p_code text, p_label text,
  p_cards jsonb default null, p_evidence jsonb default null)
returns void
language plpgsql as $$
declare
  v_req jsonb;
  v_sql text;
begin
  if p_code is null or p_label is null then
    raise exception 'G1_B0_ASSERT: expect_quote_error 必须提供 p_code/p_label';
  end if;
  v_req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p_project,
    'brief_id',p_brief,'mode','image','prompt','绑定测试图片','aspect_ratio','1:1');
  if p_cards is not null then v_req := v_req || jsonb_build_object('knowledge_card_ids', p_cards); end if;
  if p_evidence is not null then v_req := v_req || jsonb_build_object('evidence_ids', p_evidence); end if;
  v_sql := format('select api.g1_quote_request(%L::uuid, %L::jsonb)', p_user::text, v_req::text);
  begin
    execute v_sql;
    raise exception 'G1_B0_ASSERT: % 被接受（期望 %）', p_label, p_code;
  exception when others then
    if sqlerrm like 'G1_B0_ASSERT%' then raise; end if;
    if sqlerrm not like '%' || p_code || '%' then
      raise exception 'G1_B0_ASSERT: % 必须 %，实际 %', p_label, p_code, sqlerrm;
    end if;
  end;
end $$;

create function pg_temp.quote_binding(
  p_user uuid, p_project text, p_brief text,
  p_cards jsonb default null, p_evidence jsonb default null)
returns jsonb
language plpgsql as $$
declare
  v_req jsonb;
begin
  v_req := jsonb_build_object(
    'schema_version','g1_generation_request_v1','project_id',p_project,
    'brief_id',p_brief,'mode','image','prompt','绑定测试图片','aspect_ratio','1:1');
  if p_cards is not null then v_req := v_req || jsonb_build_object('knowledge_card_ids', p_cards); end if;
  if p_evidence is not null then v_req := v_req || jsonb_build_object('evidence_ids', p_evidence); end if;
  return api.g1_quote_request(p_user, v_req);
end $$;

do $$
<<g1_binding>>
declare
  u1 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  u2 constant uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  p3 constant text := 'prj-333333333333333333333333';
  p4 constant text := 'prj-444444444444444444444444';
  e3a constant text := 'ev-a00000000000000000000001';
  e3b constant text := 'ev-a00000000000000000000002';
  e3c constant text := 'ev-a00000000000000000000003';
  -- u2/p2 的跨项目证据夹具（首个 DO 块已在同一事务内持久化；此处显式声明
  -- 常量以在本块作用域内引用，绝不依赖其他 DO 块的局部变量）。
  e2 constant text := 'ev-222222222222222222222222';
  kc3a constant text := 'kc-b00000000000000000000001';
  kc3b constant text := 'kc-b00000000000000000000002';
  kc3c constant text := 'kc-b00000000000000000000003';
  kc3d constant text := 'kc-b00000000000000000000004';
  kc3e constant text := 'kc-b00000000000000000000005';
  kc3f constant text := 'kc-b00000000000000000000006';
  kc3g constant text := 'kc-b00000000000000000000007';
  kc3h constant text := 'kc-b00000000000000000000008';
  kc3i constant text := 'kc-b00000000000000000000009';
  -- u2/p2 的跨项目卡夹具（首个 DO 块已持久化；显式声明以在本块作用域内引用）。
  kc2 constant text := 'kc-222222222222222222222222';
  b3 constant text := 'brief-333333333333333333333333';
  b4 constant text := 'brief-444444444444444444444444';
  b5 constant text := 'brief-555555555555555555555555';
  b6 constant text := 'brief-666666666666666666666666';
  b8 constant text := 'brief-888888888888888888888888';
  b9 constant text := 'brief-999999999999999999999999';
  ba constant text := 'brief-aaaaaaaaaaaaaaaaaaaaaaaa';
  bb constant text := 'brief-bbbbbbbbbbbbbbbbbbbbbbbb';
  bc constant text := 'brief-cccccccccccccccccccccccc';
  bd constant text := 'brief-dddddddddddddddddddddddd';
  be constant text := 'brief-eeeeeeeeeeeeeeeeeeeeeeee';
  payload jsonb;
  result jsonb;
  quote_fp text;
  quote_id text;
  request_sha text;
  v_count integer;
  v_cards101 jsonb;
  v_evidence1001 jsonb;
begin
  -- ---- 0. 种子：两个项目 + 三条证据 + 九张知识卡 + 十一个 Brief ----
  payload := jsonb_build_object(
    'id',p3,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','G1 绑定项目','objective','P19 证据报价绑定','audience','测试','channel','X',
    'constraints',jsonb_build_array());
  perform api.p19_apply_entity_write(u1,'g1b-proj-3','project.create','project',p3,
    '{}'::jsonb,'p19_research_projects_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',p4,'version',1,'schema_version','p19_research_project_v1','status','active',
    'topic','G1 绑定隔离项目','objective','隔离','audience','测试','channel','X',
    'constraints',jsonb_build_array());
  perform api.p19_apply_entity_write(u2,'g1b-proj-4','project.create','project',p4,
    '{}'::jsonb,'p19_research_projects_v1',payload,null,null);

  -- 三条证据（u1/p3）。
  for v_count in 1..3 loop
    payload := jsonb_build_object(
      'id', case v_count when 1 then e3a when 2 then e3b else e3c end,
      'project_id',p3,'schema_version','p19_evidence_record_v1',
      'source_url','https://example.com/bind/' || v_count,
      'label','绑定证据 ' || v_count,'platform','manual',
      'content_text','绑定证据正文 ' || v_count,
      'recorded_at','2026-08-19T00:00:00Z',
      'provenance',jsonb_build_object('manual',true),'media_metadata','null'::jsonb,
      'version',1,'fingerprint',repeat(to_hex(v_count), 64),
      'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
    perform api.p19_apply_entity_write(u1,'g1b-ev-' || v_count,'evidence.create','evidence',
      payload ->> 'id','{}'::jsonb,'p19_evidence_records_v1',payload,null,null);
  end loop;

  -- 三张正常卡：kc3a 三链接同证（卡内合法重复声明）、kc3b 两链接同证、
  -- kc3c 单链接 → 权威集恰好三证。
  for v_count in 1..3 loop
    payload := jsonb_build_object(
      'id', case v_count when 1 then kc3a when 2 then kc3b else kc3c end,
      'project_id',p3,'schema_version','content_knowledge_card_v1',
      'version',1,'source_observations',jsonb_build_object('post_text','绑定卡正文 ' || v_count),
      'evidence_links', case v_count
        when 1 then jsonb_build_array(
          jsonb_build_object('claim','一','evidence_type','post_text','source_ref',e3a,'confidence',0.9),
          jsonb_build_object('claim','二','evidence_type','metadata','source_ref',e3a,'confidence',0.8),
          jsonb_build_object('claim','三','evidence_type','post_text','source_ref',e3a,'confidence',0.7))
        when 2 then jsonb_build_array(
          jsonb_build_object('claim','一','evidence_type','post_text','source_ref',e3b,'confidence',0.9),
          jsonb_build_object('claim','二','evidence_type','metadata','source_ref',e3b,'confidence',0.8))
        else jsonb_build_array(
          jsonb_build_object('claim','一','evidence_type','post_text','source_ref',e3c,'confidence',0.9))
      end,
      'trust_status','verified_local','validation_status','bound_exact',
      'fingerprint',repeat(to_hex(10 + v_count), 64),
      'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
    perform api.p19_apply_entity_write(u1,'g1b-kc-' || v_count,'card.create','card',
      payload ->> 'id','{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  end loop;

  -- 对抗卡：kc3e 链接缺 source_ref；kc3f 三条畸形 source_ref；kc3g 指向跨项目
  -- 证据 e2（u2/p2）；kc3h 多证据链接；kc3i 版本夹具（v1→e3a，稍后 v2→e3b）。
  payload := jsonb_build_object(
    'id',kc3e,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','缺 source_ref'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','无引用','evidence_type','post_text','confidence',0.9)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('e', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-e','card.create','card',kc3e,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',kc3f,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','畸形 source_ref'),
    'evidence_links',jsonb_build_array(
      jsonb_build_object('claim','短','evidence_type','post_text','source_ref','ev-xyz','confidence',0.9),
      jsonb_build_object('claim','大写','evidence_type','metadata','source_ref','ev-FFFFFFFFFFFFFFFFFFFFFFFF','confidence',0.8),
      jsonb_build_object('claim','数字','evidence_type','post_text','source_ref',42,'confidence',0.7)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('f', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-f','card.create','card',kc3f,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',kc3g,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','跨项目证据引用'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','跨项目','evidence_type','post_text','source_ref',e2,'confidence',0.9)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('a', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-g','card.create','card',kc3g,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',kc3h,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','多证据卡'),
    'evidence_links',jsonb_build_array(
      jsonb_build_object('claim','一','evidence_type','post_text','source_ref',e3a,'confidence',0.9),
      jsonb_build_object('claim','二','evidence_type','post_text','source_ref',e3b,'confidence',0.9)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('b', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-h','card.create','card',kc3h,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',kc3i,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',1,'source_observations',jsonb_build_object('post_text','版本夹具 v1'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','v1','evidence_type','post_text','source_ref',e3a,'confidence',0.9)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('c', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-i1','card.create','card',kc3i,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);

  -- 历史 Brief b3：evidence_provenance 只有 created_from/local_only/statement/store，
  -- 无 evidence_ids（P19 事故形态）。引用三卡。
  payload := jsonb_build_object(
    'id',b3,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a,kc3b,kc3c),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','历史 P19 Brief：无显式证据身份。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b3,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('d', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-3','brief.assemble','brief',b3,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);

  -- b4：显式正确 provenance（与权威集精确一致）。
  payload := jsonb_build_object(
    'id',b4,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 显式','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a,kc3b,kc3c),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','显式证据身份。','store','p19_workspace_v1',
      'evidence_ids',jsonb_build_array(e3a,e3b,e3c)),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b4,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('e', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-4','brief.assemble','brief',b4,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);

  -- b5：显式子集（与权威集不一致）；b6：显式重复。
  payload := jsonb_build_object(
    'id',b5,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 子集','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a,kc3b,kc3c),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','子集。','store','p19_workspace_v1',
      'evidence_ids',jsonb_build_array(e3a,e3b)),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b5,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('f', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-5','brief.assemble','brief',b5,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',b6,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 重复','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a,kc3b,kc3c),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','重复。','store','p19_workspace_v1',
      'evidence_ids',jsonb_build_array(e3a,e3b,e3c,e3a)),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b6,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('0', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-6','brief.assemble','brief',b6,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);

  -- b8：引用缺失卡 kc3d；b9：卡链接缺 source_ref；ba：卡链接畸形；
  -- bb：卡指向跨项目证据 e2；bc：多证据卡；bd：版本夹具卡。
  payload := jsonb_build_object(
    'id',b8,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 缺卡','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a,kc3b,kc3c,kc3d),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','缺卡。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b8,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('1', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-8','brief.assemble','brief',b8,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',b9,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 无引用','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3e),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','无引用。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',b9,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('2', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-9','brief.assemble','brief',b9,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',ba,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 畸形引用','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3f),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','畸形引用。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',ba,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('3', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-a','brief.assemble','brief',ba,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',bb,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 跨项目证据','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3g),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','跨项目证据。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',bb,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('4', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-b','brief.assemble','brief',bb,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',bc,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 多证据','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3h),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','多证据卡。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',bc,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('5', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-c','brief.assemble','brief',bc,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  payload := jsonb_build_object(
    'id',bd,'project_id',p3,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 绑定 Brief 版本夹具','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3i),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','版本夹具。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',bd,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('6', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-brief-d','brief.assemble','brief',bd,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);
  -- be：u2/p4 的 Brief 错误引用 u1/p3 的卡（wrong-user 绑定）。
  payload := jsonb_build_object(
    'id',be,'project_id',p4,'schema_version','ams_content_brief_v1','version',1,
    'status','pending_review','topic','G1 错用户绑定','objective','生成素材','audience','测试',
    'channel','X','constraints',jsonb_build_array(),
    'knowledge_citation_ids',jsonb_build_array(kc3a),
    'structural_guidance',jsonb_build_array(),
    'evidence_provenance',jsonb_build_object(
      'created_from','selected_knowledge_cards','local_only',true,
      'statement','错用户。','store','p19_workspace_v1'),
    'review',jsonb_build_object('schema_version','ams_brief_review_v1','brief_id',be,
      'decision','null'::jsonb,'comments',jsonb_build_array()),
    'fingerprint',repeat('7', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u2,'g1b-brief-e','brief.assemble','brief',be,
    '{}'::jsonb,'p19_briefs_v1',payload,null,null);

  -- ---- H1 历史 Brief（无 evidence_ids）+ 三卡/三证据 → 成功 ----
  result := pg_temp.quote_binding(u1, p3, b3);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '历史 Brief 报价必须成功');
  quote_id := result -> 'quote' ->> 'quote_id';
  quote_fp := result -> 'quote' ->> 'quote_fingerprint';
  request_sha := result -> 'quote' ->> 'request_sha256';
  perform pg_temp.assert_true(
    jsonb_array_length(result -> 'quote' -> 'knowledge_card_ids') = 3,
    '历史 Brief 报价必须绑定 3 张知识卡');
  perform pg_temp.assert_true(
    jsonb_array_length(result -> 'quote' -> 'evidence_ids') = 3,
    '历史 Brief 报价必须从卡片派生 3 条证据');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'knowledge_card_ids' = jsonb_build_array(kc3a,kc3b,kc3c),
    '报价知识卡集合必须为规范排序');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'evidence_ids' = jsonb_build_array(e3a,e3b,e3c),
    '报价证据集合必须为权威集（规范排序、跨卡合法重复去重）');

  -- ---- H2 乱序精确请求 → 复用（排序稳定性）----
  result := pg_temp.quote_binding(u1, p3, b3,
    jsonb_build_array(kc3c,kc3a,kc3b), jsonb_build_array(e3c,e3a,e3b));
  perform pg_temp.assert_true(result ->> 'outcome' = 'reused', '乱序精确请求必须复用既有 quote');
  perform pg_temp.assert_true(
    result -> 'quote' ->> 'quote_fingerprint' = quote_fp, '乱序请求必须得到同一 quote 指纹');

  -- ---- H3 精确卡片 + 省略证据 → 复用（请求省略 vs 精确请求；刷新恢复）----
  result := pg_temp.quote_binding(u1, p3, b3, jsonb_build_array(kc3a,kc3b,kc3c));
  perform pg_temp.assert_true(result ->> 'outcome' = 'reused', '省略证据的精确卡片请求必须复用 quote');
  perform pg_temp.assert_true(
    result -> 'quote' ->> 'quote_fingerprint' = quote_fp, '省略证据请求必须自动绑定权威集并复用同一指纹');

  -- ---- H4 显式正确 provenance → 成功（显式集合 == 权威集）----
  result := pg_temp.quote_binding(u1, p3, b4);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '显式正确 provenance 报价必须成功');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'evidence_ids' = jsonb_build_array(e3a,e3b,e3c),
    '显式正确 provenance 必须与权威集精确一致');

  -- ---- H5 显式 provenance 子集 → MISMATCH ----
  perform pg_temp.expect_quote_error(u1, p3, b5,
    'G1_BINDING_MISMATCH', '显式证据子集');
  -- ---- H6 显式 provenance 重复 → INVALID（去重前拒绝）----
  perform pg_temp.expect_quote_error(u1, p3, b6,
    'G1_BINDING_INVALID', '显式证据重复');

  -- ---- H7 请求证据与权威集不一致 → MISMATCH ----
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_MISMATCH', '请求证据子集',
    null, jsonb_build_array(e3a,e3b));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_MISMATCH', '请求证据含未派生/不存在的规范 id',
    null, jsonb_build_array(e3a,e3b,'ev-a00000000000000000000004'));
  -- ---- H8 请求证据重复 → INVALID ----
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据重复',
    null, jsonb_build_array(e3a,e3b,e3c,e3a));

  -- ---- H9 请求证据畸形/缺失/空/超界 → INVALID ----
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据短 id',
    null, jsonb_build_array('ev-xyz'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据大写',
    null, jsonb_build_array('ev-FFFFFFFFFFFFFFFFFFFFFFFF'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据 URL',
    null, jsonb_build_array(e3a, 'https://example.com/ev'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据截断 id',
    null, jsonb_build_array('ev-123'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据含 JSON null',
    null, jsonb_build_array('null'::jsonb));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据空数组',
    null, jsonb_build_array());
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据非数组',
    null, to_jsonb('ev-111111111111111111111111'::text));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据 JSON null',
    null, 'null'::jsonb);
  v_evidence1001 := (select jsonb_agg('ev-' || lpad(i::text, 24, '0')) from generate_series(1, 1001) i);
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求证据超界(1001)',
    null, v_evidence1001);

  -- ---- H10 请求卡片畸形/缺失/空/重复/超界 → INVALID ----
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片短 id',
    jsonb_build_array('kc-xyz'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片旧前缀 card-',
    jsonb_build_array('card-111111111111111111111111'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片大写',
    jsonb_build_array('KC-111111111111111111111111'));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片含 JSON null',
    jsonb_build_array('null'::jsonb));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片空数组',
    jsonb_build_array());
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片重复（去重前拒绝）',
    jsonb_build_array(kc3a, kc3a));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片非数组',
    to_jsonb('kc-111111111111111111111111'::text));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片 JSON null',
    'null'::jsonb);
  v_cards101 := (select jsonb_agg('kc-' || lpad(i::text, 24, '0')) from generate_series(1, 101) i);
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '请求卡片超界(101)',
    v_cards101);

  -- ---- H11 请求卡片集合与 Brief 引用集不一致 → MISMATCH ----
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_MISMATCH', '请求卡片子集',
    jsonb_build_array(kc3a,kc3b));
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_MISMATCH', '请求卡片多一张',
    jsonb_build_array(kc3a,kc3b,kc3c,'kc-111111111111111111111111'));
  -- 跨项目卡（kc2 属于 u2/p2）：集合比较先行 → MISMATCH。
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_MISMATCH', '跨项目卡片',
    jsonb_build_array(kc2));
  -- 重复发生在集合比较之前：重复 + 不同集合 → INVALID。
  perform pg_temp.expect_quote_error(u1, p3, b3,
    'G1_BINDING_INVALID', '重复卡片先于集合比较拒绝',
    jsonb_build_array(kc3a,kc3a,kc3b));

  -- ---- H12 引用缺失卡（行不存在）→ MISSING ----
  perform pg_temp.expect_quote_error(u1, p3, b8,
    'G1_BINDING_MISSING', 'Brief 引用缺失卡');

  -- ---- H13 卡链接缺 source_ref → INVALID ----
  perform pg_temp.expect_quote_error(u1, p3, b9,
    'G1_BINDING_INVALID', '卡链接缺 source_ref');
  -- ---- H14 卡链接畸形 source_ref（短/大写/数字）→ INVALID ----
  perform pg_temp.expect_quote_error(u1, p3, ba,
    'G1_BINDING_INVALID', '卡链接畸形 source_ref');
  -- ---- H15 卡指向跨项目证据（e2 属于 u2/p2）→ MISSING ----
  perform pg_temp.expect_quote_error(u1, p3, bb,
    'G1_BINDING_MISSING', '跨项目证据引用');
  -- ---- H16 错用户绑定 ----
  -- u2 报价 u1 的 Brief → BRIEF_NOT_FOUND（用户隔离先行）。
  perform pg_temp.expect_quote_error(u2, p3, b3,
    'G1_BRIEF_NOT_FOUND', '跨用户报价');
  -- u2/p4 的 Brief 引用 u1/p3 的卡 → 卡存在性按用户隔离失败 → MISSING。
  perform pg_temp.expect_quote_error(u2, p4, be,
    'G1_BINDING_MISSING', '错用户卡片绑定');

  -- ---- H18 多证据链接卡 → 权威集 = 去重并集 ----
  result := pg_temp.quote_binding(u1, p3, bc);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '多证据链接卡报价必须成功');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'evidence_ids' = jsonb_build_array(e3a,e3b),
    '多证据链接卡必须派生两条证据（规范排序）');

  -- ---- H19 卡片最新持久化版本决定权威集 ----
  result := pg_temp.quote_binding(u1, p3, bd);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '版本夹具 v1 报价必须成功');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'evidence_ids' = jsonb_build_array(e3a),
    'v1 卡必须派生 e3a');
  payload := jsonb_build_object(
    'id',kc3i,'project_id',p3,'schema_version','content_knowledge_card_v1',
    'version',2,'source_observations',jsonb_build_object('post_text','版本夹具 v2'),
    'evidence_links',jsonb_build_array(jsonb_build_object('claim','v2','evidence_type','post_text','source_ref',e3b,'confidence',0.9)),
    'trust_status','verified_local','validation_status','bound_exact',
    'fingerprint',repeat('c', 64),'created_at','2026-08-19T00:00:00Z','updated_at','2026-08-19T00:00:00Z');
  perform api.p19_apply_entity_write(u1,'g1b-kc-i2','card.create','card',kc3i,
    '{}'::jsonb,'p19_knowledge_cards_v1',payload,null,null);
  result := pg_temp.quote_binding(u1, p3, bd);
  perform pg_temp.assert_true(result ->> 'ok' = 'true', '版本夹具 v2 报价必须成功');
  perform pg_temp.assert_true(
    result -> 'quote' -> 'evidence_ids' = jsonb_build_array(e3b),
    'v2 卡必须覆盖 v1 派生 e3b（最新持久化版本为准）');

  -- ---- H20 全部失败路径零副作用：零 submit → 零 Provider/付费/作业/尝试/产物/事件 ----
  select count(*) into v_count
  from ams_private.g1_generation_jobs_v1
  where user_id = u1 and project_id = p3;
  perform pg_temp.assert_true(v_count = 0, 'p3 必须零作业（全部绑定失败停在报价前），实际 ' || v_count);
  select count(*) into v_count
  from ams_private.g1_generation_attempts_v1 a
  join ams_private.g1_generation_jobs_v1 j on j.id = a.job_id
  where j.user_id = u1 and j.project_id = p3;
  perform pg_temp.assert_true(v_count = 0, 'p3 必须零尝试，实际 ' || v_count);
  select count(*) into v_count
  from ams_private.g1_generation_artifacts_v1 ar
  join ams_private.g1_generation_jobs_v1 j on j.id = ar.job_id
  where j.user_id = u1 and j.project_id = p3;
  perform pg_temp.assert_true(v_count = 0, 'p3 必须零产物，实际 ' || v_count);
  select count(*) into v_count
  from ams_private.g1_generation_events_v1 e
  join ams_private.g1_generation_jobs_v1 j on j.id = e.job_id
  where j.user_id = u1 and j.project_id = p3;
  perform pg_temp.assert_true(v_count = 0, 'p3 必须零事件，实际 ' || v_count);
  select count(*) into v_count
  from ams_private.g1_generation_jobs_v1
  where user_id = u2 and project_id = p4;
  perform pg_temp.assert_true(v_count = 0, 'p4 必须零作业，实际 ' || v_count);
  -- 成功路径的不可变报价恰好 5 条（H1/H2/H3 共享 1 条 + H4 + H18 + H19v1 + H19v2）。
  select count(*) into v_count
  from ams_private.g1_generation_quotes_v1
  where user_id = u1 and project_id = p3;
  perform pg_temp.assert_true(v_count = 5, 'p3 成功报价必须恰好 5 条不可变 quote，实际 ' || v_count);
end $$;

rollback;
