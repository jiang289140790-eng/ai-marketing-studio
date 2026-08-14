# 工程基线（M1：工程基线与数据库可重建）

本文件记录唯一候选发布工作树、基线/候选提交、完整验收命令与结果、迁移可重建
证据、脏主目录禁用说明与回滚方法。**本文件不声称任何部署已发生，也不声称
staging/production 已被修改**；本任务全程仅本地操作。

## 唯一候选发布工作树

- 工作树：`E:\projects\_p38_legacy_video_rehydrate`
- 权威业务基线：`77aab8f2f7c0b8228718c7c205800ac17ea1d339`（与 `origin/main`
  一致）
- 候选提交：`codex/m1-engineering-baseline` 分支上的 M1 提交（见下文「提交」），
  未 push。

> ⚠️ 脏主目录禁用：`E:\projects\ai-marketing-studio` 位于陈旧分支且有大量
> 用户未提交内容，**禁止**读取后覆盖、清理、合并、重置或作为本任务发布来源。
> 任何发布/合并操作必须以本工作树（`_p38_legacy_video_rehydrate`）为唯一来源。

## 稳定合同（测试基础设施）

以下合同为 M1 测试基础设施的稳定契约，测试文件与调度器必须持续遵守：

1. **统一 CDP 浏览器测试工具**（`test/helpers/cdp-browser-harness.mjs`）：
   - 主 frame 导航提交的准确等待（`Page.frameNavigated` 计数；提交前旧文档仍可
     被 evaluate 命中，提交后才等新文档 `readyState=complete`）；
   - 当前文档 URL/origin、`document.readyState` 与目标 DOM 挂载的有界等待；
   - 目标元素存在、可见（适用时）、未 disabled 且可操作后才点击（单次 evaluate
     内完成查找 + 校验 + 点击，避免跨 evaluate 的过期引用）；
   - 有界失败诊断：URL、readyState、目标 selector、按钮摘要、正文短片段、
     最后异常（全部限长，绝不输出无界正文）；
   - Edge 主进程及整个进程树（含孤儿 crashpad/utility 子进程）的确定性关闭：
     `taskkill /PID <pid> /T /F` + 按本次 profile 路径精确兜底清理 + 零残留等待；
   - 只删除本次创建且路径经过校验的独立临时 profile（`makeTempProfile` /
     `removeTempProfile` 双重校验）。
2. **浏览器/构建类测试逐文件串行**：`scripts/run-tests.mjs` 枚举
   `test/*.test.mjs` 全量集合（排序、确定性、漏跑即失败）；浏览器/构建类
   （源码含 `msedge.exe` / `vite.js` / `npm run dev`）逐个串行执行，每个文件
   独立子进程、独立资源；普通测试并行执行；子进程超时或退出时确定性清理其
   整个进程树，不得影响下一测试；不得通过整文件重试获得绿色。
3. **禁止固定 sleep 掩盖竞态**、无限等待、整测试重试、放宽断言、吞错、跳过、
   改为 warning 或修改生产逻辑。

## 完整验收命令

以下命令即 M1 本地验收入口。本任务按序全部实际执行；五次定向浏览器测试
矩阵、两轮完整 `npm test` 逐文件矩阵、迁移回放与工程门禁的逐项结果与最终
提交哈希记录于完成报告
（`orchestration/results/ams-m1-browser-infrastructure-final-consolidated-closure-completion.md`），
不在本文件预测提交后结果：

| # | 命令 |
|---|------|
| 1 | 浏览器集合（`test/p20-browser-online.test.mjs`、`test/p29-multimodal-x-evidence.browser.test.mjs`、`test/p32-multipost-synthesis-brief.browser.test.mjs`、`test/content-creation-modes.browser.test.mjs`，连续五次，同轮串行，每轮全部通过、0 skipped，每轮后零 Edge 进程/临时目录残留） |
| 2 | `node --test test/p19-sql-integration.test.mjs`（PostgreSQL 17 顺序重放全部 45 项迁移并通过 SQL 测试） |
| 3 | `npm run migrations:check` |
| 4 | `npm run lint` |
| 5 | `npm run typecheck` |
| 6 | `npm run build` |
| 7 | `npm test`（最终提交后第 1 轮：49 个测试文件、619 条测试、0 fail、0 skipped，零残留） |
| 8 | `npm test`（最终提交后第 2 轮：同上） |

前置基础设施：Docker 容器 `supabase_db_p19-op-workbench`
（`public.ecr.aws/supabase/postgres:17.6.1.147`，PostgreSQL 17；实跑时
Docker 容器运行中）。容器或 Docker 缺失时，
`p19-sql-integration.test.mjs` **必须失败并给出明确基础设施错误**，不得把
M1 判为通过。

## 迁移可重建证据

- 全部 45 项迁移在隔离的全新数据库上按顺序回放成功（数据库
  `p19_verify_<pid>` 每次新建，finally 中精确 dropdb 清理）。
- 回放起点 bootstrap 仅复刻已验收环境（`storage` / `auth` / `extensions` /
  `graphql_public` / `vault` 架构与扩展），不构成迁移变更。
- P17-A4 函数漂移门禁改为跨 PostgreSQL 17 环境稳定的语义合同比较
  （见 `supabase/migrations/20260810143859_p17_reconcile_out_of_band_foundations.sql`）：
  - 比较：签名、返回类型、语言、security definer、leakproof、volatility、
    parallel、显式 `search_path`（规范化）、函数体（注释/大小写/空白规范化）、
    权限合同（postgres/anon/authenticated/service_role/PUBLIC 可 EXECUTE）。
  - 不比较（环境噪声，有意排除）：owner 名、ACL grantor、格式表示。
  - 失败关闭：函数缺失、未显式设置 search_path、额外 GUC 设置、
    EXECUTE 被撤销、函数体/签名/返回类型等任何被比较属性漂移 → 迁移中止。
  - 正反对抗测试 `supabase/tests/p17_b2_function_contract_guard.test.sql`：
    等价格式差异通过；函数体 / search_path / security definer / volatility /
    额外设置 / 权限合同 / 签名 / 返回类型漂移全部失败关闭。

## 提交

- 本地分支：`codex/m1-engineering-baseline`（自基线 `77aab8f…` 创建，未 push；
  最终提交哈希见完成报告）。
- 提交仅包含本任务授权文件（既有 M1 文件 + 浏览器基础设施收口授权文件，
  共 12 个）：
  - `package.json`
  - `supabase/migrations/20260810143859_p17_reconcile_out_of_band_foundations.sql`
  - `supabase/tests/p17_b2_function_contract_guard.test.sql`
  - `supabase/tests/p22_atomic_daily_budget.test.sql`
  - `test/p19-sql-integration.test.mjs`
  - `test/p29-multimodal-x-evidence.browser.test.mjs`
  - `scripts/run-tests.mjs`
  - `docs/ENGINEERING_BASELINE.md`
  - `test/p20-browser-online.test.mjs`（本次收口授权）
  - `test/p32-multipost-synthesis-brief.browser.test.mjs`（本次收口授权）
  - `test/content-creation-modes.browser.test.mjs`（本次收口授权）
  - `test/helpers/cdp-browser-harness.mjs`（本次收口授权新增）
- 未跟踪协作基础设施（`.agentbridge/`、`AGENTS.md`、`CLAUDE.md`）原样保留，
  不进入提交。

## 回滚到基线

```bash
cd E:\projects\_p38_legacy_video_rehydrate
# 恢复基线上存在、本任务修改过的文件：
git checkout 77aab8f2f7c0b8228718c7c205800ac17ea1d339 -- \
  package.json \
  supabase/migrations/20260810143859_p17_reconcile_out_of_band_foundations.sql \
  supabase/tests/p22_atomic_daily_budget.test.sql \
  test/p19-sql-integration.test.mjs \
  test/p29-multimodal-x-evidence.browser.test.mjs \
  test/p20-browser-online.test.mjs \
  test/p32-multipost-synthesis-brief.browser.test.mjs \
  test/content-creation-modes.browser.test.mjs
# 删除本任务新增、基线上不存在的文件：
git rm -f supabase/tests/p17_b2_function_contract_guard.test.sql \
  scripts/run-tests.mjs docs/ENGINEERING_BASELINE.md \
  test/helpers/cdp-browser-harness.mjs
# 或整体回退到基线提交：
#   git checkout 77aab8f2f7c0b8228718c7c205800ac17ea1d339
```

回滚到基线即恢复原始测试行为（含已复现的浏览器并发争抢问题、P38 刷新时序
竞态与浏览器清理不确定性）；当前工作树除本任务授权文件与既有协作基础设施外
无其他变更。
