# X Platform Migration Analysis

## Source project analyzed

Old project path:

`C:\Users\admin\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c83f9e12-0943-4828-8fec-f00ab3b0d0bd\trypost-ops`

Files reviewed:

- `app/Http/Controllers/Auth/XController.php`
- `app/Http/Controllers/Auth/SocialController.php`
- `app/Socialite/XProvider.php`
- `app/Services/Social/XPublisher.php`
- `app/Services/Social/ConnectionVerifier.php`
- `app/Jobs/RefreshSocialToken.php`
- `config/trypost.php`

## Old X OAuth flow

The old project uses Laravel Socialite with a custom X provider.

Flow:

```text
Accounts page
↓
XController::connect()
↓
SocialController::redirectToProvider()
↓
X OAuth authorize
↓
XController::callback()
↓
SocialController::handleCallback()
↓
SocialAccount updateOrCreate()
```

Required scopes:

- `tweet.read`
- `tweet.write`
- `media.write`
- `users.read`
- `offline.access`

The old custom provider removes `users.email` because most X apps do not have email access.

User profile endpoint:

- `GET https://api.x.com/2/users/me`
- Authorization: `Bearer <access_token>`
- Query: `user.fields=profile_image_url`

Stored account fields in old project:

- `platform`
- `platform_user_id`
- `username`
- `display_name`
- `avatar_url`
- `access_token`
- `refresh_token`
- `token_expires_at`
- `scopes`
- `status`
- `error_message`
- `disconnected_at`

## Old token refresh flow

The old project refreshes X tokens through `ConnectionVerifier::refreshXToken()`.

Endpoint:

- `POST https://api.x.com/2/oauth2/token`

Auth:

- HTTP Basic Auth using `X_CLIENT_ID` and `X_CLIENT_SECRET`

Payload:

- `grant_type=refresh_token`
- `refresh_token=<refresh_token>`

Behavior:

- X refresh tokens can rotate.
- The old project avoids unnecessary proactive refresh because concurrent refresh can invalidate the previous refresh token.
- Verification tries the current access token first.
- If it receives `401`, it refreshes and retries once.

## Old publish flow

The old X publisher uses:

- `POST https://api.x.com/2/tweets`

Payload:

```json
{
  "text": "post text",
  "media": {
    "media_ids": ["..."]
  }
}
```

Text-only posts are supported.

Media support:

- small images: simple upload
- large images / videos / GIFs: chunked upload
- upload endpoints are under the X API base URL in the old project

Returned publish result:

- `id`
- `url`: `https://x.com/{username}/status/{tweet_id}`

## Mapping to AI Marketing Studio

### social_accounts

Use as the public account entity:

- `platform = X`
- `account_name = X display name`
- `account_url = https://x.com/{username}`
- `avatar = profile image URL`
- `status = active`
- `api_status = connected`

### platform_connections

Use as the authorization state:

- `platform = X`
- `account_id = social_accounts.id`
- `status = connected / disconnected / error`
- `auth_type = oauth2_pkce`
- `permissions = ["tweet.read","tweet.write","media.write","users.read","offline.access"]`
- `expires_at = token expiry`
- `metadata.x.user_id`
- `metadata.x.username`
- `metadata.x.name`

### platform_credentials

Use as Edge Function only secure storage:

- `connection_id`
- `encrypted_token = access token`
- `refresh_token`
- `token_type = bearer`
- `scopes`
- `expires_at`
- `metadata.provider = x`

Frontend must never read this table.

## Migration decision

For Phase 3.9:

- OAuth, callback, token refresh, status, disconnect, reconnect, and text publish are implemented in the existing `platform` Edge Function.
- Media upload is prepared as a future enhancement because production validation only requires one test tweet and the first safe path is text-only.
- No frontend token handling is added.
- No SaaS billing / subscription / workspace logic is migrated.

## Required production secrets

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`
- optional `X_API_BASE_URL` defaults to `https://api.x.com/2`
- optional `X_OAUTH_BASE_URL` defaults to `https://twitter.com/i/oauth2`
- optional `X_OAUTH_TOKEN_URL` defaults to `https://api.x.com/2/oauth2/token`
- optional `X_OAUTH_STATE_SECRET`

## Current validation blocker

Supabase production project `qtrlymiqohbjvklwegsw` currently has no `X_` secrets configured.

Real tweet publishing requires:

1. X Developer App.
2. OAuth callback URL pointing to the Supabase `platform` Edge Function.
3. X OAuth authorization completed once.
4. Stored `platform_credentials` for the X account.

Without those, the implementation can be built and checked, but real tweet publish cannot be executed yet.
