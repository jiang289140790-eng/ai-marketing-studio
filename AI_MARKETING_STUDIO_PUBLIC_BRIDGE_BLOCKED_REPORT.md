# AI Marketing Studio 公网 Bridge 阻塞报告

日期：2026-07-24（Asia/Shanghai）

## 结论

Bridge 已在内网验证，但公网 HTTPS 入口仍未完成。

线上执行闭环未完成。

当前不能配置 Supabase 的 `OPS_MCP_BRIDGE_URL` 与
`OPS_MCP_BRIDGE_SECRET`，也不能执行第一个线上 dry-run。

## 本次已完成

- AutoDL SSH 与外网连接正常。
- 保持现有端口不变：
  - `6006`：ComfyUI。
  - `6008`：ComfyUI Control Panel。
  - `8787`：Bridge，仅监听 `127.0.0.1`。
- Bridge 已重新启动并通过签名健康检查。
- `bridge=true`、`mcp=true`。
- AI Marketing Studio MCP `tools/list` 返回 50 个工具（health 返回上限）。
- `/v1/actions` 错误签名返回 HTTP 401。
- `ALLOW_REAL_PUBLISH=false`。
- X MCP 没有真实 transport，准确返回：

```json
{
  "x_mcp": "unknown",
  "x_tools": false
}
```

- 修复前端把字符串 `unknown` 误判为 X MCP 已连接的问题。
- 修复 Bridge 对 `MARKETING_STUDIO_MCP_COMMAND` 和 JSON 格式
  `MARKETING_STUDIO_MCP_ARGS` 的生产环境支持。
- 新增私有生产运行包生成器，运行包同时包含 Bridge 与
  AI Marketing Studio MCP Server。
- 生成后的运行包已完成生产依赖安装与实际启动验证：

```json
{
  "bridge": true,
  "mcp": true,
  "tool_count": 50,
  "x_mcp": "unknown",
  "x_tools": false,
  "publish_adapter": "dry-run-required"
}
```

## 公网入口检查

选择方案：Cloudflare named tunnel。

检查结果：

- 本机已安装 `cloudflared 2026.6.0`。
- AutoDL 未安装 cloudflared。
- 本机与 AutoDL 均没有 Cloudflare origin certificate、named tunnel
  credentials 或 tunnel token。
- Cloudflare 官方授权页已打开，但当前浏览器没有 Cloudflare 登录状态。
- 临时 quick tunnel 未使用，因为它不是稳定生产地址。

因此目前没有稳定 Bridge 公网域名，不能把临时或伪造 URL 写入 Supabase。

## Supabase 当前状态

项目：`qtrlymiqohbjvklwegsw`

Bridge secrets：

```text
OPS_MCP_BRIDGE_URL       未配置
OPS_MCP_BRIDGE_SECRET    未配置
```

Edge Functions：

| Function | 状态 | 版本 | verify_jwt |
|---|---:|---:|---:|
| `ops-health` | ACTIVE | 2 | true |
| `ops-status` | ACTIVE | 2 | true |
| `ops-execute` | ACTIVE | 3 | true |

`ops_runs` 当前没有可用于验收的记录。由于公网 Bridge 尚未完成，本次没有创建
会立即失败的伪 dry-run 记录。

## 验证结果

- 根项目 `npm run lint`：通过。
- 根项目 `npm run build`：通过。
- 根项目 `npm run migrations:check`：通过（overall safe）。
- Bridge `npm run lint`：通过。
- AI Marketing Studio MCP `npm run lint`：通过。
- AI Marketing Studio MCP `npm test`：7/7 通过。
- 生产运行包敏感文件检查：通过。
- 生产运行包高置信度 secret 扫描：未发现。
- `.runtime-build`：已加入 Git 忽略，不会提交。

## 安全状态

- 没有把 `.env` 或 `.env.local` 放入运行包。
- 没有把 Supabase service role、Bridge secret、X secret、Telegram token
  或 API key 写入 Git、前端或本报告。
- Bridge 日志不输出签名密钥。
- 真实发布保持关闭。
- 未抢占或修改 AutoDL 的 6006/6008。

## 解除阻塞所需操作

用户需要在已经打开的 Cloudflare 官方页面登录，并选择一个由该账号管理的域名，
授权 cloudflared 创建 named tunnel certificate。

授权完成后继续：

1. 创建 named tunnel 和稳定子域名。
2. 在 AutoDL 安装 cloudflared，只通过 token/credentials 运行 tunnel。
3. 将 tunnel origin 指向 `http://127.0.0.1:8787`。
4. 验证公网 TLS、签名 `/health` 与错误签名 401。
5. 使用 Supabase Secret Store 配置两个 Bridge secrets。
6. 部署 `ops-health`、`ops-status`、`ops-execute`。
7. 登录线上 Command Center，验收四项全绿。
8. 执行 `execute_publish` 的 `dry_run=true`、`preflight_only=true` 测试。

在以上步骤完成前，不得写“线上执行闭环已完成”。
