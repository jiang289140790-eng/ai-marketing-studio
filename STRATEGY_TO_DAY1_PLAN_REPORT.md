# STRATEGY_TO_DAY1_PLAN_REPORT

## 实施结论

本次没有创建平行的 `content_plans` 或第二套 Campaign/内容包结构，也没有新增 migration、数据库字段或 RLS。正式流程继续复用：

- `campaigns`
- `strategy_plans`
- `strategy_plans.daily_plan`
- `strategy_plans.source_insights`
- `content_packages`
- `content_packages.source_insights`
- `content_packages.image_requirements`
- `content_packages.video_requirements`

已形成以下人工审批闭环：

```text
生成策略
→ 人工批准策略
→ 生成 7 天计划
→ 人工批准 7 天计划
→ 幂等创建 Day 1—Day 7 内容包
→ 只启动 Day 1
```

批准策略不再直接创建内容包；旧的 `create_weekly_plan` 仅保留为兼容性预览，不再写入内容包。

## daily_plan 最终结构

`strategy_plans.daily_plan` 使用 7 项数组。每项稳定包含：

```json
{
  "day": 1,
  "planned_date": "YYYY-MM-DD",
  "platform": "x",
  "content_pillar": "内容支柱",
  "content_role": "opening",
  "topic": "主题",
  "objective": "目标",
  "hook_type": "problem-solution",
  "format": "short_post",
  "media_requirement": "single_image_optional",
  "CTA": "行动引导",
  "notes": "备注",
  "account_id": "可选账号 ID",
  "character_id": "可选角色 ID",
  "planned_items": 1,
  "mix_status": "initial_recommendation",
  "hypothesis_status": "pending_validation",
  "adjust_after_metrics": true
}
```

规则：

- 固定输出 Day 1—Day 7，并按 `day` 升序。
- 每天默认 1 项，可配置为 1—2 项。
- 总计划量最大 14，并优先读取 Campaign 的上限设置。
- 相同主题自动区分，避免 7 天计划重复。
- 内容比例明确标记为“初始建议、待验证假设、指标回收后可调整”。
- 已有计划且结构发生变化时必须显式传入 `confirm_overwrite=true`；不会静默覆盖。
- 人工修改标记存在时同样要求显式确认。

## content_packages 如何生成

只有同时满足以下条件才允许创建：

1. `strategy_plans.status = approved`
2. `source_insights` 中最新计划节点为 `daily_plan_approval: approved`
3. daily_plan 包含完整的 Day 1—Day 7

每个 Day 只创建一个内容包。现有字段承载方式：

- `campaign_id`：运营活动
- `strategy_plan_id`：来源策略
- `account_id`：主运营账号
- `platform`：目标平台
- `title`：`Day N | 主题`
- `source_insights.day_index`：Day 序号
- `source_insights.plan_data`：当天完整计划
- `source_insights.workflow_status`：文案、素材、审批、发布状态
- `image_requirements`：角色、视觉、图片要求
- `video_requirements`：视频需求
- `review_status/status`：现有草稿状态

没有拆出新的 `content_status`、`media_status`、`approval_status` 或 `publish_status` 数据库字段；这些状态保存在现有 JSON 中。

## Day 1 如何启动

`start_campaign_day` 当前只接受 `day=1`。

启动前会再次检查：

- Campaign 属于当前用户
- 策略属于该 Campaign
- 策略已批准
- 7 天计划已批准
- Day 1 内容包已存在

启动只把 Day 1 的 `workflow_status.content_status` 更新为 `in_progress`，不会直接生成文案、图片、视频，不会启动 Day 2—Day 7，也不会创建或执行发布任务。

## 页面调整

运营活动与策略页面现在展示：

- Campaign、主账号、运营目标
- 目标受众、账号定位
- 内容支柱、发布频率、内容比例
- 视觉方向、文案风格
- 互动策略、转化策略
- 风险边界、生成依据

7 天计划按 Day 1—Day 7 展开显示主题、目标、形式、素材要求和状态。主要操作按审批状态逐步出现：

- 生成运营策略
- 批准策略 / 要求修改
- 生成或修改 7 天计划
- 批准 7 天计划
- 创建 7 天内容包
- 开始 Day 1

## MCP 工具

新增并接入安全执行网关：

- `generate_campaign_strategy`
- `approve_campaign_strategy`
- `generate_7_day_plan`
- `approve_7_day_plan`
- `create_content_packages_from_daily_plan`
- `get_campaign_day_status`
- `start_campaign_day`

所有工具均要求 `campaign_id`。写入工具还校验当前 MCP 用户对 Campaign 的所有权。

## 去重和幂等

- 计划内容哈希相同：返回已有计划，不重复写入。
- 已有计划将被改变：要求显式确认覆盖。
- 计划已批准：重复批准返回幂等成功。
- 创建内容包前按 `strategy_plan_id + campaign_id + day_index` 检查。
- 已存在的 Day 内容包复用，不重复插入。
- Day 1 已在生产中：重复启动返回幂等成功。
- 重新生成计划后，原计划批准状态自动失效，必须重新人工批准。

## 数据库确认

已只读确认线上 Supabase：

- `strategy_plans` 具有 `campaign_id`、`daily_plan`、`source_insights`、`status`。
- `content_packages` 具有 `campaign_id`、`strategy_plan_id`、`account_id`、`source_insights`、图片/视频 JSON、审核状态。
- 两表均启用 RLS。
- `content_packages.strategy_plan_id` 已有外键到 `strategy_plans.id`。

因此本次不需要新增数据库字段或 migration。

## 验证结果

- 前端 `npm run typecheck`：通过
- 前端 `npm run test`：10/10 通过
- 前端 `npm run lint`：通过
- 前端 `npm run build`：通过
- 前端 migration 安全检查：通过
- MCP 语法检查：通过
- MCP 构建检查：通过
- MCP 7 天计划纯逻辑测试：通过
- MCP 工具注册只读检查：7/7 工具可见
- 未运行会写入测试数据的旧集成套件
- 未执行任何真实外部发布

## 回滚方式

- 前端回滚策略页、计划工具函数、执行动作白名单和样式改动。
- MCP 回滚 `campaign-day-plan.js`、工具注册及旧策略审批行为调整。
- 本次没有数据库变更，因此不需要数据库回滚。
