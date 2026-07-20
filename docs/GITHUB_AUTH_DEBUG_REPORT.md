# GitHub Auth Debug Report

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

Date:

```text
2026-07-20
```

## Current symptom

After clicking `GitHub 登录` on the production site, the page shows:

```text
登录状态已重置，请重新点击 GitHub 登录。
```

## Current diagnosis

The frontend GitHub provider is configured as `github`.

The most likely current issue is not the provider name. It is the app's session recovery UX / PKCE callback recovery flow:

1. The app uses Supabase Auth with PKCE.
2. The app manually exchanges OAuth `code` through `exchangeCodeForSession()`.
3. If code exchange fails because the PKCE verifier is missing or stale, the app treats that as recoverable and returns `null`.
4. In `App.jsx`, any `null` session currently triggers:

```text
登录状态已重置，请重新点击 GitHub 登录。
```

This means the notice can appear when:

- the browser has a stale OAuth callback URL;
- the browser storage was cleared between OAuth start and return;
- the OAuth flow was started in one tab/browser and completed in another;
- the user is simply not logged in yet;
- the app cleared old Supabase auth storage after detecting a bad stored token.

So the message is currently too broad. It does not by itself prove that GitHub OAuth provider configuration is wrong.

## 1. Supabase Auth provider configuration requirements

Supabase Dashboard:

```text
Authentication → Sign In / Providers → GitHub
```

Required:

```text
GitHub enabled: on
Client ID: GitHub OAuth App Client ID
Client Secret: GitHub OAuth App Client Secret
```

Correct production callback URL shown by Supabase should be:

```text
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

Notes:

- Do not configure the old project callback:

```text
https://wyvswkxogkmywduhrhkw.supabase.co/auth/v1/callback
```

- Do not put GitHub Client Secret in frontend code or GitHub Pages secrets.
- GitHub Client Secret belongs only in Supabase Provider settings.

## 2. Frontend OAuth provider check

File:

```text
src/services/auth-service.js
```

Current provider:

```js
provider: 'github'
```

Status:

```text
PASS
```

The frontend provider is correct.

## 3. redirectTo check

File:

```text
src/services/auth-service.js
```

Current redirect:

```js
redirectTo: window.location.origin + window.location.pathname
```

On production GitHub Pages this resolves to:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Supabase URL Configuration must include:

```text
Site URL:
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

```text
Redirect URLs:
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Status:

```text
LIKELY PASS
```

If Supabase URL Configuration still has `localhost:3000` as Site URL, GitHub OAuth can return to the wrong place. But based on prior screenshots, the production GitHub Pages URL appears to have been configured.

## 4. Session recovery logic check

Files:

```text
src/services/supabase-client.js
src/services/auth-service.js
src/App.jsx
```

Current Supabase client auth config:

```js
persistSession: true
autoRefreshToken: true
detectSessionInUrl: false
flowType: 'pkce'
storageKey: 'ai-marketing-studio-auth-session'
```

Current session initialization:

```js
initializeAuthSession()
```

Behavior:

- If URL has `code`, app calls `exchangeCodeForSession(code)`.
- If code exchange succeeds, session should persist.
- If code exchange fails with stale/missing PKCE verifier, app returns `null`.
- If `initializeAuthSession()` returns `null`, app shows:

```text
登录状态已重置，请重新点击 GitHub 登录。
```

Risk:

```text
The current UX displays a reset notice for ordinary null session states, not only real reset events.
```

This is why the page can look stuck even when provider configuration is mostly correct.

## 5. GitHub OAuth callback configuration

GitHub:

```text
Settings → Developer settings → OAuth Apps → AI Marketing Studio
```

Required configuration:

```text
Homepage URL:
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

```text
Authorization callback URL:
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

Supabase GitHub Provider:

```text
Client ID:
Ov23LiRvF0a5STVey37y
```

Client Secret:

```text
Must be the current GitHub OAuth App secret generated for this exact Client ID.
```

Do not use:

```text
open-video-studio
AI Marketing Studio
```

as Client ID in Supabase. Those are names, not OAuth client IDs.

## Current problem reason

Most likely current reason:

```text
The app is treating a null/recovered auth session as a user-facing reset state.
```

Secondary possible reasons:

```text
1. Browser has stale OAuth callback URL or stale localStorage from earlier failed attempts.
2. PKCE verifier was removed because the flow was started before the latest deployment and completed after the app code changed.
3. OAuth was started in one browser context and completed in another.
4. GitHub Client Secret in Supabase is not the latest secret for Client ID Ov23LiRvF0a5STVey37y.
```

## Need to configure

### Supabase

Confirm:

```text
Project: qtrlymiqohbjvklwegsw
Authentication → Sign In / Providers → GitHub → enabled
Client ID: Ov23LiRvF0a5STVey37y
Client Secret: latest GitHub OAuth App secret
```

Confirm:

```text
Authentication → URL Configuration
Site URL: https://jiang289140790-eng.github.io/ai-marketing-studio/
Redirect URL: https://jiang289140790-eng.github.io/ai-marketing-studio/
```

### GitHub

Confirm:

```text
OAuth App: AI Marketing Studio
Authorization callback URL:
https://qtrlymiqohbjvklwegsw.supabase.co/auth/v1/callback
```

## Does code need to change?

Yes, a small auth UX/session-handling code change is recommended.

Recommended non-business-functional code change:

```text
Do not show “登录状态已重置，请重新点击 GitHub 登录。” for every null session.
```

Better behavior:

1. On normal no-session page load:

```text
Show only the GitHub 登录 button.
```

2. On stale PKCE callback:

```text
Clean URL parameters silently.
Then check existing session.
If session exists: show 已登录.
If no session exists: show GitHub 登录 button.
```

3. Only show a reset notice when the app actually removed corrupted stored auth data.

4. If login launch fails:

```text
Show the concrete sign-in error near the button.
```

This change does not alter business features. It only improves auth state handling and user feedback.

## Immediate manual test

Use a clean URL:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

Do not test with URLs containing:

```text
?code=
?error=
#access_token=
```

Then:

1. Open DevTools → Application → Local Storage.
2. Delete entries related to:

```text
ai-marketing-studio-auth-session
supabase
sb-
qtrlymiqohbjvklwegsw
```

3. Refresh.
4. Click `GitHub 登录`.
5. Confirm whether GitHub redirects back to:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

6. Expected final UI:

```text
已登录 + GitHub user info + 退出
```

## Official references

- Supabase Login with GitHub: `https://supabase.com/docs/guides/auth/social-login/auth-github`
- Supabase Redirect URLs: `https://supabase.com/docs/guides/auth/redirect-urls`

## Final conclusion

Current status:

```text
Provider name: correct
redirectTo: correct for production
GitHub callback shape: correct if configured with qtrlymiqohbjvklwegsw callback
Session persistence: enabled
User-facing reset notice: too broad
```

Recommended next action:

```text
Make a small auth UI/session recovery code adjustment so stale PKCE/null sessions do not show as a persistent reset warning.
```

## Update: direct authorize URL issue

A direct link to:

```text
/auth/v1/authorize?provider=github&redirect_to=...
```

is not sufficient for this app because the frontend is using PKCE.

Problem:

```text
The direct authorize URL can return ?code=... to the app, but the browser does not have the matching PKCE code verifier in storage.
```

Result:

```text
The app cannot exchange the returned code for a session.
```

Correct approach:

```text
Use supabase-js signInWithOAuth({ provider: 'github', options: { redirectTo } })
```

This lets Supabase JS create and store the PKCE verifier before redirecting to the provider.

## Update: production click diagnosis

Checked production bundle:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/assets/index-Bbhtejyx.js
```

Confirmed:

```text
Production bundle contains the correct Supabase project URL.
Production bundle contains the frontend anon key.
Production bundle contains GitHub login code.
Supabase /auth/v1/authorize can redirect to GitHub.
```

A local SDK-only authorization URL generation test succeeded:

```text
provider: github
redirect_to: https://jiang289140790-eng.github.io/ai-marketing-studio/
code_challenge: present
code_challenge_method: s256
storage key: ai-marketing-studio-auth-session-code-verifier
```

This proves the provider and redirect config are basically valid. The fragile part is browser-side redirect execution and preserving the PKCE verifier.

## Applied fix

Changed GitHub login launch to:

```js
const { data, error } = await client.auth.signInWithOAuth({
  provider: 'github',
  options: {
    redirectTo: window.location.origin + window.location.pathname,
    skipBrowserRedirect: true,
  },
});

window.location.assign(data.url);
```

Why:

```text
Supabase SDK still creates and stores the PKCE verifier.
The app explicitly navigates to the SDK-generated URL.
This avoids relying on the SDK/browser default redirect side effect.
Do not use a hand-written authorize URL.
```

Expected result:

```text
Clicking GitHub 登录 should immediately leave the app and open GitHub authorization.
After authorization, the app should return to the clean production URL and show 已登录.
```
