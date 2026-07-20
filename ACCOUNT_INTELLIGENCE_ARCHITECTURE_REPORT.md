# AI Marketing Studio Account Intelligence Architecture Report

## 项目定位

AI Marketing Studio 继续保持为 **Personal AI Ops Workspace**，不是 SaaS 产品。本次改造没有新增 Stripe、Billing、Subscription、Membership 或多租户商业化能力。

## 核心结论

账号体系已调整为：

```text
social_accounts = 唯一账号实体
        ↓
Collector / Content Intelligence 只能选择账号
        ↓
viral_contents 绑定 social_account_id
        ↓
Analysis Agent 分析内容
        ↓
account_profiles 生成账号画像
```

这样可以避免“账号矩阵、内容情报、采集中心重复创建账号”的问题。

## 数据库变化

新增 migration：

- `supabase/migrations/20260720073957_account_intelligence_architecture.sql`

### social_accounts

新增字段：

- `username`
- `account_role`

`account_role` 支持：

- `brand`
- `personal`
- `competitor`
- `inspiration`

并继续兼容旧字段：

- `account_type`
- `account_category`

### account_profiles

新增账号 AI 画像表：

- `id`
- `user_id`
- `account_id`
- `target_audience`
- `content_direction`
- `content_style`
- `posting_frequency`
- `brand_positioning`
- `ai_strategy`
- `analysis_summary`
- `analysis_result`
- `source_content_ids`
- `model`
- `confidence_score`
- `last_analyzed_at`
- `created_at`
- `updated_at`

安全策略：

- 已启用 RLS
- 只允许当前登录用户读取、创建、更新、删除自己的账号画像
- 已授予 authenticated 角色访问权限

### 内容情报与采集关联

新增关联字段：

- `content_sources.social_account_id`
- `viral_contents.social_account_id`
- `content_analysis.social_account_id`

这些字段让采集源、爆款内容、AI 分析结果都回到同一个账号实体。

## 前端改造

### 账号矩阵

页面：

- `src/pages/AccountsPage.jsx`
- `src/components/AccountForm.jsx`

已支持账号添加流程：

- platform
- username
- account_name
- account_url
- account_role
- target_audience
- content_strategy
- posting_frequency
- api_status
- ops_notes

账号列表现在会显示：

- 账号角色
- 目标受众
- 内容方向
- 发布频率
- AI 画像状态
- API 状态

### 内容情报中心

页面：

- `src/pages/ContentIntelligence.jsx`

已调整为：

- 不再创建竞争账号
- 只能从 `social_accounts` 里选择 `competitor` 或 `inspiration` 账号
- 保存爆款内容时写入 `viral_contents.social_account_id`
- AI 分析结果写入 `content_analysis.social_account_id`

### 采集中心

页面：

- `src/pages/CollectionCenter.jsx`

已调整为：

- 不再自由创建账号
- 创建数据源前必须选择账号矩阵中的账号
- 数据源写入 `content_sources.social_account_id`
- Telegram 采集内容入库时写入 `viral_contents.social_account_id`

## 服务层改造

### account-service

文件：

- `src/services/account-service.js`

新增：

- `listAccountProfiles()`
- `upsertAccountProfile()`

账号创建和更新时，会同步：

- `account_role`
- `account_type`
- `account_category`

### intelligence-service

文件：

- `src/services/intelligence-service.js`

调整：

- `listCompetitorAccounts()` 从 `social_accounts` 读取竞品/灵感账号
- `createViralContent()` 写入 `social_account_id`
- `createContentAnalysis()` 写入 `social_account_id`
- `analyzeViralContentWithAI()` 在分析成功后自动 upsert `account_profiles`

Analysis Agent 现在会尝试生成：

- `target_audience`
- `content_direction`
- `content_style`
- `posting_frequency`
- `brand_positioning`
- `ai_strategy`

### collector-service

文件：

- `src/services/collector-service.js`

调整：

- `content_sources` 查询包含绑定账号
- 创建数据源时保存 `social_account_id`
- Telegram 采集内容入库时保存 `social_account_id`

## 保留但降级的历史结构

历史表仍保留：

- `competitor_accounts`

原因：

- 不删除历史 migration
- 避免破坏 clean replay
- 兼容旧数据或后续迁移脚本

但当前主流程已经不再通过它创建账号。

## 当前账号智能流程

```text
1. 在账号矩阵添加账号
   platform / username / url / account_role

2. 在采集中心选择该账号创建数据源

3. Collector 采集外部内容

4. 内容进入 viral_contents，并绑定 social_account_id

5. 在内容情报中心点击 AI 分析

6. Analysis Agent 调用 AI Gateway

7. 保存 content_analysis

8. 自动更新 account_profiles
```

## 已完成

- `social_accounts` 成为唯一账号实体
- 新增 `account_profiles`
- 内容情报中心禁止直接创建账号
- 采集中心禁止直接创建账号
- 爆款内容、采集源、AI 分析统一绑定账号
- Analysis Agent 成功后自动生成或更新账号画像

## 未完成 / 后续建议

- 可增加一个“重新生成账号画像”按钮，手动汇总多条内容重新分析账号
- 可增加账号画像详情页，展示账号定位、内容风格、复刻策略
- 可将 `competitor_accounts` 历史数据迁移进 `social_accounts`
- 可让 Content Generation Agent 优先读取 `account_profiles.ai_strategy`

## 风险说明

- 本次新增 migration 没有删除旧表和旧字段，clean replay 风险较低。
- 如果生产数据库已经部署过更晚时间戳 migration，需要在正式 `db push` 前确认 migration history 顺序。
- GitHub Pages 前端只使用 Supabase anon key；账号画像写入依赖 RLS 和当前登录用户。

## 验证结果

已执行：

- `npm run lint`：通过
- `npm run build`：通过
- `npm run migrations:check`：通过，整体状态 `safe`

构建提示：

- Vite 提示主 bundle 大于 500KB，这是体积优化提示，不影响当前功能运行。
