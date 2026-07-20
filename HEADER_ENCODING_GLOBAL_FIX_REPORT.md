# Header Encoding Global Fix Report

## Problem

The production page still showed this error when saving data from multiple pages, including Social Accounts, Asset Library, and Prompt Library:

```text
Failed to execute 'set' on 'Headers':
String contains non ISO-8859-1 code point.
```

This means some non-ASCII value, such as Chinese text, a filename, a prompt, a category, or a metadata field, was being passed into an HTTP header.

## Root Cause

The earlier fix sanitized headers in the custom Supabase fetch wrapper, but it did not fully cover SDK-internal code paths.

Two remaining risks existed:

1. `src/main.jsx` installed the safe header patch after importing `App` and `AuthProvider`. Static module imports can load Supabase-related modules before the app body runs.
2. Some libraries can capture the native `Headers` constructor before `globalThis.Headers` is replaced. In that case, replacing `globalThis.Headers` alone is not enough.

The Social Accounts save error confirmed this was not only an upload issue. It was a global request-layer issue.

## Fix Implemented

### 1. Header patch now runs first

Added:

- `src/utils/safe-headers-init.js`

Updated:

- `src/main.jsx`

The app now imports the safe header initializer before importing React, App, Auth Provider, or any Supabase client code.

### 2. Native Headers prototype is now patched

Updated:

- `src/utils/safe-headers.js`

The patch now protects both:

- `globalThis.Headers`
- `NativeHeaders.prototype.set`
- `NativeHeaders.prototype.append`

This covers SDKs that already captured the original `Headers` constructor but still call `.set()` or `.append()` later.

### 3. Defensive error handling added

If a header name or value cannot be safely converted, the patch skips the unsafe header instead of allowing the browser request to crash.

## Files Changed

- `src/utils/safe-headers.js`
- `src/utils/safe-headers-init.js`
- `src/main.jsx`

Previous related files remain protected:

- `src/services/supabase-client.js`
- `src/services/asset-service.js`
- `src/services/collectors/telegram-collector.js`

## Validation

Local direct tests passed:

- New `Headers()` with non-ASCII values no longer throws.
- Previously captured native `Headers` constructor using `.set()` and `.append()` no longer throws.

Project checks passed:

```bash
npm run lint
npm run build
```

Latest build output:

- `dist/assets/index-C_behJwl.js`

## Deployment Requirement

Yes. This fix must be redeployed to GitHub Pages.

Until the new bundle is deployed, the live site will still use the old request-layer code and may keep showing the same error.

After deployment, hard refresh:

```text
Ctrl + F5
```

If Chrome still serves the old bundle, clear site data for:

```text
https://jiang289140790-eng.github.io/ai-marketing-studio/
```

## Final Status

The frontend request layer now guards against non-ASCII header crashes at both the app entry point and native `Headers` method level.

This should cover Social Accounts save, Asset upload, Prompt save, Supabase CRUD requests, Supabase Storage requests, and Edge Function calls.
