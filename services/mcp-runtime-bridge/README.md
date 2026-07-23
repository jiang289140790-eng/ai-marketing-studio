# AI Marketing Studio MCP Runtime Bridge

This service is the trusted HTTPS runtime layer between Supabase Edge Functions and the local/stdout AI Marketing Studio MCP server.

It must run in a trusted long-running Node.js environment. Do not expose it directly to browsers.
It cannot run on GitHub Pages and should not depend on a browser tab being open.

## Endpoints

- `POST /v1/actions`
- `GET /health`
- `GET /v1/runs/:id`

`/health` is the platform health-check path for Render, Railway, Fly.io, or a normal cloud server.

## Required environment variables

- `OPS_MCP_BRIDGE_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKETING_STUDIO_MCP_DIR`

Optional:

- `MCP_TOOL_TIMEOUT_MS`（默认 45000）
- `BRIDGE_REQUEST_TIMEOUT_MS`（默认 60000）
- `MCP_RUNTIME_BRIDGE_HOST` (default `0.0.0.0`)
- `MCP_RUNTIME_BRIDGE_PORT`
- `MARKETING_STUDIO_MCP_COMMAND`
- `MARKETING_STUDIO_MCP_ARGS`
- `X_MCP_ENABLED`
- `AUTODL_BASE_URL`
- `COMFYUI_BASE_URL`
- `ALLOW_REAL_PUBLISH=false`

当前 `X_MCP_ENABLED` 仅用于健康状态标记；X MCP 的远程 transport 与工具注册仍需在真实 Bridge 环境中完成，不能仅凭该标记视为已接通。

After deployment, configure these Supabase Edge Function secrets:

- `OPS_MCP_BRIDGE_URL=https://your-bridge-domain`
- `OPS_MCP_BRIDGE_SECRET=the-same-long-random-secret`

## Docker deployment

```bash
docker build -t ai-marketing-studio-mcp-runtime-bridge .
docker run -p 8787:8787 --env-file .env ai-marketing-studio-mcp-runtime-bridge
```

The service must be placed behind HTTPS before Supabase Edge Functions call it.
For a cloud VM, use Caddy, Nginx, Cloudflare Tunnel, Render, Railway, or Fly.io to provide HTTPS.

## Verification

1. Start the bridge with all required environment variables.
2. Confirm the host exposes `GET /health` over HTTPS.
3. Set `OPS_MCP_BRIDGE_URL` and `OPS_MCP_BRIDGE_SECRET` in Supabase Edge Function secrets.
4. Redeploy `ops-health` and `ops-execute`.
5. Log in to the GitHub Pages frontend and confirm `ops-health` returns:

```json
{
  "edge_function": true,
  "bridge_configured": true,
  "bridge": true,
  "mcp": true
}
```

## Security

- Requests must include `X-Ops-Signature`.
- Browser direct access is not supported.
- Only allowlisted business actions are mapped to MCP tools.
- `execute_publish` is forced to `dry_run=true` unless the bridge has `ALLOW_REAL_PUBLISH=true`.
- Secrets such as Supabase service role, X Client Secret, OAuth tokens, MCP signing key, AutoDL, ComfyUI, or model keys must never be committed.
