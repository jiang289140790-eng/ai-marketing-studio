# Supabase Production Validation

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Result

Status: Partially validated.

Local Supabase production-style validation was executed with Docker Desktop and Supabase CLI. Supabase Cloud validation was not executed because cloud project variables are not configured.

No mock data was used.

## Environment status

The current shell does not contain required Supabase Cloud production variables:

| Variable | Status |
| --- | --- |
| `VITE_SUPABASE_URL` | Missing |
| `VITE_SUPABASE_ANON_KEY` | Missing |
| `SUPABASE_URL` | Missing |
| `SUPABASE_SERVICE_ROLE_KEY` | Missing |
| `SUPABASE_PROJECT_REF` | Missing |
| `SUPABASE_ACCESS_TOKEN` | Missing |

Local Supabase values were supplied by `supabase start` and used only for local validation.

## Required variables by location

Frontend / GitHub Pages build:

| Variable | Why it is needed |
| --- | --- |
| `VITE_SUPABASE_URL` | Lets the browser app connect to the Supabase project. |
| `VITE_SUPABASE_ANON_KEY` | Lets the browser app use Supabase Auth and Data API under RLS. |

Local or CI deployment:

| Variable | Why it is needed |
| --- | --- |
| `SUPABASE_PROJECT_REF` | Identifies the target Supabase project for deploy/check commands. |
| `SUPABASE_ACCESS_TOKEN` | Allows Supabase CLI deployment commands. |

Supabase Edge Function secrets:

| Variable | Why it is needed |
| --- | --- |
| `SUPABASE_URL` | Lets Edge Functions connect back to Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Lets Edge Functions perform sensitive server-side operations. Must never be exposed to the frontend. |

## Connection validation

| Area | Status | Notes |
| --- | --- | --- |
| Database connection | Passed locally | Local Docker Supabase was started and queried. |
| Auth | Passed locally | Test users were inserted in local `auth.users` for validation. |
| Storage | Passed locally | `marketing-assets` bucket and own-folder upload/delete were verified. |
| RLS | Passed locally | Two-user owner isolation passed. |
| Dashboard real data read | Static source check passed | Dashboard reads from Supabase services; browser env still needs real frontend variables. |

## CRUD validation plan

Run this only after migrations are replay-safe and a real Supabase project is configured.

| Table | Operation | Expected result |
| --- | --- | --- |
| `social_accounts` | Create/read/update/delete one Telegram or X account row. | Only owner can access it. |
| `content_library` | Create/read/update/delete one content item. | Pipeline stage and status persist. |
| `assets` | Create metadata row and upload one file. | File URL and metadata are stored. |
| `agent_runs` | Create/update one run log. | Input/output/status/cost/duration persist. |
| `cost_records` | Create/read/delete one cost row. | Dashboard cost cards aggregate it. |

Minimum CRUD acceptance criteria:

- Create returns a row with the authenticated user's `user_id`.
- Read returns only the current user's rows.
- Update changes only the current user's row.
- Delete removes only the current user's row.
- Dashboard counts update after refresh.

Local CRUD result:

| Table | Create | Read | Update | Delete |
| --- | --- | --- | --- | --- |
| `social_accounts` | Passed | Passed | Passed | Passed |
| `content_library` | Passed | Passed | Passed | Passed |
| `assets` | Passed | Passed | Passed | Passed |
| `agent_runs` | Passed | Passed | Passed | Passed |
| `workflow_runs` | Passed | Passed | Passed | Passed |
| `cost_records` | Passed | Passed | Passed | Passed |
| `content_metrics` | Passed | Passed | Passed | Passed |

## RLS validation plan

Use two real Supabase Auth users:

1. Sign in as User A.
2. Create rows in `social_accounts`, `content_library`, `assets`, `agent_runs`, and `cost_records`.
3. Sign out and sign in as User B.
4. Confirm User B cannot read, update, or delete User A rows.
5. Confirm User A can still read/update/delete only their own rows.

Expected:

- Owner policies work through `user_id = auth.uid()`.
- UPDATE policies have both `USING` and `WITH CHECK`.
- `platform_credentials` remains unreadable from frontend clients.

Local RLS result:

| Check | Result |
| --- | --- |
| User A can create/read/update own rows | Passed |
| User B cannot select User A row | Passed |
| User B update attempt affects no User A row | Passed |
| User B cannot insert row as User A | Passed |

## Storage validation plan

Bucket:

- `marketing-assets`

Test:

1. Upload a small image under `{user_id}/test/...`.
2. Confirm public URL behavior matches the bucket setting.
3. Confirm another user cannot write into the first user's folder.

Storage acceptance criteria:

- Upload succeeds for `{user_id}/...`.
- Read URL behavior matches bucket public/private decision.
- Upload to another user's folder is rejected.
- Upsert works only when SELECT + INSERT + UPDATE are all permitted by Storage RLS.

Local Storage result:

| Check | Result |
| --- | --- |
| Bucket `marketing-assets` exists | Passed |
| Own-folder upload | Passed |
| Wrong-folder upload blocked by RLS | Passed |
| Own object delete | Passed |

## Dashboard validation plan

Dashboard should read real Supabase data from:

- `social_accounts`
- `content_library`
- `publish_tasks`
- `assets`
- `workflow_runs`
- `agents`
- `agent_tasks`
- `viral_contents`
- `content_analysis`
- `content_sources`
- `collection_runs`
- `automation_jobs`
- `automation_runs`
- `content_metrics`
- `publish_metrics`
- `campaign_links`
- `cost_records`
- `tool_usage`
- `notifications`

Expected:

- No static metric numbers.
- Empty state appears if there is no data.
- Counts change after CRUD test records are created.

Dashboard acceptance criteria:

- Account count changes after `social_accounts` CRUD.
- Content count changes after `content_library` CRUD.
- Asset count changes after asset upload/create.
- Cost cards change after `cost_records` or `tool_usage` inserts.
- System health cards reflect failed task rows from real database data.

Local Dashboard source result:

- Dashboard imports Supabase-backed service functions for every metric group.
- No `mock` or `Math.random` dashboard metric source was found.
- Live browser Dashboard validation still requires frontend env variables or a local dev session configured with local Supabase URL/key.

## Current conclusion

Supabase is validated locally with real Docker Supabase. Supabase Cloud production remains pending until real cloud variables are provided.
