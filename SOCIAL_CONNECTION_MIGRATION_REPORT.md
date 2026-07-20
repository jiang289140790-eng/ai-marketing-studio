# AI Marketing Studio Phase 3.8 Social Connection Migration Report

## 目标

迁移旧项目成熟的 Social Connection Center 到 AI Marketing Studio。

要求：

- 不重新开发 OAuth / Token / Platform Adapter
- 不单独只迁移 Telegram
- 不迁移旧 token
- 不迁移 Billing / Subscription / Workspace / SaaS 权限 / 会员系统
- 不修改业务 Agent 逻辑

本次执行内容：

- 只读分析旧项目
- 设计 AI Marketing Studio 的 Platform Connection Layer 迁移方案
- 生成迁移报告
- 未修改业务代码
- 未新增 migration

## 1. 旧系统分析

旧系统位置：

- URL：`https://47-251-244-196.sslip.io/accounts`
- 源码：`C:\Users\admin\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c83f9e12-0943-4828-8fec-f00ab3b0d0bd\trypost-ops`

详细分析见：

- `SOCIAL_PLATFORM_MIGRATION_ANALYSIS.md`

旧系统是 Laravel + Inertia 架构，账号连接中心已经具备完整生产能力。

支持平台：

- X
- TikTok
- YouTube
- Facebook Page
- Instagram
- Pinterest
- Reddit
- Telegram
- Discord
- 另外还有 LinkedIn / Threads / Bluesky / Mastodon 等扩展能力

### 页面结构

旧连接中心页面由：

- `accounts/Index.vue`
- `NetworkConnectGrid.vue`
- `TelegramConnectDialog.vue`
- `AccountsOperationsList.vue`

组成。

页面能力：

- 平台卡片
- 连接账号
- 重新连接
- 断开连接
- 显示账号状态
- 显示 token 到期时间
- 显示最近发布
- Telegram 特殊连接弹窗

### OAuth

旧系统使用：

- `SocialController::redirectToProvider()`
- `SocialController::handleCallback()`
- Laravel Socialite
- 平台专属 Controller

OAuth 成功后写入旧系统 `social_accounts`。

### Token 管理

旧系统 `SocialAccount` 模型里：

- `access_token`
- `refresh_token`

使用 Laravel encrypted cast。

Token 刷新由：

- `ConnectionVerifier`
- `TokenRefreshClient`

负责。

成熟策略：

- 不轻易刷新旋转 refresh token 的平台
- token 失效后标记 `token_expired`
- 发布前自动验证连接
- refresh 失败后断开账号
- 日志通过 `TokenRedactor` 脱敏

### Platform Adapter

旧系统已有成熟 Publisher：

- XPublisher
- TikTokPublisher
- YouTubePublisher
- InstagramPublisher
- FacebookPublisher
- PinterestPublisher
- RedditPublisher
- TelegramPublisher
- DiscordPublisher

统一由：

- `PublishToSocialPlatform`

调度。

### 发布接口

旧系统发布链路：

```text
Post
        ↓
PostPlatform
        ↓
PublishToSocialPlatform
        ↓
Publisher
        ↓
Social API
        ↓
PostPlatform status/result
```

`PostPlatform` 等价于 AI Marketing Studio 的 `publish_tasks`。

### Webhook

旧系统 Telegram webhook 能力：

- `/connect <code>` 绑定频道/群
- `message_reaction_count` 回写反应数
- `RegisterTelegramWebhook` 自动注册 webhook

### 数据同步

旧系统同步能力：

- `VerifyWorkspaceConnections` 定期检查连接状态
- `SyncPublishedPostMetrics` 同步已发布内容指标
- 平台 Analytics adapter 读取账号/帖子指标
- `PublishedContentFeedbackService` 归一化 metrics

## 2. 迁移模块

建议迁移为 AI Marketing Studio 的统一 Platform Connection Layer。

目标结构：

```text
Frontend Platform Connections Page
        ↓
Supabase Edge Function platform
        ↓
OAuth / Webhook / Token Refresh / Publish / Metrics
        ↓
social_accounts
platform_connections
platform_credentials
publish_tasks
content_metrics
```

### 需要迁移的模块

1. OAuth 连接逻辑
2. OAuth callback 逻辑
3. Token 存储逻辑
4. Token refresh 逻辑
5. 平台状态检测
6. 连接 / 断开 / 重新连接流程
7. Platform Adapter / Publisher
8. Publish 接口
9. Webhook 处理
10. 数据同步逻辑

### 不迁移的模块

- Billing
- Subscription
- Workspace SaaS 权限
- 会员系统
- Plan limits
- Team invite
- Checkout onboarding
- Cashier / Stripe

## 3. 数据库变化

本次没有修改数据库，没有新增 migration。

原因：

- 当前任务要求先只读分析旧系统
- AI Marketing Studio 已经有核心表：
  - `social_accounts`
  - `platform_connections`
  - `platform_credentials`
  - `publish_tasks`
  - `content_metrics`

### 当前表可承载的部分

#### social_accounts

负责账号实体。

用于：

- X 账号
- Instagram 账号
- Telegram 频道
- YouTube 频道
- TikTok 账号

#### platform_connections

负责授权状态。

当前已有字段：

- `platform`
- `account_id`
- `status`
- `connected_at`
- `last_sync`

目标架构建议字段：

- `auth_type`
- `permissions`
- `expires_at`
- `error_message`
- `metadata`

#### platform_credentials

负责敏感凭据。

当前已有字段：

- `encrypted_token`
- `refresh_token`
- `expires_at`

目标架构建议字段：

- `oauth_secret`
- `token_type`
- `scopes`
- `metadata`
- `updated_at`

安全要求：

- 前端不可读取
- 只允许 Supabase Edge Function 通过 service role 访问

#### publish_tasks

负责发布任务。

映射旧系统 `post_platforms`。

当前已有字段可承载：

- `content_id`
- `platform_connection_id`
- `platform`
- `scheduled_time`
- `status`
- `external_id`
- `result`
- `error_message`
- `published_at`

### 后续需要的 migration

正式实施 Phase 3.8 时建议新增 migration：

```text
platform_connections:
  auth_type text
  permissions jsonb
  expires_at timestamptz
  error_message text
  metadata jsonb
  disconnected_at timestamptz
  last_used_at timestamptz

platform_credentials:
  oauth_secret text
  token_type text
  scopes jsonb
  metadata jsonb
  updated_at timestamptz
```

注意：

- 这些是建议，不是本次已执行变更。
- 旧 token 不迁移，所有平台重新授权。

## 4. 平台支持情况

### 第一批

#### X

迁移内容：

- OAuth 2.0
- scopes
- token refresh
- users/me 验证
- 纯文本发布
- 图片/视频发布
- post metrics

优先级：高。

#### Telegram

迁移内容：

- `/connect code`
- webhook
- Bot API 发布
- reaction metrics
- getChat / getChatMemberCount

优先级：高。

#### Instagram

迁移内容：

- OAuth
- token extension refresh
- publish media container
- feed/reel/story/carousel
- insights

优先级：高，但受平台审核和权限影响。

#### YouTube

迁移内容：

- Google OAuth
- channel select
- refresh token
- Shorts/video upload
- YouTube Analytics

优先级：高。

#### TikTok

迁移内容：

- OAuth
- refresh token
- video publish
- privacy level
- creator info
- metrics

优先级：高，但上线依赖平台审核。

### 第二批

#### Facebook Page

迁移内容：

- Page select
- Page token
- feed/video publish
- page/post metrics

#### Discord

迁移内容：

- OAuth add bot
- guild/channel metadata
- bot token publish
- reaction/thread metrics

#### Reddit

迁移内容：

- OAuth
- refresh token
- submit
- identity verify

#### Pinterest

迁移内容：

- OAuth
- board metadata
- pin publish
- pin metrics

## 5. Publish Center 集成方式

目标链路：

```text
Content Library
        ↓
Publish Task
        ↓
platform_connections
        ↓
Platform Adapter
        ↓
Social API
        ↓
发布结果
        ↓
content_metrics
```

推荐执行流程：

```text
1. 用户在 Publish Center 选择 content_library 内容
2. 选择已连接 platform_connection
3. 创建 publish_tasks
4. executePublishTask 调用 Supabase Edge Function
5. Edge Function 读取 platform_credentials
6. Edge Function 调用对应平台 adapter
7. 成功后更新：
   - publish_tasks.status = published
   - publish_tasks.external_id
   - publish_tasks.result.url
   - publish_tasks.published_at
8. 失败后更新：
   - publish_tasks.status = failed
   - publish_tasks.error_message
   - publish_tasks.result.error_context
9. Metrics 同步写入：
   - content_metrics
   - publish_metrics
```

旧系统可复用思想：

- scope 检查
- token verify
- token refresh
- adapter publish
- 错误分类
- retry 语义
- metrics 归一化

## 6. 与 AI 系统连接方式

目标链路：

```text
social_accounts
        ↓
Account Intelligence
        ↓
Analysis Agent
        ↓
Content Agent
        ↓
Asset Agent
        ↓
Publish Agent
        ↓
Publish Center
```

账号作为核心实体：

- `social_accounts` 保存账号身份和运营定位
- `account_profiles` 保存 AI 账号画像
- `platform_connections` 保存授权状态
- `platform_credentials` 保存敏感凭据
- `publish_tasks` 保存发布执行
- `content_metrics` 反哺分析和策略

## 7. 页面调整方案

不要复制旧连接页面。

AI Marketing Studio 应设计新的 Platform Connections 页面。

页面结构：

```text
Platform Connections
        ↓
第一批平台卡片
  - X
  - Instagram
  - TikTok
  - YouTube
  - Telegram
        ↓
状态
权限
最后同步
连接按钮
重新连接按钮
断开按钮
```

页面只显示：

- 平台
- 账号名
- 连接状态
- 权限状态
- token 过期提示
- 最后同步

页面不显示：

- access_token
- refresh_token
- client_secret
- bot token

## 8. 安全设计

### 禁止

- 前端保存 access token
- 前端保存 refresh token
- 前端保存 OAuth secret
- 前端读取 `platform_credentials`
- 迁移旧 token

### 必须

- OAuth callback 走 Supabase Edge Function
- token exchange 走 Supabase Edge Function
- publish 走 Supabase Edge Function
- metrics sync 走 Supabase Edge Function
- credentials 由 service role 访问
- 普通用户只读连接状态

### Secrets 放置

Supabase Edge Function Secrets：

- `X_CLIENT_ID`
- `X_CLIENT_SECRET`
- `TIKTOK_CLIENT_ID`
- `TIKTOK_CLIENT_SECRET`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `INSTAGRAM_CLIENT_ID`
- `INSTAGRAM_CLIENT_SECRET`
- `FACEBOOK_CLIENT_ID`
- `FACEBOOK_CLIENT_SECRET`
- `PINTEREST_CLIENT_ID`
- `PINTEREST_CLIENT_SECRET`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`

## 9. 推荐实施计划

### Step 1：冻结旧系统能力清单

输出每个平台：

- OAuth URL
- callback URL
- scopes
- token refresh endpoint
- verify endpoint
- publish endpoint
- metrics endpoint
- required metadata

### Step 2：补齐 Platform Connection schema

新增 migration：

- `platform_connections.auth_type`
- `platform_connections.permissions`
- `platform_connections.expires_at`
- `platform_connections.error_message`
- `platform_connections.metadata`
- `platform_credentials.oauth_secret`
- `platform_credentials.scopes`
- `platform_credentials.metadata`
- `platform_credentials.updated_at`

### Step 3：建立 Edge Function Platform Runtime

目录建议：

```text
supabase/functions/platform/
  index.ts
  actions/
    connect.ts
    callback.ts
    verify.ts
    refresh.ts
    publish.ts
    metrics.ts
    disconnect.ts
  adapters/
    x.ts
    telegram.ts
    instagram.ts
    youtube.ts
    tiktok.ts
    facebook.ts
    discord.ts
    reddit.ts
    pinterest.ts
```

### Step 4：迁移第一批平台

第一批：

1. X
2. Telegram
3. Instagram
4. YouTube
5. TikTok

这不是只迁移 Telegram，而是按统一架构迁移第一批核心平台。

### Step 5：连接 Publish Center

改造：

- `publish-service.js`
- `platform-adapter.js`
- `PublishCenter.jsx`

让 `executePublishTask()` 统一调用 Edge Function。

### Step 6：连接 Performance Center

把 metrics 写入：

- `content_metrics`
- `publish_metrics`

然后由 Performance Agent 读取。

## 10. 当前验证

本次只新增文档，不修改业务代码。

已执行：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

结果：

- lint：通过
- build：通过
- migrations:check：通过，整体状态 `safe`

备注：

- Vite 仍提示主 bundle 大于 500KB，这是体积优化提示，不影响当前构建通过。

## 11. 当前状态

已完成：

- 旧系统连接中心只读分析
- OAuth 流程分析
- token 管理分析
- adapter/publisher 分析
- publish 接口分析
- webhook 分析
- metrics/data sync 分析
- AI Marketing Studio 映射方案
- Phase 3.8 实施计划

未完成：

- 尚未创建 migration
- 尚未迁移 Edge Function
- 尚未修改 Platform Connections 页面
- 尚未接入真实 OAuth callback
- 尚未迁移 publisher 代码

原因：

- 当前阶段要求先只读分析，不立即修改代码。

## 12. 下一步建议

下一阶段正式实施 Phase 3.8 时，建议按这个顺序：

1. 新增数据库字段，补齐 `platform_connections` 和 `platform_credentials`
2. 建立 Supabase Edge Function Platform Runtime
3. 迁移第一批平台统一 connect/callback/verify/refresh
4. 迁移第一批平台 publish
5. 迁移第一批平台 metrics
6. 重做 AI Marketing Studio Platform Connections 页面
7. Publish Center 全部改为通过 `platform_connections`
8. Performance Center 接入真实 `content_metrics`

核心原则：

```text
旧系统能力复用
        +
AI Marketing Studio 新 UI
        +
Supabase Edge Function 安全边界
```

不要把旧项目 SaaS 部分搬进来。
