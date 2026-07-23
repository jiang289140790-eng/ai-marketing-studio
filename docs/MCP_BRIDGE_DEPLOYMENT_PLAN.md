# MCP Bridge 真实部署计划

## 当前结论

Bridge 尚未真实部署，线上执行闭环未完成。

当前仓库已经包含 `services/mcp-runtime-bridge` 骨架，并具备：

- `GET /health`
- `POST /v1/actions`
- HMAC-SHA256 验签
- action allowlist
- Supabase `ops_runs` 审计记录
- AI Marketing Studio MCP stdio 客户端
- 默认禁止真实发布

但在公网部署前还有两个必须解决的运行时依赖：

1. 当前 Bridge Docker 镜像只复制 Bridge 自身，没有包含 `E:\projects\video-generator\mcp-servers\marketing-studio` 的 MCP Server 源码。
2. `X_MCP_ENABLED` 目前只能表达配置意图，不能证明 X MCP 已启动或 tools 可列出。上线时必须配置真实 X MCP 进程/远程连接并由 `/health` 实测。

因此，在这些条件满足前，不得配置假的 `OPS_MCP_BRIDGE_URL`，也不得把线上状态写成全绿。

## 推荐部署平台

| 平台 | 适合场景 | 注意事项 |
|---|---|---|
| Render | 最快完成容器化常驻服务 | 使用 Private Repository；Health Check Path 设为 `/health` |
| Railway | 需要快速部署 Docker 和查看日志 | 关闭公开环境变量回显；绑定稳定域名 |
| Fly.io | 需要区域部署和可控实例 | 设置至少一个常驻实例，避免后台 MCP 子进程被休眠 |
| 云服务器 | 需要完整控制 MCP、X、AutoDL 与网络 | 使用 Docker Compose + Caddy/Nginx；只开放 HTTPS 端口 |

不建议使用 GitHub Pages、纯静态托管或会随请求立即销毁的短生命周期函数承载 Bridge。MCP stdio 子进程需要长期运行。

## 推荐仓库与镜像结构

使用私有部署仓库或私有构建上下文，至少包含：

```text
runtime/
  bridge/                 # services/mcp-runtime-bridge
  marketing-studio-mcp/   # mcp-servers/marketing-studio
  Dockerfile
```

不要把 `.env`、OAuth Token、X Client Secret、Supabase service role key 或 MCP signing secret 复制进镜像层。

镜像启动时通过环境变量指定 MCP 目录：

```text
MARKETING_STUDIO_MCP_DIR=/app/marketing-studio-mcp
MARKETING_STUDIO_MCP_COMMAND=node
MARKETING_STUDIO_MCP_ARGS=["/app/marketing-studio-mcp/server.js"]
```

当前 Bridge 默认会从 `MARKETING_STUDIO_MCP_DIR/server.js` 启动；部署镜像必须保证该文件真实存在，并在构建阶段完成两个 Node 项目的生产依赖安装。

## 必需环境变量

Bridge 运行环境：

```text
OPS_MCP_BRIDGE_SECRET=<至少 32 字节的随机值>
SUPABASE_URL=https://qtrlymiqohbjvklwegsw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<仅部署平台 secret store>
MARKETING_STUDIO_MCP_DIR=/app/marketing-studio-mcp
MCP_RUNTIME_BRIDGE_HOST=0.0.0.0
MCP_RUNTIME_BRIDGE_PORT=8787
MCP_TOOL_TIMEOUT_MS=90000
ALLOW_REAL_PUBLISH=false
```

AI Marketing Studio MCP 启动配置：

```text
MARKETING_STUDIO_MCP_COMMAND=node
MARKETING_STUDIO_MCP_ARGS=["/app/marketing-studio-mcp/server.js"]
```

X MCP 必须使用真实、已授权的运行方式。若使用 stdio 适配器：

```text
X_MCP_COMMAND=<部署环境中已安装的 X MCP 启动命令>
X_MCP_ARGS=<JSON 数组格式的启动参数>
```

若使用 X 官方远程 MCP：

```text
X_MCP_URL=https://api.x.com/mcp
```

远程 MCP 的 OAuth access token 必须保存在部署平台 secret store，由服务端适配器读取；不得返回浏览器。当前 Bridge 尚未实现远程 X MCP OAuth transport，因此不能只设置 `X_MCP_URL` 就宣称完成。

## 部署步骤

### Render

1. 新建 Private Web Service，选择私有部署仓库。
2. Runtime 选择 Docker。
3. Health Check Path 填 `/health`。
4. 添加上述环境变量，所有敏感值设为 Secret。
5. 部署后确认日志出现 Bridge 监听 `0.0.0.0`，AI MCP 子进程没有退出。
6. 使用签名探针验证 `/health`，确认 `mcp: true` 且 tools 非空。

### Railway

1. 从私有 GitHub 仓库创建 Docker Service。
2. 添加稳定公网域名与 HTTPS。
3. 在 Variables 中添加运行变量；Secret 不写入仓库。
4. 设置健康检查 `/health`，观察 MCP 子进程和 Bridge 审计日志。

### Fly.io

1. 使用私有 Docker 构建上下文执行 `fly launch`。
2. 通过 `fly secrets set` 写入敏感变量。
3. 在 `fly.toml` 配置内部端口 `8787`、HTTPS 和 `/health` 检查。
4. 至少保留一个常驻实例，避免 MCP stdio 子进程频繁重启。

### 云服务器

1. 安装 Docker 与 Docker Compose。
2. 用防火墙只开放 80/443；8787 仅供反向代理访问。
3. 使用 Caddy 或 Nginx 提供 HTTPS。
4. Secret 通过服务器环境或 Docker Secret 注入。
5. 配置日志轮转、进程重启与资源限制。

## 健康检查

`/health` 不是匿名信息接口。Supabase `ops-health` 会对探针内容签名，Bridge 必须使用同一 `OPS_MCP_BRIDGE_SECRET` 验签。

验证目标：

```json
{
  "ok": true,
  "bridge": true,
  "mcp": true,
  "tools": ["..."],
  "x_mcp": "configured"
}
```

如果 AI MCP tools 为空、X MCP 未实测、请求超时或验签失败，健康检查不能视为全绿。

## 配置 Supabase Secrets

只有 Bridge 公网 HTTPS 地址已实测后才执行：

```powershell
supabase secrets set OPS_MCP_BRIDGE_URL=https://实际域名 OPS_MCP_BRIDGE_SECRET=<与Bridge一致的随机值> --project-ref qtrlymiqohbjvklwegsw
```

不要把命令中的真实 secret 保存到 PowerShell 历史、文档、截图或 Git 仓库。更安全的方式是在临时、受限的环境文件中配置，然后使用 `supabase secrets set --env-file`，完成后立即安全删除临时文件。

Supabase 官方说明：生产 Secret 应通过 Dashboard 或 CLI Secret 管理写入；不需要把值放入前端，也不需要把 `.env` 提交到 Git。

## Edge Functions 部署

配置完成后重新部署并保持 JWT 验证：

```powershell
supabase functions deploy ops-health --project-ref qtrlymiqohbjvklwegsw
supabase functions deploy ops-status --project-ref qtrlymiqohbjvklwegsw
supabase functions deploy ops-execute --project-ref qtrlymiqohbjvklwegsw
```

## 验证顺序

1. 未签名访问 Bridge `/health` 应返回非全绿结果。
2. 签名健康探针应返回 `bridge: true`、`mcp: true` 且 tools 非空。
3. 登录线上网站，Command Center 的 `ops-health` 应显示：

```json
{
  "edge_function": true,
  "bridge_configured": true,
  "bridge": true,
  "mcp": true
}
```

4. 创建一个无外部副作用的 dry-run 动作，确认 `ops_runs` 能看到 `queued → running → completed/failed`。
5. 对发布任务只运行：

```json
{
  "dry_run": true,
  "preflight_only": true
}
```

6. `ALLOW_REAL_PUBLISH` 保持 `false`，直到 dry-run、权限检查和人工审批全部验收。

## 上线闸门

必须同时满足以下条件才能写“执行闭环完成”：

- Bridge 有稳定公网 HTTPS 域名。
- HMAC 验签通过，错误签名被拒绝。
- AI Marketing Studio MCP tools 可列出。
- X MCP 真实启动/连接，且 X tools 可列出。
- action allowlist、超时和审计日志生效。
- 登录后的 `ops-health` 四项全绿。
- 发布 dry-run 通过且没有外部发布副作用。

当前这些条件没有全部满足，因此当前准确结论仍是：Bridge 尚未真实部署，线上执行闭环未完成。
