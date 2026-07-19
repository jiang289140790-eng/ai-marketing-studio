# Phase 2.10 Cloud Validation Report

Project positioning: Personal AI Ops Workspace.

Forbidden scope respected:

- No Stripe
- No Billing
- No Subscription
- No Membership
- No SaaS/multi-tenant feature work
- No new product module development

## 1. Cloud Supabase status

Temporary Cloud project created:

| Item | Value |
| --- | --- |
| Project name | `ai-marketing-studio-phase210-20260719193241` |
| Project ref | `xtkkdvghiohlnpfnnhmx` |
| Region | `us-east-1` |
| Project status | `ACTIVE_HEALTHY` |
| Database | PostgreSQL 17 |

Cloud migration replay status: Passed.

`supabase db push` applied all 16 migrations successfully from the project migration folder.

See: `docs/SUPABASE_CLOUD_REPLAY_RESULT.md`

## 2. Migration replay result

| Check | Result |
| --- | --- |
| Empty Cloud project migration replay | Passed |
| Migration count | 16 |
| Public tables | 31 |
| Public indexes | 152 |
| RLS-enabled public tables | 31 |
| Public + storage policies | 118 |
| `authenticated` grants | 210 |
| `anon` grants | 210 |

The RLS clean replay repair from Phase 2.8 held up against Cloud replay.

The 2026 Supabase Data API behavior change was considered: explicit role grants exist for public tables, so the schema is not relying on older implicit public table exposure defaults.

Reference: Supabase announced that new public tables may require explicit grants before the Data API can access them.

## 3. Cloud CRUD validation

Cloud database CRUD was validated through a real Cloud Postgres connection.

Tables covered:

- `social_accounts`
- `content_library`
- `assets`
- `agent_runs`
- `workflow_runs`
- `cost_records`
- `content_metrics`

Result:

| Check | Status |
| --- | --- |
| Create | Passed |
| Read | Passed |
| Update | Passed |
| Delete / cleanup | Passed by rollback or service cleanup path where allowed |

## 4. Cloud RLS validation

Two test users were created directly in Cloud Postgres for RLS validation.

| Check | Status |
| --- | --- |
| User A can access own rows | Passed |
| User B cannot select User A rows | Passed |
| User B cannot update User A rows | Passed |
| User B cannot insert as User A | Passed |

Storage isolation:

| Check | Status |
| --- | --- |
| `marketing-assets` bucket exists | Passed |
| User A can insert own-folder object row | Passed |
| User B cannot select User A folder | Passed |
| User B cannot insert into User A folder | Passed |

## 5. Dashboard Cloud connection

Dashboard source code reads data through Supabase service modules, not hardcoded dashboard numbers.

Confirmed source behavior:

- Dashboard imports service functions such as `listSocialAccounts`, `listContent`, `listAssets`, `listWorkflowRuns`, `listAgentTasks`, `listContentMetrics`, `listCostRecords`, and `listToolUsage`.
- Dashboard requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
- Dashboard requires a logged-in Supabase session before user-scoped data can be shown.

Cloud browser validation status: Blocked.

Reason:

- The temporary Supabase Cloud project REST API returned HTTP `402`.
- Supabase Auth/Admin API returned a project service restriction message related to Edge Functions invocation quota.

This means the database is valid, but the hosted API layer is not currently usable enough to honestly mark browser Dashboard validation as passed.

## 6. Telegram preparation check

No real Telegram publish was executed in Phase 2.10.

Checked:

- `supabase/functions/platform/index.ts`
- `supabase/functions/platform/README.md`
- `.env.example`
- Cloud function list

Result:

| Check | Status |
| --- | --- |
| Platform Edge Function source exists | Passed |
| Telegram publish handler exists | Passed |
| Telegram metrics handler exists | Passed |
| Telegram webhook handler exists | Passed |
| Campaign tracking handler exists | Passed |
| Token boundary documented | Passed |
| Function deployed to Cloud | Not deployed |
| Real Telegram publish | Not executed by requirement |

Cloud function list returned no deployed functions for the temporary project.

See: `docs/TELEGRAM_DEPLOYMENT_CHECKLIST.md`

## 7. Local vs Cloud differences

| Area | Local result | Cloud result |
| --- | --- | --- |
| Migration replay | Passed | Passed |
| Public schema counts | Passed | Passed |
| RLS policies | Passed | Passed |
| Required CRUD tables | Passed | Passed through direct Postgres |
| Storage RLS | Passed | Passed through direct Postgres |
| REST/Data API | Not the Phase 2.9 blocker | Blocked by HTTP 402 |
| Auth API | Locally available | Blocked by project quota restriction |
| Edge Function runtime | Local source checked | Cloud deployment not executed |
| Dashboard browser validation | Local setup-dependent | Blocked by Cloud API/Auth restriction |

## 8. Remaining production risks

1. Cloud project API restriction must be resolved before real production use.
   - REST returned HTTP `402`.
   - Auth/Admin API returned a service restriction related to Edge Functions invocation quota.

2. The temporary Cloud project should be deleted or its database password rotated after validation.
   - It was created for replay testing, not long-term operation.

3. Telegram Edge Function is not deployed yet.
   - Source exists.
   - Secrets are documented.
   - Runtime validation is pending API availability.

4. Google OAuth cannot be called production-ready until the Cloud Auth service is available and provider settings are configured.

5. Dashboard has real database service wiring, but Cloud browser validation is pending because user auth cannot currently complete against the restricted Cloud API layer.

## 9. Current real runnable ability

Confirmed:

- Cloud database can accept the full migration chain.
- Personal workspace schema is structurally valid.
- Required data tables exist.
- RLS isolation works for personal user data.
- Storage own-folder isolation works.
- Migration static checker remains safe.

Not confirmed:

- Browser login against Cloud.
- Dashboard reading Cloud data through a real user session.
- Edge Function deployment/runtime.
- Telegram production publish.

## 10. Next steps

Do not add features yet.

Recommended next actions:

1. Resolve Supabase Cloud project quota/restriction issue.
2. Re-run REST + Auth validation with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
3. Deploy `platform` Edge Function.
4. Set Telegram secrets.
5. Run one Telegram test publish to a private test channel.
6. Confirm webhook metrics write into `content_metrics`.
7. Delete the temporary project or rotate its database password.

