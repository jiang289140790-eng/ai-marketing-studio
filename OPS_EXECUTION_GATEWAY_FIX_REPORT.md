# AI Marketing Studio Execution Gateway Fix Report

Date: 2026-07-22

## Scope

Based on commit `3b60e47`, this change fixes the current online Command Center reliability issues without redesigning the existing dark Command Center or changing database schema.

## Fixed

### 1. `publish_metrics.created_at` query error

Location:

- `src/services/ops-service.js`

Change:

- Added per-source default ordering via `ORDER_FIELDS`.
- `publishMetrics` now orders by `last_sync`.
- `contentMetrics` orders by `collected_at`.
- `readRows()` no longer assumes every table has `created_at`.
- If a source has no reliable time field, it can skip ordering by leaving it out of `ORDER_FIELDS`.

### 2. Duplicate execution gateway errors

Locations:

- `src/components/ExecutionStatus.jsx`
- `src/components/ExecutionButton.jsx`
- `src/hooks/useExecutionAction.js`
- `src/services/execution-gateway.js`

Change:

- Command Center now uses one gateway status card.
- Technical gateway details are moved into a collapsed "查看连接详情" section.
- Buttons no longer repeat the full `OPS_MCP_BRIDGE_URL / OPS_MCP_BRIDGE_SECRET` error under every action.
- Disabled buttons show local business reasons, such as incomplete form fields.

### 3. Campaign creation error display

Location:

- `src/pages/CampaignStrategyPage.jsx`

Change:

- Empty name/goal: only shows "请先填写名称和目标".
- Complete form but disconnected Bridge: shows "执行服务暂未连接，请查看上方连接状态".
- Connected gateway: button can submit `create_campaign`.
- Success still refreshes the Campaign list via the existing callback.

### 4. Responsive layout and sidebar clipping

Locations:

- `src/components/Sidebar.jsx`
- `src/styles.css`

Change:

- Sidebar width is stable and no longer shrinks to 220px on medium screens.
- Main area uses `min-width: 0` and avoids horizontal page overflow.
- Sidebar labels are wrapped in `.nav-label` so icon/text layout does not clip.
- Verified viewport widths: `1366x768`, `1440x900`, `1920x1080`, plus a small-screen smoke check at `760x900`.

## Verification

Commands:

- `npm run lint` ✅
- `npm run build` ✅
- `npm run migrations:check` ✅
- `git diff --check` ✅

Local layout smoke test:

- `1366x768`: no horizontal overflow ✅
- `1440x900`: no horizontal overflow ✅
- `1920x1080`: no horizontal overflow ✅
- `760x900`: no horizontal overflow ✅

## Bridge status

The production Supabase project currently does not have:

- `OPS_MCP_BRIDGE_URL`
- `OPS_MCP_BRIDGE_SECRET`

Therefore the Bridge is **not** considered deployed or connected.

Current truthful expected UI state:

- Supabase: 已连接
- Edge Function: 已部署, if authenticated Edge Function call succeeds
- MCP Bridge: 未配置
- AI Marketing Studio MCP: 等待 Bridge
- X MCP: 等待 Bridge

Do not mark the online execution loop as complete until a public HTTPS Bridge is deployed and `ops-health` returns:

```json
{
  "edge_function": true,
  "bridge_configured": true,
  "bridge": true,
  "mcp": true
}
```

## Bridge deployment steps still required

1. Deploy `services/mcp-runtime-bridge` as a long-running HTTPS Node service on Render, Railway, Fly.io, or a cloud server.
2. Configure Bridge runtime environment:
   - `MCP_RUNTIME_BRIDGE_HOST=0.0.0.0`
   - `OPS_MCP_BRIDGE_SECRET=<strong random secret>`
   - Supabase URL and service role variables
   - MCP server directory/config variables
3. Confirm public `/health` returns healthy Bridge and MCP tool data.
4. Configure the same secret in Supabase Edge Function secrets:
   - `OPS_MCP_BRIDGE_URL=https://actual-bridge-domain`
   - `OPS_MCP_BRIDGE_SECRET=<same strong random secret>`
5. Redeploy:
   - `ops-health`
   - `ops-execute`
   - `ops-status`

