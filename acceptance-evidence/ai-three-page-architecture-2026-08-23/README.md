# 三页任务架构验收证据（真实浏览器）

- 日期：2026-08-23；本地 dev server（vite）+ headless Edge（CDP）。
- 数据来源调用链（唯一真实来源）：
  1. 浏览器 → http://127.0.0.1:1545/ai-marketing-studio/#/ai（新任务首页）：harnessClient.plan/confirm → fake edge（镜像 harness-command 契约）→ 任务创建与人工确认；
  2. #/ai-execution/<taskId>（任务执行详情页）：harnessClient.read(<taskId>) → 任务/计划/step_states（进度、失败、attempts=failed_count）；
  3. #/ai-results/<taskId>（任务结果与审核页）：harnessClient.read(<taskId>) → result.final_response / artifact_refs（来源链）/ confirmation（审核范围）。
- 演示任务编号：ht-3d6d7845-70fa-4a3d-967f-08f9682085f8（成功）、ht-483eb5b8-adac-4be9-8ae2-bd5a8015438b（失败）。
- 截图对应路由：execution-detail-1440 → #/ai-execution/ht-3d6d7845-70fa-4a3d-967f-08f9682085f8；results-* → #/ai-results/ht-3d6d7845-70fa-4a3d-967f-08f9682085f8；
  execution-failed-1440 → #/ai-execution/ht-483eb5b8-adac-4be9-8ae2-bd5a8015438b；home-1440 → #/ai。
- 零付费证明：fake edge 只做内存状态推进（plan×2 / confirm×2），全程零真实 Provider/付费调用、零 production 访问、零 Secret 输出。
- 无新增 mock 进入产品运行时：fake edge 仅在本浏览器测试进程注入，产品代码只走真实 harness-command 读取适配。
