# Supabase Cloud Replay Result

Phase: 2.10 Cloud Supabase production validation

Project positioning: Personal AI Ops Workspace, not SaaS.

## Cloud project used

| Item | Value |
| --- | --- |
| Project name | `ai-marketing-studio-phase210-20260719193241` |
| Project ref | `xtkkdvghiohlnpfnnhmx` |
| Region | `us-east-1` |
| Status | `ACTIVE_HEALTHY` |
| Postgres version | `17.6.1` |

This was created as a temporary Cloud Supabase validation project.

## Migration replay

| Item | Result |
| --- | --- |
| Migration command | `supabase db push` |
| Migration count | 16 |
| Started | `2026-07-19T19:33:09.5055213+08:00` |
| Finished | `2026-07-19T19:33:41.0942475+08:00` |
| Duration | 31.59 seconds |
| Status | Passed |

Applied migration versions:

1. `202607190001_initial_schema`
2. `202607190002_workspace_taxonomy_upgrade`
3. `202607190003_content_asset_system`
4. `202607190004_workflow_runtime_center`
5. `20260719081338_agent_dispatch_center`
6. `20260719082436_content_intelligence_center`
7. `20260719083243_social_intelligence_collector`
8. `20260719083854_automation_orchestrator`
9. `20260719085024_automation_real_runner`
10. `20260719085554_telegram_collector_adapter`
11. `20260719090441_social_platform_integration_base`
12. `20260719091213_publish_center_base`
13. `20260719092038_content_performance_analytics`
14. `20260719093509_telegram_feedback_conversion_loop`
15. `20260719094321_production_stability_hardening`
16. `20260719104342_personal_ops_phase2_foundation`

## Schema verification

| Check | Result |
| --- | ---: |
| Public tables | 31 |
| Public indexes | 152 |
| Public RLS-enabled tables | 31 |
| Public + storage policies | 118 |
| Public functions | 0 |
| Public triggers | 0 |
| `authenticated` table grants | 210 |
| `anon` table grants | 210 |

Important tables confirmed:

- `social_accounts`
- `content_library`
- `assets`
- `agent_runs`
- `workflow_runs`
- `cost_records`
- `content_metrics`
- `platform_connections`
- `platform_credentials`
- `publish_tasks`
- `publish_metrics`
- `campaign_links`
- `automation_jobs`
- `automation_runs`
- `content_sources`
- `viral_contents`
- `content_analysis`
- `tool_usage`

## CRUD and RLS validation

Validated through direct Cloud Postgres connection.

| Check | Status | Details |
| --- | --- | --- |
| User A CRUD visible rows | Passed | 7 rows across the required tables |
| User B cannot insert as User A | Passed | RLS rejected the insert |
| User B cannot select User A rows | Passed | 0 rows visible |
| User B cannot update User A rows | Passed | 0 rows affected |

Tables covered:

- `social_accounts`
- `content_library`
- `assets`
- `agent_runs`
- `workflow_runs`
- `cost_records`
- `content_metrics`

## Storage verification

Bucket and policy state:

| Check | Status |
| --- | --- |
| `marketing-assets` bucket exists | Passed |
| Bucket public flag | `true` |
| Own-folder SELECT policy | Present |
| Own-folder INSERT policy | Present |
| Own-folder UPDATE policy | Present |
| Own-folder DELETE policy | Present |

Storage RLS test:

| Check | Status | Details |
| --- | --- | --- |
| User A can insert own-folder object | Passed | Object path under User A folder accepted |
| User B cannot select User A folder | Passed | 0 rows visible |
| User B cannot insert into User A folder | Passed | RLS rejected the insert |

## Cloud API limitation found

The Cloud project database replay is successful, but the Supabase hosted API layer is currently restricted:

- REST request to `/rest/v1/social_accounts` returned HTTP `402`.
- Supabase Auth/Admin API validation returned: project service is restricted because an Edge Functions invocation quota was exceeded.

Impact:

- Browser Dashboard validation against Cloud cannot be counted as passed yet.
- Supabase Auth sign-in validation cannot be counted as passed yet.
- Edge Function deployment/runtime validation cannot be counted as passed yet.

This is an environment/account quota issue, not a migration replay error.

## Result

Cloud migration replay: Passed.

Cloud database CRUD/RLS/Storage isolation: Passed through direct Postgres validation.

Cloud hosted API/Auth/Edge Function availability: Blocked by Supabase project/API quota restriction.

