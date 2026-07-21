# Command Center 功能合并报告

## 目标

将本地 Command Center 中已经确认需要的核心功能，先迁移到 GitHub Pages 线上站：

- 账号矩阵
- 素材库
- 角色库

目标站点：

https://jiang289140790-eng.github.io/ai-marketing-studio/

## 本次完成

### 1. 线上站入口重整

已将线上站导航收敛为当前优先使用的个人 AI 运营入口：

- 控制台
- 账号矩阵
- 素材库
- 角色库
- 内容工厂
- 情报中心
- 发布中心
- 数据分析
- 设置

其中“账号矩阵 / 素材库 / 角色库”已经接入真实页面；其它模块暂时保留为待迁移入口，避免未完成代码影响线上使用。

### 2. 账号矩阵

已接入：

- social_accounts 账号列表
- account_profiles 账号画像展示
- platform_connections 平台连接状态展示
- 添加账号
- 编辑账号
- 删除账号
- 查看账号详情
- 平台连接状态卡片：X、Telegram、Instagram、YouTube、TikTok、Discord

安全边界：

- 前端只展示连接状态。
- Token / Secret 不进入前端。
- 后续真实 OAuth / Bot 授权仍由后端 Edge Function 管理。

### 3. 素材库

已接入：

- assets 列表
- 搜索
- 类型筛选
- 标签筛选
- 新建资产
- 上传图片 / 视频 / 音频
- 删除资产
- 预览资产

支持资产类型：

- 图片
- 视频
- 音频
- Prompt
- Workflow
- LoRA

### 4. 角色库

已接入：

- characters 列表
- 搜索
- 标签筛选
- 新建角色
- 编辑角色
- 删除角色
- 查看角色详情

角色字段包含：

- 名称
- 头像
- 描述
- 性格
- 外观
- Prompt
- LoRA
- 标签

### 5. 中文乱码修复

已修复本次上线链路里会直接展示给用户的中文乱码：

- App 页面标题
- 侧边栏导航
- Header 登录状态
- 账号矩阵页面
- 素材库页面
- 角色库页面
- 相关表单
- 状态标签
- 平台连接卡片

## 未在本次迁移中完成

以下功能没有在本次合并中展开：

- 本地 Command Center 的完整 Daily Ops 工作流
- Research Intelligence Engine 的完整页面化
- Content Factory 的真实内容生成闭环
- Publish Center 的真实发布操作
- Analytics Loop 的完整效果分析页

原因：

本阶段目标是先让线上站具备核心资产管理能力，并避免一次性迁移太多未验证交互。

## 验证结果

已执行：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

结果：

- Lint 通过
- Vite 构建通过
- Migration 检查结果为 safe

## 下一步建议

1. 等 GitHub Pages 部署完成后，打开线上站确认导航是否出现：
   - 账号矩阵
   - 素材库
   - 角色库
2. 登录 GitHub 后检查三页是否读取 Supabase 真实数据。
3. 下一阶段再迁移：
   - 内容工厂
   - 情报中心
   - 发布中心
   - 数据分析
