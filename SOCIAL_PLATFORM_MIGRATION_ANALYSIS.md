# Social Platform Migration Analysis

## 分析范围

旧系统：

- 线上入口：`https://47-251-244-196.sslip.io/accounts`
- 本地源码：`C:\Users\admin\AppData\Roaming\Open Design\namespaces\release-stable-win\data\projects\c83f9e12-0943-4828-8fec-f00ab3b0d0bd\trypost-ops`

分析目标：

1. 平台连接页面结构
2. OAuth 流程
3. Token 管理
4. Platform Adapter
5. 发布接口
6. Webhook
7. 数据同步逻辑

本次只做只读分析，不修改 AI Marketing Studio 代码，不迁移旧 token。

## 1. 平台连接页面结构

旧项目账号连接页面入口：

- `routes/app.php`
- `app/Http/Controllers/Auth/SocialController.php`
- `resources/js/pages/accounts/Index.vue`
- `resources/js/components/accounts/NetworkConnectGrid.vue`
- `resources/js/components/accounts/TelegramConnectDialog.vue`
- `resources/js/components/accounts/AccountsOperationsList.vue`

页面结构是：

```text
accounts/Index.vue
        ↓
NetworkConnectGrid.vue
        ↓
平台卡片 / 已连接状态 / 重新连接 / 断开
        ↓
TelegramConnectDialog.vue
        ↓
Telegram 专用 /connect code 流程
```

页面展示能力：

- 平台卡片
- 已连接账号列表
- 账号状态
- token 到期时间
- 最近发布信息
- 连接账号按钮
- 重新连接按钮
- 断开按钮
- Telegram 单独弹窗连接流程

旧页面还包含 AdsPower / DuoPlus 操作能力：

- AdsPower profile 绑定
- DuoPlus 云手机状态

这些不是 AI Marketing Studio 当前 Phase 3.8 的核心迁移内容，可保留为未来扩展，不建议首批迁移。

## 2. OAuth 流程

核心文件：

- `app/Http/Controllers/Auth/SocialController.php`
- `app/Http/Controllers/Auth/XController.php`
- `app/Http/Controllers/Auth/TikTokController.php`
- `app/Http/Controllers/Auth/YouTubeController.php`
- `app/Http/Controllers/Auth/InstagramController.php`
- `app/Http/Controllers/Auth/FacebookController.php`
- `app/Http/Controllers/Auth/PinterestController.php`
- `app/Http/Controllers/Auth/RedditController.php`
- `app/Http/Controllers/Auth/DiscordController.php`

通用 OAuth 流程：

```text
/connect/{platform}
        ↓
SocialController::redirectToProvider()
        ↓
Socialite driver
        ↓
平台 OAuth 授权页
        ↓
/accounts/{platform}/callback
        ↓
SocialController::handleCallback()
        ↓
workspace.socialAccounts().updateOrCreate()
        ↓
popupCallback / reload accounts
```

关键特性：

- OAuth 起始时保存 `social_connect_workspace` session
- callback 时根据 session 找回 workspace
- 使用 `updateOrCreate` 防止重复账号
- 同一 network 限制一个连接，例如 LinkedIn profile / page 属于同一 network
- 支持 reconnect
- 成功后写入 token、refresh token、expires、scopes、meta

特殊 OAuth / 多身份选择：

- YouTube：OAuth 后读取 channels，必要时进入 channel 选择页
- Facebook：OAuth 后选择 Page
- Instagram：OAuth 后选择 Instagram Business Account
- LinkedIn：支持 profile / company page
- Discord：OAuth 用于添加 bot / guild 授权

Telegram 特殊流程：

Telegram 不是标准 OAuth。旧系统使用 bot `/connect code`：

```text
点击连接 Telegram
        ↓
TelegramController::connect()
        ↓
TelegramConnectCode::issue()
        ↓
前端显示 /connect <code>
        ↓
用户在 Telegram 频道/群发送命令
        ↓
Telegram webhook 收到 update
        ↓
ConnectTelegramChannel::execute()
        ↓
写入 social_accounts
```

相关文件：

- `app/Http/Controllers/Auth/TelegramController.php`
- `app/Services/Social/Telegram/TelegramConnectCode.php`
- `app/Actions/SocialAccount/ConnectTelegramChannel.php`
- `app/Http/Controllers/Webhooks/TelegramWebhookController.php`

## 3. Token 管理

核心模型：

- `app/Models/SocialAccount.php`

旧系统 `social_accounts` 存储：

- `access_token`
- `refresh_token`
- `token_expires_at`
- `scopes`
- `meta`
- `status`
- `error_message`
- `disconnected_at`
- `last_used_at`

安全设计：

- `access_token` 使用 Laravel encrypted cast
- `refresh_token` 使用 Laravel encrypted cast
- API Resource 默认隐藏 token
- 日志和异常输出使用 `TokenRedactor`

相关文件：

- `app/Services/Social/ConnectionVerifier.php`
- `app/Services/Social/TokenRefreshClient.php`
- `app/Services/Social/TokenRedactor.php`
- `app/Jobs/VerifyWorkspaceConnections.php`

Token 刷新策略：

```text
需要发布 / 拉数据 / 验证连接
        ↓
ConnectionVerifier::verify()
        ↓
如果 access_token 仍有效，避免刷新
        ↓
如果 token 确认无效或过期，调用平台 refresh
        ↓
更新 access_token / refresh_token / expires_at
```

成熟点：

- X / LinkedIn 等 refresh token 旋转平台：先验证 access token，避免无谓刷新
- Instagram / Threads 长效 token：接近过期时主动延长
- YouTube / TikTok / Pinterest / Reddit：使用 refresh_token 换新 access_token
- Telegram / Discord：Bot token 由服务器配置，用户账号不保存普通 OAuth token
- Token 失效后状态变成 `token_expired` 或 `disconnected`

## 4. Platform Adapter

旧系统发布适配器目录：

- `app/Services/Social`

主要 Publisher：

- `XPublisher.php`
- `TikTokPublisher.php`
- `YouTubePublisher.php`
- `InstagramPublisher.php`
- `FacebookPublisher.php`
- `ThreadsPublisher.php`
- `PinterestPublisher.php`
- `Telegram/TelegramPublisher.php`
- `Discord/DiscordPublisher.php`
- `RedditPublisher.php`
- `LinkedInPublisher.php`
- `LinkedInPagePublisher.php`

统一调度入口：

- `app/Jobs/PublishToSocialPlatform.php`

调度逻辑：

```text
PostPlatform
        ↓
读取 socialAccount
        ↓
检查账号 active / connected / scopes
        ↓
getPublisher()
        ↓
publisher.publish()
        ↓
markAsPublished / markAsFailed
```

适配器成熟点：

- 平台差异封装在 Publisher 内
- 支持图文、视频、多图等不同内容类型
- 平台 API 错误统一包装为 SocialPublishException
- token 过期统一抛 TokenExpiredException
- 平台临时不可用统一抛 PlatformUnavailableException
- 发布 URL / 平台 ID 回写到 `post_platforms`

## 5. 发布接口

旧系统核心发布表：

- `posts`
- `post_platforms`

核心文件：

- `app/Models/Post.php`
- `app/Models/PostPlatform.php`
- `app/Jobs/PublishPost.php`
- `app/Jobs/PublishToSocialPlatform.php`
- `app/Actions/Post/SyncPostPlatforms.php`

发布流程：

```text
Post
        ↓
SyncPostPlatforms
        ↓
为每个 active social account 创建 PostPlatform
        ↓
用户启用目标平台
        ↓
PublishPost
        ↓
PublishToSocialPlatform per platform
        ↓
Publisher
        ↓
平台 API
        ↓
PostPlatform 记录结果
```

`post_platforms` 保存：

- `platform`
- `social_account_id`
- `content_type`
- `status`
- `enabled`
- `platform_post_id`
- `platform_url`
- `error_message`
- `error_context`
- `published_at`
- `meta`

状态：

- `pending`
- `publishing`
- `retrying`
- `published`
- `failed`

错误处理：

- 账号停用：失败
- 账号断开：失败
- token 过期：刷新后重试一次
- 缺少权限 scope：失败并提示 reconnect
- 平台临时不可用：进入 retrying 并延迟重试
- 未知错误：记录安全错误信息，不暴露内部细节

## 6. Webhook

核心文件：

- `routes/webhook.php`
- `routes/api.php`
- `app/Http/Controllers/Webhooks/TelegramWebhookController.php`
- `app/Actions/SocialAccount/RegisterTelegramWebhook.php`
- `app/Actions/SocialAccount/ConnectTelegramChannel.php`
- `app/Actions/SocialAccount/StoreTelegramReactions.php`

Telegram webhook 路径：

- `/telegram/webhook`
- `/api/telegram/webhook`

Webhook 注册：

```text
RegisterTelegramWebhook::execute()
        ↓
Telegram setWebhook
        ↓
allowed_updates:
  - message
  - channel_post
  - message_reaction_count
```

Webhook 处理：

```text
Telegram update
        ↓
如果 message_reaction_count
        ↓
StoreTelegramReactions::execute()
        ↓
更新 PostPlatform.meta.reactions

如果 /connect <code>
        ↓
TelegramConnectCode::decode()
        ↓
ConnectTelegramChannel::execute()
        ↓
写入 social_accounts
```

对 AI Marketing Studio 的价值：

- `/connect code` 可迁移为 Telegram 平台连接机制
- reaction_count 可映射为 `content_metrics`
- webhook 只能在 Edge Function 处理，不应进入 GitHub Pages 前端

## 7. 数据同步逻辑

旧系统有连接验证和发布数据同步两类。

### 连接状态同步

核心文件：

- `app/Jobs/VerifyWorkspaceConnections.php`
- `app/Services/Social/ConnectionVerifier.php`

逻辑：

```text
定时检查 social_accounts
        ↓
ConnectionVerifier::verify()
        ↓
成功：恢复 connected
失败：token_expired / disconnected
        ↓
通知 owner
```

### 发布数据同步

核心文件：

- `app/Jobs/SyncPublishedPostMetrics.php`
- `app/Services/PublishedContentFeedbackService.php`
- `app/Services/PostMetricsFetcher.php`
- `app/Services/Social/*Analytics.php`

平台 Analytics：

- `XAnalytics.php`
- `TikTokAnalytics.php`
- `YouTubeAnalytics.php`
- `InstagramAnalytics.php`
- `FacebookAnalytics.php`
- `Telegram/TelegramAnalytics.php`
- `Discord/DiscordAnalytics.php`

同步流程：

```text
Published Post
        ↓
PostMetricsFetcher
        ↓
Platform Analytics adapter
        ↓
Normalized metrics
        ↓
PostPlatform.meta.metrics_snapshot
        ↓
Content pipeline analytics snapshot
```

对 AI Marketing Studio 的映射：

```text
旧 PostPlatform.meta.metrics_snapshot
        ↓
content_metrics
publish_metrics
Performance Center
Performance Agent
```

## 旧系统可迁移能力总结

应迁移：

- OAuth start/callback 流程
- token refresh 策略
- 连接验证逻辑
- disconnect / reconnect 流程
- 平台 Publisher 适配器思路
- 平台 Analytics 适配器思路
- Telegram connect code + webhook
- Telegram reaction 回写
- 发布错误分类和 retry 语义

不应迁移：

- Billing
- Subscription
- Workspace SaaS 权限
- Team invite
- Plan limits
- Cashier / Stripe
- Onboarding checkout

## 迁移风险

1. 旧 token 不能直接搬迁：Laravel encrypted cast 依赖 Laravel APP_KEY。
2. GitHub Pages 前端不能保存任何 OAuth secret。
3. 旧项目基于 workspace，新系统基于个人 `user_id`，需要去 workspace 化。
4. 旧项目 PHP Publisher 不能直接复制到浏览器，需要迁移为 Supabase Edge Function TypeScript adapter。
5. 平台 OAuth callback 必须由 Edge Function 承接。

## 分析结论

旧项目账号连接系统是成熟系统，不建议重写。

AI Marketing Studio 应迁移其后端连接能力，而不是复制 UI：

```text
旧 Laravel Social Connection Center
        ↓
提取 OAuth / Token / Publisher / Webhook / Analytics 规则
        ↓
Supabase Edge Function Platform Connection Layer
        ↓
AI Marketing Studio social_accounts / platform_connections / platform_credentials / publish_tasks / content_metrics
```
