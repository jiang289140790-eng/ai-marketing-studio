# AI Marketing Studio Phase 3.9 - X Platform Connection Layer Report

## 1. 执行结论

Phase 3.9 已完成 X Platform Connection Layer 的代码接入与生产入口验证。

当前状态：

- X OAuth 连接入口已接入 `platform_connections`
- X 凭据写入路径已接入 `platform_credentials`
- X Adapter 已接入前端 Platform Connection Layer
- X Publisher 已接入 Publish Center 的 Edge Function 执行链路
- Token 读取与刷新逻辑只在 Supabase Edge Function 内执行
- 已部署最新 `platform` Edge Function
- `npm run lint`、`npm run build`、`npm run migrations:check` 均通过

真实发推验证未完成，阻塞原因是生产 Supabase Edge Function 尚未配置 X OAuth secrets：

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`

这不是代码逻辑阻塞。已通过真实 Production Edge Function 请求确认，登录态请求会进入 X connect 流程，并在读取 X secrets 时返回配置缺失错误。

## 2. 旧项目 X 能力分析

已分析旧项目：

`C:\Users\admin\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c83f9e12-0943-4828-8fec-f00ab3b0d0bd\trypost-ops`

重点参考文件：

- `app/Http/Controllers/Auth/XController.php`
- `app/Http/Controllers/Auth/SocialController.php`
- `app/Socialite/XProvider.php`
- `app/Services/Social/XPublisher.php`
- `app/Services/Social/ConnectionVerifier.php`
- `app/Jobs/RefreshSocialToken.php`
- `config/trypost.php`

旧项目能力：

- X OAuth 2.0 授权
- 自定义 X Socialite Provider
- access token / refresh token 存储
- token refresh
- X 账号资料读取
- X 发布接口
- 连接状态检查

本阶段已将核心设计迁移到 AI Marketing Studio 的 Supabase Edge Function 架构，不迁移旧 token，不迁移旧 SaaS / Billing / Workspace 逻辑。

详细分析见：

`X_PLATFORM_MIGRATION_ANALYSIS.md`

## 3. 数据结构接入

本阶段复用现有表，没有新增数据库 schema。

### `social_accounts`

用于保存 X 账号实体：

- platform: `X`
- account_name
- account_url
- avatar
- api_status
- status

### `platform_connections`

用于保存 X 授权连接状态：

- platform: `X`
- status: `pending` / `connected` / `disconnected`
- auth_type: `oauth2_pkce`
- permissions
- last_sync
- expires_at
- metadata

OAuth 临时 state / code verifier 只保存在 connection metadata 中，callback 完成后会清理。

### `platform_credentials`

用于保存敏感凭据：

- encrypted_token
- refresh_token
- expires_at

前端不读取该表。X access token / refresh token 只由 Supabase Edge Function 访问。

## 4. 已实现文件

### Edge Function

`supabase/functions/platform/index.ts`

新增 X 处理能力：

- `connect`
- `disconnect`
- `reconnect`
- `status`
- `publish`
- `getMetrics`
- OAuth callback
- token exchange
- token refresh
- X profile fetch
- publish_metrics 写入
- content_metrics 写入

### 前端 Adapter

`src/services/platforms/x-adapter.js`

已改为通过 Supabase Edge Function 调用 X 平台能力：

- `connect()`
- `disconnect()`
- `reconnect()`
- `status()`
- `publish()`
- `getMetrics()`

### Platform Connection Service

`src/services/platform-connection-service.js`

新增：

- `connectXPlatform()`
- `reconnectXPlatform()`
- `disconnectXPlatform()`
- `getXPlatformStatus()`

### Settings 页面

`src/pages/SettingsPage.jsx`

X 平台卡片已接入：

- 未连接：显示“连接 X”
- 已连接：显示“状态 / 重连 / 断开”
- 连接时打开 X OAuth 授权窗口

## 5. Publish Center 集成方式

目标链路已经接入：

```text
Content Library
↓
Publish Task
↓
Publish Center
↓
X Adapter
↓
Supabase Edge Function platform
↓
X API
↓
publish_metrics
↓
content_metrics
```

当前实现为 X 文本发布 MVP。

已支持：

- 根据 `publish_task_id` 读取发布任务
- 读取关联 content
- 读取 X platform connection
- Edge Function 内部读取 token
- token 即将过期时自动 refresh
- 调用 X `POST /2/tweets`
- 保存 `tweet_id`
- 保存 tweet URL
- 写入 `publish_metrics`
- 写入基础 `content_metrics`

暂未实现：

- X 图片 / 视频上传
- X 真实 metrics 拉取
- thread / 长文自动拆分

## 6. 安全设计

已保持 Personal AI Ops Workspace 定位。

本阶段没有新增：

- Stripe
- Billing
- Subscription
- Membership
- SaaS 多租户功能

X token 安全边界：

- 前端只触发连接、发布、状态检查
- 前端不保存 access token
- 前端不保存 refresh token
- token 只写入 `platform_credentials`
- token 只由 Supabase Edge Function 读取
- X OAuth secrets 只应配置在 Supabase Edge Function Secrets

需要配置的生产 secrets：

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `X_REDIRECT_URI`

推荐 callback URL：

`https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform?platform=X&action=x-callback`

## 7. 生产验证结果

### Edge Function 部署

已执行：

```bash
supabase functions deploy platform --project-ref qtrlymiqohbjvklwegsw
```

结果：

- `platform` Edge Function 部署成功

### X Connect 真实入口验证

使用 Production Supabase Edge Function 验证 X connect。

未登录请求：

- 返回：`Invalid user session`
- 说明：Edge Function 正确要求登录态

登录态请求：

- 返回：`Missing X_CLIENT_ID, X_CLIENT_SECRET, or X_REDIRECT_URI in Edge Function secrets.`
- 说明：请求已进入 X connect 逻辑，当前只缺 X OAuth secrets

### 真实 Tweet 发布验证

未执行成功。

原因：

当前 Production Supabase 未配置 X OAuth secrets，因此无法完成 X OAuth 授权，也无法获得 X access token / refresh token。

未生成：

- tweet_id
- tweet URL
- timestamp

这里没有使用 mock，也没有伪造发布结果。

## 8. 验证命令

已执行并通过：

```bash
npm run lint
npm run build
npm run migrations:check
```

结果：

- lint: passed
- build: passed
- migrations:check: safe

`npm run build` 仅有 Vite chunk size warning，不影响部署。

## 9. 下一步操作

要完成真实 X 发推闭环，需要先完成 X Developer / Supabase secrets 配置：

1. 在 X Developer Portal 创建或确认 OAuth 2.0 App
2. 配置 callback URL：

   `https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform?platform=X&action=x-callback`

3. 确认 App 权限包含：

   - `tweet.read`
   - `tweet.write`
   - `users.read`
   - `offline.access`

4. 在 Supabase Production Project 配置 Edge Function secrets：

   - `X_CLIENT_ID`
   - `X_CLIENT_SECRET`
   - `X_REDIRECT_URI`

5. 重新测试：

   - Settings → Platform Connections → 连接 X
   - 完成 X OAuth
   - 创建一条 Publish Task
   - 执行 X publish
   - 验证 `publish_metrics`
   - 验证 `content_metrics`

## 10. 当前能力状态

| 能力 | 状态 |
| --- | --- |
| X OAuth 架构 | 已完成 |
| X connect 入口 | 已完成 |
| X disconnect | 已完成 |
| X reconnect | 已完成 |
| X status | 已完成 |
| X token refresh | 已完成 |
| X text publish | 已完成代码，等待 secrets 后真实验证 |
| X publish_metrics | 已完成代码 |
| X content_metrics | 已完成代码 |
| X media upload | 未做 |
| X真实metrics同步 | 未做 |

