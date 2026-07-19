# AI Marketing Studio Production Check

Updated: 2026-07-19

## Positioning

AI Marketing Studio is a Personal AI Ops Workspace.

It is not a SaaS product. The production checklist does not include Stripe, Billing, Subscription, Membership, Pricing, or multi-tenant commercial features.

Cost, revenue, ROI, and usage data are only used for personal operations review.

## Current production status

The app has the basic production structure:

- React + Vite frontend
- GitHub Pages deployment target
- Supabase Auth / Database / Storage / RLS
- Supabase Edge Function boundary
- Telegram publish / webhook / metrics code path
- Retry, notification, cost, audit, system health, daily report, and export support

The app is not yet fully production-verified because real Supabase and Telegram variables are not configured in the current local environment.

## Required frontend variables

Configure these in GitHub Pages / CI build settings:

| Name | Purpose | Required |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser Supabase client URL. | Yes |
| `VITE_SUPABASE_ANON_KEY` | Browser Supabase anon/publishable key. | Yes |
| `GITHUB_PAGES_BASE` | Vite base path. Defaults to `/ai-marketing-studio/`. | Optional |

Do not put service role keys or provider tokens in frontend variables.

## Required Supabase deployment variables

Configure locally or in CI deployment secrets:

| Name | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_PROJECT_REF` | Target Supabase project reference. | Yes |
| `SUPABASE_ACCESS_TOKEN` | Supabase CLI deployment token. | Yes |
| `GITHUB_TOKEN` | GitHub deployment automation token. | Optional |

## Required Supabase Edge Function secrets

Configure with `supabase secrets set`:

| Name | Purpose | Required |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase URL for Edge Function runtime. | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key used by Edge Functions. | Yes |
| `TELEGRAM_ADMIN_BOT_TOKEN` | Telegram Bot token. | Yes |
| `TELEGRAM_ADMIN_CHAT_ID` | Telegram channel/chat target. | Yes |
| `TELEGRAM_WEBHOOK_URL` | Public webhook URL for Telegram. | Yes |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook validation secret. | Yes |
| `TRACKING_EVENT_SECRET` | Conversion tracking validation secret. | Yes |
| `TELEGRAM_TRACKING_BASE_URL` | Base URL for tracked campaign links. | Optional |
| `PLATFORM_FUNCTION_URL` | Generic platform Edge Function base URL. | Optional |

## Supabase migrations

Known state:

- Migration files exist.
- The initial schema already contains many later module tables.
- Later migrations recreate several tables and policies.
- Duplicate tables and indexes mostly use `IF NOT EXISTS`.
- Duplicate RLS policies are currently the main clean replay blocker.

Production rule:

Before touching a real production project, run a clean replay in a temporary Supabase project or local Docker Supabase stack.

See:

- [docs/MIGRATION_CLEAN_REPLAY_PLAN.md](docs/MIGRATION_CLEAN_REPLAY_PLAN.md)
- [docs/MIGRATION_BASELINE_AUDIT.md](docs/MIGRATION_BASELINE_AUDIT.md)

## Edge Functions

Existing function:

- `supabase/functions/platform/index.ts`

Current responsibilities:

- Telegram connection
- Telegram publishing
- Telegram webhook handling
- Telegram metrics normalization
- Campaign click / registration / revenue tracking
- Admin Telegram notification

Security boundary:

- Frontend never reads Telegram Bot Token.
- Frontend never reads Supabase `service_role`.
- `platform_credentials` must remain server-access only.
- Sensitive platform operations must run through Supabase Edge Functions.

## Auth

Check before production:

- Supabase Auth provider enabled.
- Google OAuth callback URL matches the GitHub Pages production URL if Google login is used.
- Site URL and redirect URLs are configured in Supabase Auth.

## Storage

Bucket:

- `marketing-assets`

Use:

- Images
- Videos
- Audio
- Prompt / Workflow / LoRA related files

Check before production:

- Bucket exists.
- Public/private setting matches the content strategy.
- Files are stored under `{user_id}/...`.
- Storage RLS policies allow users to manage only their own folder.

## Required smoke tests

1. Login with a real Supabase user.
2. Create, read, update, and delete:
   - social account
   - content item
   - asset
   - agent run
   - cost record
3. Upload one small file to Storage.
4. Create a Telegram platform connection.
5. Create one content item.
6. Create one publish task.
7. Execute Telegram publishing.
8. Confirm `publish_tasks.external_id` and `published_at`.
9. Trigger webhook or tracking callback.
10. Confirm `content_metrics` / `publish_metrics` update.
11. Confirm Dashboard reads real counts.

