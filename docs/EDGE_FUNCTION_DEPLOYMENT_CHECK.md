# Edge Function Deployment Check

Phase: 2.11 production environment check

No new feature development was performed.

## Local function inventory

| Function | Path | Status |
| --- | --- | --- |
| `platform` | `supabase/functions/platform/index.ts` | Source exists |

Supporting documentation:

| File | Status |
| --- | --- |
| `supabase/functions/platform/README.md` | Exists |
| `docs/TELEGRAM_DEPLOYMENT_CHECKLIST.md` | Exists |

## Current implemented server-side actions

The `platform` Edge Function currently contains server-side handling for:

- Telegram connect
- Telegram publish
- Telegram metrics snapshot
- Telegram webhook event handling
- campaign click redirect
- conversion tracking event
- admin Telegram notification
- placeholder boundary for non-Telegram platform actions

Tokens are handled server-side through Edge Function logic and `platform_credentials`.

## Required secrets

Configure in Supabase Edge Function secrets:

| Secret | Required | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | Yes | Project URL used by the function |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Server-side access to credentials, tasks, metrics |
| `TELEGRAM_ADMIN_BOT_TOKEN` | Recommended | Admin failure notification bot |
| `TELEGRAM_ADMIN_CHAT_ID` | Recommended | Admin notification target |
| `TELEGRAM_WEBHOOK_URL` | Yes for Telegram webhook | Public Telegram webhook endpoint |
| `TELEGRAM_WEBHOOK_SECRET` | Yes for Telegram webhook | Validates Telegram webhook requests |
| `TELEGRAM_TRACKING_BASE_URL` | Recommended | Campaign redirect and tracking base |
| `PLATFORM_FUNCTION_URL` | Fallback | Generic function base URL |
| `TRACKING_EVENT_SECRET` | Yes for conversion events | Validates conversion event posts |

Future provider secrets should also remain server-side only:

- `X_CLIENT_SECRET`
- `X_API_SECRET`
- `X_BEARER_TOKEN`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `QWEN_API_KEY`
- `COMFYUI_API_KEY`
- `RUNNINGHUB_API_KEY`

## Deployment commands

Set secrets:

```text
supabase secrets set <KEY>=<VALUE> --project-ref <SUPABASE_PROJECT_REF>
```

Deploy the function:

```text
supabase functions deploy platform --project-ref <SUPABASE_PROJECT_REF>
```

List deployed functions:

```text
supabase functions list --project-ref <SUPABASE_PROJECT_REF>
```

Expected function URL:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform
```

Telegram webhook URL:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform/telegram/webhook
```

## Current Cloud deployment state

Temporary project checked:

| Project ref | Functions |
| --- | --- |
| `xtkkdvghiohlnpfnnhmx` | none deployed |

The current temporary project's hosted API layer returns HTTP `402`, so deploying or validating Edge Functions there is not a reliable production test.

## Pre-deployment verification

Before deploying to the real production project:

1. Confirm REST API is not returning HTTP `402`.
2. Confirm Auth API is not returning HTTP `402`.
3. Confirm Storage API is not returning HTTP `402`.
4. Confirm `SUPABASE_SERVICE_ROLE_KEY` is stored only in Supabase secrets.
5. Confirm frontend `.env.local` contains only public `VITE_` values.
6. Confirm no Telegram bot token is committed to the repo.

## Telegram webhook flow

Expected Telegram runtime flow:

1. Telegram sends update to:

```text
https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/platform/telegram/webhook
```

2. Request must include:

```text
X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>
```

3. Edge Function validates the secret.
4. Edge Function extracts message/reaction/click data.
5. Matching `publish_tasks` are located by `platform = Telegram` and `external_id`.
6. `publish_metrics` is updated.
7. `content_metrics` receives a new snapshot row.
8. Campaign clicks/conversions update `campaign_links` when applicable.

## Deployment readiness result

Source readiness: Passed.

Secret checklist: Ready.

Cloud deployment validation: Blocked until a normal Cloud project/API layer is available.

