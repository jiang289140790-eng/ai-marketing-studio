# RLS Policy Repair Report

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Repair date: 2026-07-19

## Goal

Fix migration clean replay failure risk caused by duplicate `CREATE POLICY` statements.

## Repair approach

Historical migrations were not deleted.

Every plain `CREATE POLICY` statement was wrapped with a guarded `pg_policies` check:

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
      ...
  end if;
end $$;
```

For storage policies, the guard uses `schemaname = 'storage'`.

## Files changed

Policy guards were added in:

- `202607190001_initial_schema.sql`
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

## Before repair

| Metric | Count |
| --- | ---: |
| `CREATE POLICY` statements | 200 |
| Duplicate policy groups | 82 |
| Unsafe duplicate policy groups | 82 |
| Guarded policy statements detected by checker | 9 |

## After repair

| Metric | Count |
| --- | ---: |
| `CREATE POLICY` statements | 200 |
| Guarded policy statements | 200 |
| Ordinary unguarded policy statements | 0 |
| Dynamic policy SQL statements | 0 |
| Duplicate policy groups | 82 |
| Unsafe duplicate policy groups | 0 |

## Validation

Command:

```bash
npm run migrations:check
```

Result:

```text
Overall status: safe
No unsafe duplicate CREATE POLICY / CREATE TABLE / CREATE INDEX statements detected.
```

## Scope protection

This repair did not:

- add new tables,
- add new product modules,
- add Stripe,
- add Billing,
- add Subscription,
- add Membership,
- add SaaS functionality,
- change the intended user ownership logic of RLS policies.

## Remaining risk

Static migration checks now pass, but a real clean replay still needs to be executed with:

- Docker Desktop local Supabase, or
- a disposable Supabase project.

The current environment still cannot run `supabase db reset --local` because Docker Desktop is unavailable.

