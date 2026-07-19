# RLS Policy Audit

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19  
Latest update: Phase 2.8

## Scope

Scanned folder:

- `supabase/migrations`

Policy statement types checked:

- `CREATE POLICY`
- `ALTER POLICY`
- `DROP POLICY`
- dynamic SQL that appears to create policies

## Current summary

| Item | Count |
| --- | ---: |
| Migration files scanned | 16 |
| `CREATE POLICY` statements | 200 |
| Guarded `CREATE POLICY` statements | 200 |
| Ordinary unguarded `CREATE POLICY` statements | 0 |
| Dynamic policy SQL statements | 0 |
| `ALTER POLICY` statements | 0 |
| `DROP POLICY` statements | 0 |
| Duplicate policy groups | 82 |
| Unsafe duplicate policy groups | 0 |

## Main finding

The migration chain still contains duplicate policy names, but those duplicates are now guarded with `pg_policies` checks.

This means the duplicate policy names are no longer expected to block timestamp-order clean replay. The original RLS logic was preserved; only migration idempotency was added.

## Duplicate policy audit

| Table | Policy names | Created migrations | Duplicate risk after Phase 2.8 |
| --- | --- | --- | --- |
| `characters` | `characters_select_own`, `characters_insert_own`, `characters_update_own`, `characters_delete_own` | `202607190001_initial_schema.sql`, `202607190003_content_asset_system.sql` | Safe: guarded |
| `prompts` | `prompts_select_own`, `prompts_insert_own`, `prompts_update_own`, `prompts_delete_own` | `202607190001_initial_schema.sql`, `202607190003_content_asset_system.sql` | Safe: guarded |
| `workflow_runs` | `workflow_runs_select_own`, `workflow_runs_insert_own`, `workflow_runs_update_own`, `workflow_runs_delete_own` | `202607190001_initial_schema.sql`, `202607190004_workflow_runtime_center.sql` | Safe: guarded |
| `agents` | `agents_select_own`, `agents_insert_own`, `agents_update_own`, `agents_delete_own` | `202607190001_initial_schema.sql`, `20260719081338_agent_dispatch_center.sql` | Safe: guarded |
| `agent_tasks` | `agent_tasks_select_own`, `agent_tasks_insert_own`, `agent_tasks_update_own`, `agent_tasks_delete_own` | `202607190001_initial_schema.sql`, `20260719081338_agent_dispatch_center.sql` | Safe: guarded |
| `competitor_accounts` | `competitor_accounts_select_own`, `competitor_accounts_insert_own`, `competitor_accounts_update_own`, `competitor_accounts_delete_own` | `202607190001_initial_schema.sql`, `20260719082436_content_intelligence_center.sql` | Safe: guarded |
| `viral_contents` | `viral_contents_select_own`, `viral_contents_insert_own`, `viral_contents_update_own`, `viral_contents_delete_own` | `202607190001_initial_schema.sql`, `20260719082436_content_intelligence_center.sql` | Safe: guarded |
| `content_analysis` | `content_analysis_select_own`, `content_analysis_insert_own`, `content_analysis_update_own`, `content_analysis_delete_own` | `202607190001_initial_schema.sql`, `20260719082436_content_intelligence_center.sql` | Safe: guarded |
| `content_sources` | `content_sources_select_own`, `content_sources_insert_own`, `content_sources_update_own`, `content_sources_delete_own` | `202607190001_initial_schema.sql`, `20260719083243_social_intelligence_collector.sql` | Safe: guarded |
| `collection_tasks` | `collection_tasks_select_own`, `collection_tasks_insert_own`, `collection_tasks_update_own`, `collection_tasks_delete_own` | `202607190001_initial_schema.sql`, `20260719083243_social_intelligence_collector.sql` | Safe: guarded |
| `collection_runs` | `collection_runs_select_own`, `collection_runs_insert_own`, `collection_runs_update_own`, `collection_runs_delete_own` | `202607190001_initial_schema.sql`, `20260719083243_social_intelligence_collector.sql` | Safe: guarded |
| `automation_jobs` | `automation_jobs_select_own`, `automation_jobs_insert_own`, `automation_jobs_update_own`, `automation_jobs_delete_own` | `202607190001_initial_schema.sql`, `20260719083854_automation_orchestrator.sql` | Safe: guarded |
| `automation_runs` | `automation_runs_select_own`, `automation_runs_insert_own`, `automation_runs_update_own`, `automation_runs_delete_own` | `202607190001_initial_schema.sql`, `20260719083854_automation_orchestrator.sql` | Safe: guarded |
| `platform_connections` | `platform_connections_select_own`, `platform_connections_insert_own`, `platform_connections_update_own`, `platform_connections_delete_own` | `202607190001_initial_schema.sql`, `20260719090441_social_platform_integration_base.sql` | Safe: guarded |
| `content_metrics` | `content_metrics_select_own`, `content_metrics_insert_own`, `content_metrics_update_own`, `content_metrics_delete_own` | `202607190001_initial_schema.sql`, `20260719092038_content_performance_analytics.sql` | Safe: guarded |
| `publish_metrics` | `publish_metrics_select_own`, `publish_metrics_insert_own`, `publish_metrics_update_own`, `publish_metrics_delete_own` | `202607190001_initial_schema.sql`, `20260719092038_content_performance_analytics.sql` | Safe: guarded |
| `content_strategies` | `content_strategies_select_own`, `content_strategies_insert_own`, `content_strategies_update_own`, `content_strategies_delete_own` | `202607190001_initial_schema.sql`, `20260719092038_content_performance_analytics.sql` | Safe: guarded |
| `campaign_links` | `campaign_links_select_own`, `campaign_links_insert_own`, `campaign_links_update_own`, `campaign_links_delete_own` | `202607190001_initial_schema.sql`, `20260719093509_telegram_feedback_conversion_loop.sql` | Safe: guarded |
| `notifications` | `notifications_select_own`, `notifications_insert_own`, `notifications_update_own`, `notifications_delete_own` | `202607190001_initial_schema.sql`, `20260719094321_production_stability_hardening.sql` | Safe: guarded |
| `cost_records` | `cost_records_select_own`, `cost_records_insert_own`, `cost_records_update_own`, `cost_records_delete_own` | `202607190001_initial_schema.sql`, `20260719094321_production_stability_hardening.sql` | Safe: guarded |
| `audit_logs` | `audit_logs_select_own`, `audit_logs_insert_own` | `202607190001_initial_schema.sql`, `20260719094321_production_stability_hardening.sql` | Safe: guarded |

## Security notes

- The owner-policy pattern still uses `to authenticated` with `(select auth.uid()) = user_id`.
- UPDATE policies still include both `USING` and `WITH CHECK` where the original migration included them.
- No policy logic was intentionally changed in Phase 2.8.
- The repair was limited to migration idempotency.

## Current conclusion

RLS policy duplicate-name risk is repaired at static-check level. A real clean replay still requires Docker Desktop or a disposable Supabase project.

