# AI Marketing Studio MCP Bridge 部署阻塞报告

日期：2026-07-23（Asia/Shanghai）

## 结论

Bridge 尚未真实部署，线上执行闭环未完成。

线上界面与数据层已完成，执行层等待 MCP Bridge 部署。

本次没有配置假的 Bridge 地址，没有创建临时公网地址充当生产域名，也没有向 Supabase 写入 `OPS_MCP_BRIDGE_URL` 或 `OPS_MCP_BRIDGE_SECRET`。

## 当前阻塞条件

缺少：**公网 HTTPS 部署环境**。

已检查的候选环境：

| 候选环境 | 检查结果 | 结论 |
|---|---|---|
| Render | 本机无 CLI、无已配置凭据 | 无法部署 |
| Railway | 本机无 CLI、无已配置凭据 | 无法部署 |
| Fly.io | 本机无 CLI、无已配置凭据 | 无法部署 |
| Cloudflare Tunnel | 已安装 `cloudflared`，但没有账户 origin certificate 或已授权 tunnel | 不能创建稳定生产 tunnel |
| Docker Desktop | Docker API 不可用，daemon 未运行 | 不能在本机完成容器构建验证 |
| AutoDL / SeetaCloud | 既有主机名当前 DNS 解析失败，SSH 端口不可达 | 不能作为当前部署环境 |

GitHub 仓库目前是公开仓库；部署任务要求使用私有仓库或安全构建上下文，因此不应把包含独立 MCP Server 的部署包和生产配置直接扩展到当前公开仓库后再接入托管平台。

## 本地 Bridge 自检

本地使用临时随机 HMAC 密钥和端口 `18787` 完成验证，未使用生产 secret。

| 检查项 | 结果 |
|---|---|
| Bridge 监听 | 通过（本地 `127.0.0.1:18787`） |
| `GET /health` 正确 HMAC | 通过 |
| `/v1/actions` 错误签名 | 返回 HTTP 401，拒绝访问 |
| AI Marketing Studio MCP tools/list | 通过 |
| 返回工具数量 | 50（health 返回上限） |
| MCP Server 单元测试 | 7/7 通过 |
| X MCP | 未接入，health 为 `unknown` |
| `ALLOW_REAL_PUBLISH` | `false` |

本地脱敏健康结果：

```json
{
  "bridge": true,
  "mcp": true,
  "tool_count": 50,
  "x_mcp": "unknown",
  "real_publish_enabled": false,
  "invalid_signature_status": 401
}
```

本地验证只证明 Bridge 代码、HMAC 与 AI Marketing Studio MCP 可以协同运行，不代表已具备公网生产可用性。

## 部署包审计

当前 `services/mcp-runtime-bridge/Dockerfile` 只复制 Bridge 自身，没有包含：

```text
E:\projects\video-generator\mcp-servers\marketing-studio
```

因此当前 Dockerfile 不能单独构建完整生产镜像。

此外：

- `MARKETING_STUDIO_MCP_COMMAND` 与 `MARKETING_STUDIO_MCP_ARGS` 已写入部署计划，但当前 `mcp-client.js` 实际仍固定使用 Node 启动 `MARKETING_STUDIO_MCP_DIR/server.js`。
- `X_MCP_ENABLED` 只是状态标记，并未启动或连接真实 X MCP，也不能列出 X tools。
- 在选择真实部署平台和私有构建上下文之前，不应提交包含另一个项目源码的部署镜像改动。

## Supabase 状态

项目：`qtrlymiqohbjvklwegsw`

| Edge Function | 状态 | 版本 | JWT 验证 |
|---|---:|---:|---:|
| `platform` | ACTIVE | 12 | false |
| `ops-health` | ACTIVE | 2 | true |
| `ops-status` | ACTIVE | 2 | true |
| `ops-execute` | ACTIVE | 3 | true |

Bridge secrets：

```text
OPS_MCP_BRIDGE_URL       未配置
OPS_MCP_BRIDGE_SECRET    未配置
```

因此当前线上脱敏 `ops-health` 仍应为：

```json
{
  "edge_function": true,
  "bridge_configured": false,
  "bridge": false,
  "mcp": false,
  "x_mcp": false
}
```

没有重新部署 Edge Functions，因为没有经过验证的 Bridge 域名和配套 secret；此时重新部署不会解决阻塞。

## 构建与安全验收

- 根项目 `npm run lint`：通过
- 根项目 `npm run build`：通过
- 根项目 `npm run migrations:check`：通过（28 个 migration，overall safe）
- Bridge `npm run lint`：通过
- AI Marketing Studio MCP `npm run lint`：通过
- AI Marketing Studio MCP `npm test`：7/7 通过
- GitHub Pages 最新已验证应用提交：`31839e20b78275cda1e3a2de2aac9ea16bc2b062`
- GitHub Actions run `29972943569`：success
- 高置信度 secret 模式扫描：未发现新增 secret
- `.env`、service role key、Bridge secret、X secret、Telegram token：未提交

## 完成部署所需的用户侧条件

请选择并授权一个稳定的公网运行环境：

1. Render 私有 Web Service；或
2. Railway 私有 Service；或
3. Fly.io 组织与应用；或
4. 有固定公网入口的云服务器；或
5. 已授权的 Cloudflare named tunnel + 常驻服务器。

最少需要提供以下之一：

- 已登录对应平台的本机 CLI；或
- 已连接的私有 GitHub 部署仓库与平台项目；或
- 可访问的云服务器和稳定 HTTPS 域名；或
- 已配置好的 Cloudflare named tunnel。

不要把部署平台 token、Supabase service role key 或 Bridge secret 发到聊天正文。应将它们直接写入部署平台 Secret Store。

## 恢复执行后的顺序

1. 在私有构建上下文中同时打包 Bridge 与 AI Marketing Studio MCP。
2. 保持 `ALLOW_REAL_PUBLISH=false`。
3. 部署公网 HTTPS Bridge，验证 `/health` 与错误 HMAC 401。
4. 确认 AI Marketing Studio MCP tools/list 非空。
5. 若需要 X 能力，再接入真实 X MCP transport 并列出 X tools。
6. 只有以上验证通过后，才配置两个 Supabase Bridge secrets。
7. 重新部署 `ops-health`、`ops-status`、`ops-execute`。
8. 登录线上 Command Center，确认 `edge_function / bridge_configured / bridge / mcp` 全为 true。
9. 先执行无副作用 dry-run，再考虑开放其他动作。

在公网环境未授权前，不得写“线上执行闭环已完成”。
