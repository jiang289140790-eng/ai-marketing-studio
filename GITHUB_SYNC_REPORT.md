# GitHub Sync Report

Project: `ai-marketing-studio`

## GitHub repository

```text
https://github.com/jiang289140790-eng/ai-marketing-studio
```

Repository visibility:

```text
private
```

Branch:

```text
main
```

## Primary sync commit

```text
086346b9b868278bb0d5cbc116aedc64b9a01984
```

Commit message:

```text
Initial AI Marketing Studio workspace
```

## Synced files

130 project files were committed and pushed.

Included categories:

- React/Vite app source under `src/`
- Supabase migrations under `supabase/migrations/`
- Supabase Edge Function source under `supabase/functions/platform/`
- project scripts under `scripts/`
- documentation and production validation reports under `docs/`
- root phase reports
- package files
- `.env.example`
- `.gitignore`

## Not committed

The following local/runtime files were intentionally excluded:

- `.env`
- `.env.local`
- `.env.*.local`
- `.phase*`
- `PHASE214_*RESULT.json`
- `node_modules/`
- `dist/`
- `*.log`
- `supabase/.temp/`
- `supabase/.branches/`

GitHub Actions workflow note:

```text
.github/workflows/deploy-github-pages.yml
```

was not pushed because GitHub rejected workflow file updates from the current OAuth token without the `workflow` scope. The main project code was pushed successfully. To sync the workflow later, refresh GitHub CLI auth with `workflow` scope and commit that file separately.

## Secret check

Checks performed before commit:

- staged diff scan for Telegram bot token pattern
- staged diff scan for Supabase JWT/service role token pattern
- staged diff scan for non-placeholder `SUPABASE_SERVICE_ROLE_KEY`
- staged diff scan for non-placeholder Telegram token variables
- ignored file review for local temporary secret/session artifacts

Result:

```text
No real Telegram Bot Token, Supabase service role key, Supabase JWT, .env, or .env.local file was committed.
```

Only placeholder examples remain in `.env.example`.

## Validation before push

```text
npm run lint
npm run build
npm run migrations:check
```

Result:

```text
Passed
```

## Push result

```text
main -> origin/main
```

Status:

```text
Pushed successfully
```

