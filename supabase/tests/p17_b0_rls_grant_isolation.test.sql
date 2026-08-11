begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P17_B0_ASSERT: %', message; end if; end $$;

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_sso_user,is_anonymous)
values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','a@example.invalid','{}','{}',now(),now(),false,false),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','b@example.invalid','{}','{}',now(),now(),false,false),
 ('33333333-3333-4333-8333-333333333333','authenticated','authenticated','n@example.invalid','{}','{"staging_role":"admin"}',now(),now(),false,false);

insert into ams_private.staging_access_v1(user_id,access_role,enabled) values
 ('11111111-1111-4111-8111-111111111111','viewer',true),
 ('22222222-2222-4222-8222-222222222222','viewer',true);

insert into ams_private.ke_knowledge_cards_v1
 (user_id,knowledge_id,knowledge_version,schema_version,source_identity,evidence_refs,trust_status,validation_status,payload,payload_sha256)
select u, k, 1, 'ke_p5_v1', '{"source":"local"}', '["e1"]', 'trusted', 'valid', p,
 encode(extensions.digest(convert_to(p::text,'UTF8'),'sha256'),'hex')
from (values
 ('11111111-1111-4111-8111-111111111111'::uuid,'knowledge-a','{"owner":"a"}'::jsonb),
 ('22222222-2222-4222-8222-222222222222'::uuid,'knowledge-b','{"owner":"b"}'::jsonb)
) v(u,k,p);

set local role anon;
do $$ begin
  perform * from api.ke_knowledge_cards_v1;
  raise exception 'P17_B0_ASSERT: anon unexpectedly read api';
exception when insufficient_privilege then null; end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","user_metadata":{"staging_role":"admin"}}',true);
do $$ begin
  perform * from api.ke_knowledge_cards_v1;
  raise exception 'P17_B0_ASSERT: authenticated unexpectedly entered server-only api schema';
exception when insufficient_privilege then null; end $$;
select pg_temp.assert_true((select count(*)=0 from ams_private.ke_knowledge_cards_v1), 'user_metadata must not grant staging access');

select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select pg_temp.assert_true((select array_agg(knowledge_id order by knowledge_id)=array['knowledge-a'] from ams_private.ke_knowledge_cards_v1), 'viewer A must see only A through private RLS');
do $$ begin
  insert into ams_private.ke_knowledge_cards_v1(user_id,knowledge_id,knowledge_version,schema_version,source_identity,evidence_refs,trust_status,validation_status,payload,payload_sha256)
  values ('11111111-1111-4111-8111-111111111111','write-denied',1,'x','{}','["e"]','x','x','{}',repeat('0',64));
  raise exception 'P17_B0_ASSERT: authenticated write unexpectedly succeeded';
exception when insufficient_privilege then null; end $$;

select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
select pg_temp.assert_true((select array_agg(knowledge_id order by knowledge_id)=array['knowledge-b'] from ams_private.ke_knowledge_cards_v1), 'viewer B must see only B through private RLS');
reset role;

rollback;
