# P30 三模式智能内容工作台

## 概述

将内容工作台（`#/workspace`）从硬编码的 Day 1–7 周期生产页面重构为三种独立的内容创建模式，用户在任意时刻只展开一种模式。

## 三模式

| 模式 | 用途 | 默认 |
|---|---|---|
| 快速生成一条 | 输入一句话需求 → AI 自动补全 → 展示主版本与候选 → 修改/保存 | ✅ 默认 |
| 从 Brief 生成 | 选择已批准 Brief → 服务端复验身份/版本/状态/指纹与来源链 → 按完整策略方向生成 → 保存 | |
| 创建周期计划 | 选择 3/7/14/自定义天数与发布频率 → 展开对应 Day 1–N 生产工作台 | |

## 架构

```
src/pages/ContentWorkspacePage.jsx          # 模式切换 + 页面编排（保留旧辅助函数）
src/components/content-workspace/
  ContentCreationModePanel.jsx              # 快速生成 / Brief 生成共用面板
src/services/content-creation-service.js    # Edge Function 调用 + content_library 保存
supabase/functions/p30-content-create/
  index.ts                                  # Deno Edge Function (HTTP 处理)
  content-core.mjs                          # 纯逻辑（请求验证、prompt 构造、响应解析）
```

## 数据流

```
用户输入 → ContentCreationModePanel
  → content-creation-service
    → supabase.functions.invoke('p30-content-create', { action, ... })
      → Deno Edge Function
        → JWT 验证 + 角色检查 (api.p19_staging_role)
        → Qwen/DashScope (qwen-plus, T=0.2, max_tokens=2000)
        → 结构化验证 → 返回
  ← { ok, data: { platform, audience, ..., candidates }, meta: { provider, model, total_tokens } }

确认保存 → content-creation-service.saveContentDraft()
  → supabase.from('content_library').insert({ ...generation_brief })
  ← { id }  (通过现有 RLS 边界写入用户自己的 draft)
```

## Edge Function 安全边界

- **CORS**: 浏览器 Origin 必须命中 allowlist；非白名单来源在鉴权和模型调用前拒绝；无 Origin 仅保留给携带有效 JWT 的 CLI/服务调用
- **JWT**: Supabase Auth `getUser()` 验证 + `api.p19_staging_role` RPC 检查
- **角色**: `status` → viewer+; `generate_quick`/`generate_from_brief`/`revise` → operator+
- **输入验证**: 未知字段拒绝；上一版本限制深度、项目数与总字节；超长输入和畸形 JSON fail closed
- **模型**: 固定 `qwen-plus`、低温度 `0.2`、`max_tokens: 2000`、60 秒超时
- **响应验证**: 11 个必需字段 + 枚举检查 + 类型/非空检查 + 每字段、数组、嵌套深度与总字节上限
- **Brief 来源链**: 以用户 JWT/RLS 读取唯一 approved 行，复验 payload 内 identity/version/status/schema、SHA-256、knowledge citations 与 evidence provenance
- **错误脱敏**: Bearer token/URL/Secret/原始响应正文不入错误消息
- **零持久化**: Edge Function 不写数据库、不创建外部作业

## 保存合同 (generation_brief)

```json
{
  "schema_version": "p30_single_content_draft_v1",
  "original_input": "用户原始输入",
  "summary": "自动补全摘要行",
  "visual_plan": "视觉描述",
  "provider": "dashscope/qwen",
  "model": "qwen-plus",
  "usage": { "total_tokens": 123 },
  "source": "quick_generate | generate_from_brief",
  "brief_references": null,
  "knowledge_references": null,
  "evidence_references": null
}
```

禁止保存：token、Authorization header、Secret、原始会话数据。

## 文件清单

| 文件 | 变更 | 用途 |
|---|---|---|
| `src/pages/ContentWorkspacePage.jsx` | 修改 | 添加三模式切换 + 保留旧周期工作台 |
| `src/styles.css` | 修改 | P30 组件样式 + 响应式 (390/768/1440) |
| `src/components/content-workspace/ContentCreationModePanel.jsx` | 新增 | 快速生成/Brief 生成共用面板 |
| `src/services/content-creation-service.js` | 新增 | Edge Function 调用 + 保存合同 |
| `supabase/functions/p30-content-create/index.ts` | 新增 | Edge Function HTTP 入口 |
| `supabase/functions/p30-content-create/content-core.mjs` | 新增 | 纯逻辑模块 |
| `test/content-creation-modes.test.mjs` | 新增 | 单元测试 |
| `test/content-creation-modes.browser.test.mjs` | 新增 | 浏览器集成测试 |
| `docs/P30_CONTENT_CREATION_MODES.md` | 新增 | 本文档 |

## 验收

1. `node --test test/content-creation-modes.test.mjs` — 纯逻辑单元测试
2. `node --test test/content-creation-modes.browser.test.mjs` — 浏览器集成测试（需 Edge）
3. 现有回归测试保持不变
4. `npm run lint` — ESLint 零警告
5. `npm run build` — Vite 生产构建成功
6. 浏览器手动验证：默认快速模式、三模式互斥、折叠状态、生成/修改/保存流程、Brief 门禁、周期选择、响应式
7. Edge 对抗测试：JWT/role、CORS、未知字段、超长输入、schema 验证、超时、脱敏
8. `git diff` 仅包含 allowlisted 文件
