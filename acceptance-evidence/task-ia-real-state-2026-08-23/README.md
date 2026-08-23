# 任务信息架构与真实状态统一验收证据（真实浏览器，契约测试）

- 日期：2026-08-23；本地 dev server（vite）+ headless Edge（CDP）。
- 浏览器测试数据源/契约模拟（fake edge，非真实服务端）：
  1. 浏览器 → /tasks/new（新任务页，本地 vite dev server）：harnessClient.plan/confirm → fake edge（镜像 harness-command 契约，仅本测试进程注入）→ 任务创建与人工确认；
  2. /tasks/<taskId>（任务执行详情页）：harnessClient.read(<taskId>) → 任务/计划/step_states（进度、失败、attempts=failed_count、真实 tool_calls）；
  3. /tasks/<taskId>/results（任务结果与审核页）：harnessClient.read(<taskId>) → result.final_response / artifact_refs（五分类来源链）/ result_data.analyses+artifacts / confirmation（审核范围）。
- 证明范围：三个规范路由应用内跳转与硬刷新恢复（同一 taskId）、新任务真实空状态、
  能力任务不自动成为当前任务、执行详情步骤/工具调用/时间/错误的真实来源与明确空态、
  结果页五分类（Evidence/Analysis/Knowledge/Brief/Artifact）真实来源与逐类空态、
  导航 DOM 唯一性契约、非法/不存在编号错误态、390px 无横向溢出。
- 真实运行时数据来源：Supabase harness-command（生产 edge）；真实服务端/线上验收仍待部署后验证，
  本证据是注入 fake edge 的契约测试，不构成真实服务端成功证据。
- 演示任务编号：ht-00000000-0000-4000-8000-000000000001（成功）、ht-00000000-0000-4000-8000-000000000002（能力查询）、
  ht-00000000-0000-4000-8000-000000000003（失败）。
- 截图对应规范路由：task-new-1440 → /tasks/new；task-execution-1440 → /tasks/ht-…001；
  task-results-1440 → /tasks/ht-…001/results；task-execution-failed-1440 → /tasks/ht-…002。
- 零付费证明：fake edge 只做内存状态推进（plan×3 / confirm×3），全程零真实 Provider/付费调用、零 production 访问、零 Secret 输出。
- 无新增 mock 进入产品运行时：fake edge 仅在本浏览器测试进程注入，产品代码只走真实 harness-command 读取适配。
