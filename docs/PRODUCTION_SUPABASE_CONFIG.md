# Production Supabase Config

Phase: 2.12

Project positioning: Personal AI Ops Workspace.

No Stripe, Billing, Subscription, Membership, Pricing, or SaaS functionality is part of this setup.

## Production project

| Item | Value |
| --- | --- |
| Project name | `ai-marketing-studio-production-20260719200546` |
| Project ref | `qtrlymiqohbjvklwegsw` |
| Region | `us-east-1` |
| Status | `ACTIVE_HEALTHY` |
| Project URL | `https://qtrlymiqohbjvklwegsw.supabase.co` |

This is the formal production Supabase Cloud project for AI Marketing Studio.

The previous temporary validation project is not used:

```text
xtkkdvghiohlnpfnnhmx
```

## Configured values

| Variable | Status | Safe for frontend | Notes |
| --- | --- | --- | --- |
| `SUPABASE_PROJECT_REF` | Verified | No | `qtrlymiqohbjvklwegsw` |
| `SUPABASE_URL` | Verified | No | Used by Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | Retrieved and used for validation | No | Never commit or expose in GitHub Pages |
| `VITE_SUPABASE_URL` | Verified | Yes | Used for frontend runtime |
| `VITE_SUPABASE_ANON_KEY` | Retrieved and used for validation | Yes | Public frontend key |

Sensitive key values are intentionally not written into this document.

## Frontend runtime config

For local or GitHub Pages frontend builds:

```text
VITE_SUPABASE_URL=https://qtrlymiqohbjvklwegsw.supabase.co
VITE_SUPABASE_ANON_KEY=<production-anon-or-publishable-key>
VITE_APP_BASE_PATH=/ai-marketing-studio/
GITHUB_PAGES_BASE=/ai-marketing-studio/
```

Do not put these in frontend files:

- `SUPABASE_SERVICE_ROLE_KEY`
- database password
- Telegram bot token
- X client secret
- provider refresh tokens

## Edge Function secrets

Configure these in Supabase Edge Function secrets only:

```text
SUPABASE_URL=https://qtrlymiqohbjvklwegsw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<production-service-role-key>
TELEGRAM_ADMIN_BOT_TOKEN=<telegram-admin-bot-token>
TELEGRAM_ADMIN_CHAT_ID=<telegram-admin-chat-id>
TELEGRAM_WEBHOOK_URL=https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=<random-secret>
TELEGRAM_TRACKING_BASE_URL=https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform
PLATFORM_FUNCTION_URL=https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform
TRACKING_EVENT_SECRET=<random-secret>
```

## Validation status

| Area | Status |
| --- | --- |
| Project created | Passed |
| Project health | Passed |
| Migration deployed | Passed |
| REST API | Passed |
| Auth API | Passed |
| Storage API | Passed |
| Auth User A/B login | Passed |
| RLS isolation | Passed |
| Storage isolation | Passed |
| Dashboard Cloud read | Passed |

## Data API grant note

Supabase changed how new public tables are exposed to the Data API. New projects may require explicit grants for REST/GraphQL access.

This project passed REST validation after migration. The schema has explicit `anon` and `authenticated` grants.

Reference:

```text
https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
```

