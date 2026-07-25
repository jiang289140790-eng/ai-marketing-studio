# Campaign 上下文改造实施报告

实施日期：2026-07-25  
前端实施提交：`e10ed4ef2a3f83d65f5c88935a3faa4edf35238b`  
MCP 实施提交：`965fc762772c608062276cbc1c687a15c54aeb4b`

## 1. 复用的现有结构

本次继续使用现有 `campaigns` 作为唯一运营活动实体，没有创建
`marketing_campaigns`、`operation_campaigns`、`campaign_contexts` 或第二套 Campaign 表。

统一上下文通过以下现有关系和逻辑关系聚合：

- `campaigns.user_id`：活动所有权。
- `campaigns.target_accounts` 与 `campaigns.metadata`：主账号、对标账号和灵感账号 ID。
- `strategy_plans.campaign_id`：当前策略与 `daily_plan`。
- `content_packages.campaign_id`、`content_packages.strategy_plan_id`：内容包。
- `characters.lora`、`characters.lora_info` 与内容包 JSON：角色和 LoRA 快照。
- `asset_library.campaign_id`、`content_package_id`、`strategy_plan_id`：活动生成素材。
- `publish_tasks.content_package_id`：发布任务。没有使用历史上错误指向 `campaign_links` 的 `publish_tasks.campaign_id`。
- `content_metrics.content_package_id`、`publish_task_id` 与 `publish_metrics.publish_task_id`：指标。
- `insights.campaign_id`：活动洞察。
- `assets` 仍是跨 Campaign 可复用的个人素材库，不伪造不存在的 Campaign 外键。

## 2. 新增内容

### 2.1 统一 Campaign Context Service

新增 `src/services/campaign-context-service.js`，提供：

- `listCampaigns()`
- `getCampaign()`
- `getCampaignContext()`
- `getActiveCampaign()`
- `setActiveCampaign()`
- `getCampaignProgress()`
- `getCampaignBlockingItems()`

`getCampaignContext()` 返回：

- campaign
- primaryAccount
- competitorAccounts
- accountBrain
- currentStrategy
- dailyPlan
- contentPackages
- contentItems
- characterBindings
- mediaAssets
- publishTasks
- metricsSummary
- insights
- blockingItems
- progress

该服务先以 `campaigns.id + campaigns.user_id` 验证活动归属，然后再读取关联数据。历史
`campaign_id = null` 的内容不会自动混入当前活动。

### 2.2 前端上下文与选择器

新增：

- `CampaignContextProvider`
- `useCampaignContext`
- `CampaignContextBar`

选择器显示当前运营活动、主账号、当前阶段，并在以下核心页面顶部统一出现：

- AI 运营指挥中心
- 运营活动与策略（同时承担内容计划入口）
- 内容工作台
- 内容情报
- 素材库
- 发布队列
- 分析优化

内容工作台、内容情报、发布队列、分析优化和指挥中心已经按当前 Campaign 的关联 ID
缩小数据范围。素材库的 `assets` 是现有跨活动复用资源，没有 Campaign 字段，因此继续作为
共享素材显示；当前活动产生的素材通过上下文中的 `mediaAssets` 关联，不新增伪字段。

### 2.3 默认选择规则

- 只有一个可访问 Campaign：自动选择。
- 多个 Campaign：优先使用当前会话最近选择的可访问 Campaign，其次选择进行中的活动。
- URL 带 `campaign_id`：仅在该 ID 存在于当前用户可访问列表时采用。
- 没有 Campaign：显示创建引导。
- 会话记忆只保存 Campaign ID，不替代 Supabase/RLS 权限判断。
- 旧 Hash 路由继续兼容。

## 3. Campaign 进度

当前只动态计算最小 Day 1 闭环：

1. 对标分析
2. 策略
3. 7 天计划
4. Day 1 内容
5. Day 1 素材
6. Day 1 审核
7. Day 1 发布
8. Day 1 数据回收

“当前阶段”取第一个未完成步骤。阻塞项会明确指出缺少主账号、Account Brain、策略、
7 天计划、Day 1 内容包、文案、角色/LoRA、素材、审核、发布任务或指标。

## 4. MCP

保留原有工具，并新增：

- `get_campaign_context`
- `get_campaign_progress`
- `get_campaign_blocking_items`

原有 `list_campaigns` 继续复用。`list_campaigns` 与 `get_campaign` 现在要求有效 Owner
用户 ID；新工具也先用 Owner ID 过滤 `campaigns`，不存在或无权限时返回 `not_found`，
不会退化成跨用户查询。

注意：代码能力已完成，但部署环境仍必须把 AI Marketing Studio MCP 指向与网站相同的
Supabase 项目。此次没有改动 Secrets 或部署配置。

## 5. 新增原因

新增的是服务层、前端上下文和 MCP 只读聚合工具，不是新业务实体。现有表已经足够，
因此本次：

- 没有新增 migration；
- 没有新增数据库字段；
- 没有修改 RLS；
- 没有复制 Campaign 系统；
- 没有写入测试数据；
- 没有执行外部发布。

## 6. 测试结果

前端：

- `npm run typecheck`：通过。
- `npm run test`：通过，7/7。
- `npm run lint`：通过。
- `npm run build`：通过。
- `npm run migrations:check`：通过，未发现不安全重复声明。

覆盖场景：

- 无 Campaign；
- 单 Campaign 自动选择；
- 多 Campaign 切换；
- 无权限 Campaign ID 不会被选择；
- Campaign 缺少主账号；
- 已有策略但没有 7 天计划；
- 历史 `campaign_id = null` 不会混入。

MCP：

- 新 Campaign Context 工具语法检查：通过。
- `npm run build`：通过。
- 现有 MCP 核心测试：通过，7/7。

## 7. 回滚方式

前端可回滚提交：

```text
e10ed4ef2a3f83d65f5c88935a3faa4edf35238b
```

MCP 可回滚提交：

```text
965fc762772c608062276cbc1c687a15c54aeb4b
```

两部分互不修改数据库结构。回滚前端提交会移除选择器、页面过滤和 Context Service；
回滚 MCP 提交会移除三个上下文工具并恢复原有 Campaign 工具行为。由于没有 migration，
不需要数据库回滚。
