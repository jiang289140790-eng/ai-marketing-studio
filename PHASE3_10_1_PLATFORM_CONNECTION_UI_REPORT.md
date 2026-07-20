# Phase 3.10.1 Platform Connection UI Report

## 已完成

- 将账号管理页顶部改为 Platform Connection Center。
- 自有账号优先从平台卡片发起连接，不再要求先手动创建账号。
- X 连接按钮直接调用现有 Platform Edge Function 的 OAuth 初始化流程。
- Platform Edge Function 调用改为直接读取后端返回的 JSON 错误，避免只显示泛化的 `non-2xx status code`。
- Telegram 卡片会跳转到设置页完成 Channel / Chat ID 配置，不再伪装成 OAuth 连接。
- 平台连接状态统一读取 `platform_connections`。
- 账号矩阵仍然保留，但定位调整为连接后的账号实体与竞品/灵感账号管理。
- 手动添加按钮改为“手动添加竞品/灵感账号”，避免和自有账号 OAuth 连接流程混淆。

## 当前支持状态

| 平台 | 页面入口 | 后端连接层 | 说明 |
| --- | --- | --- | --- |
| X | 已接入 | 已接入 | 点击平台卡片即可进入 OAuth。生产环境仍需要配置 X secrets。 |
| Telegram | 已跳转设置页 | 已接入 | 连接配置仍集中在设置页，账号页显示连接状态。 |
| Instagram | 预留 | 预留 | 等待迁移旧项目成熟 OAuth。 |
| YouTube | 预留 | 预留 | 等待迁移旧项目成熟 OAuth。 |
| TikTok | 预留 | 预留 | 等待迁移旧项目成熟 OAuth。 |

## 设计调整

- `social_accounts` 继续作为唯一账号实体。
- `platform_connections` 作为授权状态来源。
- 敏感 token 仍只在 Edge Function / 后端安全层处理，前端只展示连接状态、权限、最后同步时间。

## 下一步

1. 在 Supabase Production Edge Function secrets 中配置 `X_CLIENT_ID`、`X_CLIENT_SECRET`、`X_REDIRECT_URI`。
2. 重新部署 `platform` Edge Function。
3. 在线上账号页点击 X 平台卡片，验证 OAuth 返回后是否自动创建/绑定账号。
