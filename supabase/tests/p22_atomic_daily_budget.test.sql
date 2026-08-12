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
  result jsonb;
begin
  perform pg_temp.assert_true(not has_function_privilege('public','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'public execute');
  perform pg_temp.assert_true(not has_function_privilege('anon','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'anon execute');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'authenticated execute');
  perform pg_temp.assert_true(has_function_privilege('service_role','api.p22_reserve_daily_budget(uuid,text,numeric,uuid)','EXECUTE'),'service_role missing execute');

  result := api.p22_reserve_daily_budget(u,'apify',6,r1);
  perform pg_temp.assert_true(result->>'outcome'='reserved' and (result->>'reserved_cny')::numeric=6,'first reserve');
  result := api.p22_reserve_daily_budget(u,'APIFY',6,r1);
  perform pg_temp.assert_true(result->>'outcome'='already_reserved' and (result->>'reserved_cny')::numeric=6,'idempotent reserve');
  begin
    perform api.p22_reserve_daily_budget(u,'apify',5,r2);
    raise exception 'P22_ASSERT: cap exceeded';
  exception when others then if sqlerrm not like '%P22_DAILY_BUDGET_EXCEEDED%' then raise; end if; end;

  result := api.p22_reserve_daily_budget(u,'qwen',10,r3);
  perform pg_temp.assert_true((result->>'reserved_cny')::numeric=10,'provider isolation');

  begin perform api.p22_reserve_daily_budget(u,'other',1,gen_random_uuid()); raise exception 'P22_ASSERT: provider';
  exception when others then if sqlerrm not like '%P22_PROVIDER_INVALID%' then raise; end if; end;
  begin perform api.p22_reserve_daily_budget(u,'apify',0,gen_random_uuid()); raise exception 'P22_ASSERT: amount';
  exception when others then if sqlerrm not like '%P22_AMOUNT_INVALID%' then raise; end if; end;
  begin perform api.p22_reserve_daily_budget(u,'apify',1.00001,gen_random_uuid()); raise exception 'P22_ASSERT: scale';
  exception when others then if sqlerrm not like '%P22_AMOUNT_INVALID%' then raise; end if; end;

  perform pg_temp.assert_true((select count(*) from public.cost_records where metadata->>'schema_version'='p22_budget_reservation_v1')=2,'exact reservations');
  perform pg_temp.assert_true((select coalesce(sum(amount),0) from public.cost_records where metadata->>'provider'='apify')=6,'apify cap ledger');
  perform pg_temp.assert_true((select coalesce(sum(amount),0) from public.cost_records where metadata->>'provider'='qwen')=10,'qwen cap ledger');
end $$;

rollback;
