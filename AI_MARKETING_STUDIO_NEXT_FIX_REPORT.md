# AI Marketing Studio 下一阶段修复报告

完成日期：2026-07-23（Asia/Shanghai）

## 结果摘要

- 最新已验证功能 commit：`c394a00f7292311ee42fd8f8f0e42a2e3c2f06ed`
- GitHub Actions：成功，run `29972571735`
- GitHub Pages：https://jiang289140790-eng.github.io/ai-marketing-studio/
- Supabase `ops-execute`：已部署 version 3，`verify_jwt=true`
- MCP Bridge 公网域名：未部署
- Supabase secrets：`OPS_MCP_BRIDGE_URL`、`OPS_MCP_BRIDGE_SECRET` 均未配置
- 结论：**线上界面与数据层已完成，执行层等待 MCP Bridge 部署。**

Bridge 尚未真实部署，线上执行闭环未完成。

## 修改文件

- `src/pages/ContentWorkspacePage.jsx`
- `src/components/ExecutionButton.jsx`
- `src/services/execution-gateway.js`
- `src/pages/PlatformConnectionsPage.jsx`
- `src/data/platform-connections.js`
- `src/pages/PublishQueuePage.jsx`
- `src/pages/KnowledgeVaultPage.jsx`
- `src/App.jsx`
- `src/styles.css`
- `supabase/functions/ops-execute/index.ts`
- `services/mcp-runtime-bridge/action-registry.js`
- `services/mcp-runtime-bridge/mcp-client.js`
- `services/mcp-runtime-bridge/server.js`
- `services/mcp-runtime-bridge/README.md`
- `docs/MCP_BRIDGE_DEPLOYMENT_PLAN.md`
- `docs/FRONTEND_BUNDLE_OPTIMIZATION.md`

## MCP Bridge 检查

已确认：

- `ops-health` 检查 Edge、Bridge 配置与 MCP 状态。
- `ops-execute` 只允许登录用户，通过 action allowlist、资源归属、频率限制与幂等检查后调用 Bridge。
- `_shared/ops-gateway.ts` 已实现 HMAC SHA-256 签名。
- 前端只调用 Supabase Edge Function，不直接访问 Bridge，也不保存 Bridge secret。
- Bridge 骨架包含 `/health`、`/v1/actions`、HMAC 验签、action allowlist、MCP tools/list、超时和脱敏审计日志。

当前缺口：

- 没有可用的公网 HTTPS Bridge 运行环境。
- Bridge Docker 构建尚未把 AI Marketing Studio MCP 一并打包。
- `X_MCP_ENABLED` 目前只是健康状态标记，X MCP transport 与真实工具注册尚未完成。

脱敏 `ops-health` 线上结果：

```json
{
  "edge_function": true,
  "bridge_configured": false,
  "bridge": false,
  "mcp": false,
  "x_mcp": false
}
```

完整真实部署步骤见 `docs/MCP_BRIDGE_DEPLOYMENT_PLAN.md`。

## 内容工作台步骤状态

已在现有内容卡中增加统一的 8 步生产状态：

1. 文案确认
2. 角色 / LoRA 确认
3. 素材引用
4. 图片生成
5. 视频生成
6. 结果回传
7. 终审
8. 发布队列

每一步支持“已完成 / 待处理 / 被阻塞 / 需要 Bridge”，同时显示当前阻塞原因与下一步建议按钮。线上登录验证显示 79 张内容卡均有 8 个步骤。

## 执行按钮

- 表单问题保持“请先填写…”提示。
- 执行层问题统一为“执行服务暂未连接，请查看 Command Center 的执行网关状态。”
- 业务问题显示具体下一步，不再在每个按钮下重复 Bridge 技术详情。

## 平台能力矩阵

已完成 Telegram、X、Instagram、YouTube、TikTok、Discord 六个平台的能力矩阵，展示：

- 连接状态与账号数
- 采集、发布、数据回收、Webhook
- 所需权限
- 当前阻塞原因

没有真实接入的平台明确显示“准备中/未接”。线上验证矩阵共 6 行，六张平台卡均可见，页面无横向溢出。

## 发布队列 dry-run

- 发布前检查只提交 `dry_run=true`、`preflight_only=true`。
- 真实发布只允许 `dry_run=false`、`human_confirmed=true`。
- `ops-execute` Edge Function version 3 已在服务端强制验证这两种请求形态。
- Bridge 再次强制：只有 `ALLOW_REAL_PUBLISH=true`、人工确认且明确请求真实发布时才允许 `dry_run=false`。
- 内容、账号、权限和执行服务的阻塞提示已按任务要求统一。

当前线上发布队列没有发布任务，因此未发起 dry-run；这是安全的空状态验证，不代表真实发布适配已经通过。

## Knowledge Vault

- JSON 字符串与对象会转换为可读业务字段。
- 自动标题不再输出“未命名记录/运营记录/分析记录”。
- 增加来源筛选与账号筛选。
- 线上验证读取 367 张知识卡，未出现 `[object Object]`，未出现标题“未命名记录”。

## 构建与线上验证

- `npm run lint`：通过
- `npm run build`：通过
- `npm run migrations:check`：通过（28 个 migration，overall safe）
- Bridge `npm run lint`：通过
- GitHub Pages Actions：成功
- 登录状态：正常
- Command Center：读取 Supabase 真实数据，执行网关如实显示未配置
- 内容工作台：内容包与 8 步状态正常
- 平台连接：能力矩阵正常
- 发布队列：空状态正常，dry-run 约束在前端与服务端均已实现
- Knowledge Vault：数据与筛选正常
- 响应式：桌面与 390px 窄屏无横向溢出；手机导航为 sticky，不裁切

## 包体积

AI 成果、平台连接、系统状态、工作流配置和知识库已改为按需加载。主包约 578 KB，仍有 Vite 大包警告；后续可继续拆分内容工作台与 Supabase 数据适配层。详见 `docs/FRONTEND_BUNDLE_OPTIMIZATION.md`。

## 剩余风险与下一步

1. 选择 Render、Railway、Fly.io 或云服务器部署真实 Bridge。
2. 将 AI Marketing Studio MCP 与 X MCP 一并打包并完成真实 tools/list 验证。
3. Bridge 全绿后再设置两个 Supabase secrets，并重新部署 `ops-health`、`ops-status`、`ops-execute`。
4. 用一条已终审、已连接账号且具备发布权限的任务执行 dry-run。
5. dry-run 和平台 sandbox 验证通过前，保持 `ALLOW_REAL_PUBLISH=false`。

不得将当前状态描述为“线上执行闭环已完成”。
