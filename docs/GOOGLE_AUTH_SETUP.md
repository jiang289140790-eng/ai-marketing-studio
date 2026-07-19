# Google Auth Setup

Project: `AI Marketing Studio`

Positioning: `Personal AI Ops Workspace`

Production URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Supabase project:

```text
qtrlymiqohbjvklwegsw
```

Supabase URL:

```text
https://qtrlymiqohbjvklwegsw.supabase.co
```

Current error:

```text
Unsupported provider: provider is not enabled
```

## Summary

The frontend OAuth provider is already correct.

Current code uses:

```js
provider: 'google'
```

The error means Google sign-in is not enabled/configured in the Supabase production project.

## 1. Frontend OAuth provider check

File:

```text
src/services/auth-service.js
```

Current implementation:

```js
await client.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: window.location.origin + window.location.pathname,
  },
});
```

Status:

```text
PASS
```

Reason:

Supabase OAuth provider name for Google is:

```text
google
```

The deployed site redirects back to the current page path. In production this resolves to:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

No frontend code change is required for the current error.

## 2. Supabase configuration

Open Supabase Dashboard:

```text
https://supabase.com/dashboard/project/qtrlymiqohbjvklwegsw
```

Go to:

```text
Authentication → Sign In / Providers → Google
```

Enable Google provider.

Configure:

```text
Enabled: true
Client ID: <Google OAuth Client ID>
Client Secret: <Google OAuth Client Secret>
```

Do not put the Google Client Secret in frontend code or GitHub Pages.

## 3. Supabase URL Configuration

Go to:

```text
Authentication → URL Configuration
```

Set Site URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Add Redirect URLs:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Recommended development redirect URLs:

```text
http://localhost:5173/**
http://localhost:5174/**
http://localhost:5180/**
http://127.0.0.1:5173/**
http://127.0.0.1:5174/**
http://127.0.0.1:5180/**
```

Notes:

- Supabase Redirect URLs are the destinations allowed after users sign in to this app.
- The frontend `redirectTo` value must match one of these allowed URLs.
- For this GitHub Pages app, the exact production redirect URL should be added.

## 4. Google Cloud configuration

Open Google Cloud Console:

```text
https://console.cloud.google.com/apis/credentials
```

Create or select a project.

Configure OAuth consent screen:

```text
App name: AI Marketing Studio
User support email: your email
Developer contact information: your email
Publishing status: Testing or Production
Scopes: openid, email, profile
```

Create credentials:

```text
Credentials → Create Credentials → OAuth client ID
Application type: Web application
```

Authorized JavaScript origins:

```text
https://jiang289140790-eng.github.io
```

Authorized redirect URIs:

```text
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

Important:

Google Cloud redirect URI is the Supabase Auth callback URL, not the GitHub Pages URL.

Supabase receives the Google OAuth callback first, then Supabase redirects the browser back to the app URL configured by `redirectTo`.

## 5. Required configuration map

| Area | Required value |
| --- | --- |
| Frontend provider | `google` |
| Frontend redirectTo | `https://jiang289140790-eng.github.io/ai-marketing-studio/` |
| Supabase Site URL | `https://jiang289140790-eng.github.io/ai-marketing-studio/` |
| Supabase Redirect URL | `https://jiang289140790-eng.github.io/ai-marketing-studio/` |
| Google JavaScript origin | `https://jiang289140790-eng.github.io` |
| Google redirect URI | `https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback` |

## 6. Production deployment notes

GitHub Pages should only expose frontend-safe variables:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

Do not add these to GitHub Pages or frontend code:

```text
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_SECRET
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TRACKING_EVENT_SECRET
```

Google OAuth Client Secret belongs only in:

```text
Supabase Dashboard → Authentication → Providers → Google
```

The Supabase anon key is acceptable in frontend code. Supabase service-role key is not.

## 7. Verification steps

After enabling Google provider:

1. Open:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

2. Click:

```text
Google 登录
```

3. Expected flow:

```text
GitHub Pages app
→ Supabase Auth
→ Google OAuth
→ Supabase callback
→ GitHub Pages app
→ session detected by supabase-js
```

4. Expected result:

```text
Dashboard shows logged-in user information.
```

## 8. Error guide

### Unsupported provider: provider is not enabled

Cause:

```text
Google provider is disabled or incomplete in Supabase Auth provider settings.
```

Fix:

```text
Enable Google provider and add Google OAuth Client ID / Client Secret in Supabase.
```

### redirect_to is not allowed

Cause:

```text
The app redirect URL is missing from Supabase Redirect URLs.
```

Fix:

```text
Add https://jiang289140790-eng.github.io/ai-marketing-studio/ to Supabase Redirect URLs.
```

### Google Error 400: redirect_uri_mismatch

Cause:

```text
Google Cloud OAuth client does not include the Supabase callback URL.
```

Fix:

```text
Add https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback to Google Authorized redirect URIs.
```

## 9. Official references

- Supabase Login with Google: `https://supabase.com/docs/guides/auth/social-login/auth-google`
- Supabase Redirect URLs: `https://supabase.com/docs/guides/auth/redirect-urls`
- Google OAuth credentials: `https://console.cloud.google.com/apis/credentials`

## Final status

Frontend OAuth provider:

```text
PASS
```

Supabase Google provider:

```text
ACTION REQUIRED
```

Required action:

```text
Enable Google provider in Supabase and configure Google Cloud OAuth Client ID / Client Secret.
```
