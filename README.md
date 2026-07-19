# AI Marketing Studio

AI Marketing Studio 是个人使用的 AI 内容运营系统，定位是 **Personal AI Ops Workspace**，不是商业 SaaS。

它的目标是帮助个人创作者/运营者管理账号矩阵、发现内容机会、生成内容与素材、安排发布、采集数据反馈，并让 AI Agent 持续给出运营建议。

## 当前产品定位

核心方向：

1. 账号矩阵管理
2. 内容自动生产
3. 多平台发布
4. 数据反馈
5. AI 运营 Agent

保留但不作为商业化模块：

- `tool_usage`：记录工具调用与用量
- `cost_records`：记录个人 AI / Workflow / API 运营成本
- analytics / performance：用于内容表现、转化和复盘分析

当前明确不开发：

- Stripe
- Billing
- Subscription
- Membership
- Pricing
- 商业 SaaS 权限计费
- 多租户商业产品能力

## 核心工作流

```text
账号矩阵
  → 内容情报 / 竞品分析
  → AI Agent 生成策略
  → Prompt / Character / Workflow
  → 内容与素材生成
  → 内容库审核
  → 发布任务
  → Telegram / 后续多平台发布
  → 数据反馈
  → AI 运营 Agent 优化下一轮内容
```

## 技术栈

- Frontend：React + Vite
- Hosting：GitHub Pages
- Backend：Supabase Auth / PostgreSQL / Storage / RLS
- Server boundary：Supabase Edge Functions
- 当前真实渠道：Telegram
- 后续预留：X、Instagram、TikTok、YouTube、n8n、ComfyUI、RunningHub、GPT、Claude、Qwen

## 本地运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

前端只能使用公开变量：

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-publishable-or-anon-key
VITE_APP_BASE_PATH=/ai-marketing-studio/
```

不要把这些内容放进前端或 GitHub Pages 构建变量：

- `SUPABASE_SERVICE_ROLE_KEY`
- Telegram Bot Token
- Telegram Webhook Secret
- 平台 refresh token
- 平台 access token
- AI provider API key
- RunningHub / ComfyUI private key

这些密钥只应配置在 Supabase Edge Function secrets 或本地部署环境中。

## 生产配置

生产环境变量说明见：

- [docs/ENVIRONMENT_CONFIGURATION.md](docs/ENVIRONMENT_CONFIGURATION.md)
- [production-check.md](production-check.md)

检查命令：

```bash
npm run setup:check
npm run lint
npm run build
```

## Supabase 上线注意

当前 migrations 仍需 clean replay 验证。

已知风险：

- `202607190001_initial_schema.sql` 已接近完整 baseline。
- 后续增量 migration 中仍存在重复建表、重复 index、重复 RLS policy。
- 重复 `CREATE TABLE IF NOT EXISTS` 和 `CREATE INDEX IF NOT EXISTS` 通常不会中断。
- 重复 plain `CREATE POLICY` 会导致从空库顺序执行时失败。

上线前必须先看：

- [docs/MIGRATION_CLEAN_REPLAY_PLAN.md](docs/MIGRATION_CLEAN_REPLAY_PLAN.md)
- [docs/MIGRATION_BASELINE_AUDIT.md](docs/MIGRATION_BASELINE_AUDIT.md)

## 已完成模块

- Supabase Auth 基础
- Social Accounts 账号矩阵管理
- Content Library 内容库与状态流
- AI Studio 基础草稿生成入口
- Asset Library 素材库
- Character Library 角色库
- Prompt Library 提示词库
- Workflow Runtime
- Agent Center
- Content Intelligence
- Collection Center
- Telegram Collector
- Automation Center
- Platform Integration 安全边界
- Publish Center
- Telegram 发布 / Webhook / 指标 / 转化追踪代码路径
- Performance Center
- System Health
- Daily Report

## 当前生产阻塞

真实运行前必须完成：

1. 修复或确认 migration clean replay。
2. 配置真实 Supabase 项目。
3. 配置 Supabase Edge Function secrets。
4. 部署 `platform` Edge Function。
5. 配置 Telegram Bot 与 webhook。
6. 使用真实用户完成 Supabase CRUD / RLS / Storage 验证。
7. 发布一条真实 Telegram 测试内容，并确认 webhook 和 metrics 写入。

