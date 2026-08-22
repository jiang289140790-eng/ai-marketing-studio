# 三页任务架构验收证据（真实浏览器）

- 日期：2026-08-23；本地 dev server（vite）+ headless Edge（CDP）。
- 浏览器测试数据源/契约模拟（fake edge，非真实服务端）：
  1. 浏览器 → #/ai（新任务首页，本地 vite dev server）：harnessClient.plan/confirm → fake edge（镜像 harness-command 契约，仅本测试进程注入）→ 任务创建与人工确认；
  2. #/ai-execution/<taskId>（任务执行详情页）：harnessClient.read(<taskId>) → 任务/计划/step_states（进度、失败、attempts=failed_count）；
  3. #/ai-results/<taskId>（任务结果与审核页）：harnessClient.read(<taskId>) → result.final_response / artifact_refs（来源链）/ confirmation（审核范围）。
- 证明范围：UI、精确 taskId 路由、硬刷新恢复、失败态、非法/不存在编号错误态与响应式（390px 无横向溢出）。
- 真实运行时数据来源：Supabase harness-command（生产 edge）；真实服务端/线上验收仍待部署后验证，本证据不构成真实服务端成功证据。
- 演示任务编号：ht-00000000-0000-4000-8000-000000000001（成功）、ht-00000000-0000-4000-8000-000000000002（失败）。
- 截图对应路由：execution-detail-1440 → #/ai-execution/ht-00000000-0000-4000-8000-000000000001；results-* → #/ai-results/ht-00000000-0000-4000-8000-000000000001；
  execution-failed-1440 → #/ai-execution/ht-00000000-0000-4000-8000-000000000002；home-1440 → #/ai。
- 零付费证明：fake edge 只做内存状态推进（plan×2 / confirm×2），全程零真实 Provider/付费调用、零 production 访问、零 Secret 输出。
- 无新增 mock 进入产品运行时：fake edge 仅在本浏览器测试进程注入，产品代码只走真实 harness-command 读取适配。
