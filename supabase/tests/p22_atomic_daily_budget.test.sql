-- P22/P26 原子费用预留合同测试。
--
-- P26（20260812091054_p26_remove_daily_provider_caps.sql）正式取代 P22 的
-- 项目级 UTC 每日累计上限：仍保留 service_role-only、幂等的费用预留用于审计，
-- 但移除累计日上限。本测试断言的是当前 P26 实装合同：
--   - 返回 schema_version=p26_provider_cost_tracking_v1，daily_cap_enabled=false；
--   - 首次预留 outcome=recorded，同 reservation_id 幂等重放 outcome=already_recorded；
--   - 单次金额仍受约束：>0、<=10.0000、scale<=4（否则 P22_AMOUNT_INVALID）；
--   - 不同 reservation_id 的同 provider 累计费用可超过 CNY 10（证明无累计日上限）；
--   - provider 白名单、reservation 幂等冲突（跨用户/provider/金额）、
--     service_role-only EXECUTE 全部保留；
--   - cost_records 条数、provider 汇总、日期与 metadata 精确验证。

begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P22_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values ('55555555-5555-4555-8555-555555555555','authenticated','authenticated','p22@example.invalid','{}','{}',now(),now(),false,false);

do $$
declare
  u constant uuid := '55555555-5555-4555-8555-555555555555';
  r1 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  r2 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  r3 constant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  v_today constant date := (clock_timestamp() at time zone 'UTC')::date;
  v_sum numeric;
  result jsonb;
begin
  -- service_role-only EXECUTE（P26 保留）
  perform pg_temp.assert_true(not has_function_privilege('public','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'public execute');
  perform pg_temp.assert_true(not has_function_privilege('anon','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'anon execute');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'authenticated execute');
  perform pg_temp.assert_true(has_function_privilege('service_role','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'service_role missing execute');

  -- 首次预留：recorded，P26 schema_version，daily_cap_enabled=false
  result := api.p22_reserve_daily_budget(u,'apify',6,r1);
  perform pg_temp.assert_true(result->>'schema_version'='p26_provider_cost_tracking_v1','first schema_version');
  perform pg_temp.assert_true(result->>'outcome'='recorded','first outcome recorded');
  perform pg_temp.assert_true((result->>'daily_cap_enabled')::boolean is false,'first daily_cap_enabled false');
  perform pg_temp.assert_true((result->>'recorded_cny')::numeric=6,'first recorded_cny 6');

  -- 幂等重放：同 reservation_id → already_recorded，不新增行
  result := api.p22_reserve_daily_budget(u,'APIFY',6,r1);
  perform pg_temp.assert_true(result->>'schema_version'='p26_provider_cost_tracking_v1','idempotent schema_version');
  perform pg_temp.assert_true(result->>'outcome'='already_recorded','idempotent outcome already_recorded');
  perform pg_temp.assert_true((result->>'daily_cap_enabled')::boolean is false,'idempotent daily_cap_enabled false');
  perform pg_temp.assert_true((result->>'recorded_cny')::numeric=6,'idempotent recorded_cny 6');

  -- 无累计日上限：同 provider 不同 reservation_id 再次预留，累计 6+6=12 超过 CNY 10
  result := api.p22_reserve_daily_budget(u,'apify',6,r2);
  perform pg_temp.assert_true(result->>'outcome'='recorded','second apify reservation recorded');
  perform pg_temp.assert_true((result->>'recorded_cny')::numeric=12,'cumulative 12 exceeds 10 (no daily cap)');

  -- provider 隔离：qwen 独立累计，不受 apify 影响
  result := api.p22_reserve_daily_budget(u,'qwen',10,r3);
  perform pg_temp.assert_true(result->>'outcome'='recorded','qwen reservation recorded');
  perform pg_temp.assert_true((result->>'recorded_cny')::numeric=10,'qwen recorded_cny 10');

  -- reservation 幂等冲突：同 reservation_id 换 user / provider / amount 必须拒绝
  begin
    perform api.p22_reserve_daily_budget(gen_random_uuid(),'apify',6,r1);
    raise exception 'P22_ASSERT: cross-user conflict not raised';
  exception when others then if sqlerrm not like '%P22_RESERVATION_CONFLICT%' then raise; end if; end;
  begin
    perform api.p22_reserve_daily_budget(u,'qwen',6,r1);
    raise exception 'P22_ASSERT: cross-provider conflict not raised';
  exception when others then if sqlerrm not like '%P22_RESERVATION_CONFLICT%' then raise; end if; end;
  begin
    perform api.p22_reserve_daily_budget(u,'apify',5,r1);
    raise exception 'P22_ASSERT: cross-amount conflict not raised';
  exception when others then if sqlerrm not like '%P22_RESERVATION_CONFLICT%' then raise; end if; end;

  -- 单次金额约束保留：0 / 超过 10.0000 / scale>4 全部拒绝
  begin
    perform api.p22_reserve_daily_budget(u,'apify',0,gen_random_uuid());
    raise exception 'P22_ASSERT: zero amount not rejected';
  exception when others then if sqlerrm not like '%P22_AMOUNT_INVALID%' then raise; end if; end;
  begin
    perform api.p22_reserve_daily_budget(u,'apify',10.0001,gen_random_uuid());
    raise exception 'P22_ASSERT: amount over 10.0000 not rejected';
  exception when others then if sqlerrm not like '%P22_AMOUNT_INVALID%' then raise; end if; end;
  begin
    perform api.p22_reserve_daily_budget(u,'apify',1.00001,gen_random_uuid());
    raise exception 'P22_ASSERT: scale>4 not rejected';
  exception when others then if sqlerrm not like '%P22_AMOUNT_INVALID%' then raise; end if; end;

  -- provider 白名单保留
  begin
    perform api.p22_reserve_daily_budget(u,'other',1,gen_random_uuid());
    raise exception 'P22_ASSERT: unknown provider not rejected';
  exception when others then if sqlerrm not like '%P22_PROVIDER_INVALID%' then raise; end if; end;

  -- 精确台账验证：恰好 3 行（r1/r2 apify + r3 qwen），冲突与越界尝试零写入
  perform pg_temp.assert_true((select count(*) from public.cost_records where metadata->>'schema_version'='p22_budget_reservation_v1')=3,'exact ledger count 3');
  perform pg_temp.assert_true((select count(distinct metadata->>'reservation_id') from public.cost_records where metadata->>'schema_version'='p22_budget_reservation_v1')=3,'exact distinct reservation ids 3');

  -- provider 汇总：apify 12（无累计上限）、qwen 10，按日期精确匹配
  select coalesce(sum(amount),0) into v_sum from public.cost_records where metadata->>'provider'='apify';
  perform pg_temp.assert_true(v_sum=12,'apify ledger sum 12 (no daily cap)');
  select coalesce(sum(amount),0) into v_sum from public.cost_records where metadata->>'provider'='qwen';
  perform pg_temp.assert_true(v_sum=10,'qwen ledger sum 10');

  -- 日期：全部记入 UTC 当日
  perform pg_temp.assert_true((select count(*) from public.cost_records
    where metadata->>'schema_version'='p22_budget_reservation_v1' and cost_date=v_today)=3,'all records dated today UTC');

  -- metadata 精确验证：status/currency/source/category 逐项
  perform pg_temp.assert_true((select count(*) from public.cost_records
    where metadata->>'schema_version'='p22_budget_reservation_v1'
      and metadata->>'status'='recorded_without_daily_cap'
      and metadata->>'currency'='CNY')=3,'all records status recorded_without_daily_cap + currency CNY');
  perform pg_temp.assert_true((select count(*) from public.cost_records
    where metadata->>'provider'='apify' and category='api' and source='p22:apify')=2,'apify category/source');
  perform pg_temp.assert_true((select count(*) from public.cost_records
    where metadata->>'provider'='qwen' and category='ai' and source='p22:qwen')=1,'qwen category/source');
end $$;

rollback;
