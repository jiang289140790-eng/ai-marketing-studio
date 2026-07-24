# Production runtime bundle

This directory creates a private Docker build context containing both:

- `services/mcp-runtime-bridge`
- the external `marketing-studio` MCP server

The generated `.runtime-build` directory is ignored by Git and must never be committed.

```powershell
.\Prepare-RuntimeBundle.ps1
docker build -t ai-marketing-studio-runtime .\.runtime-build
```

Provide all secrets only through the deployment platform secret store:

```text
OPS_MCP_BRIDGE_SECRET
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

Keep these runtime settings:

```text
MARKETING_STUDIO_MCP_DIR=/app/marketing-studio-mcp
MCP_RUNTIME_BRIDGE_HOST=0.0.0.0
MCP_RUNTIME_BRIDGE_PORT=8787
ALLOW_REAL_PUBLISH=false
```

The bundle script excludes `.env`, `.env.*`, `node_modules`, logs, tests, docs,
migrations, and nested Supabase sources. Inspect the generated context before every
production build.
