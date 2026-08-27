# Harness 插件注册表

本项目以官方 DeepSeek Harness 作为智能执行核心。AI Marketing Studio 只提供业务工具、业务结果页和资产页，不再额外维护一套用户可见的固定智能路由。

## 已安装插件

| 插件 | 来源 | 用途 | 是否接管 AMS 业务写入 |
| --- | --- | --- | --- |
| `@ams/harness-tools` | 本仓库 | 项目、研究、Evidence、Analysis、Knowledge、Brief、生成、Artifact 等 AMS 业务工具 | 是，业务唯一入口 |
| `@omdsh-dev/dsh-genui` | 已 vendored | 结构化结果、表格、图表、流程展示 | 否 |
| `@dsh-external/dsh-visualize` | 已 vendored | 可视化卡片、图表、交互结果展示 | 否 |
| `dsh-find-plugin` | npm / GitHub 插件生态 | 让 Harness 自己搜索可复用插件 | 否 |
| `dsh-context` | npm / GitHub 插件生态 | 会话上下文、长任务诊断与可观察性 | 否 |
| `dsh-plugin-subagents` | npm / GitHub 插件生态 | 给 Harness 增加 Codex / Claude Code / ACP 子代理能力 | 否 |

## Codex / Claude Code 子代理策略

`dsh-plugin-subagents` 只作为工程协作插件安装，不用于普通营销任务。Harness 只有在用户明确要求“交给 Codex / Claude Code 实现、审查、长任务协作”时才应使用它。

当前配置：

- 最多并发子代理：2
- 输出脱敏：开启
- relay honesty guard：开启
- 默认委派权限上限：readonly

## 不用外部插件替代的 AMS 能力

以下能力必须继续走 `@ams/harness-tools`，因为它们依赖 Supabase staging 数据合同、身份绑定、费用幂等、来源链和业务产物：

- X / Reddit 采集
- Evidence 保存
- Qwen 多模态分析
- Knowledge Card
- Campaign Brief
- 生图 / 视频生成报价、提交、状态、Artifact
- 发布前交接包

## 后续新增插件规则

1. 优先复用官方或成熟社区插件，但只补 Harness 能力，不接管 AMS 业务写入。
2. 每个插件必须固定版本，并进入 `services/harness-gateway/profile*.patch.yml`。
3. 业务写入必须继续通过 `@ams/harness-tools`，不得绕过 Supabase Tool Bridge。
4. 视觉、图表、上下文、插件搜索、子代理这类非业务能力可以使用外部插件。
