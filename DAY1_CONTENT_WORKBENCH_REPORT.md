# DAY1_CONTENT_WORKBENCH_REPORT

## 实施结果

内容工作台已改造成单个 Campaign、Day 1 的一页式生产与审核工作台。文案生成、版本选择、人工编辑、角色与 LoRA 绑定、素材生成与确认、风险检查、人工审核和发布准备均在同一张 Day 1 内容卡内完成，没有新增第二套内容审核编辑器。

本次没有自动批准内容、没有自动批准发布任务，也没有执行真实外部发布。

## Day 1 操作路径

1. 从已批准的 7 天计划进入 Day 1 内容包。
2. 查看 Campaign、运营账号、平台、主题、目标、内容支柱、开头类型、计划发布时间、角色、当前状态和下一步操作。
3. 根据 Day 1 计划生成 1 至 3 个候选文案版本。
4. 选择主版本，并在平台预览旁进行人工编辑。
5. 执行缩短、增强开头、增加互动问题、改变语气、平台本地化或重新生成。
6. 每次修改都保存为新的内容版本，旧版本保持可追溯。
7. 人工批准文案，或要求修改并填写审核意见。
8. 选择角色并确认 LoRA，生成或选择图片/视频素材。
9. 人工确认素材，完成风险检查和发布准备检查。
10. 创建待审批发布任务，进入发布队列。工作台不会自动批准或自动发布。

## 使用的现有表

- `campaigns`：当前运营活动及所有权边界。
- `strategy_plans`：Day 1 计划来源和已批准策略。
- `content_packages`：Day 1 主内容包、当前主版本、文案审核、角色/LoRA、素材和工作台状态。
- `content_library`：候选文案和修改版本。历史记录不删除、不强制回填。
- `characters`：角色设定和 LoRA 配置。
- `asset_library`：与内容包关联的图片、视频和生成结果。
- `publish_tasks`：发布准备完成后创建的待审批发布任务。

没有新增数据库字段或 migration。

## 版本管理方式

每个候选版本或修改版本都新建一条 `content_library` 记录，不覆盖旧记录。关联信息写入现有 `generation_brief` JSON：

- `campaign_id`
- `content_package_id`
- `strategy_plan_id`
- `day_index`
- `version_number`
- `revision_type`
- `parent_version_id`
- `is_selected`

当前主版本、批准状态、审核意见等工作台元数据写入现有 `content_packages.source_insights.content_workbench`。选择主版本后，同步更新内容包的标题、开头、正文、行动引导、标签和语言风格，供后续视觉生成与发布流程使用。

只读数据库复核显示当前 `content_library` 有 4 条历史内容，尚无使用新关联结构的版本记录；新流程首次生成 Day 1 文案时才会创建关联版本，历史内容不受影响。

## 状态映射

- `pending_generation`：待生成
- `generating`：生成中
- `pending_review`：待审核
- `needs_revision`：需要修改
- `approved`：已批准
- `media_pending_generation`：素材待生成
- `media_pending_confirmation`：素材待确认
- `ready_to_publish`：准备发布
- `scheduled`：已排期
- `published`：已发布

页面根据状态只突出当前允许的主要动作。文案未批准时不能进入正式素材生成；素材未确认或风险检查未通过时不能创建待审批发布任务。

## 页面入口

入口为“内容工作台”。从策略/7 天计划启动 Day 1 时，使用当前 Campaign 和 Strategy 上下文打开 Day 1 内容包。Day 2 至 Day 7 仍保留原有查看能力，但本次没有启用批量自动生产。

默认视图只展示业务所需信息。数据库 ID、原始 JSON、模型内部参数、工作流响应和日志统一放在“高级详情”中。

## MCP 调用方式

新增或完善以下 MCP 工具，全部要求 `campaign_id` 和 `content_package_id`，并校验当前用户所有权及 Day 1 归属：

- `generate_content_for_package`
- `list_content_versions`
- `select_content_version`
- `revise_content`
- `approve_content`
- `request_content_revision`
- `get_content_readiness`

AI 修改操作只创建新版本；批准工具必须由人工明确调用；就绪检查不执行发布。

## 验证结果

前端：

- `npm run typecheck`：通过
- `npm test`：13/13 通过
- `npm run lint`：通过
- `npm run build`：通过

MCP：

- `npm run lint`：通过
- `npm run build`：通过
- `node test/test-day1-content-workbench.js`：通过

数据库验证仅执行只读查询，没有写入测试数据。

## 未实现的后续范围

- Day 2 至 Day 7 批量自动生产
- 自动批准文案或素材
- 自动批准发布任务
- 真实外部发布
- 历史内容批量回填 Campaign 或内容包关系
- 新数据库字段或新版本表

## 提交记录

- 前端与执行网关：`3ebd351`
- MCP Day 1 工具：`56e5fa1`

