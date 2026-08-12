# P23：公开帖子链接 → Evidence → Knowledge

## 用户路径

1. 在 `#/research` 的“智能找资料”中粘贴一条公开 X 帖子链接。
2. 浏览器只提交规范化 URL；服务端识别平台和帖子 ID。
3. Apify Actor 使用 `startUrls` 且 `maxItems=1`，不再把链接当作搜索词。
4. 服务端只接受唯一匹配该帖子 ID 的返回项，签发有时限的来源证明。
5. 用户预览正文并点击“保存并生成知识卡”。
6. 工作台依次持久化 Evidence、确定性 Analysis 和 `content_knowledge_card_v1`。
7. 任一步中断后，同一来源可继续未完成的下游步骤，不会重复创建 Evidence。

## 当前平台边界

- 可执行：X/Twitter 的具体 `/status/<id>` 链接。
- 可识别但失败关闭：TikTok、Instagram、YouTube、Reddit、LinkedIn。
- 明确拒绝：X 主页、搜索页、列表、自定义端口、含凭据 URL、非 HTTPS URL及未知域名。

## 身份与幂等

P22 Evidence 身份绑定当前项目、provider、规范来源 URL、平台内容 ID 和正文 SHA-256：

- 同一来源、同一正文重复保存返回原 Evidence；
- 相同正文出现在不同来源时保留为独立 Evidence；
- 同一来源正文改变时创建新的不可变 Evidence 版本身份；
- provider 返回零个、多个或错误帖子 ID 时失败关闭。

## 安全与预算

- Apify 最多读取一条精确帖子；仍受每日 ¥10/UTC 原子预算门禁约束。
- Qwen 辅助结果仍是预览；P23 Knowledge 使用既有确定性分析合同。
- 四项执行标志保持 `false`，不生成、不路由、不创建外部执行作业、不发布。
- 前端不接收或显示任何 Secret；生产项目不在本里程碑范围内。

## 验收

- `test/p23-link-evidence-knowledge.test.mjs`：URL 规范化、Actor 输入、精确结果绑定、幂等与 Evidence→Analysis→Knowledge。
- `test/p22-assisted-research.test.mjs`：完整生产页面、真实浏览器 DOM、项目切换隔离及在线三步持久化模拟。
- P19–P23 回归、lint、typecheck、build 与 migration checker 均必须通过；已知 P17 历史迁移指纹问题必须单独归因，不得误报为 P23 产品失败。
