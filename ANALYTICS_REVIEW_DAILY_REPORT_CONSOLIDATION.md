# ANALYTICS_REVIEW_DAILY_REPORT_CONSOLIDATION

## 1. 收口结果

三页已经按单一职责拆分：

| 页面 | 只回答的问题 | 默认范围 |
| --- | --- | --- |
| 数据分析 | 发生了什么 | 当前 Campaign |
| AI 复盘 | 为什么发生、下一步怎么做 | 当前 Campaign |
| 运营日报 | 昨天做了什么、今天要做什么 | 当前 Campaign |

没有创建第二套指标、Memory 或日报数据库体系。页面继续复用：

- `content_metrics`
- `publish_metrics`
- `publish_tasks`
- `content_packages`
- `content_memory`
- `strategy_memory`
- `agent_runs`
- `workflow_runs`
- `notifications`
- 现有 Campaign Context

## 2. 数据分析

新增独立导航入口“数据分析”，复用原有分析数据源。

支持维度：

- Campaign
- 账号
- Day
- 内容
- 平台
- 内容类型
- Hook
- 素材类型
- 发布时间

核心指标：

- 曝光
- 点赞
- 评论
- 转发
- 收藏
- 主页访问
- 链接点击
- 新增关注
- 注册
- 转化

指标读取规则：

- 平台真实返回 `0` 时显示 `0`。
- 字段缺失或平台明确标记 unavailable 时显示“平台暂不提供”。
- 不再使用默认 `0` 冒充平台返回数据。
- 少于 3 条真实样本时显示“小样本，仅作为初步观察”。

## 3. AI 复盘

原“分析优化”已改名为“AI 复盘”。

页面包含：

1. 本轮复盘状态
2. 核心结论，最多 3 条
3. 文案表现
4. 素材表现
5. CTA 表现
6. 发布时间表现
7. 建议动作
8. 历史经验库，默认折叠

建议卡显示：

- 结论
- 证据
- 样本数
- 置信度
- 适用范围
- 数据状态
- 推荐动作

操作：

- 应用到下一条内容
- 创建策略调整草稿
- 保存为待验证假设
- 暂不采用

前三项继续通过现有安全执行网关完成，不从前端直接覆盖正式策略。

没有真实发布数据时：

- 只显示当前阻塞。
- 显示回收指标、查看发布任务或返回内容工作台。
- 不展示历史 Content Memory 和 Strategy Memory。

历史经验库仅在存在真实指标后显示，并默认折叠；只显示当前范围、最近使用且不是测试 marker 的记录。

## 4. 运营日报

页面调整为：

- 昨日完成
- 今日待办
- 发布表现
- 阻塞异常
- Agent 运行摘要
- 工作流任务摘要
- 下一步建议

按钮层级：

- 主按钮：生成今日运营日报
- 次操作：刷新、下载、查看历史
- “导出数据备份”已移入更多菜单

如果昨日没有执行记录：

- 明确说明无法生成完整日报。
- 可生成当前状态执行摘要。
- 可进入指挥中心或发布中心。
- 不再展示大量无意义的 0 统计卡。

日报继续实时聚合现有业务表，没有新增重复日报表。

## 5. 当前真实数据验证

验证 Campaign：

`X 媒体优先短内容测试`

Campaign ID：

`efd3d863-1e6e-4e49-8b87-e95af08f92e8`

Supabase 查询结果：

| 对象 | 当前 Campaign |
| --- | ---: |
| 发布任务 | 1 |
| 工作流任务 | 1 |
| 内容指标 | 0 |
| 策略 Memory | 2 |
| Agent Runs | 0 |

当前发布任务：

- 平台：X
- 状态：draft
- 审批：pending
- 尚未真实发布

当前工作流：

- `emma_s1_sdxl_t2i_v01`
- 状态：success
- Day 1
- 已关联当前 Campaign

因此当前页面应表现为：

- 数据分析：真实指标为空，十项指标显示“平台暂不提供”。
- AI 复盘：显示“尚无真实发布指标”的阻塞，不展示无关 Memory。
- 运营日报：昨日没有执行时允许生成当前执行摘要；今日待办提示继续处理发布和指标回收。

## 6. 修改文件

- `src/App.jsx`
- `src/data/navigation.js`
- `src/pages/DataAnalyticsPage.jsx`
- `src/pages/AnalyticsPage.jsx`
- `src/pages/DailyReport.jsx`
- `src/pages/KnowledgeVaultPage.jsx`
- `src/services/report-service.js`
- `src/utils/analytics-review-model.js`
- `src/utils/auxiliary-page-scope.js`
- `src/styles.css`
- `test/analytics-review-model.test.mjs`

## 7. 验证结果

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过 |
| `npm test` | 65 / 65 通过 |
| `npm run build` | 通过 |
| 数据分析路由 | HTTP 200 |
| AI 复盘路由 | HTTP 200 |
| 运营日报路由 | HTTP 200 |
| Supabase 实际数据查询 | 通过 |
| 自动页面截图 | 未完成：浏览器运行时无法写入内核资源，OS error 3 |

没有伪造页面截图。浏览器运行时恢复后需要补验：

1. 侧边栏依次打开“数据分析 / AI 复盘 / 运营日报”。
2. 确认三页顶部显示同一个当前 Campaign。
3. 确认数据分析缺失指标显示“平台暂不提供”。
4. 确认 AI 复盘只显示当前阻塞，不展开无关 Memory。
5. 点击“生成执行摘要”，确认运营日报出现七个业务区块。
6. 在 1366×768 和移动宽度下检查无横向裁切。

## 8. 回滚方式

本次没有数据库 migration、RLS 变更或历史数据删除。

当前工作区基线 commit：

`a307f0510970706f5a0d4919a8c28b4d1659185a`

回滚时只恢复“修改文件”中的本任务改动，不要清理工作区中其他阶段尚未提交的用户改动。
