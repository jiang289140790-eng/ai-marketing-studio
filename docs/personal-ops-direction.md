# AI Marketing Studio Personal Operations Direction

## 定位

AI Marketing Studio 是个人使用的 AI 内容运营系统。

它服务的是一个人或一个小型个人团队的内容运营工作，而不是商业 SaaS 平台。

当前阶段不开发：

- Stripe
- 用户订阅
- 会员套餐
- commercial billing
- SaaS pricing page
- 多租户套餐权限

## 核心目标

系统围绕 5 个方向继续优化：

1. 账号矩阵管理
2. 内容自动生产
3. 多平台发布
4. 数据反馈
5. AI 运营 Agent

## 核心闭环

```text
账号矩阵
  ↓
内容情报
  ↓
AI 策略
  ↓
内容 / 素材 / Workflow 生产
  ↓
内容库审核
  ↓
发布任务
  ↓
数据反馈
  ↓
AI Agent 优化
```

## 保留的数据表方向

### 保留

- `tool_usage`
- `cost_records`
- `content_metrics`
- `publish_metrics`
- `content_strategies`
- `audit_logs`

这些表用于个人运营复盘、成本控制、内容效果分析，不用于会员计费。

### 降级为未来预留

- `plans`
- `subscriptions`

如果未来真的要变成商业 SaaS，这些概念可以重新启用；当前不进入导航、不进入 Dashboard 核心指标、不进入主流程。

## 模块优先级

### P0：个人运营闭环

- Social Accounts
- Content Library
- AI Studio
- Asset Library
- Character Library
- Prompt Library
- Workflow Runtime
- Agent Center
- Publish Center
- Performance Center
- System Health

### P1：自动化和情报

- Content Intelligence
- Collection Center
- Automation Center
- Telegram Collector
- Analysis Agent

### P2：多平台扩展

- X
- Instagram
- TikTok
- YouTube
- Telegram 深度指标

### P3：未来预留

- plans
- subscriptions
- Stripe
- billing
- team workspace
- commercial SaaS admin

## UI 调整原则

- 不出现“会员套餐”“升级订阅”“购买计划”等主流程文案。
- 成本页面表达为“运营成本”“工具成本”“生成成本”，不是“用户账单”。
- Dashboard 优先展示：
  - 账号数量
  - 今日内容
  - 待发布
  - 失败任务
  - 生成成本
  - 内容表现
  - AI 建议
- 设置页可以保留未来预留区，但必须标注“暂不启用”。

## 开发原则

1. 先服务个人运营效率。
2. 先打通 Telegram，再扩展其他平台。
3. 所有平台密钥只走 Supabase Edge Function。
4. 先做稳定的内容生产和反馈闭环，再做复杂自动化。
5. 不引入商业 SaaS billing，除非未来重新确认产品方向。
