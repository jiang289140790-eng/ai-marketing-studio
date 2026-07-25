# USER_JOURNEY_CONSOLIDATION_REPORT

## 验收结论

本轮严格按“一个用户、一个 Campaign、一个自有账号、一个平台、一个角色、一个已批准策略、一个 7 天计划、只处理 Day 1”收口，没有新增 MCP 工具、数据表、业务对象或复杂页面。

当前已经完成：

- 默认锁定 Campaign：`X 媒体优先短内容测试`
- 主账号：X / `@chanchiholeo1`
- 灵感账号：X / `@maisiewzil`
- 角色：`Emma`
- 角色模型：`Emma LoRA`，本次权重 `0.8`
- 已批准策略：`单条 X 短内容生成方案 · Soft Signal`
- 已将原策略的单条计划整理为完整 Day 1—Day 7 计划
- 已将现有内容包 `她不是突然出现的` 修复为 Day 1，并关联 Campaign、策略、主账号、角色和 LoRA
- 已通过线上安全执行网关真实生成 1 个候选文案版本
- 已选择并人工批准该候选文案
- 已真实触发一条 Day 1 安全预演素材任务
- 已部署统一 Campaign 上下文栏、首页五区和 Day 1 渐进式工作台

当前不能判定“全部验收完成”：

- 生产 Supabase 的 `comfy_workflows` 当前没有可用图片工作流，因此素材安全预演被安全规则阻止。
- 没有可批准的真实 Day 1 素材，因此不能继续内容终审、创建 dry-run 发布任务或在发布中心完成对应任务验收。
- 应用内浏览器控制通道出现运行环境路径故障，无法在本轮生成合规的登录后页面截图；下表保留了每一步的真实后台记录和结果，但不能用这些记录冒充页面截图。

## 固定测试对象

| 对象 | 当前值 |
|---|---|
| 用户 | 当前登录用户（生产用户 ID：`a5433366-c3c6-4dc0-9aa7-657383b96f00`） |
| Campaign | `X 媒体优先短内容测试` |
| Campaign ID | `efd3d863-1e6e-4e49-8b87-e95af08f92e8` |
| 主账号 | X / `@chanchiholeo1` |
| 主账号 ID | `72042f69-d129-4310-9f26-1bf85b554275` |
| 灵感账号 | X / `@maisiewzil` |
| 策略 | `单条 X 短内容生成方案 · Soft Signal` |
| 策略 ID | `3335f586-61d0-4faf-9709-c50304d93162` |
| 计划 | Day 1—Day 7，已批准 |
| 当前 Day | Day 1 |
| 内容包 | `Day 1｜她不是突然出现的` |
| 内容包 ID | `56737ea8-5dbd-4d15-8808-8d5eff370d5d` |
| 角色 | Emma |
| 角色 ID | `ea932ba7-bb36-46be-91f1-3470937f2856` |

## 实际用户路径记录

| 步骤 | 页面/动作 | Campaign / Day | 实际状态 | 下一步按钮或动作 | 实际结果 / 证据 |
|---|---|---|---|---|---|
| 1 | 打开指挥中心 | 当前 Campaign / Day 1 | 前端已收口为五个区域 | 进入当前 Day | 线上部署已包含当前 Campaign、当前 Day、待我处理、下一条发布计划、阻塞异常 |
| 2 | 进入当前 Campaign | 当前 Campaign / Day 1 | Campaign 已设为 active | 查看 7 天计划 | 页面默认只显示当前 Campaign；历史/测试 Campaign 进入折叠筛选 |
| 3 | 打开 7 天计划 | 当前 Campaign / Day 1—7 | 7 天计划完整且已批准 | 开始 Day 1 | `strategy_plans.daily_plan` 真实保存 7 天 |
| 4 | 点击 Day 1 | 当前 Campaign / Day 1 | 已关联内容包 | 进入 Day 1 内容生产 | 内容包标题、账号、策略、角色关系已修复 |
| 5 | 生成候选文案 | 当前 Campaign / Day 1 | 已完成 | 选择主版本 | 执行记录 `ef52e10a-419f-4132-819c-fcb75460629f` completed |
| 6 | 人工确认文案 | 当前 Campaign / Day 1 | 已批准 | 进入角色 / LoRA | 主版本 `f208e110-fd6e-4df4-9e48-cf469965ed42`；选择记录 `e28034cf-145d-4c76-a62f-36bf74d23106`、批准记录 `26a54ffe-4f32-4844-b6e2-fd667056dd1f` 均 completed |
| 7 | 角色与 LoRA | 当前 Campaign / Day 1 | Emma / Emma LoRA / 0.8 已关联 | 创建安全预演素材任务 | 关联保存在 Campaign metadata 与 Day 1 image requirements |
| 8 | 创建安全预演素材任务 | 当前 Campaign / Day 1 | 已触发但安全失败 | 配置一个可用图片工作流 | 执行记录 `07294780-0631-45a5-bacb-fd95555e2774` failed；原因 `No active image workflow is available.` |
| 9 | 查看任务回传入口 | 当前 Campaign / Day 1 | 页面入口保留 | 查看生成任务状态 | 后端已有失败记录；因无图片工作流没有可回传素材 |
| 10 | 内容终审入口 | 当前 Campaign / Day 1 | 页面入口保留但被素材条件阻塞 | 先完成素材确认 | 未绕过人工素材确认 |
| 11 | 创建 dry-run 发布任务 | 当前 Campaign / Day 1 | 未执行 | 先取得并批准真实素材 | 按安全状态机阻止提前创建 |
| 12 | 发布中心查看任务 | 当前 Campaign / Day 1 | 无对应任务 | 完成素材后创建 dry-run | 没有伪造发布任务 |

## 界面收口

### 统一 Campaign 上下文栏

以下页面共用同一上下文栏：

- AI 运营指挥中心
- 运营活动与策略（含 7 天计划）
- 内容工作台
- 素材库
- 发布中心
- 数据分析

统一显示：

- 当前运营活动
- 主账号
- 平台
- 当前 Day
- 当前步骤
- 阻塞问题
- 下一步操作

默认 Campaign 固定优先选择 `X 媒体优先短内容测试`。Phase2、Phase7、Phase8、Phase9、debug 等数据默认不进入主选择列表，可通过“历史/测试数据”展开。

### Day 1 渐进式工作台

当前采用七步主线：

1. 计划确认
2. 文案生成与审核
3. 视觉内容生成
4. 素材确认
5. 内容终审
6. 发布准备
7. 已发布与数据

规则：

- 已完成步骤显示“已完成”，可回看。
- 当前步骤唯一展开。
- 后续步骤显示“等待上一步完成”，不可越级。
- 原角色、LoRA、素材、图片、视频、审核和发布能力均保留，没有建立第二套编辑器。

### 指挥中心

首页只保留五个主要业务区：

1. 当前 Campaign
2. 当前 Day 与当前步骤
3. 待我处理
4. 下一条发布计划
5. 阻塞或异常

正常服务连接状态、全局累计统计、历史策略、完整知识列表不再占据首页主区域。

## 部署一致性

| 环境 | 实际用途 | 当前结论 |
|---|---|---|
| `E:/projects/ai-marketing-studio` | 当前前端、Edge Function、Bridge 源码 | 唯一有效前端代码源 |
| `E:/projects/video-generator/command-center` | 历史独立 Command Center 服务 | 不是当前线上前端 |
| `http://localhost:3001/ai-marketing-studio/` | Vite 本地开发环境 | 进程实际从 `E:/projects/ai-marketing-studio` 启动 |
| GitHub Pages | 用户线上站点 | 已部署提交 `1207833824baed02f69e81ca16c2191b1c4843a6` |
| Supabase | 生产项目 | `qtrlymiqohbjvklwegsw` |
| Supabase Edge Function | 登录用户的安全执行网关 | 健康 |
| MCP Runtime Bridge | 阿里云 ECS Docker | 已更新为 `ai-marketing-studio-runtime:acceptance-1207833`，旧镜像保留可回滚 |
| AI Marketing Studio MCP | Bridge 内 stdio MCP | 健康；新动作允许列表已同步 |
| 当前 Codex 直连 MCP | Codex 本地连接 | 仍可能指向历史 Supabase 配置，不能作为线上写入依据 |

## 部署地址与版本

- 线上地址：<https://jiang289140790-eng.github.io/ai-marketing-studio/>
- GitHub Pages workflow：`Deploy GitHub Pages` run `30158978988`
- 部署提交：`1207833824baed02f69e81ca16c2191b1c4843a6`
- 线上主入口 bundle：`assets/index-DKFfrbmw.js`
- 线上内容工作台 bundle：`assets/ContentWorkspacePage-M7U_CjLA.js`

线上静态文件已验证包含：

- 当前 Campaign 默认逻辑
- 历史/测试数据筛选
- Day 1 七步渐进流程
- “等待上一步完成”阻塞文案

## 测试结果

- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run build`：通过
- `npm test`：26/26 通过
- GitHub Pages build/deploy：通过
- Edge Function → Bridge → MCP 健康检查：通过
- 候选文案生成：通过
- 文案选择与人工批准：通过
- 素材安全预演：按钮链路通过，业务执行因无图片工作流安全失败
- dry-run 发布：未执行，避免绕过素材批准条件

## 仍未接通

1. 生产 Supabase 没有 active 图片工作流；根据本任务限制，本轮没有新建工作流。
2. 无真实 Day 1 生成素材，因此素材确认、内容终审和 dry-run 发布仍被阻塞。
3. X MCP 在 Bridge 健康信息中仍为 `unknown`，没有伪装成已连接。
4. 登录后页面截图未完成；原因是应用内浏览器控制运行环境故障，不是页面或登录失败。

## 用户下一步只需要点击什么

先在“工作流与模型配置”中启用一个现有图片工作流，或导入一个已经验证可用的图片工作流。

然后回到：

`内容工作台 → Day 1 → 视觉内容生成 → 创建图片安全预演任务`

素材回传后依次点击：

`确认主素材 → 内容终审 → 创建 dry-run 发布任务 → 发布中心查看预检结果`

