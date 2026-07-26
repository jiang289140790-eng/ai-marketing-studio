# FINAL X AND AUXILIARY PAGES ACCEPTANCE REPORT

日期：2026-07-26  
结论：**PARTIALLY_ACCEPTED**  
验收代码基线：`4fb83b070e9a744daa0c65d81ed5c57b9e535031`

## 1. 结论摘要

本轮已恢复现有 `x-mcp` 应用的本地 xurl OAuth，X API `/users/me`、公开账号读取、公开帖子读取以及 X MCP 的实际工具调用均成功。没有创建新 X 应用，没有执行真实发帖，也没有把 Client Secret、OAuth Token、授权码或带签名的素材地址写入代码或本报告。

当前能力必须拆开理解：

| 能力 | 真实状态 | 依据 |
|---|---|---|
| X 账号已登记 | 可用 | 当前主账号为 `@chanchiholeo1` |
| 本地 xurl OAuth | 有效 | `/users/me` 返回当前账号 |
| X MCP 读取 | 可用 | `get_users_me`、`get_posts_by_id` 实际调用成功 |
| X 公开内容读取 | 可用 | 成功读取 `@maisiewzil` 最新公开帖子 |
| X API credits | 当前读取可用，余额未知 | 多次真实读取成功；API 未返回可展示余额 |
| X MCP 发帖 | 不可用 | 当前 X MCP 工具清单没有发帖工具 |
| 网站端 X OAuth | 已过期 | Supabase 中网站连接凭证已过期 |
| 网站端发布 | 不可用 | Day 1 权威预检的 `publish_permission` 未通过 |
| 网站端指标回收 | 当前 Day 1 不可用 | Day 1 尚未真实发布，没有平台帖子 ID |

因此网站应显示：**账号已登记；X MCP 可读取；网站 OAuth 已过期；当前不可发布。**

## 2. X OAuth 与 MCP 验证

### 2.1 OAuth

- 复用现有应用：`x-mcp`
- 复用现有账号：`@chanchiholeo1`
- 将本地 xurl 回调地址与 X 应用中已登记的 `http://localhost:8080/callback` 对齐
- 通过本机现有代理完成授权码交换
- `/users/me` 返回：
  - 用户名：`chanchiholeo1`
  - 显示名：`Nina Voss`
- 未创建新应用
- 未把任何凭据写入前端、普通数据库字段、日志或报告

### 2.2 X MCP

通过现有 `xurl --app x-mcp mcp` 连接到 `https://api.x.com/mcp`：

- `tools/list` 成功
- `get_users_me` 成功
- `get_posts_by_id` 成功
- 可见工具覆盖账号、帖子、新闻、趋势、时间线、提及和书签
- 当前工具清单没有创建帖子工具，因此不能把 OAuth 请求过写权限等同于“MCP 可发帖”

Agent Reach 的 `twitter-cli` 因浏览器 Cookie 解密失败不可用；按照该工具的回退规则，最终使用现有 xurl/X API 完成了真实读取，没有把浏览器 Cookie 或 Token 手工复制到环境变量。

## 3. 公开内容写入内容情报

目标账号：`@maisiewzil`  
来源：X API 真实公开数据  
帖子：`https://x.com/maisiewzil/status/2080914108375761018`

写入结果：

| 对象 | ID |
|---|---|
| 当前 Campaign | `efd3d863-1e6e-4e49-8b87-e95af08f92e8` |
| Campaign 灵感账号 | `d98cc536-d556-4275-9e1c-0a817f5641c3` |
| `viral_contents` | `488c74a3-0731-4bc2-be36-291f50e6095b` |

已保存真实字段：

- 发布时间：2026-07-25 07:12:39 UTC
- Views：2324
- Likes：98
- Comments：3
- `social_account_id` 正确指向当前 Campaign 的灵感账号
- 通过 URL 存在性检查避免重复写入

数据库复查通过，但由于登录态浏览器控制故障，本轮未能把“线上登录后页面可见”标记为 PASS。

## 4. Day 1 发布安全预演

| 对象 | ID |
|---|---|
| Day 1 内容包 | `56737ea8-5dbd-4d15-8808-8d5eff370d5d` |
| 发布任务 | `6068fb76-1905-4a48-981c-4d1e8f976187` |

执行结果：

- 复用已有发布任务，幂等检查通过
- `execution_mode = dry_run`
- 真实发帖：**未触发**
- 内容批准：通过
- 素材批准：通过
- 账号登记：通过
- 平台格式：通过
- 素材地址：通过
- 排期：通过
- 执行模式：通过
- 网站发布凭证：**未通过**
- 汇总：**业务检查 7/8；最终状态为暂不可发布**
- 数据库状态：`draft / pending / preflight_blocked`

这不是发布失败，也不是 8/8 通过。正确解释是：安全预演已执行，未触发真实发布，但网站端 X 发布凭证仍不可用。

## 5. 指标回收

- 已从 X API 获取并保存目标公开帖的真实公开指标。
- Day 1 尚未执行 live 发布，没有 `platform_post_id`，因此不能伪造 Day 1 发布指标。
- X API 真实读取成功，说明当前读取 credits 未耗尽。
- X API 没有在本次响应中提供余额，页面应显示“当前读取可用；详细额度未上报”，不能显示虚构余额。

## 6. 网站状态一致性

代码层已经使用统一连接状态：

- 账号矩阵：读取统一 OAuth 状态，不再用旧 `connected` 文本绕过过期状态
- 平台连接：区分账号登记、OAuth、X MCP、读取、发布、指标和额度
- 发布中心：区分业务检查与执行条件
- 系统状态：单独展示 X MCP 和发布执行器

但生产环境存在两个不同的执行边界：

1. Codex 本机 `xurl / X MCP`：本轮已恢复，可读取。
2. GitHub Pages → Supabase Edge Function → MCP Bridge：当前 Bridge 的说明明确写明尚未接入 X MCP 远程 transport；网站端 X OAuth 凭证也已过期。

因此不能把本地 xurl 成功伪装成网站端 OAuth 或发布凭证成功。

## 7. 登录后线上页面验收

### 已确认

- GitHub Pages 可访问。
- 未登录页面不会读取用户数据。
- 未登录时页面显示 0 是匿名状态，不作为业务数据验收结果。

### 阻塞

- Chrome 登录态标签页存在，但浏览器控制通道持续超时重置。
- 内置浏览器可以访问线上站点，但没有 GitHub 登录态。
- 内置浏览器进入 GitHub 登录页后需要用户登录，不能代替用户填写凭据。
- 因此本轮无法生成可信的登录后新版页面截图，也无法把五个页面的真实展示标成 PASS。

## 8. 验收矩阵

| 原始要求 | 状态 | 说明 |
|---|---|---|
| 使用现有 X 应用重新授权 | PASS | 复用 `x-mcp`，OAuth 与 `/users/me` 成功 |
| 不创建新应用 | PASS | 未创建 |
| 不泄露 Secret/Token | PASS | 未写入代码、报告或普通字段 |
| OAuth 有效 | PASS | 对本地 xurl 有效 |
| `/users/me` 成功 | PASS | 真实返回当前账号 |
| X MCP 工具可见 | PASS | `tools/list` 成功 |
| 可读取账号 | PASS | X MCP 和 X API 均成功 |
| 可读取公开帖子 | PASS | `@maisiewzil` 读取成功 |
| 写权限状态明确 | PASS | OAuth 请求过写 scope；X MCP 无发帖工具；网站端凭证过期，不可发布 |
| credits 状态明确 | PASS | 当前读取可用，详细余额未上报 |
| 账号矩阵状态真实一致 | CODE_ONLY | 统一状态代码和测试通过，未完成登录后页面点击 |
| 平台连接状态真实一致 | CODE_ONLY | 同上 |
| 内容工作台状态真实一致 | CODE_ONLY | 同上 |
| 发布中心状态真实一致 | CODE_ONLY | 数据与状态机通过；未完成页面点击 |
| 系统状态真实一致 | CODE_ONLY | 同上 |
| 读取一个目标 X 账号 | PASS | `@maisiewzil` |
| 保存一条公开内容 | PASS | 已写入 `viral_contents` 并关联 Campaign 灵感账号 |
| 内容情报线上页面正确显示 | BLOCKED | 登录态浏览器控制不可用 |
| Day 1 执行发布预检 | PASS | 权威预检已执行 |
| 创建 dry-run 发布任务 | PASS | 任务已存在并幂等复用 |
| 发布中心线上显示任务 | BLOCKED | 登录态浏览器控制不可用 |
| 回收真实指标 | PASS | 目标公开帖指标已回收；Day 1 因未发布明确不可用 |
| 不执行真实发帖 | PASS | `publish_triggered = false` |
| 登录后新版截图 | BLOCKED | 登录态浏览器控制不可用 |

## 9. 工程验证

- `npm run typecheck`：PASS
- `npm run lint`：PASS
- `npm test`：PASS，81/81
- `npm run build`：PASS

这些结果只证明工程检查通过，没有被当作登录后页面验收 PASS。

## 10. 尚未完成与下一步

关键未通过项：

1. 网站端 X OAuth 仍需在“平台连接”中重新连接；该凭证与本机 xurl OAuth 是两套安全边界。
2. MCP Bridge 仍需接入 X MCP 远程 transport，网站系统状态才能真实显示 X MCP 可用。
3. 需要在内置浏览器完成 GitHub 登录，或恢复 Chrome 控制通道。
4. 登录后刷新并验证：
   - 内容情报出现 `@maisiewzil` 的新内容
   - 账号矩阵显示“账号已登记 / OAuth 状态 / 发布能力”
   - 平台连接显示网站端 X OAuth 的真实状态
   - 发布中心出现任务 `6068fb76-1905-4a48-981c-4d1e8f976187`
   - 系统状态区分本地读取能力与网站执行能力
5. 页面通过后补充本轮新版截图，才可把相关 `CODE_ONLY/BLOCKED` 改为 `PASS`。

## 11. 回滚

- 删除本轮新增的 `viral_contents` 记录：
  `488c74a3-0731-4bc2-be36-291f50e6095b`
- 发布任务是历史任务的幂等复用，本轮没有新建重复任务；如需回滚本轮预检，只需保留审计记录，不执行 live。
- 本地 xurl 回调地址恢复前应先确认 X 应用实际登记地址，避免再次造成 OAuth 回调不匹配。

最终判定：**PARTIALLY_ACCEPTED**
