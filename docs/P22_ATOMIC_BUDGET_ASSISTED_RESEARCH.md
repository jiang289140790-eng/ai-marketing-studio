# P22 原子预算与智能研究接入

P22 在 `#/research` 的证据步骤增加“智能找资料”入口。它只面向已登录的 staging operator，最多预览 5 条 X 公开来源，最多选择 2 条进行 Qwen 辅助分析。

## 安全和费用

- `api.p22_reserve_daily_budget` 使用事务级 advisory lock，按 UTC 日期分别为 Apify、Qwen 原子预留费用。
- 两个 provider 每日项目级上限均为人民币 10 元；失败调用的保守预留不会自动释放，避免重试突破预算。采集失败后该次预留继续计入当日 UTC 上限，不回滚、不退款、不删除。
- RPC 仅允许 service_role 执行，浏览器角色没有 EXECUTE。
- Edge Function 只返回 Secret 是否存在的布尔状态，不返回值。
- Apify 每次最多预留 ¥2，Qwen 每次最多预留 ¥1；费用或用量无法验证时失败关闭。

## 文档化 Apify 采集序列（确定性运行身份与可审计费用链）

`collect` 在预留 Apify 预算之后，通过 `runApifyCollectionSequence`（fail-closed 适配边界）只使用 Apify API v2 的文档化端点：

1. **启动运行**：`POST https://api.apify.com/v2/acts/{actorId}/runs?maxTotalChargeUsd=...`。Apify Run Actor 把 POST 请求体本身作为 Actor 输入，因此请求体直接是顶层字段 `{"maxItems":N,"sort":"Latest","searchTerms":[topic]}`——不包裹 `input`，包裹后 Actor 收不到顶层字段。响应体必须提供 `data.id`（运行 ID）与 `data.defaultDatasetId`（默认数据集身份），作为后续每个阶段的唯一身份基准（不使用任何响应头作为身份来源）。
2. **严格超时等待**：轮询 `GET https://api.apify.com/v2/actor-runs/{runId}?waitForFinish=60`，总等待预算为 `P22_LIMITS.apify_wait_ms`（60 秒），轮询间隔 1 秒；每次读取都重新校验运行 ID 与默认数据集身份，缺失/变化/外来一律失败关闭。终态 `SUCCEEDED` 继续，`FAILED`/`ABORTED`/`TIMED-OUT` 失败关闭。
3. **只取该运行的默认数据集**：`GET https://api.apify.com/v2/actor-runs/{runId}/dataset/items?limit=5&clean=true`（端点按运行作用域限定，`limit` 不超过 `P22_LIMITS.collect`）；载荷若自报 `run_id`/`datasetId`/`dataset_id` 且与绑定的身份不一致，失败关闭。
4. **取同一运行的稳定费用**：终态 `SUCCEEDED` 后，Apify 的费用总额可能是初步值，因此按有界规则稳定读取：再次 `GET https://api.apify.com/v2/actor-runs/{runId}` 最多 `P22_LIMITS.cost_stabilize_polls`（3 次，含首次）次，间隔 `P22_LIMITS.cost_stabilize_interval_ms`（1.5 秒）。**每次成本读取都必须同时保持同一运行 ID、同一数据集身份与 `status === 'SUCCEEDED'` 才允许观测费用**——等待成功不构成后续读取成功的证据。同一运行的两次连续 `usageTotalUsd` 相等才作为最终费用证据；费用缺失、非有限数值、负值、两次观测之间下降/矛盾、始终不稳定，或超过 `maxTotalChargeUsd`（= ¥2 预留 ÷ 7.5），一律失败关闭。成本阶段出现终态失败（`FAILED`/`ABORTED`/`TIMED-OUT`）归入 `APIFY_RUN_FAILED`；状态缺失、过渡态（`RUNNING`/`READY`）、未知或与等待结果矛盾的状态一律失败关闭为 `APIFY_COST_UNVERIFIABLE`，绝不返回费用或到达证明签发。

`maxItems` 与 `maxTotalChargeUsd` 在适配边界内被钳制在现有 P22 上限内，即使调用方传入更大值也不会外溢。稳定步骤的轮询次数与间隔都是固定常量，无无限等待或重试；整个序列受 `P22_LIMITS.apify_sequence_ms`（120 秒）总超时约束。

## 失败类别与有界诊断

每个提供方失败都折叠为确定类别（HTTP 状态：`APIFY_TIMEOUT` 504、空结果 422、其余 502）：

| 类别 | 含义 |
|---|---|
| `APIFY_UPSTREAM_REJECTED` | 上游任一阶段非 2xx 或传输错误 |
| `APIFY_RUN_ID_INVALID` | 运行 ID 或默认数据集身份缺失/格式非法/重复/外来（不匹配启动的运行或数据集） |
| `APIFY_RUN_FAILED` | 运行在等待或成本稳定阶段进入终态失败（`FAILED`/`ABORTED`/`TIMED-OUT`） |
| `APIFY_TIMEOUT` | 严格等待预算耗尽或中止信号触发 |
| `APIFY_DATASET_INVALID` | 数据集载荷非法或数据集/运行身份不匹配 |
| `APIFY_COST_UNVERIFIABLE` | 费用缺失、不可解析、非有限数值、观测下降/矛盾、始终不稳定，或成本读取时运行状态缺失/处于过渡态（`RUNNING`/`READY`）/未知/与等待结果矛盾 |
| `APIFY_COST_ABOVE_RESERVATION` | 实际费用超过预留预算 |
| `EMPTY_PROVIDER_RESULT` | 规范化后没有可验证的公开内容 |

返回与日志只携带白名单有界字段：`code`、`provider`、`stage`（start/wait/dataset/cost）、安全的上游 HTTP `status`、符合 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` 的运行 ID（`run_id`）、有界 `run_status`/`reason`。绝不记录或返回 Authorization 头、令牌、请求体、采集内容、用户 ID、含凭据的 URL 或上游原始响应体；浏览器端对诊断字段再做一次白名单清洗。

任何未取得有效采集证明的失败都在签发来源证明之前抛出：不返回任何条目、不预留 Qwen、不调用模型，也没有可保存的来源；失败的预留仍计入当日 UTC 上限。

## 数据边界

- 采集和分析结果先预览，不自动写入。
- 用户明确保存时，公开来源通过既有 P20 命令边界进入当前项目。
- Qwen 输出是辅助预览，不冒充 P19 的 `deterministic_local` 权威分析；保存来源后，仍由用户运行现有确定性分析进入知识卡和 Brief 链。
- 不自动创建知识卡、Brief、交接、路由、外部作业或发布。

## 部署门禁

部署 `p22-research-assist` 和发布 Pages 前，staging 必须存在 `APIFY_TOKEN` 与 `DASHSCOPE_API_KEY` 两个 Secret 名称。值只保存在 Supabase Edge Secrets，不进入仓库、日志或报告。

## 来源绑定与项目隔离

- Apify 返回的正文先裁剪到持久化上限，再计算 SHA-256；保存边界会重新计算并严格比较，禁止“先哈希、后裁剪”。
- 采集 Edge Function 为每条来源签发短时服务端证明，绑定登录用户、来源 URL、完整正文、正文哈希、采集运行和预算预留身份。
- Qwen 分析与 P19/P20 保存均在预算预留、模型调用或数据库写入前验证该证明；浏览器不能自行声明可信 Apify provenance。
- 保存后的证据保留准确的 Apify provider、run、时间、费用、预算预留、来源身份、正文哈希和服务端证明，不降级为人工来源。
- 切换研究项目时，采集预览、选择和分析结果全部重置，A 项目的未保存状态不会进入 B 项目。
