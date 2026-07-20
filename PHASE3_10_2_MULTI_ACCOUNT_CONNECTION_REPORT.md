# Phase 3.10.2 Multi-account Platform Connection Report

## 已完成

- 账号管理页的 Platform Connection Center 改为多账号连接展示。
- 每个平台现在会显示连接数，例如 `2/3`，表示 3 条连接记录里 2 条已连接。
- 每个平台卡片下方会列出该平台的多个连接账号/连接记录。
- X 支持继续点击“连接另一个 X 账号”，用于同一平台连接多个账号。
- Telegram 入口改为“添加另一个 Telegram”，跳转设置页继续添加 Channel / Chat ID。
- 新增 Discord 平台入口。
- 全局平台列表、发布/内容/分析等下拉平台范围加入 Discord。
- Platform Adapter 注册表加入 Discord placeholder adapter。

## 当前平台状态

| 平台 | 多账号展示 | 真实连接 | 说明 |
| --- | --- | --- | --- |
| X | 已支持 | 已接入 OAuth | 可重复连接多个 X 账号。 |
| Telegram | 已支持 | 已接入 Bot / Channel | 在设置页添加不同 Channel。 |
| Instagram | 已支持 | 待迁移 | 已有 UI / Adapter 入口，等待旧系统 OAuth 迁移。 |
| YouTube | 已支持 | 待迁移 | 已有 UI / Adapter 入口，等待频道授权迁移。 |
| TikTok | 已支持 | 待迁移 | 已有 UI / Adapter 入口，等待 OAuth 迁移。 |
| Discord | 已支持 | 待迁移 | 新增平台入口，后续接入 Bot / OAuth。 |

## 数据库影响

- 未新增 migration。
- `platform_connections` 现有结构已经天然支持同一 `user_id + platform` 多条连接记录。
- `social_accounts` 仍作为唯一账号实体，连接成功后由后端创建或绑定。

## 下一步建议

1. 先完成 X OAuth 授权闭环。
2. 将旧系统中 Instagram / YouTube / TikTok / Discord 的 OAuth 与 Token 管理迁移到 `platform` Edge Function。
3. Publish Center 按 `platform_connection_id` 选择具体账号发布，而不是只按平台发布。
