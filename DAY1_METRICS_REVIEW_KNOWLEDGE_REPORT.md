# DAY1_METRICS_REVIEW_KNOWLEDGE_REPORT

## 1. 实施结果

已完成 Day 1 从真实发布结果到指标回收、AI 复盘、待审核策略建议、Campaign Insight、知识库和 Account Brain 待审核观察的闭环。

闭环顺序：

1. Day 1 发布任务必须处于 `published`。
2. 发布任务必须具有真实平台 Post ID。
3. `collect_content_metrics` 回收平台真实返回的指标。
4. 平台拿不到的指标保存为 `unavailable`，不伪造为真实的 `0`。
5. `review_content_performance` 基于指标和历史样本生成 Day 1 复盘。
6. 策略调整只写入 `strategy_memory` 的 `pending_review` 建议，不覆盖已批准策略。
7. 用户可以分别保存 Campaign Insight、Knowledge Entry 和 Account Brain 待审核观察。

## 2. 指标回收

统一指标包括：

- impressions / views
- likes
- replies / comments
- reposts / shares
- saves
- profile visits
- link clicks
- follows
- registrations
- conversions

每个指标同时记录：

- `value`
- `status: available | unavailable`
- `source`
- `source_field`
- `last_sync`

关系信息保存在指标 JSON 中：

- Campaign
- Account
- Day
- Content Package
- Content Item
- Publish Task
- Platform Post ID

当前线上数据库没有可用的 `content_library` 表，因此没有新增表或 migration。新闭环将当前 Day 的 `content_package` 作为可追溯内容实体，并在 `content_metrics.content_ref` 与 `metrics.relation.content_item_id` 中保存对应 ID。未来恢复独立内容版本表时，可以通过相同关系对象平滑迁移。

## 3. 平台能力

第一阶段继续使用现有 Telegram 发布适配器。

Telegram Bot API 对历史内容指标的拉取能力有限，因此：

- 接口真实返回的浏览、反应、回复、转发会标记为 `available`。
- 收藏、主页访问、链接点击、新增关注、注册和转化等未返回字段标记为 `unavailable`。
- 不会把不可用字段解释成零表现。
- 平台响应、数据来源和最后同步时间均被保留。

## 4. Day 1 AI 复盘

复盘包含：

- 执行概况
- 主要指标
- 与账号历史平均值比较
- 与相似内容比较
- 文案钩子判断
- 内容角色判断
- 素材表现判断
- 发布时间判断
- 失败或异常
- 下一步建议

当历史样本不足时，结果固定包含：

> 样本不足，仅作为初步观察

所有结论使用以下分类：

- `verified_conclusion`：已验证结论
- `initial_signal`：初步信号
- `hypothesis`：待验证假设
- `insufficient_data`：无足够数据

单条 Day 1 内容不会自动形成固定策略规则。

## 5. 知识沉淀与安全边界

### Insights

`save_campaign_insight` 写入：

- `source_type = day1_performance_review`
- Campaign ID
- 复盘来源 ID
- 置信度
- 待验证标签

### Knowledge Vault

同步写入 `knowledge_entries`，metadata 保留 Campaign、Account、Day、Content Package、Publish Task、Insight 和结论分类。

### Strategy Memory

`create_strategy_adjustment_suggestion` 只创建：

- `status = planned`
- `results.suggestion_status = pending_review`
- `approved_strategy_untouched = true`

不会修改或覆盖正式批准的 `strategy_plans`。

### Account Brain

`update_account_memory` 只追加到：

`brain_data.performance_memory.pending_observations`

保留原有 Brain 内容，并限制最近 50 条待审核观察。

## 6. 页面

“分析优化”页面新增 Day 1 发布后复盘区：

- 十类指标的真实值或“暂不可用”
- 数据来源语义
- AI 复盘
- 证据与结论分类
- 下一步建议
- “应用到下一天（待审核建议）”
- “保存为知识”
- “加入账号 Brain 待审核观察”

Day 1 未真实发布时，页面明确提示：

`dry_run` 只表示预检或测试完成，不会生成指标或触发复盘。

## 7. MCP 工具

已新增：

- `collect_content_metrics`
- `review_content_performance`
- `create_strategy_adjustment_suggestion`
- `save_campaign_insight`
- `update_account_memory`
- `get_day_review`

六个工具均要求 `campaign_id`，并通过现有执行网关、Bridge action registry 和 Edge allowlist 暴露。

## 8. 幂等与历史兼容

- 指标同步会更新相同发布任务的最新快照，避免每次点击产生重复业务记录。
- 策略建议按 `source_review_id` 去重。
- Insight 按 Campaign 和 Review 来源去重。
- Account Brain 按 `source_review_id` 去重。
- Day 信息缺失时，按 Content Package 创建时间升序推断 Day 顺序。
- 复盘保存在现有 `content_packages.image_requirements.day1_review` JSON 中，没有新增字段或 migration。

## 9. 实际联调结果

当前指定 Campaign 的 Day 1 发布任务尚未完成真实发布，平台 Post ID 为空。

实际调用结果：

- `collect_content_metrics`: `not_ready`
- 原因：`Day 1 has no published task. Metrics cannot be collected before a real publish.`
- 未写入任何假指标
- 未生成虚假复盘
- 未执行真实外部发布

当用户完成 Day 1 live 发布后，可以在“分析优化”页面点击“回收 Day 1 指标”继续闭环。

## 10. 验证

- 前端 `npm run typecheck`：通过
- 前端 `npm run lint`：通过
- 前端 `npm run test`：26/26 通过
- 前端 `npm run build`：通过
- MCP `npm run lint`：通过
- MCP `npm run test`：通过
- MCP `npm run build`：通过
- Day 1 指标可用性与复盘分类纯函数测试：通过

## 11. 部署说明

本任务没有执行真实外部发布，也没有伪造 Day 1 平台数据。

代码已完成并通过本地验证；Supabase Edge Function、MCP Bridge 和前端线上版本需要在部署步骤中一起发布，避免新页面按钮与旧 Bridge 工具清单不一致。
