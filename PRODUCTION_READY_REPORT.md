# AI Marketing Studio Production Ready Report

检查日期：2026-07-19

## 总体结论

当前代码层面的生产部署准备基本完成，但还不能直接判定为“可上线”。

主要原因不是业务功能缺失，而是生产环境配置尚未在本地项目中体现，且 Supabase migrations 存在一个高风险点：首个 `initial_schema` 已包含后续模块的累计结构，同时后续增量 migration 仍然存在。若从空 Supabase 项目按文件顺序执行全部 migrations，可能因为重复 `create policy` 失败。

建议上线状态：**暂缓直接生产上线，先完成迁移链整理与远端配置确认。**

产品定位更新：

- AI Marketing Studio 是个人使用的 AI 内容运营系统，不是商业 SaaS。
- 上线检查不包含 Stripe、用户订阅、会员套餐、商业 billing。
- `cost_records`、analytics、ROI 字段仅用于个人运营复盘、成本控制和内容效果分析。
- `plans` / `subscriptions` 如未来出现，只作为预留能力，不进入核心流程。

## 检查范围

本次只做生产部署检查，未新增功能。

检查项：

1. Supabase migrations 顺序
2. Edge Functions 部署列表
3. Secrets 清单
4. Auth OAuth 配置
5. Telegram Bot webhook 配置
6. RLS 策略
7. 生产环境变量

## 已完成

### 1. Supabase migrations 文件存在

本地已存在 15 个 migration 文件，按文件名排序如下：

1. `202607190001_initial_schema.sql`
2. `202607190002_workspace_taxonomy_upgrade.sql`
3. `202607190003_content_asset_system.sql`
4. `202607190004_workflow_runtime_center.sql`
5. `20260719081338_agent_dispatch_center.sql`
6. `20260719082436_content_intelligence_center.sql`
7. `20260719083243_social_intelligence_collector.sql`
8. `20260719083854_automation_orchestrator.sql`
9. `20260719085024_automation_real_runner.sql`
10. `20260719085554_telegram_collector_adapter.sql`
11. `20260719090441_social_platform_integration_base.sql`
12. `20260719091213_publish_center_base.sql`
13. `20260719092038_content_performance_analytics.sql`
14. `20260719093509_telegram_feedback_conversion_loop.sql`
15. `20260719094321_production_stability_hardening.sql`

覆盖模块：

- 用户资料
- 社交账号
- 内容库
- 素材库
- 角色库
- Prompt 库
- Workflow Runs
- Agent / Agent Tasks
- Content Intelligence
- Collector
- Automation
- Platform Connections / Credentials
- Publish Center
- Performance Analytics
- Telegram 反馈与转化追踪
- Notifications / Cost Records / Audit Logs

### 2. Edge Function 本地结构存在

本地发现 1 个 Supabase Edge Function：

- `supabase/functions/platform/index.ts`

当前 `platform` function 覆盖：

- Telegram connect
- Telegram publish
- Telegram getMetrics
- Telegram setWebhook
- Telegram webhook handler
- Campaign redirect / conversion tracking
- Admin Telegram notification

### 3. 前端没有发现 service role 泄漏

前端 `.env.example` 只包含：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_APP_BASE_PATH`

代码中前端 Supabase client 只读取：

- `import.meta.env.VITE_SUPABASE_URL`
- `import.meta.env.VITE_SUPABASE_ANON_KEY`

未发现前端读取 `SUPABASE_SERVICE_ROLE_KEY`。

### 4. Auth 代码层已接入 Google OAuth

代码中已存在：

- `signInWithOAuth({ provider: 'google' })`
- `redirectTo: window.location.origin + window.location.pathname`

这说明前端登录流程已预留 Google OAuth。

### 5. Telegram webhook 代码层已接入

Edge Function 中已存在：

- `setWebhook`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `X-Telegram-Bot-Api-Secret-Token` 校验
- allowed updates:
  - `message`
  - `channel_post`
  - `edited_channel_post`
  - `message_reaction`
  - `message_reaction_count`
  - `callback_query`

### 6. RLS 代码层已覆盖核心表

本地 migrations 中已检查到核心 public 表启用 RLS，包括：

- `profiles`
- `social_accounts`
- `content_library`
- `assets`
- `characters`
- `prompts`
- `publish_tasks`
- `workflow_runs`
- `agents`
- `agent_tasks`
- `competitor_accounts`
- `viral_contents`
- `content_analysis`
- `content_sources`
- `collection_tasks`
- `collection_runs`
- `automation_jobs`
- `automation_runs`
- `platform_connections`
- `platform_credentials`
- `content_metrics`
- `publish_metrics`
- `content_strategies`
- `campaign_links`
- `notifications`
- `cost_records`
- `audit_logs`

多数业务表已使用 owner policy：

- `to authenticated`
- `using ((select auth.uid()) = user_id)`
- update policy 包含 `with check ((select auth.uid()) = user_id)`

### 7. 敏感凭证表有保护

已检查到：

- `platform_credentials` 启用 RLS
- `revoke all on public.platform_credentials from anon`
- `revoke all on public.platform_credentials from authenticated`

这符合“令牌不出前端，只由 Edge Function 访问”的安全边界。

### 8. Storage 结构存在

已检查到 storage bucket：

- `marketing-assets`

并存在 storage object policies：

- select
- insert
- update
- delete

策略按用户目录隔离。

### 9. 本地配置检查脚本可运行

已运行：

```bash
npm run setup:check
```

脚本成功执行，并明确提示当前本地缺少生产环境变量。

## 缺失 / 待确认

### 1. 生产 Supabase 项目未确认

本地无法确认真实 Supabase 项目是否已经：

- 创建完成
- 连接到当前代码库
- 执行过 migrations
- 部署过 Edge Function
- 配置过 Auth provider
- 配置过 Storage policy

当前本地缺少：

- `SUPABASE_PROJECT_REF`
- `SUPABASE_ACCESS_TOKEN`

因此无法自动检查远端 Supabase 状态。

### 2. 生产前端环境变量缺失

`npm run setup:check` 显示缺少：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

GitHub Pages / 构建环境也需要配置：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- 可选：`GITHUB_PAGES_BASE=/ai-marketing-studio/`

### 3. Edge Function secrets 待配置

生产 Supabase Edge Function 需要配置：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_TRACKING_BASE_URL`
- `PLATFORM_FUNCTION_URL`
- `TRACKING_EVENT_SECRET`
- `TELEGRAM_ADMIN_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`

注意：

- `SUPABASE_SERVICE_ROLE_KEY` 只能放 Supabase Edge Function secrets
- Telegram Bot Token 只能放 Supabase Edge Function secrets
- 不要放入 GitHub Pages 前端构建变量

### 4. Auth OAuth 远端配置待确认

代码层已接 Google OAuth，但无法从本地确认 Supabase Dashboard 是否已配置：

- Google provider 是否启用
- Google Client ID 是否正确
- Google Client Secret 是否正确
- Site URL 是否为生产域名
- Redirect URLs 是否包含 GitHub Pages 地址

需要在 Supabase Dashboard 手动确认。

### 5. Telegram webhook 真实状态待确认

代码层支持 webhook，但无法从本地确认 Telegram Bot 当前 webhook 是否已设置。

需要用真实 Bot Token 调用 Telegram API 检查：

- `getWebhookInfo`

至少确认：

- `url` 是否等于生产 Edge Function URL
- `has_custom_certificate` 是否符合预期
- `pending_update_count` 是否正常
- `last_error_message` 是否为空
- secret token 是否与 `TELEGRAM_WEBHOOK_SECRET` 一致

### 6. Edge Function 是否已部署待确认

本地存在：

- `supabase/functions/platform/index.ts`

但无法确认远端是否已经部署：

- function name: `platform`
- function URL 是否可访问
- CORS 是否符合生产域名
- function secrets 是否已生效

### 7. 没有发现 `supabase/config.toml`

本地没有发现：

- `supabase/config.toml`

这不一定阻塞上线，但会影响本地 Supabase CLI 项目绑定、函数配置和本地模拟环境的一致性。

## 风险

### 高风险：migrations 可能不是纯增量链

检查发现：

- `202607190001_initial_schema.sql` 已包含后续模块的大量表、RLS、policy
- 后续 migration 又重复创建同名表、同名 RLS policy

重复项包括：

- 多个表重复 `create table if not exists`
- 多个表重复 `alter table ... enable row level security`
- 多个 policy 名称重复 `create policy`

风险：

- `create table if not exists` 通常不会失败
- `alter table ... enable row level security` 通常不会失败
- 但 `create policy "xxx"` 如果 policy 已存在，通常会失败

因此，如果从空库按 15 个 migration 顺序全部执行，存在 migration 中途失败的风险。

上线前必须选择一种迁移策略：

方案 A：把 `202607190001_initial_schema.sql` 作为完整初始化脚本，只执行它，不再执行后续重复迁移。

方案 B：把 `202607190001_initial_schema.sql` 恢复为真正的最小 initial schema，保留后续文件作为纯增量迁移链。

方案 C：将所有 migration 整理为一条新的干净生产 baseline，再从该 baseline 开始上线。

推荐：**方案 C。**

### 中风险：OAuth redirect 使用当前路径

当前代码：

- `redirectTo: window.location.origin + window.location.pathname`

如果 GitHub Pages 使用 SPA/hash 路由或路径变化，可能导致 OAuth 回调后停留在错误页面。

上线前需要确认：

- Supabase Site URL
- Redirect URLs
- GitHub Pages base path
- OAuth 回调后的实际路径

### 中风险：Telegram 历史指标能力有限

Telegram Bot API 对历史 views/reactions 的主动拉取能力有限。

当前系统主要依赖：

- 发布返回结果
- webhook updates
- reaction/count/callback events
- campaign link click/conversion tracking

风险：

- 不是所有频道浏览/互动都一定能完整回收
- 需要真实 Bot 权限和频道配置验证

### 中风险：管理员通知依赖 Edge Secrets

管理员 Telegram 通知已走 Edge Function，但上线前必须确认：

- `TELEGRAM_ADMIN_BOT_TOKEN` 已配置
- `TELEGRAM_ADMIN_CHAT_ID` 已配置
- Bot 能给该 chat 发消息

否则系统内通知仍会保存，但 Telegram 管理员消息不会发送。

### 低风险：Storage bucket 当前为 public

迁移中 `marketing-assets` bucket 创建为 public。

如果素材包含私密素材、未发布视频、客户内容或商业素材，应考虑改为 private bucket，通过 signed URL 访问。

## 上线步骤

### Step 1：整理 migration 策略

上线前先决定：

- 使用完整 baseline
- 或使用纯增量链

推荐操作：

1. 新建测试 Supabase 项目。
2. 从空库执行当前 migrations。
3. 如果重复 policy 失败，立即停止。
4. 整理 migrations 后重新跑。
5. 确认 `supabase_migrations.schema_migrations` 顺序正确。

### Step 2：创建 / 绑定 Supabase 生产项目

需要准备：

- Supabase project ref
- Supabase access token
- Database password

本地或 CI 需要：

- `SUPABASE_PROJECT_REF`
- `SUPABASE_ACCESS_TOKEN`

### Step 3：执行数据库迁移

确认 migration 链清理后，执行生产数据库迁移。

执行后检查：

- 所有核心表存在
- RLS 为 enabled
- `platform_credentials` 不可被 anon/authenticated 直接读取
- `marketing-assets` bucket 存在

### Step 4：部署 Edge Function

部署：

- `platform`

部署后配置 Edge Secrets：

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_WEBHOOK_URL`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_TRACKING_BASE_URL`
- `PLATFORM_FUNCTION_URL`
- `TRACKING_EVENT_SECRET`
- `TELEGRAM_ADMIN_BOT_TOKEN`
- `TELEGRAM_ADMIN_CHAT_ID`

### Step 5：配置 Supabase Auth

在 Supabase Dashboard：

1. 启用 Google provider。
2. 填入 Google Client ID。
3. 填入 Google Client Secret。
4. 设置 Site URL 为生产 GitHub Pages 地址。
5. 添加 Redirect URL：
   - GitHub Pages 首页
   - GitHub Pages app base path
   - 本地开发地址，如仍需本地测试

### Step 6：配置 GitHub Pages 生产变量

GitHub repository secrets / variables：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `GITHUB_PAGES_BASE=/ai-marketing-studio/`

禁止加入：

- `SUPABASE_SERVICE_ROLE_KEY`
- Telegram Bot Token
- refresh token
- platform access token

### Step 7：配置 Telegram Bot webhook

使用系统内 connect / setWebhook 流程，或直接通过 Telegram API 设置。

目标 webhook URL 应指向：

- Supabase Edge Function `platform`

并携带：

- `X-Telegram-Bot-Api-Secret-Token`

上线后用 `getWebhookInfo` 确认无错误。

### Step 8：生产 smoke test

必须完成以下端到端测试：

1. 打开 GitHub Pages 生产站点。
2. 使用 Google 登录。
3. 创建或确认 profile。
4. 添加 Telegram 连接。
5. 创建内容。
6. 创建 publish task。
7. 发布到 Telegram。
8. 确认 `publish_tasks.external_id` 写入。
9. 确认 `published_at` 写入。
10. 触发 Telegram webhook 或 campaign link。
11. 确认 `content_metrics` / `publish_metrics` / `campaign_links` 更新。
12. 人为制造一次失败任务。
13. 确认 System Health 显示失败。
14. 点击重试。
15. 确认管理员 Telegram 通知发送。

## 当前生产就绪状态

| 项目 | 状态 | 说明 |
|---|---|---|
| 前端代码 | 已完成 | 可 build |
| Supabase schema 设计 | 已完成但需整理 | 存在重复 migration 风险 |
| Edge Function 本地文件 | 已完成 | 仅发现 `platform` |
| Edge Function 远端部署 | 待确认 | 本地无 Supabase access token |
| Secrets 清单 | 已明确 | 但真实 secrets 未确认 |
| Google OAuth 代码 | 已完成 | Dashboard 配置待确认 |
| Telegram webhook 代码 | 已完成 | 真实 Bot webhook 待确认 |
| RLS 策略 | 代码层已覆盖 | 真实库状态待确认 |
| Storage | 代码层已覆盖 | bucket public/private 策略需业务确认 |
| 生产环境变量 | 缺失 | setup check 已提示 missing |

## 最终判断

代码准备度：**高**

配置准备度：**中**

数据库迁移风险：**高**

是否建议现在上线：**不建议直接上线**

建议下一步：

1. 先整理 Supabase migrations，解决重复 policy 风险。
2. 再连接真实 Supabase 项目。
3. 部署 `platform` Edge Function。
4. 配置所有 Edge Secrets。
5. 配置 Google OAuth 与 Telegram webhook。
6. 做一次完整生产 smoke test。
