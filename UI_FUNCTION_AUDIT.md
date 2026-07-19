# UI Function Audit

检查日期：2026-07-19

## 总体结论

当前前端页面大部分已连接 Supabase 服务层，不是纯 mock UI。主要问题是：

- 部分页面仍有“占位接口”按钮，尤其 AI 生成、非 Telegram 平台发布。
- 部分中文文案曾存在乱码，Phase 2 已优先清理导航、账号、内容库等核心页面。
- 空状态已存在，但部分页面还需要更贴近真实运营动作。

## 页面审计

### Dashboard

状态：

- 已连接 Supabase。
- 读取账号、内容、素材、角色、Prompt、Workflow、Agent、情报、采集、自动化、发布、表现、成本、通知等数据。

注意：

- 今日 AI 成本、本月成本、单条内容成本需要依赖 `cost_records` / `tool_usage` 持续写入。

### Social Accounts

状态：

- 已连接 `social_accounts`。
- 支持新增、编辑、删除。
- Phase 2 增加账号运营字段：
  - 账号类型
  - 目标受众
  - 内容策略
  - 发布频率
  - API 状态
  - 运营备注

### Content Library

状态：

- 已连接 `content_library`。
- 支持创建、编辑、删除、筛选、状态切换。
- Phase 2 改为完整内容 pipeline：
  - idea
  - researching
  - draft
  - generating
  - review
  - scheduled
  - published
  - analyzing
  - archived

### Asset Library

状态：

- 已连接 `assets`。
- 支持上传/保存资产记录、搜索、分类、删除。

注意：

- Supabase Storage 需要真实项目配置后才能完成生产文件上传验证。

### Character Library

状态：

- 已连接 `characters`。
- 可作为内容生成上下文。

### Prompt Library

状态：

- 已连接 `prompts`。
- 可作为内容生成上下文。

### Workflow Center

状态：

- 已连接 `workflow_runs`。
- 可创建 run、切换状态、保存结果到 asset 和 content。

注意：

- 真实 RunningHub / ComfyUI / n8n 调用仍是未来接入，不应标记为已完成。

### Agent Center

状态：

- 已连接 `agents` / `agent_tasks`。
- Phase 2 增加 `agent_runs` 记录输入、输出、状态、成本、耗时。

### Analytics / Performance

状态：

- 已连接 `content_metrics`、`publish_metrics`、`campaign_links`、`content_strategies`。
- 用于个人运营效果复盘，不是商业 SaaS 收费分析。

## 无法工作的按钮 / 占位能力

仍为预留或占位：

- AI Studio 的真实 GPT / Claude / Qwen API 调用
- 图片 / 视频真实生成
- 非 Telegram 平台真实发布
- X / YouTube / Instagram / TikTok OAuth 与发布 API
- n8n / Queue Worker 定时调度

这些按钮需要继续标注为“接口已预留 / 等待配置”，不能显示为生产已完成。

## 建议补强

优先：

1. 让 Social Accounts 变成真实账号矩阵档案。
2. 让 Content Library 的状态流完整覆盖每日运营。
3. 让 Content Intelligence 输出“为什么爆、如何复刻、是否适合我的账号”。
4. 让 Agent 每次运行都有日志。
5. 让 Dashboard 以今日运营为核心，而不是 SaaS 指标。
