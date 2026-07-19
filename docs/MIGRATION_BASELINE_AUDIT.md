# Migration Baseline Audit

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Result

The migration folder is not yet safe to treat as a clean production baseline.

The current history mixes a large cumulative initial schema file with later feature migrations. Many later migrations recreate tables and policies that already exist in `202607190001_initial_schema.sql`. This is workable only if every duplicated statement is fully idempotent. At the moment, duplicated `create table if not exists` statements are mostly safe, but duplicated plain `create policy` statements are a production risk because PostgreSQL does not allow creating an existing policy with the same name.

## Migration order found

1. `202607190001_initial_schema.sql`
2. `202607190002_workspace_taxonomy_upgrade.sql`
3. `202607190003_content_asset_system.sql`
4. `202607190004_workflow_runtime_center.sql`
5. `20260719081338_agent_dispatch_center.sql`
6. `20260719082436_content_intelligence_center.sql`
7. `20260719083243_social_intelligence_collector.sql`
8. `20260719083854_automation_orchestrator.sql`
9. `20260719085024_automation_real_runner.sql`
10. `20260719085554_telegram_collector_adapter.sql`
11. `20260719090441_social_platform_integration_base.sql`
12. `20260719091213_publish_center_base.sql`
13. `20260719092038_content_performance_analytics.sql`
14. `20260719093509_telegram_feedback_conversion_loop.sql`
15. `20260719094321_production_stability_hardening.sql`
16. `20260719104342_personal_ops_phase2_foundation.sql`

## Duplicate schema creation risk

Duplicate table creation was found for:

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

Most duplicate table statements use `create table if not exists`, so table creation itself is unlikely to fail. The bigger issue is that the initial migration already contains many later-module tables, while later migrations also try to create those same tables and policies.

## Focus table status

| Area | Status | Notes |
| --- | --- | --- |
| `social_accounts` | Acceptable | Created once in initial schema, then safely altered in Phase 2. |
| `content_library` | Acceptable with caution | Created once, then altered repeatedly. Phase 2 status and pipeline fields are additive/idempotent. |
| `agent_runs` | Acceptable | Created once in Phase 2 foundation with guarded policies. |
| `cost_records` | Risk | Exists in the initial schema and is created again in production hardening. |
| `tool_usage` | Acceptable | Created once in Phase 2 foundation with guarded policies. |
| `viral_contents` | Risk | Exists in initial schema and is created again in Content Intelligence migration. |
| `content_analysis` | Risk | Exists in initial schema and is created again in Content Intelligence migration. |

## Policy execution risk

Several older migrations create RLS policies with plain `create policy`. If the initial schema has already created the same policy names, applying the later migration can fail with a duplicate policy error.

The newer Phase 2 foundation migration uses guarded `do $$ begin if not exists (...) then create policy ... end if; end $$;` blocks for new policy definitions. Older migrations should be normalized the same way before production replay.

## Production impact

- A brand-new Supabase project may fail during migration replay if duplicate policies are encountered.
- A partially migrated project may be hard to reason about because the initial schema already includes tables that are also introduced by later feature migrations.
- RLS behavior is conceptually correct for personal data isolation, but production confidence requires applying the full migration chain on a clean Supabase project.

## Recommended fix without deleting history

Do not delete historical migrations.

Recommended path:

1. Create a temporary Supabase project only for migration replay.
2. Apply migrations in timestamp order.
3. If a duplicate policy fails, patch the historical migration by wrapping the policy creation in an existence check.
4. Keep `202607190001_initial_schema.sql` as the current baseline, but mark later duplicated migrations as compatibility migrations once they are fully idempotent.
5. Before real production launch, run a clean replay again and save the successful migration output in this report.

## Current conclusion

Migration baseline is not production-ready until the duplicate policy replay risk is tested and normalized.

