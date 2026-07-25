# DAY1_IMAGE_TO_DRY_RUN_ACCEPTANCE_REPORT

## 当前验收状态

状态：素材已由用户明确确认，内容终审已完成，dry-run 已真实执行；当前被 X OAuth 发布凭证过期阻塞，未执行真实发布。

本轮严格限定为：

- Campaign：X 媒体优先短内容测试
- Campaign ID：`efd3d863-1e6e-4e49-8b87-e95af08f92e8`
- Day：Day 1
- Strategy Plan ID：`3335f586-61d0-4faf-9709-c50304d93162`
- Content Package ID：`56737ea8-5dbd-4d15-8808-8d5eff370d5d`
- Content Item ID：`f208e110-fd6e-4df4-9e48-cf469965ed42`
- Character：Emma
- Character ID：`ea932ba7-bb36-46be-91f1-3470937f2856`
- 输出：1 张图片
- 后续发布模式：`dry_run`

未处理 Day 2—Day 7，未增加视频工作流、数据库表或 MCP 工具，未执行真实外部发布。

## 已完成

### Emma LoRA

- 模型：`emma_s1_sdxl_v01.safetensors`
- 触发词：`emma_s1`
- 基础模型：SDXL 1.0 Base
- 推荐权重：`0.8`
- 训练图片：15 张
- 训练步数：900
- SHA256：`3fe0e798582e1204591d804dc232f36ea784759fcbcb32b9bd20b03dc6eb2db5`
- AutoDL 路径：`/root/ComfyUI/models/loras/Characters/emma_s1_sdxl_v01.safetensors`
- Hugging Face 私有仓库：`dingping2/emma-s1-sdxl-lora-v01`
- 生产角色记录已更新。

### 图片工作流

- Provider：AutoDL / ComfyUI
- Workflow：`emma_s1_sdxl_t2i_v01`
- Workflow ID：`51b2aa68-475e-4aa1-b2c4-de9ff13d7de2`
- 状态：`active`
- 输出尺寸：`832 × 1216`
- 采样器：`dpmpp_2m`
- Scheduler：`karras`
- Steps：`28`
- CFG：`6`
- Seed：`246824`

工作流已经在生产 `comfy_workflows` 中注册，并关联 Day 1 内容包和 Emma 角色。

### 单张真实生成

- ComfyUI Prompt ID：`2cd2caf3-7f5b-40ae-b1ca-b07795a564b9`
- Generation Job ID：`1fb1e5a3-a41d-4c89-b4a3-fde246233323`
- Job 状态：`success`
- 文件：`Emma_S1_LoRA_Test_00001_.png`
- 文件大小：1,258,032 bytes
- 未批量生成。

### 素材回传

- Asset ID：`dab516cd-3dd4-4769-b89e-c0bb078c9732`
- Storage Bucket：`marketing-assets`
- Storage Path：`a5433366-c3c6-4dc0-9aa7-657383b96f00/campaigns/efd3d863-1e6e-4e49-8b87-e95af08f92e8/day-1/emma_s1_day1_00001.png`
- 素材状态：`completed`
- 人工审核状态：`approved`
- `approved_for_publishing`：`true`
- 主素材：`true`
- 用户确认时间：`2026-07-25T14:40:10.526295Z`
- 私有 Signed URL 读取验证：HTTP 200，`image/png`，1,258,032 bytes

生产页面能够依据 `output_storage_path` 为当前登录用户生成临时预览地址。

## 内容终审

- Content Package 状态：`ready_for_publish`
- Content Package 审核状态：`approved`
- 文案：已批准
- 素材：已批准
- 最终素材：`dab516cd-3dd4-4769-b89e-c0bb078c9732`
- 发布状态：`preflight_blocked`

## dry-run 发布验证

- Publish Task ID：`6068fb76-1905-4a48-981c-4d1e8f976187`
- 平台：X
- 任务状态：`draft`
- 审批状态：`pending`
- 执行模式：`dry_run`
- 检查时间：`2026-07-25T14:40:42.456Z`
- 真实外部发布：未执行
- 任务没有被错误标记为 `failed`

通过的检查：

1. 内容已批准；
2. 素材已批准；
3. 账号连接记录存在；
4. 平台格式有效；
5. 素材 URL 有效；
6. 排期有效；
7. 执行模式明确。

未通过的检查：

- 发布权限有效：X OAuth 访问令牌已经过期。系统保存有刷新令牌，但当前权威预检不会在 dry-run 中自动刷新凭证。

下一步需要重新连接 X 账号或安全刷新 OAuth 凭证，然后对同一个 Publish Task 再运行一次 dry-run。不得创建重复任务。

## 页面验收限制

后端对象、私有素材访问和 dry-run 状态已经验证。当前浏览器自动连接组件存在本机运行时路径故障，因此本轮尚未完成登录态页面的自动点击和截图。仍需在用户实际使用的线上页面核对：

1. Day 1 显示回传图片；
2. 素材显示“已确认可用”；
3. 内容终审显示“已批准”；
4. 发布中心显示任务 `6068fb76-1905-4a48-981c-4d1e8f976187`；
5. 当前显示“预检未通过 / 未执行真实发布”，阻塞原因是 X 发布凭证过期，不能显示为发布失败；
6. 重新连接 X 后再次 dry-run，目标状态为“预检通过 / 未执行真实发布”。
