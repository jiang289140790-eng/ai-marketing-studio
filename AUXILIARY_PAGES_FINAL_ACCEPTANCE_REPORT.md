# AUXILIARY_PAGES_FINAL_ACCEPTANCE_REPORT

## 验收结论

本轮已完成代码、生产数据库、Supabase Edge Function、GitHub Pages 构建产物和公网地址的一致性核对，并已将辅助页面改造部署到线上。

但是，本轮**不能标记为全部验收完成**，原因有两项：

1. 登录态浏览器控制运行时无法启动，无法完成逐页真实点击、响应式尺寸检查和新版页面截图。
2. 公网 MCP Bridge 的 `/health` 探测超时；X OAuth 记录也已过期并由后端明确标记为未连接。

本报告不会用构建通过替代真实用户路径验收，也不会伪造截图。

## 部署一致性

| 对象 | 实际值 | 结果 |
| --- | --- | --- |
| 本地项目 | `E:/projects/ai-marketing-studio` | 已确认 |
| GitHub 仓库 | `jiang289140790-eng/ai-marketing-studio` | 已确认 |
| 默认分支 | `main` | 已确认 |
| 本轮部署 Commit | `68ea2229a3a815501c5a60e36effbce0c96af403` | 已推送 |
| GitHub Pages | `https://jiang289140790-eng.github.io/ai-marketing-studio/` | HTTP 200 |
| Pages 工作流 | `Deploy GitHub Pages`，运行 `30165112809` | build、deploy 均成功 |
| 线上主资源 | `assets/index-D1lEXG9M.js` | HTTP 200，更新时间 2026-07-25 16:11:33 UTC |
| Supabase 项目 | `qtrlymiqohbjvklwegsw` | ACTIVE_HEALTHY |
| MCP Bridge | `https://bridge.47-251-244-196.sslip.io` | 本轮 `/health` 超时 |

线上主脚本和按页面拆分的资源已经确认包含新版导航、内容计划、生成任务、AI 复盘、知识治理、平台连接和运行健康页面，不是旧 CDN 资源。

## Edge Function 版本

| Function | 版本 | 状态 | JWT |
| --- | ---: | --- | --- |
| platform | 15 | ACTIVE | Edge 配置为 false；函数自身安全逻辑需单独复核 |
| ops-execute | 7 | ACTIVE | true |
| ops-status | 5 | ACTIVE | true |
| ops-health | 5 | ACTIVE | true |
| ai-gateway | 1 | ACTIVE | true |

本轮未修改 Edge Function、Secrets、RLS 或数据库结构。

## 最终导航

线上构建产物已验证包含以下导航：

- 总览
  - AI 运营指挥中心
- AI 运营
  - 运营活动
  - 内容计划
  - 内容工作台
  - 内容情报
  - 发布中心
- 资产中心
  - 账号矩阵
  - 角色库
  - 素材库
  - 生成任务
  - 提示词库
- 智能分析
  - 数据分析
  - AI 复盘
  - 运营日报
  - 知识库
- 系统
  - 平台连接
  - 工作流与模型
  - 系统状态

旧 `#/aiworks` 路由继续兼容跳转到“生成任务”。

“内容计划”复用现有运营活动与策略页面中的 `strategy_plans.daily_plan` 和 7 天计划区域，没有新建平行页面或新数据体系。

## 固定验收对象

| 对象 | 实际记录 |
| --- | --- |
| Campaign | `X 媒体优先短内容测试` |
| Campaign ID | `efd3d863-1e6e-4e49-8b87-e95af08f92e8` |
| Campaign 状态 | active |
| 主账号 | `@chanchiholeo1`，X，自有账号 |
| 主账号 API 字段 | connected |
| 灵感账号 | `@maisiewzil` |
| 策略 | `单条 X 短内容生成方案 · Soft Signal` |
| 策略状态 | approved |
| daily_plan | 7 天 |
| Day 1 内容包 | `她不是突然出现的` |
| 内容状态 | ready_for_publish / approved |
| 角色 | Emma |
| 角色 ID | `ea932ba7-bb36-46be-91f1-3470937f2856` |
| LoRA | Emma S1 SDXL LoRA |
| 触发词 / 权重 | `emma_s1` / 0.8，范围 0.7–0.9 |
| 工作流 | `emma_s1_sdxl_t2i_v01` |
| 工作流状态 | active，image，SDXL |
| Day 1 素材 | `dab516cd-3dd4-4769-b89e-c0bb078c9732` |
| 素材状态 | completed，approved_for_publishing = true |
| 生成 Provider | AutoDL |
| 生成记录 | `1fb1e5a3-a41d-4c89-b4a3-fde246233323`，success |
| 提示词模板 | `Emma · 社交图片生成模板` |

## 逐页验收结果

| 页面 | 数据/代码验收 | 登录态点击验收 | 结论 |
| --- | --- | --- | --- |
| 账号矩阵 | 当前 Campaign 范围与测试数据分类逻辑已测试；主账号和灵感账号关系真实 | 未完成 | 部分通过 |
| 角色库 | Emma 的 LoRA、触发词、权重、SDXL 工作流均由生产数据确认 | 未完成 | 部分通过 |
| 素材库 | 当前 Campaign/Day 过滤代码已测试；Day 1 已批准图片真实存在；技术文件名会转换为业务名称 | 未完成 | 部分通过 |
| 生成任务 | 当前 Campaign 成功运行记录真实存在；页面包含查看结果、回传、重试和技术详情入口 | 未完成 | 部分通过 |
| 提示词库 | Emma 图片模板真实存在并绑定角色 | 未完成 | 部分通过 |
| 平台连接 | 页面只显示平台摘要；凭据字段脱敏 | 未完成 | **真实状态异常** |
| 工作流与模型 | Emma SDXL 工作流真实为 active，LoRA 映射正确 | 未完成 | 部分通过 |
| 数据分析 | 不可用指标映射为“平台暂不提供”，有测试覆盖 | 未完成 | 部分通过 |
| AI 复盘 | 无发布指标时显示阻塞而不是无关测试 Memory，有测试覆盖 | 未完成 | 部分通过 |
| 运营日报 | 已具备执行摘要与当前 Campaign 范围逻辑 | 未执行生成按钮 | 待页面验收 |
| 知识库 | Asset、Generation Job、Phase 测试记录默认不进入普通列表，有测试覆盖 | 未完成 | 部分通过 |
| 系统状态 | 11 项核心服务、时间范围、完成率和异常脱敏已实现并测试 | 未完成 | Bridge 异常待处理 |

## X 平台真实状态

生产库存在一条绑定主账号的 X 连接记录：

- 旧文本状态：connected
- `is_connected`：false
- Token 到期时间：2026-07-20 14:31:02 UTC
- 最近验证时间：空

因此该连接不能继续显示为“可发布”。本轮已修正判断规则：

- 后端明确给出 `is_connected = false` 时，页面显示未连接；
- Token 显示已过期；
- 读取和发布能力显示未连接；
- X MCP 单独依据执行网关实时状态显示，不再用 OAuth 文本状态代替。

当前需要重新完成 X OAuth 验证后，才能继续正式读取、发布或指标回收。

## MCP Bridge 状态

历史部署记录指向：

`https://bridge.47-251-244-196.sslip.io`

本轮公网 `/health` 请求超时，因此不能声明 Bridge 当前健康。由于健康端点使用签名验证，本轮没有绕过安全机制，也没有读取或输出 Bridge Secret。

用户应先检查阿里云 ECS 上：

- `ai-marketing-studio-bridge` 容器是否运行；
- Caddy 是否运行；
- 443 端口是否可达；
- 域名解析是否仍指向当前实例；
- `ops-health` 到 Bridge 的签名健康检查是否成功。

## 响应式和交互

已完成：

- CSS 构建通过；
- 页面路由与懒加载资源构建通过；
- 本地与线上入口均返回 HTTP 200；
- 线上页面资源拆包正常；
- 导航契约测试通过。

未完成：

- 1920 桌面截图；
- 1440 桌面截图；
- 常用笔记本宽度截图；
- 移动端截图；
- 抽屉关闭、筛选刷新、导航激活和刷新后 Campaign 保留的登录态点击录像/截图。

Campaign 选择使用当前用户隔离的 Campaign 查询，并将最近选择保存在当前浏览器 `sessionStorage`；页面刷新仍保留，关闭会话后重新按当前用户和活动 Campaign 选择。`sessionStorage` 不参与数据库权限判断。

## 真实用户路径

计划验收路径：

```text
指挥中心
→ 当前 Campaign
→ Day 1
→ Emma 角色
→ Emma SDXL 工作流
→ 当前素材
→ 生成任务
→ 平台连接
→ 系统状态
→ 内容工作台
```

本轮已通过生产数据库和线上构建资源逐项确认对象存在，但由于登录态浏览器控制运行时启动失败，尚未完成真实点击记录。

浏览器运行时错误：

```text
failed to write kernel assets: 系统找不到指定的路径。 (os error 3)
```

## 页面截图

本轮没有可交付的新版截图。原因是浏览器控制运行时在执行任何页面操作前即失败。旧截图不能证明当前 Commit 的页面状态，因此没有拿旧图充当验收证据。

## 自动化验证

- `npm test`：通过
- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm run build`：通过
- 本地页面：HTTP 200
- GitHub Pages：HTTP 200
- GitHub Pages build/deploy：成功
- 导航契约：有自动化测试
- 测试数据隐藏、账号矩阵、平台连接、角色可生成性、素材命名、知识治理、分析职责、系统健康：均有模型层测试

## 失败项与尚未完成项

1. 登录态页面逐页点击和截图未完成。
2. 1920、1440、笔记本、移动端视觉验收未完成。
3. X OAuth 已过期且 `is_connected = false`。
4. MCP Bridge `/health` 本轮公网探测超时。
5. 运营日报“生成执行摘要”按钮未做真实登录态点击。
6. 不能声明 X 发布、指标回收和完整 MCP 自动化当前可用。

## 回滚方式

部署前线上 Commit：

`a307f0510970706f5a0d4919a8c28b4d1659185a`

本轮部署 Commit：

`68ea2229a3a815501c5a60e36effbce0c96af403`

若需要回滚，应在 Git 中创建对本轮 Commit 的 revert，再推送到 `main`，让 GitHub Pages 重新部署。不要重写远端历史，也不要删除生产数据。

本轮没有数据库结构、RLS、Secrets、MCP 工具或工作流变更，因此回滚只涉及前端和服务层代码。

## 用户当前操作指南

在真实页面验收恢复前，用户当前只需要处理两件事：

1. 恢复公网 MCP Bridge，让系统状态页的 Bridge 健康检查通过；
2. 重新连接 X OAuth，让平台连接页显示 Token 有效、连接可用。

完成后，从线上站点进入：

```text
AI 运营指挥中心
→ X 媒体优先短内容测试
→ 内容工作台
→ Day 1
```

再依次查看 Emma、素材、生成任务、平台连接和系统状态。

