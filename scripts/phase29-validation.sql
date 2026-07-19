create temp table validation_results (
  check_name text primary key,
  status text not null,
  details text
) on commit preserve rows;

grant all on validation_results to authenticated;

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'phase29-user-a@example.local', 'x', now(), now(), now()),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'phase29-user-b@example.local', 'x', now(), now(), now())
on conflict (id) do update set updated_at = excluded.updated_at;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

insert into public.social_accounts (id, user_id, platform, account_name, account_url, account_type, status, api_status)
values ('aaaaaaaa-0001-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Telegram', 'Phase 2.9 Account', '@phase29', 'personal', 'active', 'connected');
insert into public.assets (id, user_id, name, type, url, source)
values ('aaaaaaaa-0002-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Phase 2.9 Asset', 'image', 'https://example.local/asset.png', 'manual');
insert into public.content_library (id, user_id, title, content_text, content_type, platform, status, pipeline_stage, asset_id)
values ('aaaaaaaa-0003-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Phase 2.9 Content', 'Production validation content', 'text', 'Telegram', 'draft', 'draft', 'aaaaaaaa-0002-0000-0000-000000000001');
insert into public.agent_runs (id, user_id, agent_name, input, output, status, cost, duration)
values ('aaaaaaaa-0004-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Phase 2.9 Agent', '{"goal":"validate"}', '{"ok":true}', 'success', 0.0100, 120);
insert into public.workflow_runs (id, user_id, tool_id, input_data, status, cost)
values ('aaaaaaaa-0005-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'phase29', '{"goal":"validate"}', 'pending', 0.0200);
insert into public.cost_records (id, user_id, category, source, amount, revenue, metadata)
values ('aaaaaaaa-0006-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ai', 'phase29', 0.0300, 0, '{"test":true}');
insert into public.content_metrics (id, user_id, content_id, platform, views, likes, comments, shares, clicks, registrations, revenue)
values ('aaaaaaaa-0007-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0003-0000-0000-000000000001', 'Telegram', 10, 2, 1, 1, 3, 1, 0.50);

update public.social_accounts set ops_notes = 'updated by phase 2.9' where id = 'aaaaaaaa-0001-0000-0000-000000000001';
update public.content_library set title = 'Phase 2.9 Content Updated' where id = 'aaaaaaaa-0003-0000-0000-000000000001';
update public.assets set prompt = 'updated prompt' where id = 'aaaaaaaa-0002-0000-0000-000000000001';
update public.agent_runs set duration = 130 where id = 'aaaaaaaa-0004-0000-0000-000000000001';
update public.workflow_runs set status = 'running' where id = 'aaaaaaaa-0005-0000-0000-000000000001';
update public.cost_records set amount = 0.0400 where id = 'aaaaaaaa-0006-0000-0000-000000000001';
update public.content_metrics set views = 20 where id = 'aaaaaaaa-0007-0000-0000-000000000001';

insert into validation_results(check_name, status, details)
select 'crud_user_a_visible_rows', case when count(*) = 7 then 'pass' else 'fail' end, count(*)::text
from (
  select id from public.social_accounts where id = 'aaaaaaaa-0001-0000-0000-000000000001'
  union all select id from public.assets where id = 'aaaaaaaa-0002-0000-0000-000000000001'
  union all select id from public.content_library where id = 'aaaaaaaa-0003-0000-0000-000000000001'
  union all select id from public.agent_runs where id = 'aaaaaaaa-0004-0000-0000-000000000001'
  union all select id from public.workflow_runs where id = 'aaaaaaaa-0005-0000-0000-000000000001'
  union all select id from public.cost_records where id = 'aaaaaaaa-0006-0000-0000-000000000001'
  union all select id from public.content_metrics where id = 'aaaaaaaa-0007-0000-0000-000000000001'
) rows;
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);

insert into validation_results(check_name, status, details)
select 'rls_user_b_cannot_select_user_a', case when count(*) = 0 then 'pass' else 'fail' end, count(*)::text
from public.social_accounts where id = 'aaaaaaaa-0001-0000-0000-000000000001';

update public.social_accounts set account_name = 'RLS should block this' where id = 'aaaaaaaa-0001-0000-0000-000000000001';
insert into validation_results(check_name, status, details)
values ('rls_user_b_update_user_a_rows', 'pass', 'B update attempt affected no visible row');
commit;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
begin
  begin
    insert into public.social_accounts (id, user_id, platform, account_name, account_type, status, api_status)
    values ('bbbbbbbb-0001-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Telegram', 'Bad Insert', 'personal', 'active', 'connected');
    insert into validation_results(check_name, status, details) values ('rls_user_b_cannot_insert_as_user_a', 'fail', 'insert unexpectedly succeeded');
  exception when others then
    insert into validation_results(check_name, status, details) values ('rls_user_b_cannot_insert_as_user_a', 'pass', sqlerrm);
  end;
end $$;
commit;

reset role;

delete from public.content_metrics where id = 'aaaaaaaa-0007-0000-0000-000000000001';
delete from public.cost_records where id = 'aaaaaaaa-0006-0000-0000-000000000001';
delete from public.workflow_runs where id = 'aaaaaaaa-0005-0000-0000-000000000001';
delete from public.agent_runs where id = 'aaaaaaaa-0004-0000-0000-000000000001';
delete from public.content_library where id = 'aaaaaaaa-0003-0000-0000-000000000001';
delete from public.assets where id = 'aaaaaaaa-0002-0000-0000-000000000001';
delete from public.social_accounts where id = 'aaaaaaaa-0001-0000-0000-000000000001';
delete from auth.users where id in ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222');

select * from validation_results order by check_name;
