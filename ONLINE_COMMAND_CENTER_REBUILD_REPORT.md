# AI Marketing Studio 线上 Command Center 重构报告

## 目标

本次停止继续修补旧线上后台，改为按本地 Command Center 的真实业务流程重构线上 GitHub Pages 前端。

线上站点定位：

- Personal AI Marketing Operating System
- 用户不是操作一堆工具，而是管理 AI 运营流程
- GitHub Pages 只做静态前端和低权限 Supabase 读取
- 所有高权限动作必须通过 Supabase Edge Function、可信 API 或本地 MCP Runtime 执行

## 备份

- 已创建并推送备份 tag：`backup-before-command-center-rebuild-20260722-0001`
- 备份来源提交：`306892e feat: restructure online app around command center workflow`

## 最终导航

线上站点只保留以下入口：

1. 总览
   - AI Command Center
2. AI 运营
   - Campaign 与策略
   - 内容工作台
   - 发布队列
3. 资产中心
   - 账号矩阵
   - 素材库
   - 角色库
4. 系统
   - 平台连接
   - 系统状态
   - 工作流与模型配置

未继续保留为一级入口：

- 内容生成中心
- 内容审核中心
- LoRA 独立中心
- 账号智能独立中心
- 通用数据库浏览器
- Ops Data
- AI 结果目录
- 原始 JSON 详情页

## 已重构页面

### AI Command Center

首页不再是传统 Dashboard，而是每日运营总览：

- 待审批策略
- 待审核内容
- 生成中任务
- 待发布审批
- 失败任务
- 最近 Agent / Workflow 执行
- 最近内容包
- 最近知识与洞察

### Campaign 与策略

改为：

`运营目标 → Strategy Agent 策略 → 人工审批 → 内容包`

页面只展示业务字段：

- 目标平台
- 内容主题
- 成功指标
- 时间范围
- 目标账号
- 内容定位
- Hook 规则
- 文案风格
- CTA 规则
- 视觉方向
- 风险提示

### 内容工作台

合并内容生成与内容审核。

每张内容卡包含：

- Campaign
- 策略
- 自有账号
- 参考账号
- 平台
- 标题
- Hook
- 正文
- CTA
- 标签
- 关键词
- 语言风格
- 图片 / 视频需求
- 角色与 LoRA
- 参考素材
- 生成结果
- 素材权益确认
- 终审入口

### 发布队列

发布队列作为最终安全审批页。

规则：

- 内容终审通过不等于发布
- 批准发布计划不等于发布
- 真正执行发布需要二次确认
- GitHub Pages 前端不能直接调用外部平台 API

### 平台连接

支持按平台显示多个连接记录：

- X
- Telegram
- Instagram
- YouTube
- TikTok
- Discord

页面只显示：

- 连接数
- 连接状态
- 权限摘要
- 最后同步时间

不显示任何 token、secret、refresh token。

### 系统状态

显示：

- Agent 运行记录
- Workflow 运行记录
- 发布任务
- 失败任务
- 成功率
- 最近异常

### 工作流与模型配置

显示：

- Workflow 数量
- 角色数量
- Workflow / LoRA 类模型资产数量
- 最近生成任务

LoRA 不作为独立页面，而是进入角色库详情体系。

## 数据兼容策略

本次没有新增数据库、没有删除表、没有迁移生产数据。

前端读取时兼容：

- `content_packages`
- `content_library`
- `assets`
- `asset_library`
- `account_profiles`
- `account_intelligence_reports`
- `agent_runs`
- `workflow_runs`
- `platform_connections`

旧表继续保留，新页面统一转成业务对象展示。

## 安全设计

保留安全边界：

- 不把 service role key 放进前端
- 不把 X / Telegram / Discord / YouTube / Instagram / TikTok token 放进前端
- 不把 MCP 执行代理复制到 GitHub Pages
- 不把 ComfyUI / AutoDL 内部配置暴露给浏览器
- 未连接的执行动作显示明确原因，不伪装成功

## 未连接执行服务的处理

以下按钮会显示“执行服务未连接”原因：

- 创建 Campaign
- 生成策略
- 批准策略并创建内容包
- 生成内容包
- 导入 X 参考链接
- 提交图片 / 视频生成
- 终审通过并创建发布任务
- 批准发布计划
- 二次确认执行发布
- 平台连接 / 状态检查

原因：线上 GitHub Pages 是静态前端，高权限动作需要可信服务端执行。

## 验证

- `npm run lint`：通过
- `npm run build`：通过
- `npm run migrations:check`：通过，状态 safe
- 敏感信息扫描：未发现真实 secret；仅 `.env.example` 中存在占位符

## 未修改

- Supabase production data：未修改
- Supabase Storage：未修改
- Edge Functions：未修改
- MCP tools：未修改
- X OAuth 配置：未修改
- AutoDL / ComfyUI 配置：未修改
- Git history：未重写

## 上线地址

- GitHub Pages：[https://jiang289140790-eng.github.io/ai-marketing-studio/](https://jiang289140790-eng.github.io/ai-marketing-studio/)
- 重构提交：`cd51da56d331eeba7a2ebb13140913167d2cf089`
- GitHub Actions：`Deploy GitHub Pages` 已通过
- 线上构建确认：
  - `AI Command Center`：存在
  - `内容工作台`：存在
  - `发布队列`：存在
  - `平台连接`：存在
  - 旧入口 `内容工厂` / `Ops Data`：未出现在当前构建产物中

## 下一步建议

1. 把本地 Command Center 的可信执行代理部署成安全 API 或 Edge Function。
2. 让线上按钮从“只读展示”升级为真正调用 MCP Runtime。
3. 优先接通：
   - Strategy Agent 执行
   - 内容包创建
   - X 参考链接导入
   - 内容终审创建 publish task
4. 继续保持 GitHub Pages 不接触任何后端密钥。
