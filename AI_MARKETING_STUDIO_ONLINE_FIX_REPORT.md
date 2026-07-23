# AI Marketing Studio 线上修复报告

生成时间：2026-07-23（Asia/Shanghai）  
线上地址：https://jiang289140790-eng.github.io/ai-marketing-studio/  
实现 commit SHA：`7ade51075c391fa719c690fa2be32f424e0f62e8`

## 结论

线上界面与数据层已完成，执行层等待 MCP Bridge 部署。

没有伪造 Bridge URL，没有把任何平台 Token、Client Secret、Supabase service role key 或 MCP secret 写入前端。

## 修改文件列表

- `src/components/ExecutionButton.jsx`
- `src/components/ExecutionStatus.jsx`
- `src/components/Sidebar.jsx`
- `src/pages/CommandCenter.jsx`
- `src/pages/ContentWorkspacePage.jsx`
- `src/pages/KnowledgeVaultPage.jsx`
- `src/pages/PlatformConnectionsPage.jsx`
- `src/pages/PublishQueuePage.jsx`
- `src/services/execution-gateway.js`
- `src/styles.css`

## GitHub Pages 部署状态

- 状态：成功
- 工作流：Deploy GitHub Pages
- Run ID：`29938165128`
- 部署提交：`7ade51075c391fa719c690fa2be32f424e0f62e8`
- 工作流地址：https://github.com/jiang289140790-eng/ai-marketing-studio/actions/runs/29938165128
- 线上访问：成功
- GitHub 登录恢复：成功，线上已识别当前登录用户
- 浏览器控制台：未发现来自站点脚本的明显错误

## Supabase Edge Function 状态

| Function | 状态 | 版本 | JWT |
|---|---|---:|---|
| `platform` | ACTIVE | 12 | 平台函数自行处理授权流程 |
| `ops-execute` | ACTIVE | 2 | 开启 |
| `ops-status` | ACTIVE | 2 | 开启 |
| `ops-health` | ACTIVE | 2 | 开启 |

迁移安全检查通过：28 个迁移文件，没有发现不安全的重复 `CREATE POLICY`、`CREATE TABLE` 或 `CREATE INDEX`。

## MCP Bridge 与 Secrets

- MCP Bridge 是否真实部署：否
- Bridge 公网域名：未部署
- `OPS_MCP_BRIDGE_URL`：未配置
- `OPS_MCP_BRIDGE_SECRET`：未配置
- X OAuth 服务端配置：已存在（仅核对名称，未读取或输出值）
- Telegram 服务端配置：已存在（仅核对名称，未读取或输出值）
- Supabase Secrets 是否完成：执行网关所需的 Bridge 两项 Secret 未完成，因此不能视为执行闭环完成

## `ops-health` 脱敏结果

已通过登录后的线上 Command Center 调用并验证：

```text
Supabase: 已连接
Edge Function: 已部署
MCP Bridge: 未配置
AI Marketing Studio MCP: 等待 Bridge
X MCP: 等待 Bridge
```

该结果与 Supabase Secrets 审计一致。未向匿名用户暴露健康详情。

## Command Center 修复结果

- 移除未接入 allowlist 的“运行今日 AI 运营”主动作。
- Bridge 未连接时显示“执行服务暂未连接”，并提供查看网关、查看连接和查看待处理内容入口。
- 页面只保留一个执行网关状态卡片，技术详情收进折叠区。
- 数据层读取真实 Supabase 数据；线上验收时可见 Campaign、内容、账号、知识库和工作流统计。
- 没有用假数据填补 Agent / Workflow 空记录。

## 内容工作台修复结果

- 增加全部、待审核、待生成素材、已生成素材、待发布、已发布、失败、测试数据八类筛选。
- 增加“隐藏测试内容”开关，默认隐藏，测试内容不删除。
- 内容卡补齐 Campaign、策略、平台、账号、状态、审核状态、Hook、正文摘要、CTA、标签、角色、LoRA、素材数和时间信息。
- 每张卡提供查看详情、继续编辑、生成素材、审核、查看生成结果快捷入口。
- 图片/视频要求按中文字段渲染，详情不显示 `[object Object]`。
- 线上验收：80 个内容包，默认显示 79 个正式内容；1 个测试内容被隐藏；无横向溢出。
- Bridge 未连接时统一说明生成、导入和发布动作不可执行。

## 平台连接中心修复结果

- X 与 Telegram 按真实连接记录展示，线上验收均存在已连接记录。
- Instagram、YouTube、TikTok、Discord 明确显示“准备中”。
- 显示真实连接数量、账号列表、授权范围、最后同步和五类能力状态。
- 前端不读取或显示 `platform_credentials` 中的 Token/secret。
- 线上验收：6 个平台卡片、34 条账号展示行、30 个能力状态项；页面无 Token/secret 文本。

## 发布队列修复结果

- 明确状态流：草稿 → 待审核 → 已批准 → 已排期 → 发布中 → 已发布 → 失败。
- 发布前真实判断内容审核、账号连接、发布权限和平台格式。
- 增加人工二次确认；未确认时不能执行真实发布。
- 发布前检查通过 `execute_publish` 的 `dry_run` 模式，真实发布明确使用 `dry_run: false`。
- 失败原因可见；重试按钮只在失败任务出现。
- 当前线上没有发布任务，因此状态流已验证，任务级检查卡等待真实任务进入后继续验收。
- Bridge 未连接时所有发布执行动作继续由统一执行网关状态禁用。

## 知识库修复结果

- 通用名称自动转成账号/主题/类型组合标题。
- 对对象内容做可读字段展开，不再显示原始 JSON。
- 增加来源、关联账号、Campaign、类型、重要性、可复刻策略和下一步字段。
- 线上验收读取 367 条知识记录，未发现 `[object Object]` 或以原始 JSON 开头的正文。

## 旧页面与导航收敛

- 当前主导航只保留 Command Center、Campaign 与策略、内容工作台、内容情报、发布队列、AI 成果、分析优化、运营日报、知识库、账号矩阵、素材库、角色库及必要系统入口。
- 旧 AI Studio、旧 Publish Center、传统 CRUD 页面仍保留在代码中以便兼容，但没有进入当前主导航和主路由。

## 响应式验收

| 尺寸 | 横向溢出 | 导航裁切 | 侧栏 |
|---|---|---|---|
| 1366×768 | 无 | 无 | 固定且可独立滚动 |
| 1440×900 | 无 | 无 | 固定且可独立滚动 |
| 1920×1080 | 无 | 无 | 固定且可独立滚动 |
| 780×900 | 无 | 无 | 可折叠，展开后可滚动 |

## 剩余风险

1. MCP Bridge 尚未部署，因此生成、导入、账号同步、分析和发布都只能展示真实禁用状态。
2. 当前发布队列没有真实任务，任务级发布前检查需要在第一条真实任务进入后再做端到端验证。
3. GitHub Actions 提示部分官方 action 仍声明 Node.js 20；当前已被 runner 自动切换到 Node.js 24，部署成功，但应持续关注官方 action 更新。
4. 前端主包体积约 593 kB，后续可按页面做动态加载，不影响本次功能验收。

## 下一步建议

1. 在可长期运行、具备公网 HTTPS 的环境部署 MCP Bridge，并实现 HMAC 校验、action allowlist、幂等、超时与审计日志。
2. 仅在 Bridge 真实可访问后配置 `OPS_MCP_BRIDGE_URL` 与 `OPS_MCP_BRIDGE_SECRET`。
3. 重新执行登录后的 `ops-health`，只有 Bridge、MCP、X MCP 等状态全绿后，才开始端到端生成和发布验收。
4. 创建一条真实但不发布的测试任务，先完成 `dry_run`，再由人工决定是否进行首次真实发布。
