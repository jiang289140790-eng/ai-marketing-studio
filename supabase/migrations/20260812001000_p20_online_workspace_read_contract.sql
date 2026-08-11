-- P20 authenticated online workspace read boundary.
-- Server-only: the Edge Function supplies the verified subject. Browser roles
-- retain zero direct access to ams_private and cannot call this RPC.

create or replace function api.p20_list_projects(p_user_id uuid)
returns jsonb
language sql
security definer
set search_path = ams_private, pg_catalog
stable
as $$
  select coalesce(jsonb_agg(summary order by summary ->> 'updated_at' desc, summary ->> 'id'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', latest.project_id,
      'version', latest.project_version,
      'status', latest.status,
      'topic', latest.payload ->> 'topic',
      'objective', latest.payload ->> 'objective',
      'audience', latest.payload ->> 'audience',
      'channel', latest.payload ->> 'channel',
      'created_at', latest.payload ->> 'created_at',
      'updated_at', latest.payload ->> 'updated_at',
      'evidence_count', (select count(*) from ams_private.p19_evidence_records_v1 e where e.user_id = p_user_id and e.project_id = latest.project_id),
      'analysis_count', (select count(*) from ams_private.p19_analyses_v1 a where a.user_id = p_user_id and a.project_id = latest.project_id),
      'card_count', (select count(*) from ams_private.p19_knowledge_cards_v1 c where c.user_id = p_user_id and c.project_id = latest.project_id),
      'brief_status', (select b.brief_status from ams_private.p19_briefs_v1 b where b.user_id = p_user_id and b.project_id = latest.project_id order by b.brief_version desc, b.id limit 1),
      'has_handoff', exists(select 1 from ams_private.p19_handoff_packages_v1 h where h.user_id = p_user_id and h.project_id = latest.project_id)
    ) as summary
    from (
      select distinct on (project_id) project_id, project_version, status, payload
      from ams_private.p19_research_projects_v1
      where user_id = p_user_id
      order by project_id, project_version desc, id
    ) latest
  ) rows;
$$;

revoke all on function api.p20_list_projects(uuid) from public, anon, authenticated;
grant execute on function api.p20_list_projects(uuid) to service_role;
comment on function api.p20_list_projects(uuid) is 'P20 server-only owner-scoped project summaries. Verified user subject is supplied by the Edge Function; browser roles have zero EXECUTE.';

create or replace function api.p20_import_project(
  p_user_id uuid,
  p_idempotency_key text,
  p_package jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ams_private, api, extensions, pg_catalog
as $$
declare
  v_project jsonb := p_package -> 'project';
  v_item jsonb;
  v_project_result jsonb;
  v_index integer := 0;
begin
  if p_package ->> 'schema_version' <> 'p19_project_package_v1'
    or jsonb_typeof(v_project) <> 'object'
    or v_project ->> 'id' !~ '^prj-[0-9a-f]{24}$'
    or v_project ->> 'status' <> 'active'
    or jsonb_typeof(p_package -> 'evidence') <> 'array'
    or jsonb_typeof(p_package -> 'analyses') <> 'array'
    or jsonb_typeof(p_package -> 'knowledge_cards') <> 'array'
  then
    raise exception using errcode = 'P0001', message = 'P20_IMPORT_PACKAGE_INVALID';
  end if;

  v_project_result := api.p19_apply_entity_write(
    p_user_id, p_idempotency_key || ':project', 'project.import', 'project', v_project ->> 'id',
    jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint'),
    'p19_research_projects_v1', v_project, null, null, null
  );

  for v_item in select value from jsonb_array_elements(p_package -> 'evidence')
  loop
    v_index := v_index + 1;
    perform api.p19_apply_entity_write(
      p_user_id, p_idempotency_key || ':e:' || v_index, 'project.import', 'evidence', v_item ->> 'id',
      jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint', 'index', v_index),
      'p19_evidence_records_v1', v_item, null, null, null
    );
  end loop;

  v_index := 0;
  for v_item in select value from jsonb_array_elements(p_package -> 'analyses')
  loop
    v_index := v_index + 1;
    perform api.p19_apply_entity_write(
      p_user_id, p_idempotency_key || ':a:' || v_index, 'project.import', 'analysis', v_item ->> 'id',
      jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint', 'index', v_index),
      'p19_analyses_v1', v_item, null, null, null
    );
  end loop;

  v_index := 0;
  for v_item in select value from jsonb_array_elements(p_package -> 'knowledge_cards')
  loop
    v_index := v_index + 1;
    perform api.p19_apply_entity_write(
      p_user_id, p_idempotency_key || ':c:' || v_index, 'project.import', 'card', v_item ->> 'id',
      jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint', 'index', v_index),
      'p19_knowledge_cards_v1', v_item, null, null, null
    );
  end loop;

  if jsonb_typeof(p_package -> 'brief') = 'object' then
    v_item := p_package -> 'brief';
    perform api.p19_apply_entity_write(
      p_user_id, p_idempotency_key || ':brief', 'project.import', 'brief', v_item ->> 'id',
      jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint'),
      'p19_briefs_v1', v_item, null, null, null
    );
  end if;

  if jsonb_typeof(p_package -> 'handoff') = 'object' then
    v_item := p_package -> 'handoff';
    perform api.p19_apply_entity_write(
      p_user_id, p_idempotency_key || ':handoff', 'project.import', 'handoff', v_item ->> 'id',
      jsonb_build_object('package_fingerprint', p_package ->> 'fingerprint'),
      'p19_handoff_packages_v1', v_item, null, null, null
    );
  end if;

  return jsonb_build_object(
    'outcome', coalesce(v_project_result ->> 'outcome', 'applied'),
    'entity', jsonb_build_object('type', 'project', 'id', v_project ->> 'id'),
    'ledger', v_project_result -> 'ledger',
    'applied_at', clock_timestamp()
  );
exception
  when raise_exception then
    if sqlerrm = 'P19_PROJECT_REVISION_STALE' then
      raise exception using errcode = 'P0001', message = 'P20_IMPORT_PROJECT_COLLISION';
    end if;
    raise;
end;
$$;

revoke all on function api.p20_import_project(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function api.p20_import_project(uuid, text, jsonb) to service_role;
comment on function api.p20_import_project(uuid, text, jsonb) is 'P20 server-only atomic import of one fully validated active P19 package. Exact identity is preserved; collisions fail closed.';
