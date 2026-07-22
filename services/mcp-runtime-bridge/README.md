# AI Marketing Studio MCP Runtime Bridge

This service is the trusted HTTPS runtime layer between Supabase Edge Functions and the local/stdout AI Marketing Studio MCP server.

It must run in a trusted long-running Node.js environment. Do not expose it directly to browsers.

## Endpoints

- `POST /v1/actions`
- `GET /health`
- `GET /v1/runs/:id` currently returns 501; browser status reads should go through Supabase `ops-status`.

## Required environment variables

- `OPS_MCP_BRIDGE_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKETING_STUDIO_MCP_DIR`

Optional:

- `MCP_RUNTIME_BRIDGE_PORT`
- `X_MCP_ENABLED`
- `AUTODL_BASE_URL`
- `COMFYUI_BASE_URL`

## Security

- Requests must include `X-Ops-Signature`.
- Browser direct access is not supported.
- Only allowlisted business actions are mapped to MCP tools.
- `execute_publish` is forced to `dry_run` unless payload explicitly passes `dry_run=false`; testing should keep dry-run enabled.
