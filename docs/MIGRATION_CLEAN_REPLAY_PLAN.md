# Migration Clean Replay Plan

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Goal

Verify whether a brand-new empty database can apply every file in `supabase/migrations` in timestamp order.

## Attempted execution

Command attempted:

```bash
supabase db reset --local --no-seed --debug
```

Result:

The local clean replay could not run because Docker Desktop is not available/running in the current environment.

Observed error:

```text
failed to inspect service: error during connect ... dockerDesktopLinuxEngine ... The system cannot find the file specified.
Docker Desktop is a prerequisite for local development.
```

No remote Supabase database was modified.

## Static audit result

The migration chain is not safe to consider clean-replay-ready yet.

The main issue is not repeated tables or indexes. The main blocker is repeated RLS policy creation.

## Duplicate `CREATE TABLE`

Repeated tables were found, but each repeated table creation uses `IF NOT EXISTS`, so these are usually safe during replay.

Affected tables include:

- `agent_tasks`
- `agents`
- `audit_logs`
- `automation_jobs`
- `automation_runs`
- `campaign_links`
- `characters`
- `collection_runs`
- `collection_tasks`
- `competitor_accounts`
- `content_analysis`
- `content_metrics`
- `content_sources`
- `content_strategies`
- `cost_records`
- `notifications`
- `platform_connections`
- `platform_credentials`
- `prompts`
- `publish_metrics`
- `viral_contents`
- `workflow_runs`

Impact:

- Low to medium.
- Mostly safe because `CREATE TABLE IF NOT EXISTS` is used.
- Still confusing because the initial schema acts like a full baseline while later migrations also act like feature migrations.

## Duplicate `CREATE INDEX`

Repeated indexes were found, but the migration files generally use `CREATE INDEX IF NOT EXISTS`.

Impact:

- Low.
- Should not block replay if every duplicate uses `IF NOT EXISTS`.

## Duplicate `ALTER TABLE`

Repeated `ALTER TABLE` is expected in a long-running schema. Most additions use `ADD COLUMN IF NOT EXISTS` or drop/recreate constraints intentionally.

Impact:

- Medium.
- Constraint changes should be reviewed during clean replay because repeated `ADD CONSTRAINT` without `IF NOT EXISTS` can fail unless preceded by a safe `DROP CONSTRAINT IF EXISTS`.

## Duplicate `CREATE POLICY`

This is the main blocker.

Duplicate plain `CREATE POLICY` statements were found for many tables. PostgreSQL does not support `CREATE POLICY IF NOT EXISTS`. If the same policy name already exists, replay fails.

High-risk duplicated policy groups:

- `characters_*_own`
- `prompts_*_own`
- `workflow_runs_*_own`
- `agents_*_own`
- `agent_tasks_*_own`
- `competitor_accounts_*_own`
- `viral_contents_*_own`
- `content_analysis_*_own`
- `content_sources_*_own`
- `collection_tasks_*_own`
- `collection_runs_*_own`
- `automation_jobs_*_own`
- `automation_runs_*_own`
- `platform_connections_*_own`
- `content_metrics_*_own`
- `publish_metrics_*_own`
- `content_strategies_*_own`
- `campaign_links_*_own`
- `notifications_*_own`
- `cost_records_*_own`
- `audit_logs_*_own`

Impact:

- High.
- A clean empty-database replay is likely to fail after the initial migration creates a policy and a later migration tries to create the same policy again.

## Supabase platform note

Supabase announced a 2026 breaking change where new public tables may not be automatically exposed to the Data API and explicit grants can be required. This project already includes several `GRANT ... TO authenticated` statements, but every user-facing table should still be checked after clean replay.

Reference:

- Supabase changelog: `Breaking Change: Tables not exposed to Data and GraphQL API automatically`, April 28, 2026.

## Recommended fix approach

Do not delete historical migrations.

Recommended safe path:

1. Keep all migration files.
2. Patch duplicated policy creation in older feature migrations.
3. For every repeated policy, use a guarded block:

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

4. Re-run `supabase db reset --local --no-seed` after Docker Desktop is available.
5. If local replay passes, run the same migration chain on a temporary Supabase project.
6. Only then apply to the real production project.

## Suggested priority

Patch in this order:

1. `202607190003_content_asset_system.sql`
2. `202607190004_workflow_runtime_center.sql`
3. `20260719081338_agent_dispatch_center.sql`
4. `20260719082436_content_intelligence_center.sql`
5. `20260719083243_social_intelligence_collector.sql`
6. `20260719083854_automation_orchestrator.sql`
7. `20260719090441_social_platform_integration_base.sql`
8. `20260719092038_content_performance_analytics.sql`
9. `20260719093509_telegram_feedback_conversion_loop.sql`
10. `20260719094321_production_stability_hardening.sql`

## Current conclusion

Database clean replay is not verified and should be treated as blocked until:

- Docker Desktop or a disposable Supabase project is available.
- Duplicate RLS policy creation is guarded.
- Full ordered migration replay succeeds.

