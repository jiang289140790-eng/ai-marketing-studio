# Phase 2.8 RLS Stability Report

Project: AI Marketing Studio  
Positioning: Personal AI Ops Workspace, not SaaS  
Date: 2026-07-19

## Summary

Phase 2.8 fixed the RLS policy migration clean replay blocker at the static migration level.

No product feature was added.

No Stripe, Billing, Subscription, Membership, Pricing, or SaaS functionality was added.

## 1. RLS risk repair status

Before repair:

- `CREATE POLICY` statements: 200
- Duplicate policy groups: 82
- Unsafe duplicate policy groups: 82
- `npm run migrations:check`: failed

After repair:

- `CREATE POLICY` statements: 200
- Guarded policy statements: 200
- Ordinary unguarded policy statements: 0
- Dynamic policy SQL statements: 0
- Duplicate policy groups: 82
- Unsafe duplicate policy groups: 0
- `npm run migrations:check`: passed

The duplicate policy names still exist historically, but they are now guarded with `pg_policies`, so they should not fail simply because a prior migration already created the same policy.

## 2. Clean replay status

Static check:

- Passed.
- Overall status: safe.

Local replay:

- Attempted with `supabase db reset --local --no-seed --debug`.
- Blocked because Docker Desktop is unavailable in the current environment.
- No remote Supabase project was modified.

Remote disposable replay:

- Not executed because real Supabase deployment variables are not configured.

Conclusion:

- The known duplicate RLS policy blocker is fixed.
- Full clean replay still needs a real local Docker Supabase stack or a disposable Supabase project.

## 3. Remaining production risks

1. Docker Desktop is required for local Supabase replay.
2. Real Supabase variables are still missing:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_PROJECT_REF`
   - `SUPABASE_ACCESS_TOKEN`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Real Telegram variables are still missing for the later production channel test.
4. RLS still needs real two-user validation after migrations are applied.
5. Storage still needs upload/RLS validation against `marketing-assets`.
6. Supabase Data API grants should be confirmed on a real project because of Supabase's 2026 Data API exposure change.

## 4. Commands executed

| Command | Result |
| --- | --- |
| `npm run migrations:check` | Passed. Overall status: safe. |
| `npm run lint` | Passed. |
| `npm run build` | Passed. |
| `npm run setup:check` | Passed as a checklist command; reports missing Supabase/Telegram production variables. |
| `supabase db reset --local --no-seed --debug` | Blocked by Docker Desktop unavailable. |

## 5. Next stage recommendation

Do not start feature development.

Next stage should be real Supabase validation:

1. Start Docker Desktop or create a disposable Supabase project.
2. Run migration clean replay.
3. Configure real Supabase environment variables.
4. Validate Auth.
5. Validate CRUD for core tables.
6. Validate RLS with two users.
7. Validate Storage upload.
8. Confirm Dashboard reads real database data.
9. After Supabase passes, continue to Telegram production validation.

