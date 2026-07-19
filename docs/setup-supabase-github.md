# Supabase 与 GitHub Pages 配置清单

## 1. 创建 Supabase 项目

在 Supabase Dashboard 创建项目，记录：

- Project URL
- anon key 或 publishable key
- Project ref

前端只能使用 anon/publishable key，不要使用 `service_role`。

## 2. 执行数据库 migration

新项目直接执行：

```text
supabase/migrations/202607190001_initial_schema.sql
```

已执行旧版本的项目，继续按顺序执行：

```text
supabase/migrations/202607190002_workspace_taxonomy_upgrade.sql
supabase/migrations/202607190003_content_asset_system.sql
supabase/migrations/202607190004_workflow_runtime_center.sql
supabase/migrations/20260719081338_agent_dispatch_center.sql
supabase/migrations/20260719082436_content_intelligence_center.sql
supabase/migrations/20260719083243_social_intelligence_collector.sql
supabase/migrations/20260719083854_automation_orchestrator.sql
supabase/migrations/20260719085024_automation_real_runner.sql
supabase/migrations/20260719085554_telegram_collector_adapter.sql
supabase/migrations/20260719090441_social_platform_integration_base.sql
supabase/migrations/20260719091213_publish_center_base.sql
supabase/migrations/20260719092038_content_performance_analytics.sql
supabase/migrations/20260719093509_telegram_feedback_conversion_loop.sql
supabase/migrations/20260719094321_production_stability_hardening.sql
```

第四个 migration 会补充：

- `workflow_runs`
- workflow 状态：`pending` / `running` / `success` / `failed`
- Workflow Run 与 Workflow 资产、角色、Prompt 的关联
- Workflow Run RLS policies
- authenticated grants

第五个 migration 会补充：

- `agents`
- `agent_tasks`
- Agent 类型：`content_generator` / `asset_generator` / `analysis`
- Agent 任务状态：`pending` / `running` / `success` / `failed`
- Agent RLS policies
- authenticated grants

第六个 migration 会补充：

- `competitor_accounts`
- `viral_contents`
- `content_analysis`
- 内容情报 RLS policies
- authenticated grants

第七个 migration 会补充：

- `content_sources`
- `collection_tasks`
- `collection_runs`
- 采集中心 RLS policies
- authenticated grants

第八个 migration 会补充：

- `automation_jobs`
- `automation_runs`
- 自动化中心 RLS policies
- authenticated grants

第九个 migration 会补充：

- `automation_runs.status` 支持 `queued`
- `assets.source` 支持 `workflow-runtime`
- Automation 可以真实驱动内部 Collector / Agent / Workflow 模块

第十个 migration 会补充：

- `content_sources.source_type` 支持 `telegram`
- `content_sources.channel`
- `content_sources.username`
- `content_sources.last_message_id`
- `content_sources.sync_time`
- `collection_runs.duration_ms`

第十一个 migration 会补充：

- `platform_connections`
- `platform_credentials`
- `automation_jobs.type` 支持 `platform`
- `platform_credentials` 不授权给前端角色
- Social Platform Edge Function 基础边界

## 3. 配置 Google 登录

在 Supabase Dashboard：

1. 进入 Authentication → Providers。
2. 启用 Google。
3. 填入 Google Cloud OAuth Client ID / Secret。
4. 在 Google Cloud OAuth 设置中加入 Authorized redirect URI。
5. 在 Supabase Auth URL 配置中加入 GitHub Pages 地址。

本地开发可加入：

```text
http://127.0.0.1:5180/ai-marketing-studio/
```

## 4. 配置 GitHub Pages Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 新增：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

不要新增 service role key 到前端构建环境。

## 5. 本地环境

复制：

```bash
cp .env.example .env.local
```

填写：

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
```

## 6. 验证

```bash
npm run setup:check
npm run lint
npm run build
```

登录后检查：

- Social Accounts 能添加、编辑、删除。
- Content Library 能新建、编辑、删除、搜索、筛选。
- Asset Library 能上传、删除、搜索、筛选、预览。
- Character Library 能创建、编辑、删除和搜索角色。
- Prompt Library 能创建、编辑、删除和筛选 Prompt。
- Workflow Runs 能创建任务、切换状态、保存结果。
- 保存 Workflow 结果后，`assets` 出现生成结果，`content_library` 出现草稿。
- Agent Center 能创建 Agent、执行任务，并在内容库或 Workflow Runs 中看到对应结果。
- Content Intelligence 能添加竞争账号、保存爆款内容、生成 AI 分析。
- 分析 Agent 能读取爆款内容并输出复刻策略。
- Collection Center 能添加数据源、创建采集任务、模拟运行并记录历史。
- Telegram 公开频道能通过 Collection Center 采集并写入 Viral Content Library。
- Automation Center 能创建自动任务、启停任务、手动运行并真实驱动 Collector / Agent / Workflow。
- Settings 能展示 Social Connections 平台连接状态，但不会展示 token。
- Platform Edge Function 占位存在，但不执行真实发布。
- Workflow 自动任务能创建 Workflow Run、保存 Asset，并生成 Content Draft。
- Dashboard 显示真实 Supabase 统计。
## Publish Center

- 执行 `supabase/migrations/20260719091213_publish_center_base.sql` 后，`publish_tasks` 会支持发布中心字段。
- 发布任务状态为 `draft` / `scheduled` / `publishing` / `published` / `failed`。
- 当前只验证 Content Library → Publish Task → Platform Adapter 的内部链路。
- 真实平台发布不要放在前端，后续必须通过 Supabase Edge Function 执行。

## Content Performance Analytics

- 执行 `supabase/migrations/20260719092038_content_performance_analytics.sql` 后，会新增 `content_metrics`、`publish_metrics` 和 `content_strategies`。
- 当前指标可以在 Performance Center 手动录入。
- Analysis Agent 会读取 `viral_contents` + `content_metrics`，生成并保存 `optimization_strategy`。
- 真实平台指标同步后续通过 Supabase Edge Function / Platform Adapter 完成。

## Telegram 发布闭环

- 在 Supabase Edge Function secrets 中配置 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。
- 不要把 `SUPABASE_SERVICE_ROLE_KEY` 写入前端 `.env.local` 或 GitHub Pages secrets。
- 在 Telegram 中创建 Bot，并把 Bot 加为目标频道/群管理员。
- 在 Settings 页面填写 Bot Token、频道用户名（例如 `@your_channel`）或 `-100...` chat_id。
- 在 Publish Center 创建 Telegram 发布任务，点击调用 Adapter 后会走 Edge Function 调用 Telegram Bot API。
- 发布成功后会保存 `external_id`、`published_at`，并写入初始 `content_metrics` / `publish_metrics` 快照。

## Telegram Webhook 与转化追踪

- 执行 `supabase/migrations/20260719093509_telegram_feedback_conversion_loop.sql`。
- 在 Edge Function secrets 中配置：
  - `TELEGRAM_WEBHOOK_URL`
  - `TELEGRAM_WEBHOOK_SECRET`
  - `TELEGRAM_TRACKING_BASE_URL` 或 `PLATFORM_FUNCTION_URL`
  - `TRACKING_EVENT_SECRET`
- Telegram webhook 请求必须带 `X-Telegram-Bot-Api-Secret-Token`，否则不会写入指标。
- 在 Performance Center 创建 `campaign_links`，再到 Publish Center 绑定到 Telegram 发布任务。
- Webhook 会把 Telegram 互动事件写入 `content_metrics` / `publish_metrics`，点击、注册、收入可通过 campaign link 手动或后续回传更新。
- Telegram 帖子里的 campaign link 可以先访问 Edge Function `?campaign_id=...`，系统记录 clicks 后再跳转到真实落地页。
- 你的内容网站注册完成后，可以用 `X-Tracking-Event-Secret` 向 Edge Function 回传 registrations / revenue。

## 生产稳定性强化

- 执行 `supabase/migrations/20260719094321_production_stability_hardening.sql`。
- 该 migration 会补 retry 字段、通知表、成本表和审计表。
- System Health 页面会读取任务运行、通知、成本和审计数据。
- Telegram / Email 通知通道目前只预留字段，真实推送后续接入。
