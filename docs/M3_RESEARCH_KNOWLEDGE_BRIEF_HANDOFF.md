# M3: Research → Knowledge → Brief → Handoff 在线闭环

本文档描述 M3 里程碑的本地确定性实现：在既有 P19/P22/P23/P24/P32/M2 合同之上
统一「来源采集 → Evidence 保存 → 单帖/多帖 Qwen 分析 → Knowledge Card →
pending-review Brief → 人工批准或退回 → approved Brief → Handoff」的在线闭环，
并完成对抗加固。M3 不执行生成、路由或发布；所有在线写入继续走
`p19-workspace-command` 命令边界。

## 1. 范围与复用

| 合同 | 复用位置 |
|---|---|
| 来源采集（X 单链接 / Reddit 单链接 / 主题搜索 / 批量导入） | `p22-research-assist` 边沿函数 + `p22-research-assist.js` 客户端（`toP19EvidenceInput` / `importSearchSelection`） |
| 版本化 Qwen 分析（p32_multimodal_model_v2） | `recordVersionedReanalysis` / `recordVersionedTextReanalysis`（追加不覆写） |
| Knowledge Card（content_knowledge_card_v1） | `buildKnowledgeCard` / `buildKnowledgeCardsForSelection`（M3 增加过时门禁） |
| Brief（ams_content_brief_v1 + p32_multimodal_synthesis_v1） | `assembleSynthesisBrief`（精确选中 2–5 张当前卡） |
| 人工审核（ams_brief_review_v1） | `reviewBrief`（approved / return_for_revision；M3 增加审计记录） |
| Handoff（ams_external_handoff_package_v1） | `deriveHandoffPackage`（仅当前已批准且未过时） |
| 在线命令边界 | `command-core.mjs`（`evidence.create` / `analysis.create` / `card.create` / `brief.assemble` / `brief.decide` / `handoff.create`） |

## 2. M3 新增行为

### 2.1 知识卡只从「当前、完整、准确绑定」的分析生成（范围 3）

`buildKnowledgeCard`（服务层）与 `applyCardCreate`（在线命令边界）双层强制：

- 分析绑定的证据已变化（`evidence_fingerprint` / `evidence_version` 失配）→
  `CARD_ANALYSIS_STALE` 失败关闭，项目完全不变；
- 同一分析重试仍幂等复用（不产生重复卡）；旧版卡快照保持可查看且不自动过时
  （P32-A 快照语义：新分析版本不使旧版卡失效）；
- 旧版本恢复：未过时的旧分析版本仍可确定性恢复其卡（同一不可变卡）。

### 2.2 决策审计记录（范围 5）

`reviewBrief` 每次决定（approved / return_for_revision）都在
`brief.review.comments` 追加有界审计条目：

```
[第 {N} 版 已批准] / [第 {N} 版 已退回修改] + 理由
```

- 当前决定只保存在 `review.decision`；重建 Brief 后旧决定绝不显示为 current；
- 审计条目随 `comments` 在重建间延续、随 Brief 记录持久化（本地 store 与在线
  Brief 记录均可刷新恢复）；上限 50 条与命令边界口径一致；
- 已决定 Brief 不得重复决定（`BRIEF_REVIEW_STATE_INVALID`）；退回后必须
  重建新版本再审核；
- 在线边界 `applyBriefDecide` 以 `decision.brief_version` 修订校验拒绝旧决定
  复用（`DECISION_REVISION_MISMATCH`）。

### 2.3 旧 Handoff 审计（范围 5）

- 重建 Brief 后 `project.handoff` 与 `handoffs` 清空——旧 Handoff 绝不显示为
  current；重新批准并派生时产生全新 `handoff-pkg-*` identity；
- 旧 Handoff 记录保留在在线账本（`p19_handoff_packages_v1`）中供审计：
  命令边界不存在任何交接包删除/更新命令（`handoff.remove` / `handoff.update`
  不在 `COMMAND_ALLOWLIST`）；
- UI 交接包区明示：本页只展示当前 Brief 修订绑定的交接包。

### 2.4 费用绑定（范围 10）

- P22 采集证据：`provenance.usage_total_usd` + `budget_reservation_id` +
  `run_id` 原样绑定（既有合同），证据库展示实际费用与预留/运行身份；
- Qwen 分析：服务端实际返回的 `cost`（`actual_usd` / `recorded_cny` /
  `reservation_id`）随 `model_analysis.usage` 保存——仅当上游实际返回费用
  记录才绑定（`boundAnalysisCost`），绝不虚构；
- 未返回费用记录的分析保持只有 `total_tokens`；确定性本地分析恒为无费用
  （UI 明示「未调用任何模型、不产生任何费用」，绝不伪装为付费模型调用）。

## 3. 在线命令边界（范围 7）

页面 → `p20-online-store` → `p19-server-write-adapter` → `p19-workspace-command`
边沿函数。`buildOnlineCommand` 把每次本地变更映射到唯一命令：

| 变更 | 命令 |
|---|---|
| 证据新增/编辑/移除 | `evidence.create` / `evidence.update` / `evidence.remove` |
| 分析保存 | `analysis.create` |
| 知识卡生成 | `card.create`（M3：过时分析 → `CARD_ANALYSIS_STALE`） |
| Brief 组装/重建 | `brief.assemble` |
| 审核决定 | `brief.decide`（修订失配 → `DECISION_REVISION_MISMATCH`） |
| 交接包派生 | `handoff.create`（未批准 → `HANDOFF_BRIEF_NOT_APPROVED`；持久化重派生比对） |

所有命令携带幂等键：同键重放返回 `replayed`，绝不重复写入；两标签页并发由
`expected_base_version` / `expected_entity_fingerprint` 修订保护失败关闭
（`PROJECT_REVISION_STALE` / `ENTITY_REVISION_STALE`）。

## 4. 对抗矩阵（test/m3-research-knowledge-brief-handoff.test.mjs）

1. 统一入口：X/Reddit 单链接 + 主题搜索批量导入 → 精确 Evidence 身份与费用
   绑定；幂等重试零重复记录；
2. 版本化分析：当前有效绑定；显式新版本；旧版不可变；请求身份去重；费用绑定
   与不虚构；
3. 知识卡门禁：过时/缺失/错绑/缺哈希/重复与外来媒体全部失败关闭；旧版卡快照
   保留；
4. Brief：2–5 张当前卡；未选中卡不混入；逐项结论反查 Knowledge→Analysis→
   Evidence（精确 fingerprint/version）；缺少/过时/跨项目失败关闭；
5. 审核：退回必须重建新版再审核；旧决定保留审计不 current；批准前 Handoff
   拒绝；旧 Handoff 不 current；新 Handoff 全新 identity；无别名；
6. 命令边界：完整链 + 幂等重放 + `ENTITY_REVISION_STALE` 两标签页冲突 +
   跨项目/跨账号 `PROJECT_NOT_FOUND` + `IDEMPOTENCY_CONFLICT` + 在线卡过时
   门禁 + `HANDOFF_BRIEF_NOT_APPROVED` + 无交接包删除命令；
7. 刷新/重新登录恢复：store 往返与在线命令边界重载
   identity/fingerprint/version/决定/费用 完全一致；身份不匹配拒绝加载；
8. 跨项目隔离：同一来源内容分属两项目时分析/卡绝不混入；
9. 错误脱敏：不输出 Bearer/JWT/service-role。

## 5. 浏览器验收（test/m3-research-knowledge-brief-handoff.browser.test.mjs）

真实 Edge 浏览器：版本菜单 + 费用绑定显示 → 生成知识卡 → 组装 Brief →
人工批准（审计记录可见）→ 派生交接包 → 硬刷新恢复 → 项目切换隔离 →
确定性分析「无费用」展示 → 移动端无横向溢出。

## 6. 边界

- 不修改数据库 migration/schema/RLS/GRANT/Auth/OAuth/Storage；
- 不新增持久化字段（本地 store 严格 allowlist 保持不变）；
- 不执行生成、路由、provider/workflow 选择、外部 generation job、导出或
  社交发布；四项执行标志恒为 false；
- 不访问 production `qtrlymiqohbjvklwegsw`；目标仅限 staging
  `xtkkdvghiohlnpfnnhmx`（由 MASTER 选择性部署与真实登录验收）。
