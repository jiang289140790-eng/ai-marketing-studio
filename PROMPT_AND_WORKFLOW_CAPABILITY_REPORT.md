# PROMPT_AND_WORKFLOW_CAPABILITY_REPORT

## 交付结论

本次完成“提示词模板与工作流能力中心”收口：

- 提示词库负责保存用户明确选择的可复用模板、变量、版本与使用表现。
- 工作流与模型页面负责展示真实可执行工作流、通用模型依赖、Provider 和生成测试。
- Emma 等角色 LoRA 继续由角色库管理，没有在模型资产页面复制第二套 LoRA 数据。
- 没有新增业务表或 migration。
- 没有自动触发图片生成、付费工作流或外部发布。

## 一、复用的数据结构

### 提示词模板

复用 `prompts`：

- `title`：模板名称
- `category`：类型
- `content`：模板正文
- `platform`：适用平台
- `character`：关联角色

复用 `audit_logs` 承载：

- 当前版本与历史版本
- 修改原因
- 创建来源
- 用途
- Campaign 范围
- 推荐工作流
- 模板状态
- 变量清单

复用 `workflow_runs.prompt_id` 动态计算：

- 使用次数
- 成功率
- 最近使用时间

这种方式没有改变 `prompts` 的生产结构，也没有建立平行提示词表。

### 工作流

复用：

- `comfy_workflows`
- `workflow_runs`
- `characters.recommended_workflows`
- `characters.lora_info`
- `assets`
- `asset_library`

工作流与提示词的绑定写入现有 `comfy_workflows.default_params.prompt_template_id`。

角色与工作流的绑定继续写入 `characters.recommended_workflows`。LoRA 本身仍只读取角色库配置。

## 二、提示词库

### 分类

页面分类统一为：

- 文案
- 图片
- 视频
- 分析
- 工作流
- 系统

数据库仍保留兼容的英文内部值。

### 模板信息

模板卡与详情展示：

- 名称
- 类型
- 用途
- 平台
- 角色
- Campaign 范围
- 模板正文
- 变量
- 推荐工作流
- 版本
- 状态
- 使用次数
- 成功率
- 最近使用
- 来源

### 模板来源

创建表单支持明确选择：

- 手动新建
- AI 生成模板
- 从当前内容保存
- 从已批准策略保存
- 从工作流保存
- 从高表现内容生成
- 从知识条目转换

系统不会自动把所有运行 Prompt 写入提示词库。只有用户点击保存或明确执行转换时才创建模板。

### 变量与预览

支持结构化变量：

- `{{character_trigger}}`
- `{{platform}}`
- `{{content_goal}}`
- `{{hook_type}}`
- `{{visual_direction}}`
- `{{outfit}}`
- `{{location}}`
- `{{camera}}`
- `{{cta}}`

表单显示变量说明、示例输入和即时渲染预览。

### 版本管理

编辑模板不会丢失旧内容：

1. `prompts` 保存当前版本；
2. `audit_logs` 保存每次修改前后的完整快照；
3. 每次修改要求填写修改原因；
4. 页面按 v1、v2、v3 展示历史；
5. 创建来源和修改原因随版本保留。

### 空状态

当前范围没有模板时，页面提供：

- 从当前策略生成模板
- 从当前内容保存
- 新建提示词

不再只显示“暂无提示词”。

## 三、Emma 图片模板

已在生产数据库创建并回读验证：

- 模板：Emma · 社交图片生成模板
- 模板 ID：`f1e08fa3-2e0a-4637-b8f0-460d0d80612d`
- 类型：图片
- 平台：X
- 角色：Emma
- 用途：Emma 社交短内容图片生成
- 版本：v1
- 状态：可使用
- 来源：能力中心任务
- 使用次数：0
- 成功率：待验证

模板正文使用结构化变量，没有写入 Token、Secret、内部地址或临时签名链接。

## 四、工作流与模型能力中心

### 页面标签

- 工作流
- 模型资产
- Provider
- 生成测试

### 工作流卡

显示：

- 名称
- 类型
- Provider
- 基础模型
- 输入类型
- 输出类型
- 支持 LoRA
- 支持角色
- 当前状态
- 生产是否启用
- 最近测试
- 平均耗时
- 预估成本
- 最近任务

操作：

- 查看详情
- 测试运行
- 启用 / 停用
- 绑定角色
- 绑定提示词模板
- 查看任务

“测试运行”只进入内容工作台的安全测试配置，不会在能力中心自动调用付费工作流。

### 工作流详情

详情标签：

- 概览
- 输入映射
- 输出映射
- 模型依赖
- 角色绑定
- 提示词模板
- 测试记录
- 运行记录
- 高级配置

普通模式不展示：

- 密钥
- Token
- 内网地址
- 完整工作流 JSON
- Provider 原始响应

高级模式也只展示脱敏摘要，不把 Secret 送入前端。

### 模型资产

模型页从真实工作流依赖动态识别：

- SDXL Base / Checkpoint
- Flux
- Wan
- VAE
- ControlNet
- 通用模型

角色 LoRA 被明确排除，不在模型资产中重复展示。

## 五、Emma 工作流

生产数据库回读确认：

- 名称：`emma_s1_sdxl_t2i_v01`
- 工作流 ID：`51b2aa68-475e-4aa1-b2c4-de9ff13d7de2`
- 基础模型：SDXL 1.0
- 输入：文本
- 输出：图片
- 支持 Emma S1 LoRA
- 状态：已验证
- 生产：已启用
- 历史测试：1 次
- 成功测试：1 次
- 最近测试时间：2026-07-25
- 最近测试图：从已回传素材读取

Emma 图片模板已经真实绑定：

- 绑定模板 ID：`f1e08fa3-2e0a-4637-b8f0-460d0d80612d`
- 数据库回读结果与工作流 `default_params.prompt_template_id` 一致

## 六、职责边界

| 对象 | 负责内容 | 不负责内容 |
|---|---|---|
| 提示词库 | 模板正文、变量、版本、来源、使用表现 | LoRA 文件、工作流执行 |
| 工作流能力中心 | 输入输出映射、Provider、通用模型、启停、测试和运行 | 角色身份维护 |
| 角色库 | 角色设定、角色 LoRA、触发词、权重、参考图 | 通用模型和 Provider |
| 生成任务 | 每次执行过程、进度、输出和错误 | 模板长期管理 |

## 七、安全措施

- 不展示或返回 Secrets、Token 和 Provider 密钥。
- 普通模式不显示完整工作流 JSON、内网地址或内部路径。
- 测试按钮不自动触发付费工作流。
- 启停、绑定角色和绑定模板都是明确用户操作。
- 所有绑定和版本修改写入审计日志。
- 没有修改角色 LoRA 的数据归属。

## 八、主要修改文件

- `src/pages/PromptLibrary.jsx`
- `src/components/PromptForm.jsx`
- `src/pages/WorkflowModelConfigPage.jsx`
- `src/services/prompt-service.js`
- `src/services/workflow-capability-service.js`
- `src/utils/prompt-template-model.js`
- `src/utils/workflow-capability-model.js`
- `src/data/navigation.js`
- `src/styles.css`
- `test/prompt-template-model.test.mjs`
- `test/workflow-capability-model.test.mjs`

## 九、验证结果

### 数据库验证

- Emma 图片模板创建成功
- Emma 角色关联正确
- Campaign 元数据已记录
- 模板 v1 审计记录存在
- Emma 工作流绑定模板成功
- 工作流保持启用
- 未触发新的生成任务或费用

### 自动检查

- `npm run typecheck`：通过
- `npm run lint`：通过，0 warning
- `npm test`：通过，52/52
- `npm run build`：通过
- `git diff --check`：通过

### 本地路由

- `http://localhost:3001/ai-marketing-studio/#/prompts`：HTTP 200
- `http://localhost:3001/ai-marketing-studio/#/workflows`：HTTP 200

### 页面截图与真实点击

尝试连接桌面内置浏览器进行真实页面点击和截图，但浏览器运行内核初始化失败：

`failed to write kernel assets: 系统找不到指定的路径。 (os error 3)`

因此本报告不伪造截图或声称浏览器点击验收完成。数据库关系、应用构建和本地路由已经验证；最终视觉截图需在浏览器内核运行环境恢复后补测，或由用户刷新上述两个页面并提供截图后继续修正。

## 十、回滚方式

1. 恢复提示词库、提示词表单和工作流页面的上一版本。
2. 删除新增的两个能力模型工具和对应测试。
3. 恢复 `prompt-service.js` 的简单 CRUD。
4. 将工作流 `default_params.prompt_template_id` 移除即可解除模板绑定。
5. 删除 Emma 模板及其对应的 prompt 审计日志即可回滚本次唯一业务数据新增。

本次没有 migration，因此回滚不涉及数据库结构恢复。

## 十一、版本

- 当前基础提交：`a307f05`
- 当前工作区包含前序阶段尚未提交的改动。
- 本轮未主动提交，避免把多个阶段混入一个未经确认的提交。

