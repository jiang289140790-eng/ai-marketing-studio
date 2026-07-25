# AUXILIARY PAGE FOUNDATION REPORT

## 交付状态

- 统一基础框架：已完成
- 十个辅助页面接入：已完成
- 数据范围真实过滤：已完成
- 测试数据默认隐藏：已完成
- 普通 / 高级模式：已完成
- 集中状态中文映射：已完成
- typecheck / lint / build / tests：已通过
- 本地服务可访问：已验证，`http://127.0.0.1:3001/ai-marketing-studio/` 返回 HTTP 200
- 自动化页面点击与截图：等待应用内浏览器验收通道恢复；当前浏览器运行环境报“找不到指定的路径”，没有伪造截图

## 统一页面组件

### `AuxiliaryPageFrame`

所有目标辅助页面统一经过 `src/components/AuxiliaryPageFrame.jsx`：

1. 当前 Campaign 上下文栏
2. 页面职责
3. 数据范围
4. 当前范围摘要
5. 普通 / 高级模式
6. 页面主内容
7. 高级技术详情

涉及页面：

- 账号矩阵
- 角色库
- 素材库
- 提示词库
- 平台连接
- 工作流与模型
- 系统状态
- 分析优化
- 运营日报
- 知识库

### `MoreActionsMenu`

账号、角色、素材和提示词的删除入口已收纳到“更多”菜单。原有二次确认机制继续保留。

### `EmptyState`

统一回答：

1. 当前为什么没有数据
2. 需要先完成什么
3. 用户可以点击什么

旧调用保持兼容；没有提供专用动作的页面默认引导到当前运营活动。

### 统一详情抽屉

账号、素材、提示词和角色详情采用统一的右侧抽屉尺寸、间距、背景和滚动规则。角色原有遮罩交互继续保留。

## Campaign 上下文使用方式

继续复用现有 `CampaignContextProvider` 和 `CampaignContextBar`，没有创建第二套上下文。

上下文栏统一显示：

- 当前运营活动
- 主账号
- 平台
- 当前 Day
- 当前步骤
- 阻塞问题
- 下一步操作

页面读取同一份：

- `activeCampaignId`
- `campaignContext`
- `primaryAccount`
- `competitorAccounts`
- `currentStrategy`
- `contentPackages`
- `characterBindings`
- `mediaAssets`
- `publishTasks`

## 数据范围查询规则

集中实现于 `src/utils/auxiliary-page-scope.js`。

### 当前运营活动

只保留与以下任一关系匹配的数据：

- `campaign_id`
- `strategy_id` / `strategy_plan_id`
- `content_package_id`
- `account_id` / `social_account_id`
- `character_id`
- `publish_task_id`
- `workflow_id`
- 上述字段在 `metadata`、`source_insights`、`generation_brief`、`input_data` 或 `output_data` 中的兼容值

### 当前账号

只保留与当前 Campaign 主账号关联的数据，不把竞品账号混入“当前账号”范围。

### 全部历史

显示当前用户的非测试历史记录。

### 测试数据

只显示被识别为测试或调试的数据。

切换范围会改变页面组件 key，并把 `dataScope` 纳入各页面查询依赖，因此会重新读取和过滤数据，不是只改变标签。

## 测试数据识别规则

不删除任何数据。以下信号会进入“测试数据”范围：

- 名称或标题：`phase2`、`phase7`、`phase8`、`phase9`
- `debug`
- `test` / `testing`
- `fixture` / `mock` / `smoke` / `nightly`
- `自动化测试` / `测试数据` / `回归测试`
- `is_test = true`
- `metadata.is_test = true`
- `metadata.test = true`
- `environment = test / testing / debug`
- `source`、`created_by`、`agent_name` 等文本中的上述模式

正式 Campaign“X 媒体优先短内容测试”不会因为名称中含“测试”而被错误归为测试记录。

## 普通模式与高级模式

普通模式默认只显示：

- 中文业务名称
- 状态
- 结论
- 当前阻塞
- 下一步操作

高级模式才显示：

- Campaign / Account UUID
- 原始 Prompt
- 技术错误
- 原始 JSON 或工作流技术详情

Secrets 和 Token 在任何模式都不显示。

## 状态翻译表

集中维护于 `src/utils/formatters.js`：

| 数据库值 | 中文显示 |
| --- | --- |
| `draft` | 草稿 |
| `review` | 待审核 |
| `approved` | 已批准 |
| `planned` | 已计划 |
| `pending` | 待处理 |
| `pending_approval` | 待批准 |
| `running` | 运行中 |
| `completed` | 已完成 |
| `failed` | 失败 |
| `not_started` | 未开始 |
| `dry_run` | 安全预演 |
| `live` | 正式执行 |
| `preflight_passed` | 预检通过 |
| `preflight_failed` | 预检未通过 |
| `needs_revision` | 需要修改 |
| `ready_for_publish` | 准备发布 |

数据库状态值未被修改。

## 修改文件

### 新增

- `src/components/AuxiliaryPageFrame.jsx`
- `src/components/MoreActionsMenu.jsx`
- `src/utils/auxiliary-page-scope.js`
- `test/auxiliary-page-scope.test.mjs`
- `AUXILIARY_PAGE_FOUNDATION_REPORT.md`

### 修改

- `src/App.jsx`
- `src/components/EmptyState.jsx`
- `src/components/Header.jsx`
- `src/components/StatusBadge.jsx`
- `src/pages/AccountsPage.jsx`
- `src/pages/AnalyticsPage.jsx`
- `src/pages/AssetLibrary.jsx`
- `src/pages/CharacterLibrary.jsx`
- `src/pages/DailyReport.jsx`
- `src/pages/KnowledgeVaultPage.jsx`
- `src/pages/PlatformConnectionsPage.jsx`
- `src/pages/PromptLibrary.jsx`
- `src/pages/SystemOverviewPage.jsx`
- `src/pages/WorkflowModelConfigPage.jsx`
- `src/services/report-service.js`
- `src/styles.css`
- `src/utils/formatters.js`

未修改数据库、Migration、RLS、Secrets、MCP 业务逻辑或发布安全规则。

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | 32 项通过，0 失败 |
| `npm run build` | 通过，139 个模块完成构建 |
| `git diff --check` | 通过 |
| 本地 HTTP | 200 |
| 页面自动点击 | 验收工具环境阻塞，未冒充通过 |
| 页面截图 | 验收工具环境阻塞，待补 |

新增测试覆盖：

- 测试数据识别
- 当前 Campaign 的直接关系和 JSON 嵌套关系
- 历史范围排除测试数据
- 测试范围只显示测试数据
- 当前账号只使用主账号
- 集中状态中文映射

## 页面截图

截图目录原计划为：

`docs/acceptance/auxiliary-foundation/`

当前未生成截图。原因是应用内浏览器自动验收运行环境无法创建其内核运行文件，错误为“系统找不到指定的路径”。代码构建和本地网站服务均正常。恢复浏览器验收通道后，应补拍：

1. 账号矩阵普通模式 / 当前 Campaign
2. 角色库高级模式
3. 素材库详情抽屉
4. 平台连接当前账号范围
5. 系统状态空状态
6. 知识库测试数据范围

## 回滚方式

本任务没有数据库变更，回滚只涉及前端文件：

1. 恢复上述已修改文件；
2. 删除本任务新增的两个组件、范围工具和测试文件；
3. 重新运行 typecheck、lint、test、build。

用户原有未跟踪文件未被修改。

## 版本

- 基线提交：`a307f0510970706f5a0d4919a8c28b4d1659185a`
- 当前实现：工作区未提交变更
