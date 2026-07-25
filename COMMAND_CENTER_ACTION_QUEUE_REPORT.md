# COMMAND_CENTER_ACTION_QUEUE_REPORT

## 实施结果

AI 运营指挥中心已从“系统总览仪表盘”简化为“今日决策入口”。本次只调整首页信息层级和待办入口，没有修改左侧导航渲染逻辑，没有新增数据库字段或迁移，也没有删除原有业务功能。

## 首页保留的五个区域

1. **待我处理**
   - 聚合策略审批、7 天计划审批、Day 1 文案生成与审核、素材生成与确认、发布审批、发布失败和指标回收失败。
   - 每项包含类型、Campaign、账号、Day、简要说明、优先级和直接处理按钮。
   - 按紧急、高、普通、低优先级排序；同优先级下优先显示较早的 Day。
2. **当前运营活动**
   - 显示活动目标、主账号、当前阶段、7 天计划进度、Day 1 状态、当前阻塞和下一步操作。
3. **未来 7 天发布计划**
   - 读取当前策略 `daily_plan`，以简洁列表展示日期、主题、平台、形式和状态。
4. **异常**
   - 仅展示数据读取失败、发布失败、指标回收失败，以及确实阻塞生成任务的执行服务异常。
   - Supabase、Edge Function、MCP 等正常连接状态不再占据首页，继续保留在系统状态相关页面。
5. **AI 建议**
   - 最多显示 3 条。
   - 只在存在账号分析、策略记忆或内容记忆时展示，并标注依据和日期/成功率。

## 统一待办服务

新增：

- `src/services/action-queue-service.js`
- `getUserActionQueue(options)`
- `buildUserActionQueue(data, options)`

每个待办统一返回：

```text
action_type
entity_type
entity_id
campaign_id
day
title
summary
priority
target_url
recommended_action
```

同时为前端直达补充 `target_page`、`target_id` 和 `target_params`。详情地址携带 `campaign_id`、`day` 和具体对象 ID，继续兼容现有 Hash 路由。

## 支持的待办类型

- `approve_strategy`
- `approve_7_day_plan`
- `generate_day1_content`
- `review_copy`
- `generate_asset`
- `confirm_asset`
- `approve_publish`
- `resolve_publish_failure`
- `resolve_metrics_failure`

相同动作和对象会去重，失败任务优先于普通审批任务。

## 首次使用引导

当用户没有 Campaign 时，不再展示大量为 0 的统计卡，改为以下六步引导：

1. 添加运营账号
2. 添加对标账号
3. 创建运营活动
4. 生成并批准策略
5. 生成 7 天计划
6. 开始 Day 1

## 保留与回滚

- 原有 `ExecutionStatus`、`StatCard`、`StatusBadge` 等组件文件没有删除。
- 原有业务页面、导航、数据表、服务和路由没有删除。
- 旧版 Command Center 的通用样式仍保留在样式表中，新版样式独立使用 `command-center-v2` 等命名。
- 如需回滚，可回退实现提交 `8e180e05870081c3f7aa99eceaf142f34971ae6d`，不会影响数据库数据。

## 验证结果

- ESLint：通过
- TypeScript typecheck：通过
- 自动测试：22 / 22 通过
- 生产构建：通过
- 本地页面 HTTP 检查：`200`
- `git diff --check`：通过
- 新增待办服务测试覆盖：
  - 策略与 7 天计划审批
  - Day 1 文案生成和审核的顺序推进
  - 素材生成与素材确认
  - 发布失败和指标回收失败优先级
  - Campaign 过滤
  - 返回字段契约与对象直达链接

浏览器自动视觉检查受当前 Codex 浏览器运行环境路径异常影响，未通过自动截图执行；响应式规则、无横向固定宽度约束、类型检查和生产构建均已通过。

## 实现提交

`8e180e05870081c3f7aa99eceaf142f34971ae6d`

