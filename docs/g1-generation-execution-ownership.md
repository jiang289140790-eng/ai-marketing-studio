# G1 百炼生成执行层 — 文件所有权台账（Milestone G1）

本台账记录 G1 里程碑中每个改动文件的所有权、理由与验收证据位置。除本台账
明确列出的文件外，本里程碑没有改动任何其他文件；既有工作区中的脏文件属于
用户，未读取、未覆盖。

## 新增文件（G1 所有）

| 文件 | 内容 | 验收覆盖 |
|---|---|---|
| `supabase/migrations/20260816090000_g1_bailian_generation_execution_v1.sql` | 唯一前向迁移：provider 注册表、quote、作业/尝试/产物/事件表、13 个 service-role-only 原子 RPC、终态不可变触发器、私有 bucket | #1 #2 |
| `supabase/functions/g1-generation-command/index.ts` | G1 Edge Function：JWT + staging 角色、service-role RPC 适配、签名 URL | #2 #5 |
| `supabase/functions/g1-generation-command/generation-core.mjs` | Edge 纯核心：动作清单、有界校验、approval 构造、错误映射（node:test 可测） | #2 #3 |
| `services/generation-worker/package.json` | worker 清单（@supabase/supabase-js 固定版本） | #4 |
| `services/generation-worker/config.mjs` | 运行时环境配置与全部有界值；Secret 只从环境/文件挂载读取 | #4 |
| `services/generation-worker/db-adapter.mjs` | service-role RPC 适配（可注入） | #4 |
| `services/generation-worker/storage-adapter.mjs` | 私有路径上传/引用素材准备（可注入） | #4 |
| `services/generation-worker/bailian-adapter.mjs` | Bailian(DashScope) 异步适配器：提交/轮询/有界下载/脱敏诊断（可注入 fetch） | #3 #4 |
| `services/generation-worker/worker.mjs` | worker 主循环：claim/lease/提交/轮询/完成；崩溃对账；绝不重复付费提交 | #4 |
| `src/pages/GenerationTasksPage.jsx` | 真实生成流页面（选择 Brief → 报价 → 显式批准 → 提交 → 进度 → 产物/版本历史） | #5 |
| `src/pages/GenerationTasksPage.css` | 页面专属样式（全局主题变量） | #5 |
| `src/components/generation-execution/GenerationQuotePanel.jsx` | 不可变报价与显式批准面板 | #5 |
| `src/components/generation-execution/GenerationJobCard.jsx` | 作业状态卡片（有界诊断） | #5 |
| `src/components/generation-execution/GenerationArtifactViewer.jsx` | 私有产物预览/下载/版本历史/血缘 | #5 |
| `src/services/generation-execution-service.js` | 浏览器服务端契约（真实模式 + demo/测试模式） | #5 |
| `supabase/tests/g1_b0_generation_adversarial.test.sql` | 数据库对抗测试（ACL/隔离/报价失效/幂等/并发/租约/终态不可变/血缘） | #1 #2 |
| `test/g1-migration-replay.test.mjs` | 两次干净回放 + 并发同 key 提交（6 并行 psql） | #1 #2 |
| `test/g1-generation-core.test.mjs` | Edge 核心单元测试 | #2 #3 |
| `test/g1-provider-adapter.test.mjs` | 适配器对确定性 fake HTTP server 全行为 | #3 |
| `test/g1-worker.test.mjs` | worker 崩溃/重启/轮询恢复/绝不重复提交 | #4 |
| `test/g1-harness-tools.test.mjs` | Harness 生成工具（批准/无批准不提交/精确绑定/只读/失败停止/重放） | #6 |
| `test/g1-generation.browser.test.mjs` | 真实生产构建浏览器测试（fake 本地 provider/Storage） | #5 |
| `docs/g1-generation-execution-ownership.md` | 本台账 | #9 |

## 既有文件（仅按 G1 需要的最小改动）

| 文件 | 改动 | 理由 |
|---|---|---|
| `services/harness-gateway/tool-contract.mjs` | 新增 generation.quote/submit/status/artifact 四个操作；结果数据字段扩展；toBoundaryRequest 的 g1 expected_revision 透传 | G1 工具契约 |
| `services/harness-gateway/workflow-catalog.mjs` | 新增 generate_media / read_generation 工作流；付费/写入标志改为按批准范围派生（任何端点一致适用） | G1 工作流 |
| `services/harness-gateway/planner.mjs` | 新增生成/读取/报价意图分类与有界槽位提取；generation.* 步骤要求项目绑定 | G1 规划 |
| `services/harness-gateway/deterministic-executor.mjs` | 新增 4 个操作的 payload 构造/捕获/恢复输出 | G1 执行 |
| `supabase/functions/harness-tool-bridge/bridge-core.mjs` | 新增 4 个操作路由；generation.* 精确往返；允许 expected_revision 边界字段 | G1 桥接 |
| `services/harness-gateway/test/workflow-catalog.test.mjs` | 工作流数量 11→13 + G1 断言 | 目录完整性 |
| `services/harness-gateway/test/planner.test.mjs` | 新增 G1 分类/计划断言 | 分类回归 |
| `services/harness-gateway/test/tool-contract.test.mjs` | 操作数量 16→20 + 端点集合 + G1 断言 | 契约回归 |
| `test/p19-sql-integration.test.mjs` | 迁移数量 47→48（含新迁移回放与 g1 对抗 SQL 执行） | 验收 #1 #2 必需 |

## 明确不改动

- 历史迁移（全部 47 个既有文件逐字节未动）；
- `src/services/ai-service.js` 的占位适配器（显式 placeholder，未伪装为可用）；
- 既有 `assets`/`workflow_runs`/`marketing-assets` 约定（只读复用）；
- Auth、既有 RLS/GRANT 语义、既有业务数据、旧 ComfyUI 表；
- 用户拥有的未跟踪文件（`.agentbridge/`、`AGENTS.md`、`CLAUDE.md`）。

## 验收证据位置

- #1/#2：`test/g1-migration-replay.test.mjs` + `supabase/tests/g1_b0_generation_adversarial.test.sql`（在 `test/p19-sql-integration.test.mjs` 中随全部迁移回放执行）；
- #3：`test/g1-provider-adapter.test.mjs`；
- #4：`test/g1-worker.test.mjs`；
- #5：`test/g1-generation.browser.test.mjs`；
- #6：`test/g1-harness-tools.test.mjs` + harness-gateway 三个既有测试文件的 G1 断言；
- #7：上述全部 + 既有 P19/P22/P30/P31/P32/M1–M4 测试（未改动、预期保持绿色）；
- #9：`E:\projects\AI Marketing Studio Control Center\orchestration\results\ams-g1-bailian-generation-execution-layer-completion.md`。
