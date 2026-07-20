# Global Header Encoding Fix Report

## Error

```text
TypeError: Failed to execute 'set' on 'Headers':
String contains non ISO-8859-1 code point.
```

## Scope

The issue appeared globally, across multiple pages, including:

- Dashboard
- Social Accounts
- Asset Library
- Prompt Library

This indicated a shared request-layer problem rather than a single page bug.

## Project Scan

Scanned:

- `src/services`
- `src/lib`
- `src/hooks`
- `src/pages`
- Supabase Edge Function call sites

Search targets:

- `Headers.set`
- `Headers.append`
- `new Headers`
- `headers:`
- `fetch(`
- `supabase.functions.invoke`
- `Authorization`
- `apikey`

Findings:

- `src/lib` does not exist.
- `src/hooks` does not exist.
- No page-level code was found placing business data directly into HTTP headers.
- Request entry points are centralized in:
  - `src/services/supabase-client.js`
  - `src/services/asset-service.js`
  - `src/services/collectors/telegram-collector.js`
  - `client.functions.invoke(...)` call sites

## Root Cause

The deployed GitHub Pages bundle contained a hidden UTF-8 BOM character before Supabase environment values:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

This invisible character is `U+FEFF`.

When the Supabase client used the anon key as an `apikey` header value, the browser rejected the header because `U+FEFF` is not a valid ISO-8859-1 header code point.

That is why the error appeared on every page that attempted to read from Supabase.

Follow-up inspection also confirmed that copied secrets may appear in multiple BOM forms:

- Standard invisible BOM: `U+FEFF`
- Latin-1 mojibake prefix: `\u00EF\u00BB\u00BF`
- Common CJK mojibake prefixes: `\u9518\u7E23`, `\u9518\u00BF`

## Fix

Updated:

- `src/services/supabase-client.js`

Changes:

- Added centralized environment value cleanup.
- Removed leading BOM and common BOM-mojibake prefixes.
- Removed invisible zero-width characters.
- Trimmed accidental whitespace from Supabase URL and anon key.
- Exported cleaned `supabaseUrl` and `supabaseAnonKey`.

Updated:

- `src/services/asset-service.js`

Changes:

- Stopped reading raw `import.meta.env.VITE_SUPABASE_URL`.
- Stopped reading raw `import.meta.env.VITE_SUPABASE_ANON_KEY`.
- Reused the cleaned values exported by `supabase-client.js`.

## Authorization Safety

Normal Authorization is preserved.

The fix does not remove valid ASCII tokens such as:

- Supabase JWT access tokens
- Supabase anon/publishable keys
- `Bearer ...`
- `apikey`

It only removes invisible invalid characters before environment values are used.

## Validation

Executed a build test with intentionally BOM-prefixed fake Supabase values.

Result:

- The app builds successfully with BOM-prefixed environment values.
- Runtime config cleanup removes BOM and mojibake prefixes before Supabase client creation.
- Cleaned values are used by Supabase client, manual Storage upload, and request header generation.

Executed:

```bash
npm run lint
npm run build
```

Result:

- Lint passed.
- Build passed.

## Deployment Note

Because this is frontend runtime code, GitHub Pages must be redeployed before the live site reflects the fix.

Recommended additional cleanup:

- Re-save GitHub Actions Secrets for `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` manually without copying any leading invisible character.

The code-level cleanup now protects against the same mistake happening again.
