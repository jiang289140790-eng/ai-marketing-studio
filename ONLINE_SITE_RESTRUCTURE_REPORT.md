# AI Marketing Studio 线上站点重新整合报告

## 1. 最终导航结构

### 总览

- AI Command Center

### AI 运营

- Campaign 与策略
- 内容工作台
- 发布队列

### 资产中心

- 账号矩阵
- 素材库
- 角色库

### 系统

- 平台连接
- 系统状态
- 工作流与模型配置

## 2. 已删除或隐藏的重复页面

已从导航中移除：

- 单独的内容工厂
- 单独的生成中心
- 单独的内容审核中心
- 单独的账号情报中心
- 单独的 LoRA 中心
- 通用数据库表浏览式 Ops Data 页面
- 独立知识库入口
- 独立分析优化入口
- 独立 AI 成果入口

这些能力没有被抛弃，而是合并到更符合实际操作习惯的位置：

- 账号分析进入账号矩阵详情
- LoRA 管理进入角色库详情
- 生成结果进入素材库，并在内容工作台的内容卡片里显示
- 分析、知识、Agent 结果进入 Command Center 和系统状态视图

## 3. 当前真实可操作功能

- GitHub 登录状态恢复
- 账号矩阵读取、添加、编辑、删除
- 素材库读取、上传、新建、删除、预览
- 角色库读取、创建、编辑、删除、详情查看
- 平台连接状态展示
- Command Center 读取真实运营状态

## 4. 当前仍为展示或待接入动作的功能

以下功能已完成页面边界和操作位置，但真实执行仍需接入 Edge Function、MCP 或内部 Agent Runtime：

- 新建 Campaign 后自动触发 Strategy Agent
- 批准 / 驳回 / 重生成策略
- 策略批准后自动创建内容包
- 内容卡片内重新生成文案
- 内容卡片内提交图片或视频生成
- 生成结果确认可用
- 内容终审后创建发布任务
- 批准发布
- 执行真实平台发布
- 失败任务重试

## 5. Agent 策略生成如何执行

设计上 Campaign 页面只让用户填写运营目标、平台、账号、主题和指标。

真实执行应由后端动作完成：

1. 读取 Campaign 目标
2. 读取账号矩阵中的自有账号与参考账号
3. 读取账号画像和 Knowledge Vault
4. 读取历史表现
5. 调用 Strategy Agent
6. 写入策略计划
7. 状态设为待审批

浏览器前端不直接调用高权限密钥或模型密钥。

## 6. 内容生成和审核如何合并

新的“内容工作台”把原来的生成和审核合并到一张内容卡片中：

- 文案区域
- 图片 / 视频生成区域
- 生成结果与审核
- 内容终审区域

用户不需要在多个页面之间跳转。

## 7. 账号矩阵如何参与策略与发布

账号矩阵作为唯一账号资产中心：

- Campaign 选择自有账号
- Campaign 选择参考账号
- Strategy Agent 读取账号资料
- 发布队列选择发布账号
- Analytics 后续回写账号表现

## 8. 素材库如何参与生成与终审

素材库作为统一素材入口：

- 内容卡片选择参考素材
- 生成结果自动进入素材库
- 内容终审选择最终素材
- 发布任务引用最终素材

## 9. 角色库如何加载 LoRA

角色库作为角色与 LoRA 的统一管理入口：

- 内容卡片选择角色
- 自动读取角色设定
- 自动读取 LoRA 信息
- 自动读取推荐 Workflow
- 生成结果自动关联角色

## 10. 使用的 Supabase 数据

页面读取现有核心数据，不新增数据库结构：

- 账号与连接
- Campaign
- 策略计划
- 内容包与旧内容库
- 素材与旧素材库
- 角色
- 发布任务
- 内容指标
- 知识、洞察、内容记忆、策略记忆
- Agent 运行记录
- Workflow 运行记录
- ComfyUI Workflow 配置

普通用户界面不再直接展示数据库表名。

## 11. MCP 工具

本次没有新增 MCP 工具，也没有改动 MCP Server。

后续真实动作建议映射：

- create_campaign
- generate_strategy
- approve_strategy
- regenerate_strategy
- create_content_package
- generate_asset
- approve_content
- create_publish_task
- approve_publish
- execute_publish

## 12. Edge Function

本次没有新增 Edge Function。

高权限动作仍应由 Supabase Edge Function、可信服务端或 MCP 执行。

## 13. 数据库结构

本次没有修改数据库结构，没有新增 migration。

## 14. 测试结果

已执行：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

结果：

- Lint 通过
- Build 通过
- Migration 检查为 safe

## 15. 安全边界

本次保持：

- 不提交 `.env`
- 不提交 service role key
- 不提交 X Client Secret
- 不提交 OAuth Token
- 不提交平台 API Token
- GitHub Pages 只使用前端可用的 Supabase anon key

## 16. 线上部署地址

https://jiang289140790-eng.github.io/ai-marketing-studio/
