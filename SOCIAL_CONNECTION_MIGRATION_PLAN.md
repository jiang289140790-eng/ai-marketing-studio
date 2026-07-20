# Social Connection Migration Plan

## 背景

已有成熟平台账号连接系统：

- 线上入口：`https://47-251-244-196.sslip.io/accounts`
- 本地项目：`C:\Users\admin\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c83f9e12-0943-4828-8fec-f00ab3b0d0bd\trypost-ops`

目标不是重新开发社交平台连接功能，而是把旧项目里已经成熟的账号连接能力迁移到 AI Marketing Studio。

AI Marketing Studio 当前定位仍是：

- Personal AI Ops Workspace
- 不是 SaaS
- 不迁移 Billing / Subscription / Membership / Pricing / 多租户套餐逻辑

## 旧项目已有能力分析

### 1. OAuth 流程

旧项目是 Laravel + Inertia 架构。

核心入口：

- `routes/app.php`
- `app/Http/Controllers/Auth/SocialController.php`
- `app/Http/Controllers/Auth/XController.php`
- `app/Http/Controllers/Auth/TikTokController.php`
- `app/Http/Controllers/Auth/YouTubeController.php`
- `app/Http/Controllers/Auth/InstagramController.php`
- `app/Http/Controllers/Auth/TelegramController.php`

主要流程：

```text
/connect/{platform}
        ↓
SocialController::redirectToProvider()
        ↓
Laravel Socialite / 平台 OAuth
        ↓
/accounts/{platform}/callback
        ↓
获取 platform user
        ↓
updateOrCreate social_accounts
        ↓
返回 accounts 页面 / popup callback
```

已支持的连接模式：

- 标准 OAuth：X、TikTok、YouTube、Instagram、Facebook、LinkedIn、Pinterest、Reddit 等
- 多身份选择：YouTube channel、Facebook Page、Instagram Business Account、LinkedIn Page
- Telegram 特殊连接：不是 OAuth，而是 Bot `/connect <code>` 绑定频道/群

Telegram 连接相关文件：

- `app/Http/Controllers/Auth/TelegramController.php`
- `app/Actions/SocialAccount/ConnectTelegramChannel.php`
- `app/Services/Social/Telegram/TelegramConnectCode.php`

Telegram 连接流程：

```text
用户点击连接 Telegram
        ↓
服务端生成 15 分钟有效 encrypted connect code
        ↓
用户在 Telegram 里发送 /connect code
        ↓
Telegram webhook 收到 update
        ↓
ConnectTelegramChannel::execute()
        ↓
写入 social_accounts
```

### 2. Token 管理

旧项目核心模型：

- `app/Models/SocialAccount.php`

字段包括：

- `access_token`
- `refresh_token`
- `token_expires_at`
- `scopes`
- `status`
- `error_message`
- `disconnected_at`
- `last_used_at`
- `meta`

安全点：

- `access_token` / `refresh_token` 在 Laravel Model 里使用 encrypted cast
- Resource 输出隐藏 token
- 日志里有 `TokenRedactor` 防止 token 泄露

相关文件：

- `app\Services\Social\TokenRefreshClient.php`
- `app\Services\Social\ConnectionVerifier.php`
- `app\Services\Social\TokenRedactor.php`

Token 刷新策略：

```text
发布前 / 验证连接前
        ↓
ConnectionVerifier::verify()
        ↓
如果 token 过期或无效
        ↓
按平台 refresh
        ↓
更新 social_accounts token
```

旧项目有一个很重要的成熟策略：

- 对 X、LinkedIn 等旋转 refresh token 的平台，优先验证当前 access token，不轻易刷新，避免 refresh token 被提前轮换导致失效。
- 对 Instagram / Threads 这种长效 token 延长模型，提前刷新。
- 对 Telegram / Discord 这种 bot-token 模式，用户账号本身不保存真实 OAuth token。

### 3. Platform Adapter / Publisher

旧项目已经有平台发布适配器。

核心目录：

- `app\Services\Social`

典型文件：

- `XPublisher.php`
- `TikTokPublisher.php`
- `YouTubePublisher.php`
- `InstagramPublisher.php`
- `FacebookPublisher.php`
- `ThreadsPublisher.php`
- `PinterestPublisher.php`
- `Telegram\TelegramPublisher.php`
- `Discord\DiscordPublisher.php`

统一入口：

- `app\Jobs\PublishToSocialPlatform.php`

旧项目发布模型是：

```text
Post
        ↓
PostPlatform
        ↓
SocialAccount
        ↓
Publisher
        ↓
平台 API
        ↓
PostPlatform.markAsPublished / markAsFailed
```

旧系统已实现的关键能力：

- 发布前检查账号是否 active
- 发布前检查账号是否 connected
- 发布前检查 required scopes
- 发布中状态更新
- 成功后保存平台 post id 和 URL
- 失败后保存错误分类和上下文
- token 过期时尝试 refresh 后重试一次
- 平台临时不可用时延迟重试

### 4. 发布接口

旧项目发布链路：

- `app\Jobs\PublishPost.php`
- `app\Jobs\PublishToSocialPlatform.php`
- `app\Actions\Post\SyncPostPlatforms.php`
- `app\Models\Post.php`
- `app\Models\PostPlatform.php`

发布状态：

- `pending`
- `publishing`
- `retrying`
- `published`
- `failed`

`PostPlatform` 保存每个平台发布结果：

- `platform_post_id`
- `platform_url`
- `error_message`
- `error_context`
- `published_at`
- `meta`

这和 AI Marketing Studio 的 `publish_tasks` 很接近。

### 5. 数据结构

旧项目核心表：

#### social_accounts

字段：

- `id`
- `workspace_id`
- `platform`
- `platform_user_id`
- `username`
- `display_name`
- `avatar_url`
- `access_token`
- `refresh_token`
- `token_expires_at`
- `scopes`
- `meta`
- `status`
- `is_active`
- `error_message`
- `disconnected_at`
- `last_used_at`
- `created_at`
- `updated_at`

#### post_platforms

字段：

- `id`
- `post_id`
- `social_account_id`
- `enabled`
- `platform`
- `platform_name`
- `platform_username`
- `platform_avatar`
- `content_type`
- `status`
- `platform_post_id`
- `platform_url`
- `error_message`
- `error_context`
- `published_at`
- `meta`

## AI Marketing Studio 当前对应结构

AI Marketing Studio 已有：

### social_accounts

用于个人账号矩阵和 AI 分析核心实体。

已有/新增字段包括：

- `id`
- `user_id`
- `platform`
- `account_name`
- `username`
- `account_url`
- `avatar`
- `account_role`
- `status`
- `api_status`
- `target_audience`
- `content_strategy`
- `posting_frequency`
- `ops_notes`

### account_profiles

用于 AI 账号画像。

### platform_connections

用于记录平台连接状态。

字段：

- `id`
- `user_id`
- `platform`
- `account_id`
- `status`
- `connected_at`
- `last_sync`
- `created_at`

### platform_credentials

用于 token 存储。

字段：

- `id`
- `connection_id`
- `encrypted_token`
- `refresh_token`
- `expires_at`
- `created_at`

安全要求：

- 前端不能读取
- 只允许 Edge Function / 服务端访问

### publish_tasks

用于发布中心。

字段：

- `id`
- `user_id`
- `content_id`
- `platform_connection_id`
- `platform`
- `scheduled_time`
- `status`
- `external_id`
- `result`
- `error_message`
- `created_at`
- `published_at`

## 推荐映射方案

### 旧 social_accounts → AI Marketing Studio social_accounts

| 旧项目字段 | AI Marketing Studio 字段 | 说明 |
|---|---|---|
| `platform` | `platform` | 平台名称需统一大小写：`x` → `X` |
| `username` | `username` | 保留 handle |
| `display_name` | `account_name` | 展示名 |
| `avatar_url` | `avatar` | 头像 URL |
| `profile_url` accessor | `account_url` | 可由 platform + username 生成 |
| `status` | `api_status` | connected/token_expired/disconnected 映射为 API 状态 |
| `is_active` | `status` | true → active，false → inactive |
| `meta` | 暂放 platform_connections / 未来 connection_meta | chat_id/channel_id/page_id 等平台身份信息 |
| `last_used_at` | platform_connections.last_sync | 可作为最后活跃/同步时间 |

建议：

- `social_accounts` 继续只保存可展示、可分析、可筛选的账号信息
- 不把 token 放进 `social_accounts`
- 旧项目的 token 字段不要迁移到前端可读表

### 旧 social_accounts token → platform_credentials

| 旧项目字段 | AI Marketing Studio 字段 | 说明 |
|---|---|---|
| `access_token` | `platform_credentials.encrypted_token` | 必须由服务端加密写入 |
| `refresh_token` | `platform_credentials.refresh_token` | 建议也加密；当前字段名虽然未写 encrypted，但应按 encrypted 处理 |
| `token_expires_at` | `platform_credentials.expires_at` | token 过期时间 |
| `scopes` | 建议新增到 credentials 或 connection metadata | 当前 schema 没有 scopes，迁移时需要设计存放位置 |

建议下一阶段不要直接迁移 token 数据，先迁移 OAuth/连接流程，让新系统重新授权生成 token。

原因：

- 旧项目 Laravel encrypted cast 依赖 Laravel APP_KEY
- AI Marketing Studio Supabase Edge Function 无法直接解密旧 token，除非迁移 Laravel 加密逻辑和 APP_KEY
- 重新授权更安全、更干净

### 旧 post_platforms → AI Marketing Studio publish_tasks

| 旧项目字段 | AI Marketing Studio 字段 | 说明 |
|---|---|---|
| `post_id` | `content_id` | 旧 Post 对应新 content_library |
| `social_account_id` | `platform_connection_id` 间接关联 | 新系统通过 connection 绑定账号 |
| `platform` | `platform` | 平台 |
| `status` | `status` | pending/retrying 需要映射 |
| `platform_post_id` | `external_id` | 平台消息/帖子 ID |
| `platform_url` | `result.url` | 发布 URL |
| `error_message` | `error_message` | 错误信息 |
| `error_context` | `result.error_context` | 错误上下文 |
| `published_at` | `published_at` | 发布时间 |
| `meta` | `result.meta` | 平台特殊参数 |

状态映射：

| 旧状态 | 新状态 |
|---|---|
| `pending` | `scheduled` 或 `draft` |
| `publishing` | `publishing` |
| `retrying` | `failed` + retry metadata，或未来扩展 `retrying` |
| `published` | `published` |
| `failed` | `failed` |

建议：

- AI Marketing Studio 当前 `publish_tasks.status` 没有 `retrying`
- 可以先把 retrying 放到 `result.retry_context`
- 等真实队列成熟后再考虑增加 `retrying`

## 迁移后的目标架构

```text
Settings / Social Connections
        ↓
Frontend 只触发连接
        ↓
Supabase Edge Function: platform
        ↓
Platform OAuth / Telegram connect code
        ↓
social_accounts
        ↓
platform_connections
        ↓
platform_credentials

Content Library
        ↓
Publish Center / publish_tasks
        ↓
Supabase Edge Function: platform
        ↓
Platform Adapter
        ↓
平台 API
        ↓
publish_tasks.external_id / result / published_at
        ↓
content_metrics
```

## 平台迁移优先级

### 第一优先级：Telegram

原因：

- AI Marketing Studio 已经有 Telegram 发布闭环基础
- 旧项目 Telegram 连接设计成熟
- Telegram 不依赖复杂 OAuth

应迁移能力：

- encrypted `/connect` code
- webhook 接收 `/connect`
- chat_id / username / type 写入 connection metadata
- Bot API 发布
- Bot API 验证 getChat

### 第二优先级：X

原因：

- 用户明确关注 X 账号矩阵
- 旧项目已有 X OAuth、refresh token 和发布实现

应迁移能力：

- OAuth 2.0 PKCE / scopes
- `tweet.write`
- `media.write`
- token refresh
- `users/me` verify
- text/image/video publish 分支

### 第三优先级：YouTube

原因：

- 旧项目已有 channel selection
- 需要视频上传能力

应迁移能力：

- Google OAuth
- channel select
- refresh token
- upload video / Shorts

### 第四优先级：Instagram / TikTok

原因：

- 依赖更多平台审核、素材格式、隐私参数
- 旧项目代码可复用，但上线风险高于 Telegram/X

## 不建议迁移的内容

不要迁移：

- BillingController
- Cashier / Stripe
- subscription gate
- workspace invite / team 成员体系
- plan limits
- SaaS onboarding checkout

可以参考但不要照搬：

- workspace 权限模型
- account limit
- subscription middleware

AI Marketing Studio 是个人系统，应该用 `user_id` 作为归属，不需要 workspace/team 权限模型。

## 需要补齐的 AI Marketing Studio 字段

当前 schema 已能承载大部分连接能力，但正式迁移前建议评估是否补充：

### platform_connections 建议增加

- `platform_user_id`
- `username`
- `display_name`
- `avatar_url`
- `profile_url`
- `scopes jsonb`
- `metadata jsonb`
- `error_message`
- `disconnected_at`
- `last_used_at`

或者：

- 保持 `platform_connections` 简洁
- 把这些放到 `social_accounts` + `platform_credentials.metadata`

更推荐：

```text
social_accounts：展示和运营画像
platform_connections：连接状态
platform_credentials：token + scopes + provider metadata，只给 Edge Function 读
```

### platform_credentials 建议增加

- `scopes jsonb`
- `token_type text`
- `metadata jsonb`
- `updated_at`

注意：

- 这些不是立刻要改的代码，只是迁移设计建议。
- 如果下一阶段开始迁移真实 OAuth，再单独创建 migration。

## Edge Function 迁移设计

AI Marketing Studio 是 GitHub Pages 前端，不能在浏览器里处理 secret。

推荐 Edge Function：

```text
supabase/functions/platform
  connect
  callback
  verify
  refresh
  publish
  metrics
  disconnect
```

所有平台密钥放在 Supabase Secrets：

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `TIKTOK_CLIENT_ID`
- `TIKTOK_CLIENT_SECRET`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `INSTAGRAM_CLIENT_ID`
- `INSTAGRAM_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

前端只保存：

- 当前登录 session
- `social_account_id`
- `platform_connection_id`
- OAuth start URL / connect state

前端绝不保存：

- access token
- refresh token
- client secret
- bot token

## Publish Center 映射

旧系统 `PostPlatform` 的职责，在 AI Marketing Studio 由 `publish_tasks` 承担。

建议迁移后的发布流程：

```text
content_library
        ↓
createPublishTask()
        ↓
publish_tasks.status = scheduled / draft
        ↓
executePublishTask()
        ↓
Edge Function platform.publish
        ↓
读取 platform_credentials
        ↓
调用对应 adapter
        ↓
返回 external_id / url / metrics seed
        ↓
更新 publish_tasks
```

旧系统的 `PublishToSocialPlatform` 可以拆成 Edge Function runner：

- scope 检查
- token verify
- token refresh
- adapter publish
- 错误分类
- publish task 状态更新

## 平台 Adapter 迁移方式

旧项目 PHP publisher 不能直接复制到前端。

推荐迁移为 TypeScript Edge Function adapters：

```text
supabase/functions/platform/adapters/
  telegram.ts
  x.ts
  youtube.ts
  instagram.ts
  tiktok.ts
```

统一接口：

```ts
connect(input)
callback(input)
verify(connection)
refresh(connection)
publish({ connection, credentials, content, task })
getMetrics({ connection, task })
disconnect(connection)
```

每个平台 adapter 复用旧项目的：

- API URL
- scopes
- required metadata
- 发布参数
- 错误分类
- token refresh 策略

但不要复用旧项目的：

- workspace subscription gating
- Laravel encrypted casts
- Inertia popup UI 细节

## 迁移步骤建议

### Phase A：只迁移连接架构

1. 梳理旧项目每个平台 OAuth 参数和 scopes
2. 在 AI Marketing Studio Edge Function 里实现 `connect` / `callback` 基础
3. OAuth 成功后写入：
   - `social_accounts`
   - `platform_connections`
   - `platform_credentials`
4. Settings 页面只显示连接状态，不显示 token

### Phase B：迁移 Telegram

1. 复用旧项目 `TelegramConnectCode` 思路
2. Edge Function 生成 connect code
3. Telegram webhook 接收 `/connect`
4. 写入账号和连接
5. 用现有 Publish Center 发布测试

### Phase C：迁移 X

1. 实现 X OAuth start/callback
2. 写入 token 和 scopes
3. 实现 verify / refresh
4. 先发布纯文本
5. 再发布图片/视频

### Phase D：迁移 YouTube / Instagram / TikTok

按平台逐个迁移，不要一次接完。

## 风险与注意事项

### 1. 旧 token 不建议直接迁移

旧 token 是 Laravel encrypted cast，加密依赖 Laravel APP_KEY。

更安全做法：

- 新系统重新授权
- 新 token 存入 Supabase
- 不搬旧 token

### 2. GitHub Pages 不能处理 OAuth secret

所有 OAuth callback 和 token exchange 必须走 Edge Function。

### 3. RLS 与 credentials 隔离

`platform_credentials` 当前已 revoke anon/authenticated。

保持这个设计：

- 前端不可读
- Edge Function 用 service role 访问
- 普通页面只读 `platform_connections` 状态

### 4. 平台状态命名需要统一

旧项目：

- connected
- disconnected
- token_expired

AI Marketing Studio：

- connected
- disconnected
- pending
- error

建议后续加入：

- `expired`
- `needs_reconnect`

或把 token 过期放入：

- `status = error`
- `error_message = token_expired`

## 推荐最终映射

```text
旧项目 mature module
        ↓
OAuth / token / publisher 逻辑
        ↓
Supabase Edge Function platform
        ↓
AI Marketing Studio tables
```

最终关系：

```text
social_accounts
  = 唯一账号实体，给 AI 分析、账号矩阵、内容策略使用

platform_connections
  = 某账号的平台连接状态

platform_credentials
  = token / refresh token / scopes / provider metadata，仅服务端可读

publish_tasks
  = 替代旧 post_platforms，记录每次发布任务和结果
```

## 下一阶段建议

下一阶段不要重新开发连接 UI。

建议先执行：

1. 把旧项目 Telegram connect code + webhook 设计迁移成 Supabase Edge Function
2. 让 Settings / Social Connections 调用这个 Edge Function
3. 成功后写入 `social_accounts + platform_connections + platform_credentials`
4. 用 Publish Center 发一条 Telegram 测试消息
5. 再迁移 X OAuth

这样最稳，也最符合当前 Personal AI Ops Workspace 的路线。
