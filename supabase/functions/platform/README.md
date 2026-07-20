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
- X `connect`
- X `disconnect`
- X `reconnect`
- X `status`
- X `publish`
- X `getMetrics`

## Prepared platform boundaries

The same Edge Function now returns safe setup details for these prepared platforms:

- Instagram
- YouTube
- TikTok
- Discord

These responses include required secret names, callback URLs, supported actions, and multi-account behavior. They do not expose tokens. Real OAuth handlers still need provider-specific implementation before live account authorization can complete.

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
- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`
- `INSTAGRAM_CLIENT_ID`
- `INSTAGRAM_CLIENT_SECRET`
- `INSTAGRAM_REDIRECT_URI`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`
- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REDIRECT_URI`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`
- `DISCORD_REDIRECT_URI`

Do not put the service role key into frontend `.env` files or GitHub Pages client builds.
Do not put the Telegram bot token into frontend `.env` files, GitHub Pages secrets, or browser requests.
Do not put OAuth client secrets or bot tokens into browser requests.

## Current metrics limitation

Telegram Bot API can publish and return the sent message payload. Historical pull-based views/reactions for a specific message are limited. The webhook handler accepts `message`, `channel_post`, `message_reaction`, `message_reaction_count`, and `callback_query` updates when `X-Telegram-Bot-Api-Secret-Token` matches `TELEGRAM_WEBHOOK_SECRET`.

## Conversion tracking

- `GET ?campaign_id=<uuid>` increments clicks and redirects to `campaign_links.url`.
- `POST` with `X-Tracking-Event-Secret` can record downstream clicks, registrations, and revenue.
- Telegram publish uses `TELEGRAM_TRACKING_BASE_URL` or `PLATFORM_FUNCTION_URL` to append a tracked campaign URL when a publish task has `campaign_id`.
