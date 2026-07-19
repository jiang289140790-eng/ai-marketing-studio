# GitHub Auth Setup

Project: `AI Marketing Studio`

Positioning: `Personal AI Ops Workspace`

Production URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Supabase production project:

```text
qtrlymiqohbjvklwegsw
```

Supabase callback URL:

```text
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

## Current frontend configuration

The app now uses GitHub OAuth:

```js
provider: 'github'
```

File:

```text
src/services/auth-service.js
```

Redirect target:

```js
window.location.origin + window.location.pathname
```

In production this resolves to:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

## Supabase setup

Open the correct Supabase project:

```text
qtrlymiqohbjvklwegsw
```

Go to:

```text
Authentication → Sign In / Providers → GitHub
```

Enable GitHub provider.

Configure:

```text
Client ID: <GitHub OAuth App Client ID>
Client Secret: <GitHub OAuth App Client Secret>
```

Do not configure this in the old/wrong project if the callback URL starts with:

```text
https://wyvswkxogkmywduhrhkw.supabase.co
```

The correct callback URL must start with:

```text
https://qtrlymiqohbjvklwegsw.supabase.co
```

## Supabase URL Configuration

Go to:

```text
Authentication → URL Configuration
```

Set Site URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Add Redirect URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Recommended local development Redirect URLs:

```text
http://localhost:5173/**
http://localhost:5174/**
http://localhost:5180/**
http://127.0.0.1:5173/**
http://127.0.0.1:5174/**
http://127.0.0.1:5180/**
```

## GitHub OAuth App setup

Open:

```text
GitHub → Settings → Developer settings → OAuth Apps
```

Create or edit an OAuth App.

Use:

```text
Application name:
AI Marketing Studio
```

```text
Homepage URL:
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

```text
Authorization callback URL:
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

Copy from GitHub OAuth App into Supabase:

```text
Client ID
Client Secret
```

## Security notes

GitHub OAuth Client Secret belongs only in:

```text
Supabase Dashboard → Authentication → Sign In / Providers → GitHub
```

Do not put these in GitHub Pages, frontend code, or `.env.example` as real values:

```text
GitHub OAuth Client Secret
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TRACKING_EVENT_SECRET
```

GitHub Pages should only use:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
```

## Verification

After Supabase GitHub provider is enabled:

1. Open:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

2. Click:

```text
GitHub 登录
```

3. Expected flow:

```text
GitHub Pages app
→ Supabase Auth
→ GitHub OAuth
→ Supabase callback
→ GitHub Pages app
→ session detected by supabase-js
```

4. Expected result:

```text
Dashboard shows logged-in GitHub user information.
```

## Common errors

### Unsupported provider: provider is not enabled

Cause:

```text
GitHub provider is disabled or incomplete in Supabase.
```

Fix:

```text
Enable GitHub provider in the qtrlymiqohbjvklwegsw Supabase project and add Client ID / Client Secret.
```

### redirect_uri_mismatch

Cause:

```text
GitHub OAuth App callback URL does not match Supabase Auth callback URL.
```

Fix:

```text
Set GitHub OAuth App Authorization callback URL to:
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

### Login returns to the wrong project

Cause:

```text
Provider was configured in the wrong Supabase project.
```

Fix:

```text
Use the Supabase project qtrlymiqohbjvklwegsw.
```

## Final status

Frontend GitHub provider:

```text
CONFIGURED
```

Supabase GitHub provider:

```text
ACTION REQUIRED IN DASHBOARD
```
