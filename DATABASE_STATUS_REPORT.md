# Database Status Report

检查日期：2026-07-19

## 定位结论

当前数据库整体符合 Personal AI Ops Workspace 方向：核心表围绕账号、内容、素材、Workflow、Agent、发布、采集、分析和成本复盘，没有发现 Stripe、pricing、membership、商业订阅等实际 billing 表。

保留的 `cost_records`、`tool_usage`、analytics / metrics 字段应理解为个人运营成本与效果复盘，不是用户收费系统。

## 已确认

- 未发现 Stripe / checkout / billing 相关 schema。
- 未发现 `plans` / `subscriptions` 作为核心表存在。
- 已有个人运营核心表：
  - `social_accounts`
  - `content_library`
  - `assets`
  - `characters`
  - `prompts`
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
  - `publish_tasks`
  - `content_metrics`
  - `publish_metrics`
  - `content_strategies`
  - `campaign_links`
  - `notifications`
  - `cost_records`
  - `audit_logs`

## Phase 2 新增/增强

新增 migration：

- `20260719104342_personal_ops_phase2_foundation.sql`

新增能力：

- `social_accounts` 增加：
  - `account_type`
  - `target_audience`
  - `content_strategy`
  - `posting_frequency`
  - `api_status`
  - `ops_notes`
- `content_library` 增加完整 pipeline：
  - `idea`
  - `researching`
  - `draft`
  - `generating`
  - `review`
  - `scheduled`
  - `published`
  - `analyzing`
  - `archived`
- `viral_contents` 增加：
  - `source_platform`
  - `engagement_score`
  - `viral_reason`
  - `content_type`
  - `ai_recommendation`
- `content_analysis` 增加：
  - `viral_reason`
  - `ai_recommendation`
  - `replication_notes`
  - `fit_score`
- 新增 `agent_runs`：
  - 记录每次 Agent 输入、执行、输出、状态、成本、耗时
- 新增 `tool_usage`：
  - 记录 GPT、图片生成、视频生成、API、Workflow 等个人运营工具成本
- 新增 `platform_adapters`：
  - 记录 Telegram / X / YouTube / Instagram / TikTok 的适配器状态和配置要求

## 仍存在的风险

### Migration baseline 重复风险

`202607190001_initial_schema.sql` 已包含较完整的累计 schema，而后续增量 migrations 中也有重复建表和重复 policy。

风险：

- 空库按顺序执行全部 migrations 时，重复 `create policy` 可能失败。

建议：

- 上线前整理一份干净 production baseline。
- 或将 `initial_schema` 恢复为最小初始版本，后续保留纯增量。

### Storage public 风险

`marketing-assets` 当前为 public bucket。若存储私密素材，建议改为 private + signed URL。

## Personal AI Ops 适配度

符合：

- 账号矩阵管理
- 内容情报发现
- AI 分析
- 内容生成
- 素材生成
- 发布任务
- 数据采集
- 效果分析
- 策略优化
- 个人运营成本复盘

不包含：

- Stripe
- subscription billing
- membership package
- pricing plan
- multi-tenant SaaS billing
