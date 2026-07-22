# AI Marketing Studio Ops Execution Gateway Completion Report

生成时间：2026-07-22

定位：Personal AI Ops Workspace。未新增 Stripe、Billing、Subscription、Membership、Pricing 或 SaaS 多租户功能。

## 已完成

### 1. MCP Runtime Bridge

- Bridge 默认监听地址从本机限定改为可部署模式：
  - `MCP_RUNTIME_BRIDGE_HOST`，默认 `0.0.0.0`
  - `MCP_RUNTIME_BRIDGE_PORT`，默认 `8787`
- 新增长期运行服务部署文件：
  - `services/mcp-runtime-bridge/Dockerfile`
  - `services/mcp-runtime-bridge/.dockerignore`
  - `services/mcp-runtime-bridge/.env.example`
- 更新 Bridge README：
  - Docker 部署方式
  - HTTPS 反代要求
  - `/health` 健康检查
  - Supabase Edge Function secrets 配置方式
- Bridge 本机健康检查已通过：
  - `bridge: true`
  - `mcp: true`
  - 可读取 43 个 AI Marketing Studio MCP tools

### 2. ops_runs 安全策略

新增 migration：

- `supabase/migrations/20260722033000_ops_business_tables_and_rls_hardening.sql`

修复内容：

- 删除浏览器对 `ops_runs` 的 insert/update/delete 权限。
- 登录用户只能 select 自己的 `ops_runs`。
- 插入和更新执行结果只允许 Edge Function / Bridge 使用 service role 完成。
- `ops-execute` 增加 idempotency 查询，重复请求不会重复提交到 MCP。

### 3. 业务表兼容与 RLS

为线上执行闭环补齐或兼容：

- `campaigns`
- `strategy_plans`
- `content_packages`
- `asset_library`
- `publish_tasks`
- `platform_connections`

补充：

- `user_id`
- Campaign/Strategy/Content Package/Asset 关系字段
- 发布队列需要的 `publish_content`、`publish_result`、`approval_status`
- Bridge 兼容的 `is_connected`、`connection_config`、`connection_type`

RLS 原则：

- 浏览器只读当前用户自己的记录。
- Bridge 使用 service role 写入后回填 `user_id`。
- 未能证明归属的数据不会被前端读取。

### 4. Edge Function 加固

已重新部署：

- `ops-execute`
- `ops-status`
- `ops-health`

改动：

- `verifyResourceOwnership()` 不再因为某张表没有 `user_id` 就默认允许。
- 支持沿父级关系校验：
  - campaign
  - strategy
  - content_package
  - content
  - asset
  - character
  - publish_task
  - account
  - platform_connection
- 无法证明属于当前用户时返回：
  - HTTP 403
  - `RESOURCE_FORBIDDEN`

### 5. 前端执行链路

已接通：

- Campaign 表单创建：
  - 名称
  - 目标
  - 平台
  - 目标账号
  - 内容主题
  - 成功指标
  - 是否需要图片
  - 是否需要视频
- Campaign 卡片生成策略：
  - 传递 `campaign_id`
  - 传递 `account_ids`
  - 传递 `platforms`
  - 传递 `objective`
  - 传递 `content_topics`
- 策略审核：
  - 批准策略
  - 驳回策略
  - 驳回意见
- 内容工作台：
  - 保存草稿接入 Bridge
  - Agent 重写接入 Bridge
  - 图片生成接入 `generate_character_image`
  - 视频生成接入 `generate_character_video`
  - 终审通过时传递最终正文、CTA、最终素材和排期信息
- 发布队列：
  - 兼容 `status=connected` 和 `is_connected=true`
  - `execute_publish` 默认 dry-run

### 6. 请求层与错误显示

- `ops-health`、`ops-execute`、`ops-status` 改为直接调用 Supabase Edge Function URL，并显式带登录 session token。
- 数据读取不再静默吞错：
  - 表不存在
  - 字段不匹配
  - RLS 拒绝
  - 网络错误
- Command Center 会显示“数据读取异常”提示，避免统计数字错误变成 0。

## 已部署

### Supabase

生产项目：

- `qtrlymiqohbjvklwegsw`

已执行：

- `supabase db push`
- `supabase functions deploy ops-execute`
- `supabase functions deploy ops-status`
- `supabase functions deploy ops-health`

备注：

- `supabase db push` 成功应用 migration。
- CLI 最后出现 Docker Desktop warning，仅影响本地 cache/catalog 检查，不影响远端 migration 已应用。

## 当前阻塞

### 1. Bridge 公网地址未配置

`supabase secrets list` 中当前没有：

- `OPS_MCP_BRIDGE_URL`
- `OPS_MCP_BRIDGE_SECRET`

因此生产 Edge Function 虽然已部署，但线上 `ops-health` 无法返回完整：

```json
{
  "edge_function": true,
  "bridge_configured": true,
  "bridge": true,
  "mcp": true
}
```

需要先把 `services/mcp-runtime-bridge` 部署成一个长期运行的 HTTPS 服务，再把以上两个 secret 配置到 Supabase。

### 2. X 链接导入尚未完成真实 MCP 适配

当前 `import_x_reference` 仍会准确返回未配置原因，不会假装成功。

需要：

- Bridge 运行环境能访问 X MCP。
- X MCP 能读取公开推文和媒体。
- 设计私有 Storage 写入路径。
- 确认素材使用权限字段。

### 3. 文件上传仍需专用签名上传接口

二进制文件上传不应该走通用 MCP JSON action。

后续应走：

```text
Browser
→ Supabase Storage signed upload
→ asset_library/assets record
→ content_package association
```

### 4. 真实发布仍保持 dry-run

`execute_publish` 在 Bridge 层强制：

- 默认 `dry_run=true`
- 只有 `ALLOW_REAL_PUBLISH=true` 时才允许真实发布

因此当前不能声明“已经真实发布到 X”。

## 验证结果

通过：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`
- Bridge lint
- 本机 Bridge `/health`
- 本机 Bridge → MCP tools list
- Supabase migration push
- Edge Function deploy

未完成：

- 线上登录后的完整端到端测试
- 线上 `ops-health` Bridge/MCP 全绿
- 真实 Campaign → Strategy → Content Package → Asset → Publish dry-run 全链路

原因：

- 缺少公网 HTTPS Bridge 服务地址和对应 Supabase secrets。

## 下一步

1. 部署 `services/mcp-runtime-bridge` 到 Render、Railway、Fly.io 或云服务器。
2. 配置 Bridge 环境变量：
   - `OPS_MCP_BRIDGE_SECRET`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `MARKETING_STUDIO_MCP_DIR`
   - `ALLOW_REAL_PUBLISH=false`
3. 在 Supabase 配置：
   - `OPS_MCP_BRIDGE_URL`
   - `OPS_MCP_BRIDGE_SECRET`
4. 重新部署：
   - `ops-health`
   - `ops-execute`
5. 登录线上网站验证：
   - 创建 Campaign
   - 生成策略
   - 批准策略
   - 创建内容包
   - 生成/关联素材
   - 终审通过
   - 进入发布队列
   - 执行 dry-run 发布检查
