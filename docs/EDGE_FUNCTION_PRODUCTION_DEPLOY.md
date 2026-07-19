# Edge Function Production Deploy

Phase: 2.13

Project positioning: Personal AI Ops Workspace.

No database schema changes were made.

No Stripe, Billing, Subscription, Membership, Pricing, or SaaS functionality was added.

## Production project

| Item | Value |
| --- | --- |
| Project ref | `qtrlymiqohbjvklwegsw` |
| Project URL | `https://qtrlymiqohbjvklwegsw.supabase.co` |
| Function | `platform` |
| Function URL | `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform` |
| Telegram webhook URL | `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform/telegram/webhook` |

## Function inventory

| File | Status |
| --- | --- |
| `supabase/functions/platform/index.ts` | Present |
| `supabase/functions/platform/README.md` | Present |

The function is a Deno/TypeScript Supabase Edge Function.

It handles:

- Telegram connect
- Telegram publish
- Telegram metrics snapshot
- Telegram webhook updates
- Campaign redirect tracking
- Conversion tracking events
- Admin notification action
- Placeholder responses for non-Telegram platform adapters

## Required secrets

| Secret | Status | Purpose |
| --- | --- | --- |
| `TELEGRAM_WEBHOOK_URL` | Configured | Telegram webhook endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | Configured | Validates Telegram webhook requests |
| `TELEGRAM_TRACKING_BASE_URL` | Configured | Campaign tracking URL base |
| `PLATFORM_FUNCTION_URL` | Configured | Generic platform function URL |
| `TRACKING_EVENT_SECRET` | Configured | Validates conversion tracking events |
| `TELEGRAM_ADMIN_BOT_TOKEN` | Missing | Admin notifications and real Telegram bot operations |
| `TELEGRAM_ADMIN_CHAT_ID` | Missing | Admin notification target |

Supabase skipped manual setting of reserved `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` names. The deployed function was successfully invoked afterward, confirming the platform runtime can execute the function. Authenticated placeholder invocation returned HTTP 200.

## Secret configuration command

Configured non-Telegram-token secrets with:

```text
supabase secrets set --project-ref qtrlymiqohbjvklwegsw \
  TELEGRAM_WEBHOOK_URL=<function-webhook-url> \
  TELEGRAM_WEBHOOK_SECRET=<random-secret> \
  TELEGRAM_TRACKING_BASE_URL=<function-url> \
  PLATFORM_FUNCTION_URL=<function-url> \
  TRACKING_EVENT_SECRET=<random-secret>
```

When Telegram credentials are available, add:

```text
supabase secrets set --project-ref qtrlymiqohbjvklwegsw \
  TELEGRAM_ADMIN_BOT_TOKEN=<telegram-bot-token> \
  TELEGRAM_ADMIN_CHAT_ID=<telegram-chat-or-channel-id>
```

## Deploy command

Webhook requests from Telegram do not include Supabase JWTs, so the function was deployed with JWT verification disabled and performs its own request validation.

```text
supabase functions deploy platform --project-ref qtrlymiqohbjvklwegsw --no-verify-jwt
```

## Deployment result

| Item | Result |
| --- | --- |
| Deploy exit code | 0 |
| Function slug | `platform` |
| Function status | `ACTIVE` |
| Version | 1 |
| JWT verification | `false` |
| Script size | 69 kB |

Function list confirmed:

```text
platform ACTIVE
```

## Runtime verification

| Check | Result |
| --- | --- |
| Missing auth request | HTTP 401 |
| Authenticated placeholder action | HTTP 200 |
| Synthetic Telegram webhook | Passed |
| `publish_metrics` write | Passed |
| `content_metrics` write | Passed |

## Synthetic webhook validation

A temporary content item and publish task were created, then a synthetic Telegram update was sent to:

```text
https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform/telegram/webhook
```

The request included:

```text
X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
```

Result:

| Check | Result |
| --- | --- |
| Publish task matched | 1 |
| `content_metrics.views` | 42 |
| `content_metrics.likes` | 5 |
| `content_metrics.comments` | 2 |
| `content_metrics.shares` | 3 |
| `publish_metrics` snapshot | Written |

Temporary rows were cleaned after validation.

## Real Telegram publish blocker

Real Telegram publish was not executed because no Telegram Bot Token or Telegram Chat/Channel ID was available in:

- local environment variables
- project `.env` files
- existing `platform_connections`
- existing `platform_credentials`

Required before real publish:

1. Create or choose a Telegram Bot.
2. Add the bot to the target channel/chat.
3. Grant the bot permission to post.
4. Provide:
   - bot token
   - channel username or chat id
5. Connect Telegram in Settings or create the connection through the Edge Function.

