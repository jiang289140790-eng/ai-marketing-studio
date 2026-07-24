# AI Marketing Studio 公网执行网关部署报告

## 结论

线上控制台到可信执行端的闭环已经打通：

`GitHub Pages 前端 → Supabase Edge Functions → HTTPS Bridge → AI Marketing Studio MCP → Supabase`

公网 Bridge 地址：

- `https://bridge.47-251-244-196.sslip.io`

本次只完成安全预检与 dry-run。真实外部发布保持关闭，没有向 X、Telegram 或其他平台发送内容。

## 已部署组件

- 阿里云 ECS 上的 Bridge 容器：`ai-marketing-studio-bridge`
- 当前运行镜像：`ai-marketing-studio-runtime:platform-compat2`
- Caddy HTTPS 反向代理与自动证书
- Bridge 仅绑定 `127.0.0.1:8787`
- 容器自动重启策略：`unless-stopped`
- 容器安全限制：
  - drop all Linux capabilities
  - `no-new-privileges`
  - 768 MiB 内存上限
  - 1536 MiB memory+swap 上限
- Supabase Edge Functions：
  - `ops-health`
  - `ops-status`
  - `ops-execute`

## 安全配置

- Edge Function 到 Bridge 使用 HMAC 请求签名。
- 错误签名请求返回 401。
- Bridge、Supabase 服务端密钥和平台凭证不进入浏览器前端。
- `ALLOW_REAL_PUBLISH=false`
- `DRY_RUN=true`
- `CONTENT_FACTORY_DRY_RUN=true`
- Bridge 环境文件权限为 600。
- 未修改数据库结构，未放宽 RLS。

## 健康检查

- 公网 HTTPS 健康检查通过。
- Edge Function 健康检查通过。
- Bridge 已识别 50 个 MCP 工具。
- AI Marketing Studio MCP 可用。
- X MCP 当前仍未接入该公网 Bridge，因此状态保持 unknown/unavailable。

线上“系统状态”页已确认以下连接为可用：

- Supabase 已连接
- Edge Function 已部署
- MCP Bridge 已连接
- AI Marketing Studio MCP 已连接

## 兼容性修复

最终验收定位并修复了两个旧线上数据库兼容问题：

1. `publish_tasks.platform` 的旧约束使用 `X`、`Telegram`、`YouTube` 等首字母大写值，而 MCP 内部使用小写标准值。现在创建任务遇到旧约束时会自动回退为旧标签，查询队列同时兼容两种格式。
2. 当前线上 `publish_tasks.campaign_id` 外键指向 `campaign_links`，但内容包的 Campaign 来自 `campaigns`。现在写入前先验证目标是否存在于 `campaign_links`；不存在时安全写入 `null`，避免错误关联。

修复文件：

- `E:\projects\video-generator\mcp-servers\marketing-studio\lib\tools\distribution.js`

## 最终闭环验收

验收流程：

1. 内容包终审并创建发布任务
2. 人工批准发布任务
3. 执行 `dry_run + preflight_only`

结果：

- 发布任务 ID：`1c9ffcd2-05dc-497b-89c6-e5b5a78186db`
- 内容包终审运行 ID：`15683431-e928-41f6-b0cb-783fa0191e23`
- 批准运行 ID：`bc54cd17-6063-48ac-8509-471bb3bf7e4c`
- 发布预检运行 ID：`43ac75fd-9f76-45ea-9fa1-87e65af81342`
- 三个运行状态：`completed`
- 发布执行结果：`dry_run`
- 发布任务审批状态：`approved`
- 发布任务状态：`draft`
- `published_at`：空
- 外部发布请求：`false`

这证明线上按钮背后的执行链路已完整贯通，同时安全边界有效。

## 验证记录

- MCP lint 通过。
- Phase 8 Distribution 自动测试 5/5 通过。
- GitHub Pages 生产基线提交：`e964259`
- 线上地址：
  - `https://jiang289140790-eng.github.io/ai-marketing-studio/?deploy=e964259`
- 可重复执行的安全验收脚本：
  - `E:\projects\ai-marketing-studio\scripts\run-public-bridge-acceptance.ps1`

验收脚本不会保存或打印 Supabase 密钥；邮箱必须在运行时显式提供。

## 已知风险与后续建议

1. 用户曾在对话和截图中暴露 ECS root 密码，应立即在阿里云控制台轮换，并优先改为 SSH 密钥登录。
2. ECS 安全组还开放了多个与本任务无关的端口。未获明确授权，本次没有调整；建议单独审计并收窄。
3. `sslip.io` 是第三方通配 DNS，正式长期使用建议切换到自有域名。
4. X MCP 尚未接入公网 Bridge；在接入 OAuth 和服务端凭据前，不应显示为可发布。
5. ECS 为 2 vCPU / 4 GiB，余量有限；应监控内存与容器重启。
6. 系统存在待安装安全更新。更新与重启应安排维护窗口后执行。
7. 当前 Caddy 配置已在运行中加载；后续替换配置文件后应显式 reload 或重建容器，避免绑定文件 inode 导致配置未刷新。

## 真实发布前的解锁条件

只有同时满足以下条件，才能考虑开启真实发布：

- 对应平台 OAuth/API 连接已验证
- 发布账号与内容包明确绑定
- 前端执行二次人工确认
- 服务端再次验证 `human_confirmed`
- 审批记录和审计日志完整
- 将 `ALLOW_REAL_PUBLISH` 从 false 改为 true，并在变更后重新进行一轮受控验收

在完成这些条件前，应继续保持 dry-run。
