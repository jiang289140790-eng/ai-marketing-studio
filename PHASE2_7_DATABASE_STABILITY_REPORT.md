# Phase 2.7 Database Stability Report

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Summary

Phase 2.7 focused only on database migration reliability.

No Stripe, Billing, Subscription, Membership, Pricing, or SaaS feature was added.

## Completed

- Created a full RLS policy audit:
  - `docs/RLS_POLICY_AUDIT.md`
- Created a production migration strategy:
  - `docs/MIGRATION_PRODUCTION_PLAN.md`
- Added a migration risk checker:
  - `scripts/check-migrations.mjs`
- Added npm command:
  - `npm run migrations:check`
- Strengthened Supabase production validation checklist:
  - `docs/SUPABASE_PRODUCTION_VALIDATION.md`

## 1. Is migration risk resolved?

Current answer: Partially.

Resolved:

- Migration risk is now detectable by script.
- Duplicate table/index/policy risk is documented.
- Production-safe strategy is documented.
- Supabase validation requirements are clearer.

Not yet resolved:

- Duplicate RLS policy creation still exists in historical migrations.
- `npm run migrations:check` correctly fails because unsafe duplicated policies remain.

Latest scan:

| Risk type | Duplicate groups | Unsafe groups | Status |
| --- | ---: | ---: | --- |
| `CREATE TABLE` | 22 | 0 | Safe enough for replay because duplicates are guarded. |
| `CREATE INDEX` | 93 | 0 | Safe enough for replay because duplicates are guarded. |
| `CREATE POLICY` | 82 | 82 | Not replay-safe yet. |

## 2. Does the migration chain support clean replay?

Current answer: No.

Reason:

PostgreSQL does not support `CREATE POLICY IF NOT EXISTS`. The migration chain has repeated plain `CREATE POLICY` statements. A clean empty database replay is expected to fail when a later migration tries to create a policy that was already created by `202607190001_initial_schema.sql`.

Local replay status:

- `supabase db reset --local --no-seed --debug` was attempted in Phase 2.6.
- It could not run because Docker Desktop was not available.
- No remote database was modified.

## 3. Required fix before production clean replay

Guard duplicated policy creation in-place.

Recommended pattern:

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

Files that need policy guard work:

- `202607190003_content_asset_system.sql`
- `202607190004_workflow_runtime_center.sql`
- `20260719081338_agent_dispatch_center.sql`
- `20260719082436_content_intelligence_center.sql`
- `20260719083243_social_intelligence_collector.sql`
- `20260719083854_automation_orchestrator.sql`
- `20260719090441_social_platform_integration_base.sql`
- `20260719092038_content_performance_analytics.sql`
- `20260719093509_telegram_feedback_conversion_loop.sql`
- `20260719094321_production_stability_hardening.sql`

## 4. Next real Supabase test steps

After policy guards are added and `npm run migrations:check` reports zero unsafe duplicates:

1. Start Docker Desktop.
2. Run:

```bash
supabase db reset --local --no-seed
```

3. If local replay passes, create a temporary Supabase project.
4. Configure:
   - `SUPABASE_PROJECT_REF`
   - `SUPABASE_ACCESS_TOKEN`
5. Push migrations to the temporary project.
6. Configure frontend:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
7. Run Supabase production validation:
   - Auth login
   - CRUD
   - RLS two-user isolation
   - Storage upload
   - Dashboard real data read

## 5. Current command results

| Command | Result |
| --- | --- |
| `npm run migrations:check` | Failed intentionally because 82 unsafe duplicate policy groups remain. |
| `npm run lint` | Passed. |
| `npm run build` | Passed. |
| `npm run setup:check` | Passed as a checklist command; reports missing required Supabase and Telegram production variables. |

## 6. Supabase platform note

Supabase's April 28, 2026 changelog says new public tables may need explicit grants before Data API access. This project already includes grants for many authenticated tables, but the clean replay test should verify browser Data API access after migration.

Source:

- Supabase changelog, “Breaking Change: Tables not exposed to Data and GraphQL API automatically”.

## Final conclusion

Phase 2.7 made the migration reliability problem measurable and production-actionable, but the database migration chain is not yet clean-replay-safe.

The next phase should be a focused migration patch pass: guard the 82 duplicated policy groups, rerun `npm run migrations:check`, then perform a real local or disposable Supabase clean replay.
