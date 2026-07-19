# Supabase Smoke Test

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Audit date: 2026-07-19

## Result

Status: Not executed against a real Supabase project in this local run.

Reason:

- `VITE_SUPABASE_URL` is not configured in the current shell.
- `VITE_SUPABASE_ANON_KEY` is not configured in the current shell.
- `SUPABASE_PROJECT_REF` is not configured in the current shell.
- `SUPABASE_ACCESS_TOKEN` is not configured in the current shell.
- No authenticated test user session is available for RLS validation.

No mock data was used.

## Required test records

When real Supabase credentials are configured, create and verify one record in each table:

| Table | Test action | Expected result |
| --- | --- | --- |
| `social_accounts` | Insert/update/delete one account. | CRUD works only for the signed-in owner. |
| `content_library` | Insert/update/delete one content item. | Pipeline status fields persist correctly. |
| `agent_runs` | Insert/update one agent run. | Input/output/cost/duration are stored. |
| `assets` | Insert/update/delete one asset. | Asset metadata and URL fields persist. |
| `cost_records` | Insert one cost record. | Personal cost dashboard can aggregate it. |

## RLS validation plan

Use two real Supabase Auth users:

1. Sign in as User A.
2. Create records in the focus tables.
3. Sign in as User B.
4. Confirm User B cannot read, update, or delete User A records.
5. Confirm User A can read, update, and delete only their own records.

Expected RLS result:

- Personal workspace isolation works by `user_id = auth.uid()`.
- `platform_credentials` is not readable from the frontend.
- Sensitive operations that need `service_role` are performed only by Supabase Edge Functions.

## Current risk

The schema contains RLS policies, but production RLS cannot be marked verified until the clean migration replay and two-user isolation test pass on a real Supabase project.

## Next execution command

After configuring real environment variables:

```bash
npm run setup:check
npm run build
```

Then perform the CRUD and RLS checks from the browser with two test accounts.

