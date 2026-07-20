# Phase 3.10.3 Platform Connection Setup Report

## 定位

AI Marketing Studio 继续保持 Personal AI Ops Workspace，不新增 Stripe、Billing、Subscription、Membership 或 SaaS 多租户能力。

## 已完成

- 账号管理页的 Platform Connection Center 已统一使用配置清单。
- 已加入并展示 6 个第一批平台：
  - X / Twitter
  - Telegram
  - Instagram
  - YouTube
  - TikTok
  - Discord
- 每个平台都按 `platform_connections` 的多账号模型展示：
  - 连接数
  - 权限
  - 最后同步
  - 多条连接记录
- X 保持真实 OAuth 连接入口。
- Telegram 保持 Bot / Channel 连接入口。
- Instagram、YouTube、TikTok、Discord 不再显示灰色假按钮，改为可点击的“查看接入配置”。
- 点击未完成真实 OAuth 的平台后，会显示：
  - 授权方式
  - 是否支持多账号
  - 回调地址
  - Token 存储边界
  - 需要配置的 Edge Function Secrets
  - 哪些 Secret 还缺失
- Supabase Edge Function `platform` 对未完成真实 OAuth 的平台返回安全配置结果，不返回 token。
- `.env.example` 已补齐各平台 Secret 名称。
- Settings 页面旧文案已更新，不再误导为“只有 Telegram”。

## 平台状态

| 平台 | 当前状态 | 多账号 | 说明 |
| --- | --- | --- | --- |
| X | 真实 OAuth 链路已接入 | 支持 | 可继续连接多个 X 账号 |
| Telegram | Bot / Channel 链路已接入 | 支持 | 每个 Channel 一条连接 |
| Instagram | 配置入口完成 | 支持 | 需要迁移真实 OAuth handler 与平台密钥 |
| YouTube | 配置入口完成 | 支持 | 需要迁移频道 OAuth / 频道选择 / 发布 handler |
| TikTok | 配置入口完成 | 支持 | 需要迁移 TikTok OAuth / 发布权限 / 隐私设置 |
| Discord | 配置入口完成 | 支持 | 需要接入 Bot token / OAuth / 频道选择 |

## 需要配置的 Supabase Edge Function Secrets

### Instagram

- `INSTAGRAM_CLIENT_ID`
- `INSTAGRAM_CLIENT_SECRET`
- `INSTAGRAM_REDIRECT_URI`

### YouTube

- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REDIRECT_URI`

### TikTok

- `TIKTOK_CLIENT_KEY`
- `TIKTOK_CLIENT_SECRET`
- `TIKTOK_REDIRECT_URI`

### Discord

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`
- `DISCORD_REDIRECT_URI`

## 安全边界

- 前端只显示连接状态、权限、最后同步和配置说明。
- 前端不读取、不保存、不展示 access token、refresh token、bot token 或 client secret。
- 所有密钥只应放在 Supabase Edge Function Secrets。
- 真实 token 后续只写入 `platform_credentials` 或由 Edge Function Secret 引用。

## 验证

- `npm run lint`：通过
- `npm run build`：通过
- `npm run migrations:check`：通过，状态 safe

## 下一步

1. 在各平台开发者后台创建应用并填入对应回调地址。
2. 将平台密钥写入 Supabase Edge Function Secrets。
3. 按优先级迁移真实 OAuth handler：
   1. Discord Bot / Channel 发布
   2. YouTube OAuth + 频道选择
   3. Instagram OAuth / Meta Graph
   4. TikTok OAuth / 发布权限
4. 每个平台连接成功后，继续复用当前 `platform_connections` 多账号模型。
