# KNOWLEDGE_VAULT_GOVERNANCE_REPORT

## 1. 实施结果

知识库已从“数据库记录混合列表”调整为“可复用知识库”：

- 主列表只显示能够形成业务结论的知识。
- 素材、生成任务、Agent 运行日志、工作流输出、API 原始响应、Storage 路径和测试 marker 默认排除。
- 被排除记录仍保留在数据库；高级模式可查看当前范围内的技术归档。
- 默认继承现有 Campaign Context，只显示当前 Campaign 与当前账号相关记录。
- 支持“当前 Campaign / 当前账号 / 全部历史 / 测试数据”范围切换。
- 每页最多显示 24 条，不再一次铺开全部 368 条记录。

本次没有新增数据表、migration、RLS 或平行业务对象，也没有删除或改写历史知识。

## 2. 知识语义模型

### 显示分类

| 分类 | 主要识别依据 |
| --- | --- |
| 账号知识 | `type/category/tags/title` 中的 account、profile、persona、账号 |
| 内容知识 | 默认可复用内容结论 |
| 策略知识 | strategy、campaign、策略 |
| 平台知识 | platform、X API、Telegram、Instagram、TikTok、YouTube |
| 角色知识 | character、角色、LoRA |
| 工作流知识 | workflow、provider、model、ComfyUI |
| 系统知识 | system、security、error、configuration |

分类优先复用现有 `type`、`metadata.category`、`metadata.tags` 和标题，不增加数据库字段。

### 知识状态

数据库仍保留英文值，页面统一显示：

- `verified` → 已验证
- `preliminary` → 初步信号
- `pending` → 待验证
- `expired` → 过期
- `test` → 测试
- `deprecated` → 已废弃

高置信度但没有人工批准或明确验证标记的知识只会显示为“初步信号”，不会伪装成“已验证”。

### 来源与证据区分

- 人工批准结论：直接证据。
- X 原生或公开数据：平台证据。
- 外部搜索推断：外部推断。
- AI 分析：模型推断。
- 系统记录：系统数据。
- 来源未标注：待确认。

页面使用不同徽章展示，避免把 X 原生证据、人工结论和外部推断混为一类。

## 3. 主列表排除规则

默认排除：

- `Asset Image`、`Asset Video` 及 `type=asset/asset_image/asset_video`
- 只有文件 URL、Signed URL 或 Storage 路径的记录
- Generation Job
- Agent Run / Agent Log
- Workflow Output
- 原始 API Response
- Phase 2 / 7 / 8 / 9、debug、test、marker、fixture、mock、smoke

这些记录没有被删除：

- 素材继续由素材库承载。
- 生成过程继续由生成任务承载。
- Agent 和系统记录继续由系统状态承载。
- 高级模式可查看已脱敏的技术归档。

## 4. 数据库查询验证

项目：`qtrlymiqohbjvklwegsw`

查询时间：2026-07-25

| 检查项 | 结果 |
| --- | ---: |
| `knowledge_entries` 总记录 | 368 |
| 保守 SQL 规则识别的素材/技术记录 | 28 |
| 保守 SQL 规则识别的测试记录 | 77 |
| 保守 SQL 规则识别的可复用主列表记录 | 285 |
| 当前 Campaign 可复用知识 | 3 |

前端语义治理规则比保守 SQL 查询更完整，还会检查 `metadata.is_test`、`environment`、`marker`、`asset_id`、`generation_job_id`、`workflow_output`、`api_response`、`storage_path` 和 `signed_url`。

数据库安全边界检查：

- `knowledge_entries`：登录用户只有 SELECT 权限。
- `insights`：登录用户只有 SELECT 权限。
- 当前没有安全的知识状态写入 RPC。
- 因此本次没有在前端绕过 RLS 直接修改知识状态，也没有放宽 RLS。
- “应用到当前策略/下一条内容”会进入对应人工确认页面；不会直接覆盖已批准策略。
- 状态修改入口会明确提示需要可信执行网关，不显示虚假的成功结果。

## 5. 页面结构

页面采用三段式业务布局：

1. 左侧：七类知识导航、分类数量、被排除记录说明。
2. 中间：语义知识列表、搜索、状态/来源过滤、24 条分页。
3. 右侧：知识详情抽屉。

顶部统计：

- 已验证知识
- 待验证假设
- 即将过期
- 测试记录

知识卡只显示：

- 标题
- 核心结论
- 类型
- 来源
- 状态
- 置信度
- 适用范围
- 最近更新时间

详情标签：

- 结论
- 证据
- 来源
- 适用范围
- 关联对象
- 使用历史
- 版本历史
- 高级数据

高级数据会递归隐藏 Secret、Token、Authorization、API Key、Password 和 Signed URL。

## 6. 去重治理

重复检测依据：

- 相同标题
- 相同 `source_ref`
- 相同 `content_hash`
- 相同结论与来源

页面只显示疑似重复候选并打开关联详情，不自动合并、不自动删除。

## 7. 修改文件

- `src/pages/KnowledgeVaultPage.jsx`
- `src/services/knowledge-governance-service.js`
- `src/utils/knowledge-governance.js`
- `src/styles.css`
- `test/knowledge-governance.test.mjs`

## 8. 验证结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 warning |
| `npm test` | 通过，59/59 |
| `npm run build` | 通过 |
| 本地知识库 URL | HTTP 200，存在 React 根节点 |
| 知识库路由与导航 | 已注册 |
| Supabase 查询验证 | 通过 |
| 浏览器截图 | 阻塞：Codex 浏览器运行时连续第三次无法写入内核资源（OS error 3） |

截图未伪造。浏览器运行时恢复后需要补做：

1. 打开 `http://localhost:3001/ai-marketing-studio/#/knowledge`。
2. 确认默认是当前 Campaign 范围。
3. 确认 Asset/Phase marker 不在普通主列表。
4. 切换全部历史并验证分页。
5. 打开详情抽屉并验证八个标签和高级数据脱敏。

## 9. 回滚方式

本次未提交独立 commit。当前基线 commit：

`a307f0510970706f5a0d4919a8c28b4d1659185a`

如需回滚，只恢复“修改文件”中与知识库治理相关的改动；不要回滚工作区中其他阶段尚未提交的用户改动。

## 10. 尚未完成

知识状态写入和“应用知识后自动生成待审核建议”尚未接入可信执行网关。原因是当前知识表没有用户归属字段，登录用户也没有写权限；在没有资源归属校验的情况下开放写入会产生越权风险。

后续应在现有安全执行网关中增加带 Campaign 所有权校验的知识治理动作，而不是放宽 RLS 或从前端直写。
