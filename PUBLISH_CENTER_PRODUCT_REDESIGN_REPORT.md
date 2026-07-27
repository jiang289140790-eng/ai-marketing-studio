# PUBLISH CENTER PRODUCT REDESIGN REPORT

生成时间：2026-07-27  
线上地址：https://jiang289140790-eng.github.io/ai-marketing-studio/?deploy=42b087d#/publish  
功能提交：`42b087df67a65c75536570c725aedc99ecb53307`

## 结论

发布中心已从“手动创建任务 + 技术适配器调用”改造成“人工审核、AI 执行”的发布操作台。

本轮完成了代码实现、自动化测试、生产构建、GitHub Pages 部署、登录态线上渲染和四种尺寸截图。线上页面已真实读取当前 Campaign、账号、Day、连接状态和现有发布任务。

由于本轮浏览器点击控制在读取登录态页面结构时持续超时，Windows 备用控制又因无法可靠确认当前浏览器网址而按安全策略停止，因此“标签、抽屉和状态动作的逐个线上点击”不能标记为完全通过。相关能力已通过代码和测试验证，但没有用这些结果冒充线上点击验收。

## 产品结构调整

### 页面主结构

- 顶部统一展示当前 Campaign、主账号、平台、Day、连接状态、当前阻塞和下一步操作。
- 顶部统计调整为：
  - 待我批准
  - 今天待发布
  - 发布中
  - 失败待处理
  - 指标待同步
- 页面只保留四个业务标签：
  - 待处理
  - 发布日历
  - 发布中
  - 历史记录
- 手动创建任务从常驻表单移入右侧抽屉，定位为高级补充入口。
- 默认正式任务仍由内容工作台终审后创建。

### 任务状态

用户不再直接选择数据库状态。页面动作驱动状态变化：

```text
awaiting_approval
→ scheduled
→ publishing
→ published

publishing → failed
awaiting_approval / scheduled → cancelled
```

旧数据的 `draft + pending approval` 在显示层兼容映射为“待批准”，没有删除或重写历史任务。

### 发布预检

预检拆成三个独立维度：

1. 内容检查（5项）
   - 文案已批准
   - 素材已批准
   - 平台格式有效
   - Campaign 有效
   - 排期有效
2. 平台检查（3项）
   - 账号已登记
   - OAuth 有效
   - 发布权限与平台能力可用
3. 执行授权
   - `dry_run` / `live`
   - 人工批准

显示结果不再使用互相矛盾的“8/8 通过”和“预检未通过”，而是分别显示业务检查、平台检查、执行授权与最终可发布状态。

### 任务卡片

待处理和发布中的任务默认使用业务卡片，展示：

- 文案摘要
- 素材缩略图
- Campaign
- Day
- 平台
- 账号
- 计划时间
- 安全预演 / 正式执行
- 内容检查
- 平台检查
- 当前阻塞
- 下一步操作
- 追踪链接

历史记录保留紧凑表格视图。

### 发布日历

- 支持未来 7 天。
- 支持周视图和列表视图。
- 显示时间、平台、账号、内容和状态。

### 操作文案

已删除“调用 Adapter”业务按钮，按状态显示：

- 运行安全预演
- 批准并排期
- 正式发布
- 重试发布
- 同步指标
- 查看平台帖子
- 退回内容工作台
- 重新连接账号

发布中心不会自动批准，也不会自动真实发帖。

## 连接状态与平台能力

发布中心复用平台连接统一摘要服务，与账号矩阵、平台连接页面保持同一来源，并区分：

- 账号已登记
- OAuth 是否有效
- MCP 读取是否可用
- 发布是否可用
- 指标回收是否可用

未绑定账号显示“仅计划草稿，无法发布”。  
OAuth 过期显示“账号已登记 / OAuth 已过期 / 当前不可发布”。  
指标同步按钮根据当前平台能力决定，不再写死 Telegram。

## 错误边界

普通模式只展示：

- 用户可理解说明
- 业务影响
- 推荐操作
- 错误编号
- 是否可重试

不再直接输出 `error.message`。高级详情仅展示脱敏技术信息。

## 字段关系与兼容计划

### 当前关系

- `publish_tasks.campaign_id`：真实关联 `campaigns.id`，表示运营活动。
- `campaign_link_id`：表示追踪链接，前端名称统一为“追踪链接”。
- 当前数据库暂未增加 `publish_tasks.campaign_link_id` 字段。
- 兼容期将 `campaign_link_id` 保存到 `publish_content` JSON 中，不再错误复用 `campaign_id`。

### 后续最小迁移计划

本轮没有执行数据库迁移。未来如需结构化查询追踪链接，建议：

1. 为 `publish_tasks` 增加可空 `campaign_link_id` 外键；
2. 从兼容 JSON 或现有关联安全回填；
3. 发布服务优先读新字段，继续兼容旧 JSON；
4. 验证历史数据后再停止写入兼容 JSON。

不需要创建第二套发布任务表。

## 修改文件

- `src/pages/PublishQueuePage.jsx`
- `src/services/ops-service.js`
- `src/services/publish-service.js`
- `src/services/publish-state-machine.js`
- `src/styles.css`
- `src/utils/publish-center-model.js`
- `test/publish-state-machine.test.mjs`
- `test/publish-center-model.test.mjs`

## 自动化验证

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` | PASS，96/96 |
| `npm run build` | PASS |
| GitHub Pages workflow | PASS |
| 部署 workflow | https://github.com/jiang289140790-eng/ai-marketing-studio/actions/runs/30236490222 |

自动化测试覆盖：

- 页面任务分组与统计
- 待批准、已排期、发布中、已发布、失败、取消状态映射
- dry-run / live 执行授权
- 内容检查、平台检查和最终状态拆分
- 未绑定账号
- OAuth 过期
- 预检通过与失败
- 失败任务重试动作
- 指标能力按平台读取
- `campaign_id` 与 `campaign_link_id` 兼容映射

## 登录态线上验收

### 已真实验证

- 登录态线上页面成功加载新版本。
- 当前 Campaign 筛选为“X 媒体优先短内容测试”。
- 当前主账号为 `chanchiholeo1`，平台 X，当前 Day 1。
- 页面读取统一连接状态并显示“OAuth 有效，可以发布”。
- 顶部五项统计真实显示。
- 四个标签真实显示：待处理、发布日历、发布中、历史记录。
- 待处理任务显示 Day 1、测试执行、文案摘要和 2 张图片素材。
- 手动创建任务已改为右上角按钮。
- 页面不再出现“调用 Adapter”。
- 1920、1440、1366、390 均未发现横向溢出。
- 移动端改为菜单入口，上下文和主要操作保持可读。

### 尚未完成的线上点击验收

以下项目已有实现和自动化测试，但本轮浏览器点击控制被运行环境阻塞，不能标记为线上点击 PASS：

- 逐个切换四个标签并核对内容刷新；
- 打开并关闭手动创建任务抽屉；
- 在真实 OAuth 过期任务上验证按钮；
- 在真实未绑定账号任务上验证阻塞文案；
- 在真实失败任务上点击重试；
- 在真实预检通过/失败任务间切换；
- 实际点击“退回内容工作台”并核对目标对象。

阻塞来自验收控制环境，不是页面报错；Statsig/Codex 浏览器遥测超时未计入网站错误。

## 截图

- `acceptance-evidence/2026-07-27/publish-center-1920.png`
- `acceptance-evidence/2026-07-27/publish-center-1440.png`
- `acceptance-evidence/2026-07-27/publish-center-1366.png`
- `acceptance-evidence/2026-07-27/publish-center-390.png`

## 回滚方式

功能改造集中在提交：

```text
42b087df67a65c75536570c725aedc99ecb53307
```

如需回滚，可对该提交创建反向提交。没有数据库迁移、没有删除历史发布任务，也没有修改 Secrets，因此回滚不涉及数据恢复。

## 最终验收状态

**PARTIALLY_ACCEPTED**

原因：代码、测试、生产部署、登录态线上渲染和响应式截图均已完成；逐按钮线上交互仍受当前浏览器控制环境阻塞，不能仅凭构建和测试标记为完全验收。
