# Phase 3.8.1 Telegram Platform Layer Report

## Scope

This phase starts implementing the AI Marketing Studio Platform Connection Layer by migrating Telegram into the shared connection architecture.

The project remains a Personal AI Ops Workspace. No Stripe, billing, subscription, membership, workspace SaaS, or pricing logic was added.

## Implemented

### 1. Platform connection data structure

Added a compatibility migration:

- `supabase/migrations/20260720112159_phase3_8_1_telegram_platform_layer.sql`

It extends the existing tables instead of recreating them:

- `platform_connections`
  - `auth_type`
  - `permissions`
  - `expires_at`
  - `error_message`
  - `metadata`
  - `disconnected_at`
  - `last_used_at`

- `platform_credentials`
  - `oauth_secret`
  - `token_type`
  - `scopes`
  - `metadata`
  - `updated_at`

The migration keeps `platform_credentials` private:

- `anon`: revoked
- `authenticated`: revoked
- frontend reads only `platform_connections`

### 2. Telegram credential security

Changed Telegram connection flow so the browser no longer sends or stores Bot Token.

Current secure behavior:

- Frontend submits only:
  - `account_name`
  - `chat_id`
- Edge Function reads Bot Token from:
  - `TELEGRAM_BOT_TOKEN`, or
  - `TELEGRAM_ADMIN_BOT_TOKEN`
- `platform_credentials.encrypted_token` stores only a safe reference:
  - `edge-secret:TELEGRAM_BOT_TOKEN_OR_ADMIN`
- Real token remains inside Supabase Edge Function Secrets.

### 3. Telegram connection flow

Implemented Edge Function actions:

- `connect`
- `disconnect`
- `reconnect`
- `status`

Connection writes:

- `social_accounts`
- `platform_connections`
- private `platform_credentials` reference

The function validates Telegram access with:

- `getMe`
- `getChat`

It also attempts webhook registration when webhook secrets are present.

### 4. Telegram connect-code compatibility

Added a `/connect <code>` compatible webhook path inspired by the old project flow.

If `connect` is called without `chat_id`, the Edge Function returns a signed, 15-minute connect code.

Webhook can receive:

```text
/connect <code>
```

Then it binds the Telegram chat/channel to the authenticated user represented by that code.

The code is signed using:

- `TELEGRAM_CONNECT_SECRET`, or
- fallback `TELEGRAM_WEBHOOK_SECRET`

### 5. Telegram Publisher integration

Telegram publishing now stays behind the platform adapter boundary:

```text
Content Library
↓
Publish Task
↓
Telegram Adapter
↓
Supabase Edge Function platform
↓
Telegram Bot API
↓
publish_metrics / content_metrics
```

The Edge Function returns safe publish data:

- `message_id`
- `channel_id`
- `external_id`
- `url`
- `published_at`
- `metrics`

No token is returned.

### 6. Telegram webhook metrics

Existing webhook path remains connected to:

- `publish_tasks`
- `publish_metrics`
- `content_metrics`
- `campaign_links`

It handles:

- `message`
- `channel_post`
- `edited_channel_post`
- `message_reaction`
- `message_reaction_count`
- `callback_query`
- `/connect <code>`

### 7. Settings UI update

Updated:

- `src/pages/SettingsPage.jsx`
- `src/services/platform-connection-service.js`
- `src/services/platforms/platform-adapter.js`
- `src/styles.css`

Frontend now:

- no longer asks for Telegram Bot Token
- shows connection status only
- supports:
  - connect
  - disconnect
  - reconnect
  - status check

## Security design

Frontend can access:

- connection status
- account name
- account URL / chat identifier
- timestamps

Frontend cannot access:

- Bot Token
- refresh token
- service role key
- platform credentials table

Sensitive execution happens only in:

- `supabase/functions/platform/index.ts`

Required secrets:

- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` or `TELEGRAM_ADMIN_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `TRACKING_EVENT_SECRET`
- optional `TELEGRAM_CONNECT_SECRET`

## Files changed

- `supabase/migrations/20260720112159_phase3_8_1_telegram_platform_layer.sql`
- `supabase/functions/platform/index.ts`
- `supabase/functions/platform/README.md`
- `src/services/platform-connection-service.js`
- `src/services/platforms/platform-adapter.js`
- `src/pages/SettingsPage.jsx`
- `src/styles.css`

## Validation

Passed:

```text
npm run lint
npm run build
npm run migrations:check
```

Result:

- lint: passed
- build: passed
- migrations:check: safe

Additional note:

- Local `deno check` could not run because Deno is not installed in this Windows environment.
- Edge Function code was reviewed, but should be validated during Supabase function deployment.

## Deployment notes

This phase changes both frontend and Edge Function behavior.

Required deployment:

1. Push database migration.
2. Deploy `platform` Edge Function.
3. Ensure Supabase secrets exist.
4. Rebuild and redeploy GitHub Pages frontend.

Suggested commands:

```text
supabase db push
supabase functions deploy platform
npm run build
```

## Remaining work

Next phase should validate real Telegram production flow:

1. Connect Telegram channel from Settings.
2. Create a `publish_task`.
3. Execute publish from Publish Center.
4. Confirm Telegram message ID is saved.
5. Confirm `publish_metrics` is written.
6. Confirm webhook writes `content_metrics`.

Do not migrate other platforms until Telegram has passed this production test.
