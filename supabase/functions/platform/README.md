# Platform Edge Function

This function is the server-side boundary for social platform operations.

It is responsible for:

- reading provider credentials from Edge Function secrets and private `platform_credentials` references;
- calling provider APIs;
- returning sanitized results to the app;
- never returning access tokens or refresh tokens to the frontend.

## Implemented now

- Telegram `connect`
- Telegram `disconnect`
- Telegram `reconnect`
- Telegram `status`
- Telegram `publish`
- Telegram `getMetrics`

Telegram publishing uses Bot API methods such as `sendMessage`, `sendPhoto`, and `sendVideo`.

## Required Edge Function environment

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ADMIN_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_CONNECT_SECRET` optional; falls back to `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_TRACKING_BASE_URL` or `PLATFORM_FUNCTION_URL`
- `TRACKING_EVENT_SECRET`

Do not put the service role key into frontend `.env` files or GitHub Pages client builds.
Do not put the Telegram bot token into frontend `.env` files, GitHub Pages secrets, or browser requests.

## Current metrics limitation

Telegram Bot API can publish and return the sent message payload. Historical pull-based views/reactions for a specific message are limited. The webhook handler accepts `message`, `channel_post`, `message_reaction`, `message_reaction_count`, and `callback_query` updates when `X-Telegram-Bot-Api-Secret-Token` matches `TELEGRAM_WEBHOOK_SECRET`.

## Conversion tracking

- `GET ?campaign_id=<uuid>` increments clicks and redirects to `campaign_links.url`.
- `POST` with `X-Tracking-Event-Secret` can record downstream clicks, registrations, and revenue.
- Telegram publish uses `TELEGRAM_TRACKING_BASE_URL` or `PLATFORM_FUNCTION_URL` to append a tracked campaign URL when a publish task has `campaign_id`.
