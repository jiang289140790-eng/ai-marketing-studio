# AI Marketing Studio 线上执行闭环报告

## 1. 最终执行架构

当前实现为三层安全链路：

```text
GitHub Pages 前端
  → Supabase Auth
  → Supabase Edge Function：ops-execute / ops-status / ops-health
  → 可信 MCP Runtime Bridge
  → AI Marketing Studio MCP（当前为 stdio）
  → Supabase 写回 ops_runs 与业务结果
  → 前端轮询状态并显示进度 / 错误 / run_id
```

前端不保存：

- Supabase service role
- X Client Secret
- OAuth Token
- MCP Secret
- AutoDL Key
- ComfyUI 密钥
- Bridge 签名密钥

## 2. 现状审计

### 当前前端执行层

- `src/services/execution-gateway.js`
  - 已从静态占位升级为真实执行客户端
  - 支持 `ops-health`
  - 支持 `ops-execute`
  - 支持 `ops-status`
  - 支持 action allowlist
  - 支持 idempotency key

- `src/components/ExecutionButton.jsx`
  - 已从永久 disabled 改为状态机
  - 状态包括：
    - `unavailable`
    - `ready`
    - `submitting`
    - `queued`
    - `running`
    - `completed`
    - `failed`
  - 显示真实错误和 `run_id`

- `src/hooks/useExecutionAction.js`
  - 统一执行 hook
  - 页面不再重复手写鉴权和请求逻辑

- `src/components/ExecutionStatus.jsx`
  - 显示当前执行网关 / Bridge / MCP 健康状态

### 当前 Supabase Edge Functions

已有：

- `ai-gateway`
- `media-gateway`
- `platform`

新增：

- `ops-execute`
- `ops-status`
- `ops-health`
- `_shared/ops-gateway.ts`

### 当前执行记录

新增最小表：

- `ops_runs`

原因：现有 `agent_runs` / `workflow_runs` 字段不足以统一表达所有前端触发动作、idempotency、resource_type、resource_id、progress、retryable 和安全错误码。

没有删除或破坏：

- `agent_runs`
- `workflow_runs`

### 当前 AI Marketing Studio MCP

本地 MCP 项目：

`E:\projects\video-generator\mcp-servers\marketing-studio`

当前传输模式：

- `stdio`

这意味着：

- Supabase Edge Function 不能直接启动本地 MCP 进程
- 必须通过可信 HTTPS Runtime Bridge 调用

### 当前可公网访问的 MCP 服务

目前仓库中没有发现可直接公网访问的 AI Marketing Studio MCP 服务。

本次新增：

- `services/mcp-runtime-bridge`

但是否线上可用取决于是否部署到一个可长期运行 Node 进程的环境。

本地 Bridge 健康测试结果：

- Bridge：可启动
- AI Marketing Studio MCP：可连接
- MCP 工具数量：43
- X MCP：当前 Bridge 环境显示 `unknown`
- AutoDL：当前 Bridge 环境显示 `unknown`
- ComfyUI：当前 Bridge 环境显示 `unknown`

## 3. Edge Function 地址

生产项目部署后地址应为：

- `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/ops-execute`
- `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/ops-status`
- `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/ops-health`

部署状态：

- `ops-execute`：已部署
- `ops-status`：已部署
- `ops-health`：已部署

## 4. MCP Runtime Bridge

新增目录：

`services/mcp-runtime-bridge`

提供：

- `POST /v1/actions`
- `GET /health`
- `GET /v1/runs/:id`：当前返回 501，状态读取统一走 Supabase `ops-status`

安全要求：

- 只监听可信环境
- 通过 `X-Ops-Signature` 验证来自 Edge Function 的请求
- 不允许浏览器直接调用
- 不允许传任意 MCP tool name
- 只允许 action allowlist
- 日志和错误会脱敏

## 5. 已接通 action 与 MCP 工具映射

| 前端 action | Bridge MCP 工具 |
| --- | --- |
| `create_campaign` | `create_campaign` |
| `generate_strategy` | `generate_content_strategy` |
| `approve_strategy` | `approve_strategy(action=approve)` |
| `reject_strategy` | `approve_strategy(action=reject)` |
| `generate_content` | `compose_content` |
| `rewrite_content` | `compose_content` |
| `generate_character_image` | `generate_character_image` |
| `generate_character_video` | `generate_character_video` |
| `poll_asset_status` | `poll_asset_status` |
| `review_generated_asset` | `review_generated_asset` |
| `regenerate_asset` | `regenerate_asset` |
| `finalize_content_package` | `finalize_content_package` |
| `approve_publish` | `approve_publish(action=approve)` |
| `reject_publish` | `approve_publish(action=reject)` |
| `execute_publish` | `execute_publish(dry_run=true by default)` |
| `analyze_account` | `analyze_account_intelligence` |

尚未接通或需要额外服务：

- `sync_x_account`
- `import_x_reference`
- `upload_reference_asset`
- `save_draft`

这些动作不会假装成功，会写入失败状态和真实原因。

## 6. 新增 Secrets 名称

需要在 Supabase Edge Function Secrets 中配置：

- `SUPABASE_SERVICE_ROLE_KEY`
- `OPS_MCP_BRIDGE_URL`
- `OPS_MCP_BRIDGE_SECRET`

需要在 Bridge 运行环境配置：

- `OPS_MCP_BRIDGE_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MARKETING_STUDIO_MCP_DIR`

可选：

- `MCP_RUNTIME_BRIDGE_PORT`
- `X_MCP_ENABLED`
- `AUTODL_BASE_URL`
- `COMFYUI_BASE_URL`

报告不包含任何 secret 值。

## 7. RLS 检查

新增 `ops_runs` 已启用 RLS。

策略：

- 用户只能读取自己的执行记录
- 用户只能插入自己的执行记录
- 用户只能更新自己的执行记录

Edge Function 使用 service role 时，先验证 Supabase JWT 与资源归属，再写入执行记录。

Migration 已推送到生产项目：

- `20260722023000_ops_execution_gateway.sql`

## 8. 端到端状态

已完成代码层闭环：

- 前端可调用 `ops-health`
- 前端可调用 `ops-execute`
- Edge Function 创建 `ops_runs`
- Edge Function 验证 JWT、action allowlist、资源归属
- Edge Function 调用 Bridge
- Bridge 调用 stdio MCP
- Bridge 写回执行状态
- 前端轮询 `ops-status`

尚未声称完成线上真实闭环：

- Bridge 需要部署到可信 Node 长进程环境
- Supabase Secrets 需要配置 Bridge URL 和签名密钥

## 9. dry-run 发布

`execute_publish` 在 Bridge 层默认强制：

```json
{ "dry_run": true }
```

测试期不会真实发布。

## 10. 修改文件

- `src/services/execution-gateway.js`
- `src/hooks/useExecutionAction.js`
- `src/components/ExecutionButton.jsx`
- `src/components/ExecutionStatus.jsx`
- `src/pages/CommandCenter.jsx`
- `src/pages/CampaignStrategyPage.jsx`
- `src/pages/ContentWorkspacePage.jsx`
- `src/pages/PublishQueuePage.jsx`
- `src/pages/PlatformConnectionsPage.jsx`
- `src/styles.css`
- `supabase/migrations/20260722023000_ops_execution_gateway.sql`
- `supabase/functions/_shared/ops-gateway.ts`
- `supabase/functions/ops-execute/index.ts`
- `supabase/functions/ops-status/index.ts`
- `supabase/functions/ops-health/index.ts`
- `services/mcp-runtime-bridge/*`

## 11. 验证结果

- 根项目 `npm run lint`：通过
- 根项目 `npm run build`：通过
- 根项目 `npm run migrations:check`：通过，状态 safe
- Bridge `npm run lint`：通过
- Bridge 本地 `/health`：通过，确认可连接 stdio MCP
- Supabase `db push`：已推送新增 migration
- Supabase Functions deploy：`ops-execute` / `ops-status` / `ops-health` 已部署

## 12. 当前线上阻塞

线上执行闭环还差最后一环：

- 需要把 `services/mcp-runtime-bridge` 部署到一个公网 HTTPS、可长期运行 Node 进程的可信环境。
- 部署完成后，把 `OPS_MCP_BRIDGE_URL` 和 `OPS_MCP_BRIDGE_SECRET` 写入 Supabase Edge Function Secrets。

在这一步完成前，线上按钮会真实显示 Bridge 未连接或未配置，不会假装任务成功。

## 13. 下一步

1. 选择 Bridge 运行环境。
2. 配置 Bridge 环境变量。
3. 配置 Supabase Secrets。
4. 做一次浏览器端 `ops-health` 检查。
5. 先跑 `approve_strategy` 或 `finalize_content_package` 这类低风险动作。
6. 最后再跑 `execute_publish(dry_run=true)`。
