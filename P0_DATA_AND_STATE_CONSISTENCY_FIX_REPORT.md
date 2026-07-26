# P0_DATA_AND_STATE_CONSISTENCY_FIX_REPORT

## 结论

三个 P0 数据与状态一致性问题已修复，并在登录后的 GitHub Pages 生产页面完成真实验证。

- 线上地址：<https://jiang289140790-eng.github.io/ai-marketing-studio/>
- 验收 Campaign：`X 媒体优先短内容测试`
- 当前主账号：`X · chanchiholeo1`
- 当前 Day：`Day 1`
- 生产提交：`0362c38988c327993d3280015055e47ac2011963`
- GitHub Pages 部署：成功
- 未修改数据库架构
- 未重新授权 X
- 未新增页面

## P0-1 内容情报

### 根因

`content_analysis` 到 `viral_contents` 同时存在两条历史外键：

- `content_analysis_content_id_fkey`
- `content_analysis_viral_content_id_fkey`

原查询使用未指定外键的嵌入式关系：

```text
viral_contents(...)
```

PostgREST 无法判断应使用哪条关系，导致 `listContentAnalysis()` 失败。内容情报页面又使用一个 `Promise.all()` 同时加载账号、内容和分析；任一查询失败后，三个前端数组均保持初始空数组，因此将“加载失败”错误显示为“情报账号 0”。

数据库实际状态不是 0：

- 当前 Campaign 已关联灵感账号 `@maisiewzil`
- 线上修复后“情报账号”真实显示为 `1`

### 修复

- 明确使用：

```text
viral_contents!content_analysis_viral_content_id_fkey
```

- 保留现有两条外键，没有删除外键规避问题。
- 查询成功且为空时才显示 `0`。
- 查询失败时统计显示 `—`，并标记“加载失败，并非 0”。
- 当前 Campaign 没有竞争/灵感账号时显示“当前运营活动尚未添加情报账号”。
- 普通页面不再显示 PostgREST 原始错误，提供安全错误摘要和重新加载入口。

### 线上验收

- 登录状态：通过
- 当前 Campaign：正确
- 情报账号：`1`
- 来源账号下拉：包含 `@maisiewzil · X`
- 原始数据库错误：未出现

## P0-2 发布预检状态

### 根因

页面同时使用两套未分层的判断：

- 当前页面动态计算的 8 项业务检查
- `publish_result.preflight.passed` 中保存的上一次安全预演结果

动态检查用于展示 `8/8`，历史字段却用于展示“预检未通过”，造成同一张卡片出现互相矛盾的结论。

### 修复

发布状态拆分为三层：

1. 业务检查：内容、素材、账号、权限、格式、素材 URL、排期、执行模式。
2. 执行条件：已运行并通过安全预演、人工授权等。
3. 最终状态：可以发布或暂不可发布。

页面现在明确显示：

```text
业务预检：6/8 通过
执行条件：未满足
最终状态：暂不可发布
```

历史结果改为“上次安全预演通过/未通过”，并注明当前结论以“当前业务检查和执行条件”为准。

当前真实任务未通过项是：

- 账号连接
- 发布权限

这与 X OAuth 已过期的真实状态一致。

### 线上验收

- 内容检查：通过
- 素材检查：通过
- 账号连接：未通过
- 平台权限：未通过
- 格式检查：通过
- 素材 URL：通过
- 排期检查：通过
- 执行模式：通过
- 执行条件：未满足
- 最终状态：暂不可发布
- 未执行真实发布

## P0-3 账号连接状态

### 根因

历史代码把以下条件都视为“已连接”：

```text
status = connected
或
is_connected = true
```

当前 X 连接记录同时存在旧的 `status = connected` 和明确的 `is_connected = false` / 已过期时间。账号矩阵采信旧文本，平台连接页面采信有效授权，导致两个页面结论相反。

### 修复

建立统一连接判定：

- `is_connected = false` 明确优先，不能被旧 `status = connected` 覆盖。
- `expires_at` 已过期时视为 OAuth 无效。
- 账号登记、OAuth、读取、发布、指标回收分开表达。
- 账号矩阵、平台连接和发布预检复用同一连接有效性函数。

当前线上真实状态：

```text
账号矩阵
账号已登记
OAuth 已过期
不可发布
指标不可用

平台连接
已登记账号 2
OAuth 有效账号 0
可发布账号 0
OAuth 已过期：账号仍保留登记，但当前不可发布或回收指标

发布中心
账号连接未通过
发布权限未通过
最终状态暂不可发布
```

没有执行 X OAuth 重新授权。

## 修改文件

- `src/services/intelligence-service.js`
- `src/pages/ContentIntelligence.jsx`
- `src/services/publish-state-machine.js`
- `src/pages/PublishQueuePage.jsx`
- `src/utils/platform-connection-summary.js`
- `src/utils/account-matrix.js`
- `src/pages/AccountsPage.jsx`
- `src/pages/PlatformConnectionsPage.jsx`
- `test/account-matrix.test.mjs`
- `test/platform-connection-summary.test.mjs`
- `test/publish-state-machine.test.mjs`

## 自动化验证

- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm test`：77/77 通过
- `npm run build`：通过
- GitHub Pages Workflow：通过

自动化测试重点覆盖：

- `is_connected = false` 优先于旧 `status = connected`
- OAuth 过期时账号矩阵显示“账号已登记 / OAuth 已过期 / 不可发布”
- 发布预检不能绕过 OAuth 失效
- 8 项业务检查通过但执行授权未满足时显示“暂不可发布”
- 历史安全预演结果不覆盖当前业务检查

## 页面前后截图

### 内容情报

- 修复前：`acceptance-evidence/2026-07-26/page-intelligence.png`
- 修复后：`acceptance-evidence/2026-07-26/p0-after-intelligence.png`

### 发布中心

- 修复前：`acceptance-evidence/2026-07-26/page-publish.png`
- 修复后：`acceptance-evidence/2026-07-26/p0-after-publish.png`

### 账号矩阵

- 修复前：`acceptance-evidence/2026-07-26/page-accounts.png`
- 修复后：`acceptance-evidence/2026-07-26/p0-after-accounts.png`

### 平台连接

- 修复前：`acceptance-evidence/2026-07-26/page-connections.png`
- 修复后：`acceptance-evidence/2026-07-26/p0-after-connections.png`

## 验收矩阵

| 验收项 | 结果 | 线上证据 |
|---|---|---|
| 内容情报不暴露数据库错误 | PASS | 页面无 PostgREST 原始错误 |
| 查询失败不显示 0 | PASS | 失败态使用 `—` 和安全错误摘要 |
| 当前 Campaign 情报账号正确 | PASS | 显示 `1`，下拉包含 `@maisiewzil` |
| 发布状态无矛盾 | PASS | 业务检查、执行条件、最终状态分层 |
| 账号矩阵与平台连接一致 | PASS | 均显示 OAuth 已过期、不可发布 |
| 发布中心与连接状态一致 | PASS | 账号和发布权限两项未通过 |
| 不重新授权 X | PASS | 未执行 OAuth 写操作 |
| 不修改数据库架构 | PASS | 无 migration、无 DDL |
| 线上已部署 | PASS | GitHub Pages workflow 成功 |

## 当前真实阻塞

本轮 P0 数据和状态显示已经统一。Day 1 仍然不能正式发布的原因是真实的外部授权状态：

- X OAuth 已过期
- OAuth 有效账号为 0
- 可发布账号为 0

这不是页面错误。后续如需恢复发布能力，需要单独重新完成 X OAuth 授权；本任务按要求没有执行该操作。
