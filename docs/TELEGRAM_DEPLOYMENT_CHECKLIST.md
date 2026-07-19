# Telegram Deployment Checklist

Phase: 2.10 Telegram deployment preparation only.

No real Telegram publish was executed in this phase.

## Current implementation status

| Area | Status |
| --- | --- |
| Telegram publish handler | Present in `supabase/functions/platform/index.ts` |
| Telegram metrics handler | Present |
| Telegram webhook handler | Present |
| Campaign click redirect | Present |
| Conversion event handler | Present |
| Token kept out of frontend | Yes, handled through Edge Function + `platform_credentials` |
| Edge Function deployed to Cloud | Not deployed in Phase 2.10 |

## Required Supabase Edge Function

Function path:

```text
supabase/functions/platform
```

Expected production URL:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform
```

Telegram webhook URL:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform/telegram/webhook
```

## Required secrets

Configure these in Supabase Edge Function secrets, not in frontend GitHub Pages builds.

| Secret | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Edge Function connects back to the project |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side DB access for credentials, publish tasks, metrics |
| `TELEGRAM_ADMIN_BOT_TOKEN` | Optional but recommended | Admin failure notifications |
| `TELEGRAM_ADMIN_CHAT_ID` | Optional but recommended | Admin notification target |
| `TELEGRAM_WEBHOOK_URL` | Yes for webhook | Telegram Bot API webhook endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | Yes for webhook | Validates Telegram webhook requests |
| `TELEGRAM_TRACKING_BASE_URL` | Recommended | Click tracking URL base |
| `PLATFORM_FUNCTION_URL` | Fallback | Generic function base URL |
| `TRACKING_EVENT_SECRET` | Yes for conversion events | Validates conversion tracking posts |

Frontend must only use:

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Public Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon or publishable key |

Never expose:

- `SUPABASE_SERVICE_ROLE_KEY`
- Telegram bot tokens
- X/Twitter secrets
- Provider refresh tokens

## Deployment steps

1. Confirm the Cloud Supabase project API is not restricted.
2. Set Edge Function secrets.
3. Deploy the function:

```text
supabase functions deploy platform --project-ref <SUPABASE_PROJECT_REF>
```

4. Verify the function exists:

```text
supabase functions list --project-ref <SUPABASE_PROJECT_REF>
```

5. Connect Telegram from Settings using:

- account name
- channel/chat id
- bot token

6. Set Telegram webhook through the app or through the function action:

```json
{
  "platform": "Telegram",
  "action": "setWebhook",
  "connection_id": "<platform_connection_id>"
}
```

7. Create a publish task from Content Library or Publish Center.
8. Execute publish through the platform adapter / publish service.
9. Confirm:

- `publish_tasks.status = published`
- `publish_tasks.external_id` stores Telegram `message_id`
- `publish_tasks.published_at` is filled
- `publish_metrics` has a Telegram snapshot
- `content_metrics` has a row for the content

## Current Cloud blocker

The Phase 2.10 temporary Cloud project API returned HTTP `402` for REST access, and Supabase Auth/Admin API returned a quota restriction message.

Until that is resolved, Telegram Edge Function deployment/runtime validation should not be treated as production-ready.

## Next Telegram validation

After Cloud API restriction is cleared:

1. Deploy `platform` Edge Function.
2. Set all Telegram secrets.
3. Run one private test publish to a test Telegram channel.
4. Trigger one webhook update.
5. Confirm metrics land in `content_metrics`.
6. Confirm no bot token appears in frontend responses, browser console, or network payloads.

