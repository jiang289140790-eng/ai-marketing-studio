# Migration Production Plan

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Latest update: Phase 2.8

## Goal

A new empty Supabase database should be able to execute all migrations in timestamp order without failing on duplicate schema objects.

## Current static-check status

The migration chain is now static-check safe for duplicate object creation.

Latest `npm run migrations:check` result:

| Risk type | Duplicate groups | Unsafe groups | Current impact |
| --- | ---: | ---: | --- |
| `CREATE TABLE` | 22 | 0 | Safe at static-check level; duplicates use `IF NOT EXISTS`. |
| `CREATE INDEX` | 93 | 0 | Safe at static-check level; duplicates use `IF NOT EXISTS`. |
| `CREATE POLICY` | 82 | 0 | Safe at static-check level; duplicate policies are guarded with `pg_policies`. |

## Production-safe strategy used

History-preserving idempotency.

Historical migration files were not deleted. Duplicate policy creation was guarded in-place.

Guard pattern:

```sql
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'table_name'
      and policyname = 'policy_name'
  ) then
    create policy "policy_name" on public.table_name
      for select to authenticated
      using ((select auth.uid()) = user_id);
  end if;
end $$;
```

## Required validation sequence

1. Run static migration check:

```bash
npm run migrations:check
```

Expected:

```text
Overall status: safe
Unsafe duplicate policies: 0
Unsafe duplicate tables: 0
Unsafe duplicate indexes: 0
```

2. Run local clean replay:

```bash
supabase db reset --local --no-seed
```

Requires Docker Desktop.

3. Run disposable remote clean replay:

```bash
supabase db push
```

Use a temporary Supabase project, not production.

4. Run Supabase validation:

- Auth login
- CRUD
- RLS two-user isolation
- Storage upload
- Dashboard real data read

## Current clean replay status

Static migration checker: passed.

Local Supabase replay: not executed successfully because Docker Desktop is unavailable in the current environment.

Remote disposable Supabase replay: not executed because production Supabase variables are not configured.

## Supabase 2026 Data API note

Supabase has announced that new public tables may not be automatically exposed to the Data API by default. Because this app uses `supabase-js`, production migrations must include explicit `GRANT` statements for browser-accessible tables.

This repo already includes grants for many authenticated tables, but the clean replay test should confirm Data API access after migrations.

Source: Supabase changelog, “Breaking Change: Tables not exposed to Data and GraphQL API automatically”, April 28, 2026.

## Current conclusion

The RLS duplicate policy blocker is repaired at static-check level. The next step is not feature development; it is real Supabase clean replay and production validation.

