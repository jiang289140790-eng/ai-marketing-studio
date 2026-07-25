# DAY1_PUBLISHING_CLOSED_LOOP_REPORT

## 结论

第一阶段选择 **Telegram**。发布中心、线上安全执行网关、AI Marketing Studio MCP、Supabase 发布任务、Telegram Edge Function 和审计记录已经形成单平台 Day 1 闭环。

真实外部发布没有执行。当前测试任务停留在人工批准之前，符合“未经用户明确批准，不得执行真实外部发布”的安全要求。

## 为什么选择 Telegram

- `platform_adapters` 中 Telegram 已标记为 `implemented`。
- Telegram 已声明 `publish`、`metrics`、`webhook` 能力。
- 当前用户存在状态为 `connected` 的 Telegram 平台连接。
- Telegram 凭证使用 `platform_credentials` 中的 Edge Secret 引用，Token 不进入前端、MCP 输出、任务结果或报告。
- X 当前只处于 `prepared`，不作为第一阶段正式发布平台。

## 三个独立状态维度

### 内容审核状态

- `pending`：待审核
- `approved`：已批准
- `needs_revision`：需要修改
- `rejected`：已拒绝

### 发布任务状态

- `draft`：草稿
- `pending_approval`：前端组合状态，数据库中为 `status=draft + approval_status=pending`
- `scheduled`：已排期
- `publishing`：发布中
- `published`：已发布
- `failed`：发布失败
- `cancelled`：已取消

### 执行模式

- `dry_run`：运行完整预检，不调用 Telegram 发布接口。
- `live`：仅在内容、素材、任务、连接、权限、格式、排期、人工授权、安全开关全部通过后执行。

`dry_run` 成功时页面显示：

- 预检通过
- 测试执行完成
- 未执行真实发布

不会再显示为“发布失败”。

## 统一发布前检查

服务端权威预检包含：

1. 内容已批准；
2. 素材已批准；
3. 账号已连接；
4. 发布凭证有效；
5. Telegram 正文为 1—4096 字符；
6. 主素材 URL 为有效 HTTPS；
7. 排期格式有效；
8. 执行模式明确。

`live` 额外检查：

1. 发布任务已批准；
2. 当前操作有明确人工确认；
3. Campaign 的授权模式允许本次操作；
4. `ALLOW_REAL_PUBLISH=true`；
5. Telegram 安全执行器可用。

## 页面调整

发布中心现在按以下入口组织：

- 待处理
- 发布日历
- 已排期
- 发布中
- 已发布
- 失败

主要按钮随状态变化：

- 待批准：运行一次测试预检、批准并排期、退回内容工作台；
- 已排期：修改时间、立即发布、取消；
- 失败：查看安全原因、重试、返回修改；
- 发布中或已发布：刷新平台结果。

页面只显示简洁错误原因、是否可重试、建议操作和错误编号；底层异常只写入审计日志。

## MCP 工具

已新增或完善：

- `create_publish_task`
- `run_publish_preflight`
- `approve_publish_task`
- `schedule_publish_task`
- `execute_publish_task`
- `retry_publish_task`
- `get_publish_result`

保留旧的 `approve_publish` 和 `execute_publish` 作为兼容入口。

`create_publish_task` 已增加幂等检查：同一内容包、同一平台存在未结束任务时返回原任务，不重复创建。

## Day 1 实际验证

### 测试对象

- Campaign：`e7bb6caf-4bc6-459f-addb-aaefcc09bf90`
- Content Package：`85429419-9a27-4726-8026-30712f14da88`
- Approved Asset：`9815bec6-d34e-4a60-848d-e54f3b01d741`
- Telegram Account：`e1ef4d20-0f79-4459-8cbc-4895f66211ee`
- Platform Connection：`f0c4ff62-c48a-4084-aa44-7b580345a312`
- Publish Task：`b2b6047d-1054-4ed9-8c3e-1f436cfcd1d5`

### dry_run 结果

- `create_status`：`existing`（幂等复用同一任务）
- `preflight_status`：`preflight_passed`
- `preflight_passed`：`true`
- `test_execution_completed`：`true`
- `publish_triggered`：`false`
- `approval_status`：`pending`
- `publish_status`：`draft`
- `execution_mode`：`dry_run`
- `external_id`：`null`

### live 发布

- 是否实际执行：**否**
- 原因：用户尚未对该具体发布任务给出明确 live 批准。
- Telegram 平台返回 ID：无。
- 当前下一步：用户在发布中心检查内容和素材后，批准并排期；正式发布时还需再次勾选人工确认。

## 状态变化

```text
Day 1 内容已批准
→ 主素材已批准
→ 创建发布任务（draft / pending）
→ dry_run 权威预检通过
→ 测试执行完成，未触发平台发布
→ 等待人工批准
→ [未执行] scheduled
→ [未执行] publishing
→ [未执行] published / failed
```

审计日志已记录 `publish_preflight`，其中包含执行模式、预检结果、失败检查项和 `publish_triggered=false`。

## 数据库与线上执行器

- `publish_tasks.campaign_id` 已改为关联现有 `campaigns(id)`，没有创建第二套 Campaign。
- `publish_tasks.status` 已兼容 `cancelled`。
- 没有新增平行发布任务表。
- Telegram Token 继续保存在 Edge Secret；MCP live 执行通过 HMAC 签名委托 `platform` Edge Function，不读取或返回 Token。
- `ops-execute` 已部署为线上第 7 版，保持 JWT 校验。
- `platform` 已部署为线上第 15 版，继续使用自定义 OAuth、Webhook 和内部签名验证。

## 验证结果

- 前端 lint：通过
- 前端 typecheck：通过
- 前端测试：26/26 通过
- 前端 build：通过
- MCP lint：通过
- MCP 核心测试：通过
- MCP build：通过
- MCP 线上健康与工具清单：通过，工具总数 83
- 本地页面 HTTP 可达性：200
- 自动浏览器截图验收：未完成，桌面浏览器控制通道连接失败
- 真实 Telegram live：未执行

## 后续多平台扩展点

复用同一套状态机、预检结构、人工授权和审计协议，仅增加平台适配器：

1. 平台正文和素材限制；
2. 平台授权与凭证有效性检查；
3. 平台发布执行器；
4. 外部 ID 与 URL 解析；
5. 指标回收适配器；
6. 平台特有的可重试错误映射。

第一阶段没有同时改造 X、Instagram、TikTok、YouTube 或 Discord。

## 回滚方式

- 前端发布中心可通过 Git 回退页面、状态工具和样式文件。
- MCP 可回退 Distribution 工具注册与实现。
- Edge Function 可重新部署上一版本代码。
- 数据库只修改了 Campaign 外键和状态检查约束；回滚前必须先确认没有 `cancelled` 任务以及所有 Campaign 引用是否仍兼容旧关系。
- Day 1 测试任务为明确标记的测试对象，可以单独取消；不要删除历史正式发布记录。
