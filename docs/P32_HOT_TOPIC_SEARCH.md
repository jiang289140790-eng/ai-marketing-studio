# P32-B：X 热门主题搜索、指标排序与批量导入当前研究项目

## 概述

P32-B 在现有 `#/research` 当前研究项目内新增「热门主题搜索」能力：

1. **关键词批量搜索** — 输入关键词搜索 X 公共帖子（默认 10、最多 20 条，带服务端来源证明），不需要新建研究项目；
2. **五种确定性排序** — 按浏览量 / 点赞 / 转发 / 总互动 / 互动率排序，缺失指标明确显示「—」，绝不伪造为 0；
3. **批量导入** — 勾选 1–5 条结果，一次点击导入当前项目 Evidence；已导入来源明确标记并禁止重复导入；
4. **失败关闭** — 搜索失败、来源证明失效、重复来源、项目切换或部分导入失败时，当前项目完全不变。

「热门主题搜索」与既有「智能找资料」的**单帖 URL 读取**清楚区分：搜索面板只接受关键词，
任何链接形态的输入都失败关闭并引导使用单帖读取；单帖读取行为（P22）、P32-A 的 Qwen
重新分析与多帖比较全部保留。

## 架构

```
assist-core.mjs（search 动作：关键词规范化/URL 拒绝/数量边界/Actor 输入固定/结果唯一性/批次身份）
    ↓
index.ts（服务端构造 Actor 输入，签发 collection proof，返回 search_batch_id）
    ↓
p22-research-assist.js（search 客户端动作 + 确定性排序纯函数 + 批次重验证 + 批量导入编排）
    ↓
p19-workspace-service.js（addEvidenceBatch：工作区层原子批量保存）
    ↓
P19WorkbenchPanels.jsx（P32HotTopicSearchPanel：搜索/排序/勾选/导入 UI）
    ↓
ResearchWorkspacePage.jsx（瞬态搜索状态持有、切换项目清空、导入后滚动/聚焦 Evidence 列表）
    ↓
ResearchWorkspacePage.css（P32-B 样式）
```

## Edge 搜索合同

### 请求

| 字段 | 约束 |
|------|------|
| `action` | 精确 `search` |
| `keyword` | 字符串，trim + 折叠空白，≤120 字符；**URL 形态一律失败关闭**（`KEYWORD_IS_URL`，引导使用单帖读取） |
| `count` | 整数 1–20，缺省 10（`P22_LIMITS.search_default/search_max`） |
| `sort` | 排序意图，当前仅接受 `latest`（服务端固定，可扩展但本里程碑只执行该意图） |

请求只接受上述字段；未知字段失败关闭。**客户端绝不提供任意 Actor 输入。**

### Actor 输入（服务端构造）

`POST /v2/acts/xquik~x-tweet-scraper/runs` 的请求体由服务端精确构造：

```json
{ "maxItems": 20, "sort": "Latest", "searchTerms": ["精确关键词"] }
```

- `maxItems` 受 `hardMax = P22_LIMITS.search_max`（20）约束；
- 平台由固定 `actorId`（`xquik/x-tweet-scraper`）绑定为 X；
- 运行身份（`data.id` / `data.defaultDatasetId`）、费用稳定读取与证明签发沿用 P22 契约。

### 响应

```json
{
  "ok": true, "action": "search",
  "search_batch_id": "p32-search-<24hex>",
  "keyword": "...", "count": 10, "sort_intent": "latest",
  "collected_at": "...",
  "items": [/* 规范化结果：正文/身份/来源快照/媒体/provenance/collection_proof */],
  "cost": { "recorded_cny": 2, "actual_cny": 0.08, "tracking": {...} }
}
```

- **结果唯一性（fail closed）**：规范化后任何重复的 source URL / external ID / 正文哈希
  即整批失败（`SEARCH_RESULT_DUPLICATE`），绝不静默丢弃或接受；
- **缺失互动字段保留 `null`**（`normalizeSourceMetadata`），绝不伪造为 0；
- **搜索批次身份**：`searchBatchId` 确定性绑定精确关键词、数量、排序意图、采集运行、
  采集时间与全部结果的（URL|外部 ID|正文哈希）有序身份集合 —— 任何字段缺失、篡改、
  乱序、错绑都会产生不同批次身份，导入端据此失败关闭。

## 排序（确定性纯函数）

`computeEngagementMetrics(item)` 返回：

| 指标 | 口径 |
|------|------|
| `views` / `likes` / `retweets` | 来源快照中的非负整数；缺失为 `null` |
| `total_engagement` | `likes + retweets + replies + quotes + bookmarks`，只累加已提供的非负整数；全部缺失为 `null` |
| `engagement_rate` | `total_engagement / views`，仅当 `views > 0` 且总互动可用时计算；否则 `null` |

`rankSearchResults(items, sortKey)`：

- 主指标**降序**；主指标缺失的结果排在可用结果之后（稳定次序）；
- 主指标相同时按 `published_at`（缺失后置，较新在前）、完整来源身份
  （`source_url → external_id → content_sha256` 字典序）稳定决序；
- 纯函数：不修改输入数组，相同输入永远产生相同输出；
- 只接受 `P32_SEARCH_SORT_KEYS`（views/likes/retweets/total_engagement/engagement_rate）；
- UI 明确说明这是**本地展示口径，不是 X 官方热门榜**。

## 批量导入（导入前整批验证 + 离线单次原子保存）

`importSearchSelection({ project, batch, selectedIds, nowMs, skipAlreadyImported })`：

1. **批次重验证**（任一条失败整批拒绝，当前项目完全不变）：
   - 项目 ID：批次绑定的 `project_id` 必须等于当前项目（切换项目即失效）；
   - 批次 ID：`batch_id` 必须匹配 `p32-search-<24hex>`，**且必须与内容重算一致**——
     客户端按服务端同一规范形式重算批次身份（绑定精确关键词、数量、排序意图、
     采集运行、采集时间与全部结果的（URL|外部 ID|正文哈希）有序身份集合），
     只验证正则形状绝不通过：结果乱序、正文哈希被篡改、关键词/数量/排序/采集
     时间/采集运行被错改都会产生不同身份 → `P32_BATCH_INVALID` 整批失败关闭；
   - 结果身份：每条选择必须存在于当前批次（乱序/过期/被替换即失败）；
   - 正文 hash：重算 `sha256(content_text)` 与 `content_sha256` 一致（篡改即失败）；
   - collection proof：格式 `<expires>.<64hex>` 且未过期；
   - 媒体与来源快照：P29 有界形状校验；
   - 数量：1–5 条；选择内无重复 id、无重复来源三元组（URL/外部 ID/hash）。
2. **重复来源检查**（严格模式，`skipAlreadyImported: false` 缺省）：与项目内既有证据的
   canonical source URL / external ID / content hash 任一相同即 `P32_ALREADY_IMPORTED`
   整批失败关闭（已导入的来源在 UI 中标记并禁用勾选）。
3. **幂等重试模式**（`skipAlreadyImported: true`，在线模式使用）：同一选择重试时
   已导入身份跳过并计入 `alreadyImported`，只写入尚未导入的身份，绝不产生重复
   Evidence；全部已导入时 `imported = 0` 且不写任何记录。
4. **工作区原子保存**：`addEvidenceBatch` 全部输入先按单条相同规则构建并校验，
   全部有效才一次性保存并递增一次版本；批次内重复身份或与已有证据身份冲突整批失败。
5. 不自动批准 Brief、不自动路由、不生成、不发布；四项执行标志恒为 false。

### 在线批次部分失败（确定性契约）

在线模式不具备远端跨命令事务原子性，准确表述为**「导入前整批验证 + 失败后
权威重载 + 幂等续传」**：前端先预验证全部所选，再逐条执行确定性幂等命令：

- 任一步失败时**立即重载权威项目**，并以重载后的权威 Evidence 与原始选择的
  URL/external_id/content hash 身份**重新对账** imported/pending/pending_ids
  —— 响应丢失但写入已成功的情况绝不误报为待重试；返回结构化
  `P32_ONLINE_BATCH_PARTIAL`（`details: { imported: 已确认导入数量, pending: 待重试数量, pending_ids: 剩余身份 }`），
  UI 精确显示「已确认 N 条成功、剩余 M 条尚未导入」及待重试身份，**绝不把部分结果展示为全成功**；
- 重试同一选择利用服务端 Evidence 身份幂等（`skipAlreadyImported`），只写入
  尚未导入的身份，不产生重复记录，最终完整导入；
- 离线分支保持真正单次原子保存（`addEvidenceBatch` 一次写入、一次版本递增）。

### 瞬态状态隔离

- 搜索结果批次与选择由页面持有（内存态）：**切换项目、重新搜索或刷新后立即清空**，
  旧选择绝不会导入其他项目；
- 导入成功后保留结果批次（用于「已导入」标记），只清空选择，并滚动/聚焦到 Evidence 列表。

## 修改文件

| 文件 | 变更 |
|------|------|
| `supabase/functions/p22-research-assist/assist-core.mjs` | `search` 动作解析、`isUrlLikeKeyword`、`assertUniqueSearchResults`、`searchBatchId`、`normalizeCollectedItems` maxItems 选项、`runApifyCollectionSequence` hardMax |
| `supabase/functions/p22-research-assist/index.ts` | search 动作服务端构造 Actor 输入并返回批次身份 |
| `src/services/p22-research-assist.js` | `search` 客户端动作、排序纯函数、`recomputeSearchBatchId` 批次身份重算、批次重验证、`importSearchSelection`（含幂等重试 `skipAlreadyImported`）、`findConflictingEvidence` |
| `src/services/p19-workspace-service.js` | `buildEvidenceRecord` 提取、`addEvidenceBatch` 原子批量保存 |
| `src/components/integrated-workspace/P19WorkbenchPanels.jsx` | `P32HotTopicSearchPanel`（页面级 P32 导入错误镜像：版本重挂载后部分失败计数仍精确可见） |
| `src/pages/ResearchWorkspacePage.jsx` | 瞬态搜索状态、`handleImportHotSearch`（在线部分失败 `P32_ONLINE_BATCH_PARTIAL`：权威重载 + URL/external_id/content hash 身份对账 + 幂等重试）、面板集成、导入后滚动/聚焦 |
| `src/pages/ResearchWorkspacePage.css` | P32-B 样式（~200 行） |
| `test/p32-hot-topic-search.test.mjs` | 单元/对抗性测试（排序严格 external_id、批次身份重算绑定、在线幂等重试） |
| `test/p32-hot-topic-search.browser.test.mjs` | 真实生产构建浏览器验收（含在线批次部分失败确定性场景） |

## 安全边界

- 搜索不接受任意链接为关键词；Actor 输入由服务端构造并绑定精确关键词/平台/数量/排序意图；
- 结果内 source URL / ID / 正文哈希重复即整批失败关闭；
- 缺失互动指标保留 `null`，绝不伪造为 0；
- 批量导入任一无效整批失败，当前项目完全不变；
- 搜索批次身份与内容重算绑定（关键词/数量/排序/运行/时间/有序结果身份），
  只验证正则形状绝不通过；乱序、篡改、错绑一律 `P32_BATCH_INVALID` 失败关闭；
- 已导入来源（同 URL / 外部 ID / 正文哈希）禁止重复导入；在线部分失败后同一
  选择重试幂等（只写入缺失身份，不产生重复 Evidence），绝不展示为全成功；
- 项目切换、重新搜索、刷新后旧选择立即失效；
- 不自动批准 Brief、不自动路由、不生成、不发布；四项执行标志恒为 false；
- 搜索/排序/选择操作绝不修改项目或证据指纹。

## 兼容性

- P22 单帖 URL 读取、P32-A Qwen 重新分析（版本化追加）、多帖比较全部保留；
- 单帖/普通采集路径（`collect`/`collect_url`）的 Actor 输入与限制不变（`collect` 仍为 5 条）；
- `normalizeCollectedItems` / `runApifyCollectionSequence` 的新参数带缺省值，向后兼容。
