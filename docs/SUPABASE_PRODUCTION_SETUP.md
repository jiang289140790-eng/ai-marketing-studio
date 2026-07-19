# Supabase Production Setup

Phase: 2.11 production environment preparation

Project positioning: Personal AI Ops Workspace, not SaaS.

Do not add or configure Stripe, Billing, Subscription, Membership, Pricing, or multi-tenant SaaS features.

## Current Cloud situation

Current temporary project:

| Item | Value |
| --- | --- |
| Project ref | `xtkkdvghiohlnpfnnhmx` |
| Purpose | Phase 2.10 migration replay validation |
| Migration replay | Passed |
| Database CRUD/RLS | Passed through direct Postgres |
| REST/Auth/Storage API | Blocked by HTTP `402` |

Attempting to create a new Cloud Supabase project during Phase 2.11 was blocked by the Supabase organization free-project limit:

```text
The following organization members have reached their maximum limits for the number of active free projects within organizations where they are an administrator or owner.
```

Required action before creating the real production project:

1. Delete or pause the temporary validation project, or
2. Delete or pause another unused free project, or
3. Upgrade/remove the relevant Supabase account limitation.

## 1. Create the production project

Recommended project settings:

| Setting | Recommendation |
| --- | --- |
| Project name | `ai-marketing-studio-production` |
| Region | Choose the region closest to daily usage and Telegram/API workload |
| Database password | Generate a unique strong password and store it in a password manager |
| Pricing mode | Personal usage; avoid SaaS billing/subscription features in this app |

CLI creation template:

```text
supabase projects create ai-marketing-studio-production \
  --org-id <SUPABASE_ORG_ID> \
  --region <REGION> \
  --db-password <STRONG_DATABASE_PASSWORD>
```

After creation, save:

| Value | Where to get it |
| --- | --- |
| `SUPABASE_PROJECT_REF` | CLI output or Supabase dashboard |
| Project URL | Dashboard → Project Settings → API |
| Publishable/anon key | Dashboard → Project Settings → API |
| Service role key | Dashboard → Project Settings → API |
| Database password | Password manager only |

Never commit the database password or service role key.

## 2. Link the project locally

```text
supabase link --project-ref <SUPABASE_PROJECT_REF>
```

If the CLI asks for the database password, use the production database password from the password manager.

## 3. Deploy migrations

Run the migration checker first:

```text
npm run migrations:check
```

Then deploy migrations:

```text
supabase db push --project-ref <SUPABASE_PROJECT_REF>
```

Confirm:

```text
supabase migration list --project-ref <SUPABASE_PROJECT_REF>
```

Expected migration count:

```text
16
```

## 4. Verify database structure

Required checks:

| Check | Expected |
| --- | --- |
| Public tables | 31 |
| Public indexes | 152 |
| Public RLS-enabled tables | 31 |
| Public + storage policies | 118 |
| `anon` / `authenticated` grants | Present |

Supabase Data API note:

New Supabase projects may require explicit grants before public tables are reachable through REST/GraphQL. The current migrations include grants for `anon` and `authenticated`, but the production project still needs a real REST request check after migration.

Reference:

```text
https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
```

## 5. Configure frontend environment

For local browser testing, create `.env.local`.

Only public frontend values belong here:

```text
VITE_SUPABASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable-or-anon-key>
VITE_APP_BASE_PATH=/ai-marketing-studio/
GITHUB_PAGES_BASE=/ai-marketing-studio/
```

Do not put these in frontend files:

- `SUPABASE_SERVICE_ROLE_KEY`
- Telegram bot token
- X client secret
- provider refresh tokens
- database password

## 6. Configure Edge Function secrets

Set these in Supabase secrets:

```text
supabase secrets set \
  SUPABASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
  TELEGRAM_ADMIN_BOT_TOKEN=<telegram-admin-bot-token> \
  TELEGRAM_ADMIN_CHAT_ID=<telegram-admin-chat-id> \
  TELEGRAM_WEBHOOK_URL=https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform/telegram/webhook \
  TELEGRAM_WEBHOOK_SECRET=<random-secret> \
  TELEGRAM_TRACKING_BASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform \
  PLATFORM_FUNCTION_URL=https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform \
  TRACKING_EVENT_SECRET=<random-secret> \
  --project-ref <SUPABASE_PROJECT_REF>
```

## 7. Verify Cloud API layer

After migration and environment setup, validate:

| API | Required check |
| --- | --- |
| REST API | `GET /rest/v1/social_accounts?select=id&limit=1` returns HTTP 200, 401, or 403 depending on auth/RLS; not 402 |
| Auth API | `/auth/v1/settings` returns HTTP 200 |
| Storage API | `/storage/v1/bucket` works with service role |
| Dashboard | Browser reads real project data after login |

## 8. Auth validation

Create two test users:

- User A
- User B

Validate:

| Check | Expected |
| --- | --- |
| User A login | Works |
| User B login | Works |
| Session persists | Works |
| User A can read own rows | Works |
| User B cannot read User A rows | Works |
| User B cannot update User A rows | Works |
| Storage own-folder isolation | Works |

## 9. GitHub Pages deployment variables

For GitHub Pages/Vite deployment, configure repository or build environment variables:

| Variable | Required | Safe for frontend |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Yes |
| `VITE_SUPABASE_ANON_KEY` | Yes | Yes |
| `VITE_APP_BASE_PATH` | Yes | Yes |
| `GITHUB_PAGES_BASE` | Yes | Yes |

Service-role and provider secrets must stay in Supabase Edge Function secrets only.

## 10. Production readiness gate

Do not treat the production environment as ready until all of these pass:

1. New Cloud project created successfully.
2. `supabase db push` completes.
3. REST API returns non-402.
4. Auth API returns non-402.
5. Storage API returns non-402.
6. User A / User B login works.
7. RLS isolation works through Supabase API, not only direct Postgres.
8. Dashboard reads real Cloud data in browser.
9. Edge Function deploys successfully.
10. Telegram webhook URL is configured.

