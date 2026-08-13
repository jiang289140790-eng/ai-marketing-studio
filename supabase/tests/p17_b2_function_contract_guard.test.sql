-- P17-B2：P17-A4 函数语义合同守卫的正反对抗测试。
--
-- 比较逻辑（p17_normalize_search_path / p17_normalize_body /
-- p17_contract_matches）不是人工复制：每个 helper 被哨兵注释块包裹
-- （-- @p17-helper-migration: <name>@BEGIN / @END）。集成测试
-- test/p19-sql-integration.test.mjs 在回放时从迁移
-- 20260810143859_p17_reconcile_out_of_band_foundations.sql 中提取实装并替换
-- 哨兵块（同源注入：本测试实际执行的就是迁移使用的实现），同时做字节级漂移
-- 检测——镜像与迁移 helper 不一致时测试失败（防「迁移和复制测试一起犯同一
-- 错误」仍绿灯）。直接以 psql -f 独立运行本文件时使用哨兵块内的镜像，该镜像
-- 与迁移实装一致，且由集成测试的漂移检测兜底。
--
-- 覆盖（P17-A4 返修后的对抗要求）：
--   + 正例：quoted-empty search_path（set search_path to ''，PostgreSQL 17
--     目录表示 search_path=""）与显式空合同等价；缺失与 public/其他真实路径
--     绝不得归一为空；关键字大小写/注释（含嵌套块注释）/空白/不同美元引用
--     标签等价。
--   - 负例：函数体、search_path（缺失/public/pg_catalog/空对非空）、字符串
--     字面量大小写、字符串内 -- 与 /* */ 样式文本、quoted identifier 大小写、
--     美元引用串内容、security definer、volatility、额外 GUC 设置、权限
--     合同、签名、返回类型漂移必须失败关闭。
--
-- 全部在单个事务内执行并以 rollback 收尾，不触碰真实业务对象（scratch
-- schema p17_adv 随事务回滚消失）。

begin;

create function pg_temp.assert_true(ok boolean, message text) returns void
language plpgsql as $$ begin if ok is not true then raise exception 'P17_B2_ASSERT: %', message; end if; end $$;

-- ---- 迁移比较逻辑的镜像（哨兵块；p19-sql-integration.test.mjs 提取迁移实装
-- 替换以下三块并做字节级漂移检测，见该文件 extractMigrationHelper/injectMigrationHelpers）----

-- @p17-helper-migration: p17_normalize_search_path@BEGIN
create or replace function pg_temp.p17_normalize_search_path(setting text)
returns text
language sql
immutable
as $function$
  select coalesce((select string_agg(trim(x), ',' order by ord)
    from unnest(string_to_array(coalesce(setting, ''), ',')) with ordinality as t(x, ord)
    where trim(x) <> '' and trim(x) <> '""'), '');
$function$;
-- @p17-helper-migration: p17_normalize_search_path@END

-- @p17-helper-migration: p17_normalize_body@BEGIN
create or replace function pg_temp.p17_normalize_body(body text)
returns text
language plpgsql
immutable
as $function$
declare
  b text := coalesce(body, '');
  n int := length(b);
  i int := 1;
  j int;
  k int;
  depth int;
  tag text;
  out text := '';
begin
  while i <= n loop
    -- whitespace run -> single space
    if substr(b, i, 1) ~ '[[:space:]]' then
      while i <= n and substr(b, i, 1) ~ '[[:space:]]' loop
        i := i + 1;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- line comment -> single space
    if substr(b, i, 1) = '-' and substr(b, i + 1, 1) = '-' then
      while i <= n and substr(b, i, 1) <> chr(10) loop
        i := i + 1;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- block comment (nested) -> single space
    if substr(b, i, 1) = '/' and substr(b, i + 1, 1) = '*' then
      depth := 0;
      while i <= n loop
        if substr(b, i, 1) = '/' and substr(b, i + 1, 1) = '*' then
          depth := depth + 1;
          i := i + 2;
        elsif substr(b, i, 1) = '*' and substr(b, i + 1, 1) = '/' then
          depth := depth - 1;
          i := i + 2;
          exit when depth = 0;
        else
          i := i + 1;
        end if;
      end loop;
      if out <> '' and substr(out, length(out), 1) <> ' ' then
        out := out || ' ';
      end if;
      continue;
    end if;
    -- dollar-quoted string: $tag$ ... $tag$ (tag optional) -> verbatim
    if substr(b, i, 1) = '$' then
      j := i + 1;
      while j <= n and substr(b, j, 1) ~ '[A-Za-z0-9_]' loop
        j := j + 1;
      end loop;
      if j <= n and substr(b, j, 1) = '$' then
        tag := substr(b, i, j - i + 1);
        k := j + 1;
        while k <= n - length(tag) + 1 and substr(b, k, length(tag)) <> tag loop
          k := k + 1;
        end loop;
        if k <= n - length(tag) + 1 then
          out := out || substr(b, i, k + length(tag) - i);
          i := k + length(tag);
          continue;
        end if;
      end if;
      -- not a dollar-quote opener: fall through, the '$' stays verbatim
    end if;
    -- single-quoted string: '...' with '' escape (backslash escape in E'...')
    if substr(b, i, 1) = '''' then
      j := i + 1;
      while j <= n loop
        if substr(b, j, 1) = '\' then
          j := j + 2;
        elsif substr(b, j, 1) = '''' then
          if substr(b, j + 1, 1) = '''' then
            j := j + 2;
          else
            exit;
          end if;
        else
          j := j + 1;
        end if;
      end loop;
      if j <= n then
        out := out || substr(b, i, j - i + 1);
        i := j + 1;
        continue;
      end if;
      -- unterminated string: keep the quote verbatim and rescan
    end if;
    -- double-quoted identifier: "..." with "" escape -> verbatim
    if substr(b, i, 1) = '"' then
      j := i + 1;
      while j <= n loop
        if substr(b, j, 1) = '"' then
          if substr(b, j + 1, 1) = '"' then
            j := j + 2;
          else
            exit;
          end if;
        else
          j := j + 1;
        end if;
      end loop;
      if j <= n then
        out := out || substr(b, i, j - i + 1);
        i := j + 1;
        continue;
      end if;
    end if;
    -- unquoted word (keyword / unquoted identifier) -> lowercase
    if substr(b, i, 1) ~ '[A-Za-z_]' then
      j := i + 1;
      while j <= n and substr(b, j, 1) ~ '[A-Za-z0-9_$]' loop
        j := j + 1;
      end loop;
      out := out || lower(substr(b, i, j - i));
      i := j;
      continue;
    end if;
    -- anything else (operators, digits, punctuation): verbatim
    out := out || substr(b, i, 1);
    i := i + 1;
  end loop;
  return btrim(out);
end
$function$;
-- @p17-helper-migration: p17_normalize_body@END

-- @p17-helper-migration: p17_contract_matches@BEGIN
create or replace function pg_temp.p17_contract_matches(
  target regprocedure,
  p_identity text,
  p_result text,
  p_language text,
  p_security_definer boolean,
  p_leakproof boolean,
  p_volatility text,
  p_parallel text,
  p_search_path text,
  p_body text,
  p_execute_roles text[]
) returns text[]
language plpgsql
set search_path = pg_catalog, public, extensions
as $function$
declare
  p pg_proc;
  l pg_language;
  mismatches text[] := '{}'::text[];
  setting text;
  setting_name text;
  found_search_path boolean := false;
  actual_search_path text := null;
  role_name text;
begin
  if target is null then
    return array['function missing'];
  end if;
  select * into p from pg_proc where oid = target;
  if not found then
    return array['function missing'];
  end if;
  select * into l from pg_language where oid = p.prolang;
  if pg_get_function_identity_arguments(p.oid) is distinct from p_identity then
    mismatches := mismatches || format('signature: got [%s] want [%s]', pg_get_function_identity_arguments(p.oid), p_identity);
  end if;
  if pg_get_function_result(p.oid) is distinct from p_result then
    mismatches := mismatches || format('result: got [%s] want [%s]', pg_get_function_result(p.oid), p_result);
  end if;
  if l.lanname is distinct from p_language then
    mismatches := mismatches || format('language: got [%s] want [%s]', l.lanname, p_language);
  end if;
  if p.prosecdef is distinct from p_security_definer then
    mismatches := mismatches || format('security_definer: got [%s] want [%s]', p.prosecdef, p_security_definer);
  end if;
  if p.proleakproof is distinct from p_leakproof then
    mismatches := mismatches || format('leakproof: got [%s] want [%s]', p.proleakproof, p_leakproof);
  end if;
  if p.provolatile::text is distinct from p_volatility then
    mismatches := mismatches || format('volatility: got [%s] want [%s]', p.provolatile::text, p_volatility);
  end if;
  if p.proparallel::text is distinct from p_parallel then
    mismatches := mismatches || format('parallel: got [%s] want [%s]', p.proparallel::text, p_parallel);
  end if;
  foreach setting in array coalesce(p.proconfig, '{}'::text[]) loop
    setting_name := split_part(setting, '=', 1);
    if setting_name = 'search_path' then
      found_search_path := true;
      actual_search_path := substring(setting from length('search_path=') + 1);
    else
      mismatches := mismatches || format('unexpected setting [%s]', setting_name);
    end if;
  end loop;
  if not found_search_path then
    mismatches := mismatches || format('search_path: not explicitly set, want [%s]', p_search_path);
  elsif pg_temp.p17_normalize_search_path(actual_search_path)
        is distinct from pg_temp.p17_normalize_search_path(p_search_path) then
    mismatches := mismatches || format('search_path: got [%s] want [%s]',
      pg_temp.p17_normalize_search_path(actual_search_path), pg_temp.p17_normalize_search_path(p_search_path));
  end if;
  if pg_temp.p17_normalize_body(p.prosrc) is distinct from p_body then
    mismatches := mismatches || format('body: got [%s] want [%s]', pg_temp.p17_normalize_body(p.prosrc), p_body);
  end if;
  foreach role_name in array coalesce(p_execute_roles, '{}'::text[]) loop
    if role_name <> 'public' and not has_function_privilege(role_name, p.oid, 'EXECUTE') then
      mismatches := mismatches || format('permission: role [%s] cannot execute', role_name);
    end if;
  end loop;
  if 'public' = any(coalesce(p_execute_roles, '{}'::text[]))
     and not exists (
       select 1 from pg_proc q where q.oid = p.oid and (
         q.proacl is null or exists (select 1 from aclexplode(q.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
       )
     ) then
    mismatches := mismatches || 'permission: PUBLIC cannot execute';
  end if;
  return mismatches;
end
$function$;
-- @p17-helper-migration: p17_contract_matches@END

-- ---- 测试载体：scratch schema（事务回滚后整体消失）----

create schema if not exists p17_adv;

create function p17_adv.canonical(x integer) returns integer
language sql stable set search_path to pg_catalog, public
as $$ select x + 1 $$;

do $do$
declare
  canonical regprocedure := 'p17_adv.canonical(integer)'::regprocedure;
  identity_t text; result_t text; volatility_t text; parallel_t text;
  search_t text; body_t text; mismatches text[];
begin
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = canonical;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = canonical;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = canonical;

  -- 基线自检：canonical 与自身合同必须完全匹配。
  mismatches := pg_temp.p17_contract_matches(canonical, identity_t, result_t, 'sql', false, false,
    volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(array_length(mismatches, 1) is null,
    'canonical must match its own contract: '||coalesce(array_to_string(mismatches,'; '),''));

  -- 1) 正例：等价格式差异（注释、大小写、空白、不同美元引用标签）必须通过。
  create function p17_adv.format_variant(x integer) returns integer
  language sql stable set search_path to pg_catalog, public
  as $q$
    -- 仅格式差异：注释 + 大小写 + 空白
    SELECT    x + 1
  $q$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.format_variant(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(array_length(mismatches, 1) is null,
    'formatting-equivalent body must pass: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.format_variant(integer);

  -- 2) 负例：函数体语义漂移（x+1 -> x+2）必须失败关闭。
  create function p17_adv.body_drift(x integer) returns integer
  language sql stable set search_path to pg_catalog, public
  as $$ select x + 2 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.body_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and mismatches[1] like 'body%',
    'body drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.body_drift(integer);

  -- 3) 负例：search_path 漂移（改为 public）必须失败关闭。
  create function p17_adv.sp_drift(x integer) returns integer
  language sql stable set search_path to public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sp_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%search_path%',
    'search_path drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sp_drift(integer);

  -- 4) 负例：security definer 漂移必须失败关闭。
  create function p17_adv.sec_drift(x integer) returns integer
  language sql stable security definer set search_path to pg_catalog, public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sec_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%security_definer%',
    'security definer drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sec_drift(integer);

  -- 5) 负例：volatility 漂移（stable -> immutable）必须失败关闭。
  create function p17_adv.vol_drift(x integer) returns integer
  language sql immutable set search_path to pg_catalog, public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.vol_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%volatility%',
    'volatility drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.vol_drift(integer);

  -- 6) 负例：额外 GUC 设置（statement_timeout）必须失败关闭。
  create function p17_adv.set_drift(x integer) returns integer
  language sql stable set search_path to pg_catalog, public set statement_timeout to 1000
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.set_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%unexpected setting%',
    'extra GUC setting drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.set_drift(integer);

  -- 7) 负例：权限合同漂移（撤销 PUBLIC 执行权 → anon/authenticated/service_role
  --    失去执行权）必须失败关闭。
  create function p17_adv.perm_drift(x integer) returns integer
  language sql stable set search_path to pg_catalog, public
  as $$ select x + 1 $$;
  revoke execute on function p17_adv.perm_drift(integer) from public;
  mismatches := pg_temp.p17_contract_matches('p17_adv.perm_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t,
    '{postgres,anon,authenticated,service_role}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%permission%',
    'permission drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.perm_drift(integer);

  -- 8) 负例：签名漂移（参数类型 integer -> bigint）必须失败关闭。
  create function p17_adv.sig_drift(x bigint) returns integer
  language sql stable set search_path to pg_catalog, public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sig_drift(bigint)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%signature%',
    'signature drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sig_drift(bigint);

  -- 9) 负例：返回类型漂移（integer -> bigint）必须失败关闭。
  create function p17_adv.res_drift(x integer) returns bigint
  language sql stable set search_path to pg_catalog, public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.res_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%result%',
    'result type drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.res_drift(integer);

  -- 10) 负例：未显式设置 search_path（继承调用方）不能与显式 search_path
  --     合同视为相同，必须失败关闭。
  create function p17_adv.no_sp(x integer) returns integer
  language sql stable
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.no_sp(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%search_path%',
    'missing explicit search_path must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.no_sp(integer);

  -- 11) search_path 规范化单元：quoted-empty（PostgreSQL 17 目录表示
  --     search_path=""）与空合同等价；public 等其他真实路径绝不归一为空。
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('""') = '',
    'quoted-empty must normalize to empty, got ['||pg_temp.p17_normalize_search_path('""')||']');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('') = '',
    'bare-empty must normalize to empty');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('pg_catalog, ""') = 'pg_catalog',
    'quoted-empty element must drop out of a list');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('"",pg_catalog') = 'pg_catalog',
    'leading quoted-empty element must drop out of a list');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path(null) = '',
    'null must normalize to empty');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('public') = 'public',
    'public must never normalize to empty');
  perform pg_temp.assert_true(pg_temp.p17_normalize_search_path('pg_catalog,public') = 'pg_catalog,public',
    'real paths must survive normalization');

  -- 12) 正例（P17-A4 返修缺陷回归）：set search_path to '' 在 PostgreSQL 17
  --     的目录表示是 search_path=""，必须匹配显式空合同。
  create function p17_adv.sp_empty_ok(x integer) returns integer
  language sql stable set search_path to ''
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sp_empty_ok(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, '', body_t, '{}'::text[]);
  perform pg_temp.assert_true(array_length(mismatches, 1) is null,
    'quoted-empty search_path must match the explicit-empty contract: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sp_empty_ok(integer);

  -- 13) 负例：public / pg_catalog 等其他路径不得满足显式空合同；显式空实际
  --     路径不得满足非空合同。
  create function p17_adv.sp_public_wrong(x integer) returns integer
  language sql stable set search_path to public
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sp_public_wrong(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, '', body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%search_path%',
    'public must not satisfy the empty search_path contract: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sp_public_wrong(integer);
  create function p17_adv.sp_catalog_wrong(x integer) returns integer
  language sql stable set search_path to pg_catalog
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sp_catalog_wrong(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, '', body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%search_path%',
    'pg_catalog must not satisfy the empty search_path contract: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sp_catalog_wrong(integer);
  create function p17_adv.sp_empty_wrong(x integer) returns integer
  language sql stable set search_path to ''
  as $$ select x + 1 $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.sp_empty_wrong(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, 'pg_catalog', body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%search_path%',
    'empty actual must not satisfy a non-empty search_path contract: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.sp_empty_wrong(integer);

  -- 14) body 规范化单元：关键字大小写/注释/空白等价；字符串字面量大小写、
  --     字符串内注释样式文本、quoted identifier 大小写、美元引用串内容的
  --     语义差异必须保留（fail-closed）。
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select x from t') = pg_temp.p17_normalize_body('SELECT x FROM t'),
    'keyword case must be equivalent');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select /* c */ x') = pg_temp.p17_normalize_body('select x'),
    'block comment must be equivalent');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select -- c'||chr(10)||' x') = pg_temp.p17_normalize_body('select x'),
    'line comment must be equivalent');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select /* a /* b */ c */ x') = pg_temp.p17_normalize_body('select x'),
    'nested block comment must be equivalent');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select ''x'' -- ''q''') = pg_temp.p17_normalize_body('select ''x'''),
    'comment after a string must be equivalent (stray quote inside comment)');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select ''A''') <> pg_temp.p17_normalize_body('select ''a'''),
    'string literal case must be preserved');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select ''a -- b''') <> pg_temp.p17_normalize_body('select ''a -- B'''),
    'line-comment-like text inside a string must be preserved');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select ''a /* b */''') <> pg_temp.p17_normalize_body('select ''a /* B */'''),
    'block-comment-like text inside a string must be preserved');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select "ColA"') <> pg_temp.p17_normalize_body('select "colA"'),
    'quoted identifier case must be preserved');
  perform pg_temp.assert_true(pg_temp.p17_normalize_body('select $q$ABC$q$') <> pg_temp.p17_normalize_body('select $q$abc$q$'),
    'dollar-quoted string content must be preserved');

  -- 15) 负例（合同级）：字符串字面量大小写、字符串内注释样式文本、quoted
  --     identifier 大小写、美元引用串内容的漂移必须失败关闭。每个基线函数
  --     都派生自己的合同（与漂移体仅差字面量内部语义）。
  create function p17_adv.str_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'A' $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.str_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.str_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.str_base(integer)'::regprocedure;
  create function p17_adv.str_drift(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'a' $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.str_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%body%',
    'string literal case drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.str_drift(integer);
  drop function p17_adv.str_base(integer);

  create function p17_adv.cmt_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'a -- B' $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.cmt_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.cmt_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.cmt_base(integer)'::regprocedure;
  create function p17_adv.cmt_drift(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'a -- b' $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.cmt_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%body%',
    'line-comment-like text inside string drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.cmt_drift(integer);
  drop function p17_adv.cmt_base(integer);

  create function p17_adv.blk_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'a /* B */' $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.blk_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.blk_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.blk_base(integer)'::regprocedure;
  create function p17_adv.blk_drift(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'a /* b */' $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.blk_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%body%',
    'block-comment-like text inside string drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.blk_drift(integer);
  drop function p17_adv.blk_base(integer);

  create function p17_adv.qid_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select t."ColA" from (values ('y')) as t("ColA") $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.qid_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.qid_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.qid_base(integer)'::regprocedure;
  create function p17_adv.qid_drift(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select t."colA" from (values ('y')) as t("colA") $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.qid_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%body%',
    'quoted identifier case drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.qid_drift(integer);
  drop function p17_adv.qid_base(integer);

  create function p17_adv.dq_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select $q$ABC$q$::text || x::text $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.dq_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.dq_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.dq_base(integer)'::regprocedure;
  create function p17_adv.dq_drift(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select $q$abc$q$::text || x::text $$;
  mismatches := pg_temp.p17_contract_matches('p17_adv.dq_drift(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%body%',
    'dollar-quoted string content drift must fail closed: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.dq_drift(integer);
  drop function p17_adv.dq_base(integer);

  -- 16) 负例（合同级）：parallel 漂移。language sql stable 且未声明
  --     parallel 的函数目录 proparallel 为 'u'；期望 's' 必须失败关闭，
  --     期望 'u'（目录实测值）必须通过。
  create function p17_adv.par_base(x integer) returns text
  language sql stable set search_path to pg_catalog, public
  as $$ select x::text || 'P' $$;
  select pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
         p.provolatile::text, p.proparallel::text
    into identity_t, result_t, volatility_t, parallel_t
    from pg_proc p where p.oid = 'p17_adv.par_base(integer)'::regprocedure;
  perform pg_temp.assert_true(parallel_t = 'u',
    'SQL STABLE without parallel declaration must catalog proparallel=u: '||parallel_t);
  select pg_temp.p17_normalize_search_path(coalesce((
           select substring(s from length('search_path=') + 1)
             from unnest(p.proconfig) s where s like 'search_path=%'), ''))
    into search_t
    from pg_proc p where p.oid = 'p17_adv.par_base(integer)'::regprocedure;
  select pg_temp.p17_normalize_body(p.prosrc) into body_t from pg_proc p where p.oid = 'p17_adv.par_base(integer)'::regprocedure;
  mismatches := pg_temp.p17_contract_matches('p17_adv.par_base(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, 's', search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(mismatches is not null and array_to_string(mismatches,'; ') like '%parallel%',
    'expected parallel s against u catalog must report parallel mismatch: '||coalesce(array_to_string(mismatches,'; '),''));
  mismatches := pg_temp.p17_contract_matches('p17_adv.par_base(integer)'::regprocedure,
    identity_t, result_t, 'sql', false, false, volatility_t, parallel_t, search_t, body_t, '{}'::text[]);
  perform pg_temp.assert_true(array_length(mismatches, 1) is null,
    'expected parallel u against u catalog must not report mismatch: '||coalesce(array_to_string(mismatches,'; '),''));
  drop function p17_adv.par_base(integer);
end
$do$;

rollback;
