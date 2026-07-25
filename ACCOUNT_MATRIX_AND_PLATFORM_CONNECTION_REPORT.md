# ACCOUNT_MATRIX_AND_PLATFORM_CONNECTION_REPORT

生成时间：2026-07-25  
工作分支：`codex/online-fix-task`  
基准提交：`a307f05`（本次修改尚未提交）

## 1. 实施结论

本次已将两个页面的职责收口为：

- **账号矩阵**：管理账号身份、账号大脑、运营用途、内容样本、运营活动和角色绑定。
- **平台连接**：管理 OAuth/认证、权限、发布、指标回收、Webhook、额度、Token 有效状态和连接异常。

未新增数据库字段、迁移、业务表或 MCP 工具；未修改 RLS；未读取或展示 `platform_credentials`；未写入测试数据；未删除历史账号。

## 2. 真实数据审计

只读检查生产项目 `qtrlymiqohbjvklwegsw`：

- `social_accounts`：51 条
- 自有/品牌/个人账号：7 条
- 竞争/灵感账号：44 条
- 已有账号大脑、画像或完成报告：40 条
- `platform + handle` 明确重复组：0
- 主页 URL 疑似重复组：3
- 按替换字符、连续问号和常见错误转码特征检测到的明确乱码记录：0
- X 平台连接记录：3 条，其中当前有效连接 1 条
- Telegram 平台连接记录：5 条，当前有效连接 5 条

页面会继续对当前筛选范围实时检测乱码和疑似重复；发现问题时只做标记，不自动覆盖、合并或删除。

## 3. 账号矩阵

### 页面结构

- 默认标签：自有账号
- 标签：自有账号 / 对标与灵感 / 全部账号
- 默认视图：表格
- 可切换：表格 / 卡片
- 继续复用统一 Campaign Context 和数据范围筛选
- Phase2、Phase7、Phase8、Phase9、debug、test、fixture、mock 等记录默认归入“测试数据”

### 自有账号字段

- 账号名称和头像
- 平台
- 连接状态
- 发布能力
- 指标回收能力
- 绑定角色
- 当前运营活动
- 最近发布
- 最近分析
- 账号大脑状态
- 下一步操作

### 对标与灵感字段

- 账号名称
- 平台
- 类型：竞争 / 灵感
- 最近抓取
- 有效内容样本数
- 数据来源
- 分析可信度
- 账号大脑状态
- 可复制模式
- 数据质量警告
- 下一步操作

### 账号详情

详情抽屉包含：

- 概览
- 账号大脑
- 内容样本
- 运营活动关联
- 角色绑定
- 平台能力
- 分析历史
- 数据质量

自有账号详情突出运营用途、主活动、角色和发布能力；对标/灵感账号详情突出样本、可信度和可复制模式，不再共用完全相同的业务模板。

### 乱码和重复处理

- 明确损坏字段显示“原内容损坏”
- 不尝试猜测或伪造恢复文本
- 疑似重复依据：
  - `platform + handle`
  - `profile_url / account_url`
  - 连接元数据中的安全外部用户标识
- 仅提示疑似重复原因，不自动删除或合并

## 4. 平台连接

### 主页面

主页面只显示平台摘要卡，不再展开全部账号。每张卡固定展示：

- 连接状态
- 已连接账号数
- 可发布账号数
- 读取能力
- 发布能力
- 指标回收能力
- Webhook
- Token 状态
- 额度或限制
- 最近验证时间
- 当前业务异常

卡片使用统一网格高度，X 不再展开历史账号列表。账号列表仅在详情抽屉“账号”标签中显示。

### 平台详情抽屉

- 认证
- 权限
- 账号
- 发布
- 指标
- Webhook
- 额度
- 错误记录

技术权限范围默认折叠；普通模式不显示技术响应、内部配置或原始元数据。

### X 特殊状态

X 卡片单独汇总：

- 已连接 OAuth 账号
- X MCP 状态
- API credits 状态
- 读取、发布、指标回收能力
- 最近真实验证时间

如果 credits 状态为 `depleted` 或剩余额度为 0，页面显示：

> API 额度已用尽：读取、发布或指标回收会受到影响。

### 凭据安全

- 页面不查询 `platform_credentials`
- 页面不显示 Token、Secret、连接配置或完整元数据
- 摘要转换层会从传给组件的数据中移除 `connection_config` 和 `metadata`
- 静态配置中的 `requiredSecrets` 和回调地址不会进入页面摘要对象
- 仅展示权限名称、Token 有效期状态和白名单额度字段

## 5. 修改文件

本任务直接修改：

- `src/pages/AccountsPage.jsx`
- `src/pages/PlatformConnectionsPage.jsx`
- `src/services/ops-service.js`
- `src/styles.css`

本任务新增：

- `src/utils/account-matrix.js`
- `src/utils/platform-connection-summary.js`
- `test/account-matrix.test.mjs`
- `test/platform-connection-summary.test.mjs`
- `ACCOUNT_MATRIX_AND_PLATFORM_CONNECTION_REPORT.md`

同时复用上一阶段已经存在的：

- `src/components/AuxiliaryPageFrame.jsx`
- `src/components/MoreActionsMenu.jsx`
- `src/utils/auxiliary-page-scope.js`

## 6. 验证结果

### 自动化验证

- `npm test`：通过，39/39
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run build`：通过
- `git diff --check`：通过（只有 Windows 换行提示）
- 本地站点 `http://localhost:3001/ai-marketing-studio/`：HTTP 200，应用根节点存在

覆盖的新增测试：

- 三种历史账号角色字段兼容
- 乱码只标记、不伪造
- 三类疑似重复检测
- 自有账号与对标账号业务模型差异
- 平台摘要不携带 Token/Secret/连接原始元数据
- X credits depleted 业务影响
- 未连接/准备中平台状态

### 实际页面截图

本轮在调用应用内页面验证通道时，桌面端验证运行环境返回：

`failed to write kernel assets: 系统找不到指定的路径。 (os error 3)`

已重置并再次尝试，错误仍然发生。为避免伪造验收，本报告不附未实际取得的截图。代码构建和本地 HTTP 可达性已经验证，但“登录态点击与截图”仍需在桌面页面验证通道恢复后补做。

建议人工最短验收路径：

1. 打开“账号矩阵”，确认默认进入“自有账号”和“表格”。
2. 切换“对标与灵感”，确认列结构与自有账号不同。
3. 切换“卡片”，确认没有 47 个超长四列卡片铺开。
4. 打开一个账号详情，逐个点击 8 个详情标签。
5. 打开“平台连接”，确认平台卡高度基本一致且主卡不展开账号列表。
6. 打开 X 详情，确认 OAuth、X MCP、credits 和业务影响可见，技术权限默认折叠。
7. 检查页面中不存在 Token、Secret、连接配置或 Storage 内部路径。

## 7. 回滚方式

本次没有数据库变更，回滚只涉及前端文件：

1. 恢复 `AccountsPage.jsx`、`PlatformConnectionsPage.jsx`、`ops-service.js` 和本次 CSS。
2. 删除两个新增工具函数和两个新增测试。
3. 重新执行 typecheck、lint、test、build。

历史账号、连接、账号大脑、样本和平台数据不受回滚影响。

