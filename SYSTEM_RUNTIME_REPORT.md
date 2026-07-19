# System Runtime Report

检查日期：2026-07-19

## 总体结论

当前运行时结构已经具备个人 AI 内容运营系统的基础闭环，但真实外部能力仍集中在 Telegram。其他平台和 AI 生成供应商仍处于适配器预留阶段。

## Supabase 连接

前端使用：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

代码位置：

- `src/services/supabase-client.js`

本地配置状态：

- `.env.example` 已提供模板。
- 当前本地检查脚本仍提示真实生产环境变量缺失。

## Edge Function

本地 Edge Function：

- `supabase/functions/platform/index.ts`

已实现：

- Telegram connect
- Telegram publish
- Telegram getMetrics
- Telegram setWebhook
- Telegram webhook handler
- Campaign click / conversion tracking
- Admin Telegram notification

未确认：

- 远端 Supabase 是否已部署
- Edge secrets 是否已配置
- Telegram Bot webhook 是否已真实生效

## Agent Runtime

已有：

- `agents`
- `agent_tasks`
- `agent-service.js`

Phase 2 增强：

- 新增 `agent_runs`
- 每次 Agent 执行应记录：
  - input
  - output
  - status
  - cost
  - duration
  - error_message

## Workflow Runtime

已有：

- `workflow_runs`
- `workflow-service.js`

当前能力：

- 创建运行记录
- 更新状态
- 保存生成结果
- 自动创建 asset
- 自动创建 content draft

仍待真实接入：

- RunningHub
- ComfyUI
- n8n
- 外部回调

## Publish Center

已有：

- `publish_tasks`
- `publish-service.js`
- `platform-adapter.js`
- Telegram adapter

真实能力：

- Telegram 发布
- Telegram metrics / webhook / campaign tracking

Phase 2 适配器方向：

- `publish(content, platform)` 返回统一结构：
  - `success`
  - `message_id`
  - `url`
  - `error`

X Adapter 状态：

- 已准备接口结构。
- 不伪装完成。
- 需要真实 X Developer App、OAuth、API key、callback URL 后才能启用。

## 运行风险

- Supabase migrations 需要整理 baseline。
- Edge Function 生产部署未确认。
- Telegram webhook 真实状态未确认。
- X / Instagram / TikTok / YouTube 不应显示为已完成。
- AI Studio 真实模型调用未接入。

## 下一步运行时优先级

1. 整理 migrations。
2. 配置真实 Supabase。
3. 部署 Edge Function。
4. 完成 Telegram 生产 smoke test。
5. 配置 X Developer App，完成 OAuth callback 和发布接口的真实验证。
