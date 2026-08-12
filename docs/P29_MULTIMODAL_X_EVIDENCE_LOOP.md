# P29 多模态 X 帖子证据闭环

分支：`codex/p20-pages-release`（基线 `9106b96`）。范围：一条粘贴的公开 X 帖子链接 →
读取完整有界帖子记录（正文、作者、发布时间、互动、全部图片/视频）→ 真实媒体预览 →
完整性绑定的多模态 Evidence → 一次真实多模态 Qwen 分析 → 知识卡 → 纯语言可审核 Brief。

## 一、Actor 规范化（assist-core.mjs）

接受当前官方 `xquik/x-tweet-scraper` 字段：

- 媒体：`media`（对象数组或字符串）、`mediaUrls`、`imageUrls`、`videoUrls`、`gifUrls`
  （数组或单值）；同 URL 去重（保留首次出现顺序）。
- 作者：`author`（对象：name/userName/username/screenName/id/userId/rest_id；或字符串）
  与扁平 `name/handle/username/screenName/authorName/authorHandle/authorUsername/authorId/userId`。
- 时间：`createdAt/created_at/timestamp/date/createdAtDate/publishedAt/tweetDate`（ISO-8601 或 epoch）。
- 互动：`likeCount/likes/favoriteCount`、`retweetCount/retweets`、`replyCount/replies`、
  `quoteCount/quotes`、`viewCount/views/impressionCount`、`bookmarkCount/bookmarks`。

规范化输出：

- `source_metadata = { author: {name,handle,user_id} | null, published_at | null,
  engagement: {likes,retweets,replies,quotes,views,bookmarks} | null }` —— 字段缺省为 null，
  出现但畸形（类型错、负数、超长、不可解析时间）一律硬失败 `SOURCE_METADATA_INVALID`。
- `media_assets` 有序数组（零基）：`id`（`m-<24hex>`，由 推文id+顺序+精确URL 确定性派生）、
  `tweet_id/external_id`（推文绑定）、`canonical_tweet_url`、`media_url`（精确 URL）、
  `order`、`kind`（image/video/gif）、`mime_type`、`dimensions`（可用时）、`byte_size`
  （可验证时）、`hash = {algorithm:'sha256', kind:'url'|'content', value}` —— 哈希种类显式暴露，
  绝不把 URL 字符串哈希冒充内容哈希。
- 媒体数量超过声明上限 `max_media: 8` → 硬失败 `MEDIA_BOUND_EXCEEDED`（绝不静默截断）。

内容 SHA-256 只从严格 X/Twitter CDN 白名单抓取
（`pbs.twimg.com` / `video.twimg.com` / `abs.twimg.com`，仅 HTTPS）：

- 重定向逐跳复验（最多 5 跳），目标必须仍为 HTTPS 白名单主机，否则 `MEDIA_REDIRECT_REJECTED`；
- 强制 `image/*|video/*|audio/*` content-type，否则 `MEDIA_CONTENT_TYPE_REJECTED`；
- 每媒体超时 15s（`MEDIA_FETCH_TIMEOUT`）与 512 MiB 字节上限（`MEDIA_SIZE_OVERFLOW`）；
- 非白名单主机从不抓取：保留 url 哈希完整性记录（不是静默降级，哈希种类如实标注）。

## 二、v3 采集证明（p22_collection_proof_v3）

证明载荷在 v2（正文哈希 + 来源身份 + 采集运行）之上追加：

- 规范化来源快照（作者/时间/互动，canonical JSON）；
- 每条有序媒体的 `[id, URL, order, kind, 算法, 哈希种类, 哈希值]` 绑定。

验证时正文哈希重算；带非空扩展字段（快照或媒体）的条目必须使用 v3；
无扩展字段的存量记录显式接受 v2 证明（v2 域 `p22-collection-proof-v2\0` 固定不变，
历史签名可继续验证）。篡改/删除/乱序/重复/外来媒体、错误推文绑定、快照篡改、
跨用户绑定、过期、混合畸形版本全部 fail closed（`SOURCE_PROOF_INVALID` /
`SOURCE_PROOF_EXPIRED`）。证明字符串仍为 `<expires>.<64hex>`（版本在签名载荷内部）。

## 三、多模态 Qwen 分析（OpenAI 兼容 DashScope 契约）

- 带媒体来源 → `qwen3.5-omni-flash`，消息内容为「来源文本 + 每个已验证媒体 URL
  精确顺序」（图片/GIF 用 `image_url` 部件，视频用 `video_url` 部件）；
- 纯文本来源 → 既有 `qwen-plus` 文本契约（`buildQwenPrompt`/`parseQwenAnalyses` 不变）；
- 带媒体来源绝不静默回退到纯文本分析：analyze 按组拆分，媒体组走多模态契约；
- 响应为严格来源绑定 JSON：`text_expression`、逐媒体 `media_analysis`
  （`visual_content/composition/people/scene/emotion`，每项精确绑定 `media_id`）、
  `virality_drivers`、`reusable_methods`、`signals`、`risks`；
- 逐媒体结果必须与来源媒体按**精确顺序一一对应** —— 缺失、重复、乱序、外来、多余
  id 一律 `MODEL_MEDIA_BINDING_INVALID` 失败关闭；
- 每组合独立记录有界费用；`usage.total_tokens` 必须为正整数。

## 四、持久化（无数据库迁移）

数据库边界 `p19_analyses_v1.kind` 约束为 `deterministic_local` 且本次任务禁止
schema 变更，因此多模态分析以**显式版本化扩展**持久化：

- 分析记录 `kind` 保持 `deterministic_local`，新增可选
  `model_analysis`（`p29_multimodal_model_v1`）：`provider: dashscope`、
  `model: qwen3.5-omni-flash`、`method: multimodal_model`、`executed_at`、
  有序 `media_ids`、`result`（**精确的服务端返回结果**，含逐媒体视觉发现）、
  `usage.total_tokens`；
- `provenance.model` 必须与扩展模型标识精确一致（保留模型/来源身份）；
- 确定性规则仅作补充（`result.rules`）；纯确定性分析（无 `model_analysis`）契约不变，
  旧记录显式接受；
- 证据记录新增可选 `source_metadata` / `media_assets`（缺省 = 旧记录）；
  知识卡新增可选 `analysis_provenance`（方法/模型/执行时间/来源分析/媒体绑定）；
  Brief 新增可选 `analysis_provenance` 与 `multimodal_findings`（纯语言发现，
  ≤10 条 × 240 字，来自绑定保存的多模态结果）；
- 同正文身份绑定不同来源快照/媒体 → `EVIDENCE_IDENTITY_CONFLICT` 失败关闭；
- 幂等重放、同一来源/新版本、用户/项目隔离、乐观修订守卫、深克隆隔离、四项执行
  标志恒 false 全部保持。

## 五、UI

- 来源卡：作者 + 句柄 + 平台 + 发布时间 + 有界互动计数 + 响应式有序媒体画廊
  （真实媒体 URL 的 `<img>`/`<video>` 节点）；「预览未保存」与「已保存为证据」明确区分；
  正文只出现一次（去除短帖标题/正文重复）；
- 主操作改名「保存图文证据并生成分析」：一次点击保存精确来源 → 运行/取得多模态
  分析 → 持久化 Evidence → Analysis → Knowledge Card → 可审核 Brief，部分持久化或
  刷新后可幂等恢复（「继续生成分析并完成草案」）；
- Brief 区改为纯语言「内容策划草案（待你确认）」：证据/媒体计数、系统结论
  （多模态发现）、批准后能做什么（仅进入交接包，不生成/不路由/不发布）；
  按钮语义明确：重新生成草案 / 批准草案 / 退回修改；技术 id/来源绑定折叠进
  次级「查看技术细节」。

## 六、兼容性与边界

- P19/P20/P22/P23/P24 合同保持：证据/分析/知识卡/Brief/交接包校验器只做版本化
  扩展，缺省字段的存量记录显式接受，畸形混版本 fail closed；
- 已验收禁止词（看起来像/应该是/大概有）不得进入知识卡断言（清洗进 uncertainties）；
- 媒体加载/分析失败显示有界消息并保留可恢复部分状态；绝无假占位图充当证据；
- 不引入数据库迁移、不触碰 Auth/RLS/GRANT/Storage/密钥、无 Git 提交/部署、
  无生成/路由/任务/发布。

## 七、验证

- `test/p29-multimodal-x-evidence.test.mjs`：双图/四图/视频/纯文本/混合字段形状、
  重复与越界媒体、错误推文绑定、非白名单与重定向主机、MIME/大小/超时失败、
  哈希篡改、证明过期、畸形作者/时间/互动、模型媒体 id 缺失/重复/乱序/外来、
  部分持久化重放、跨项目污染、深拷贝突变、v2 存量证明兼容；
- `test/p29-multimodal-x-evidence.browser.test.mjs`：生产 React 页面 + 示例链接
  `https://x.com/example/status/2087047011753467912` 双图夹具 → 恰好两个真实媒体
  节点按顺序渲染（字节真实加载）→ 保存 → 硬刷新 → Evidence/Knowledge/Brief 的
  媒体、哈希、分析身份一致；模型请求携带两条精确 URL（按顺序）；持久化知识卡与
  Brief 包含返回的视觉发现而非本地文本替代；
- 既有 P19/P20/P22/P23/P24 聚焦套件、迁移检查、lint、typecheck、生产构建全绿；
- 执行器测试零真实网络/模型调用；staging 部署与最终付费 canary 由 MASTER 执行。
