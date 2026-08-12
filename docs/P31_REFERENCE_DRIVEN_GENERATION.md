# P31 参考驱动智能内容生成

## 概述

P31 在 P30 三模式内容工作台基础上，增加了**参考驱动**的智能意图解析和条件化内容生成能力。用户可提供参考 X 链接、参考文本或截图，AI 解析意图后按平台规则生成内容。

## 关键能力

| 能力 | 说明 |
|------|------|
| 意图解析 | `resolve_intent` 先分析用户需求，输出 platform/content_format/tone 等结构化意图 |
| 优先级规则 | explicit overrides > validated reference > account defaults > model inference |
| 反小红书启发式 | 不因中文输入自动推断为小红书；需显式指定或提供链接 |
| 条件化输出 | 根据平台+格式组合决定 CTA/标签/候选版本是否必选 |
| 参考输入 | X URL（P22 collectUrl）、参考文本、截图（仅用于本次生成，不持久化） |
| 多模态模型 | 仅当有图片参考时使用 `qwen3.5-omni-flash`，否则用 `qwen-plus` |
| v2 编辑 | 标题、正文、视觉方案可编辑后保存 |
| 草稿 handoff | 保存后可直接查看草稿或进入图片生成准备页面 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `supabase/functions/p30-content-create/content-core.mjs` | 新增 v2 动作、意图解析、条件化输出验证、多模态选择 |
| `supabase/functions/p30-content-create/index.ts` | 新增 resolve_intent/generate_quick_v2 handler、多模态路由 |
| `src/services/content-creation-service.js` | 新增 resolveIntent/generateQuickContentV2/saveContentDraftV2/loadDraftById |
| `src/components/content-workspace/CreationIntentSummary.jsx` | 新建：意图 chip 摘要 + 编辑面板 |
| `src/components/content-workspace/ContentCreationModePanel.jsx` | 新增参考输入、意图流、v2 编辑、保存后卡片 |
| `src/pages/ContentWorkspacePage.jsx` | 新增 onPrepareImage 回调、图片准备 notice |
| `src/pages/GenerationTasksPage.jsx` | 新增 routeParams、草稿 handoff 面板 |
| `src/styles.css` | 新增参考输入、意图摘要、v2 编辑、handoff 面板样式 |
| `test/p31-reference-driven-generation.test.mjs` | 新建：单元/对抗测试 |
| `docs/P31_REFERENCE_DRIVEN_GENERATION.md` | 本文档 |

## v2 合同

### resolve_intent

```json
// 请求
{
  "action": "resolve_intent",
  "input_text": "为创业者写一篇 X 贴文",
  "reference_url": "https://x.com/user/status/123",
  "reference_text": "可选参考文本",
  "has_image_reference": false,
  "schema_version": "p31_reference_driven_v2"
}

// 响应
{
  "ok": true,
  "data": {
    "intent": {
      "platform": "x",
      "content_format": "image_caption",
      "language_mode": "zh-cn",
      "length_profile": "short",
      "tone": "professional",
      "cta_policy": "optional",
      "hashtag_policy": "optional_0_5",
      "confidence": "explicit",
      "provenance": "user_request"
    }
  }
}
```

### generate_quick_v2

```json
// 请求
{
  "action": "generate_quick_v2",
  "input_text": "...",
  "intent": { /* 已解析的意图 */ },
  "has_image_reference": false,
  "schema_version": "p31_reference_driven_v2"
}

// 响应
{
  "ok": true,
  "data": {
    "title": "AI 正在改变创业的游戏规则",
    "main_copy": "...",
    "visual_description": "...",
    "platform": "x",
    "content_format": "image_caption",
    "cta": "在评论区分享你的看法",
    "hashtags": ["#AI"],
    "candidates": []
  }
}
```

## 条件化输出规则

| 平台 | 格式 | CTA | 标签 | 候选版本 |
|------|------|-----|------|----------|
| X | image_caption | optional | optional_0_5 | optional |
| X | carousel | optional | optional_0_5 | optional |
| X | long_post | optional | optional_0_5 | optional |
| 小红书 | carousel | optional | required_3_5 | optional |
| 小红书 | long_post | optional | required_3_5 | optional |
| 其他 | 全部 | required | required_3_5 | optional |

## 边界与安全

- 不持久化原始图片数据（仅保存元数据和 SHA-256 哈希）
- 参考 URL 仅支持 HTTPS X/Twitter status 链接
- 图片仅接受 JPEG/PNG/WebP，≤10MB，≤4096px
- 错误消息脱敏（无 Token、URL、模型原始响应）
- P22 collectUrl 仅通过显式用户点击触发
- 无数据库 schema/RLS 变更
- v1 合同完全保持兼容

## 测试

```bash
# 运行所有测试
npm run test

# 仅运行 P31 测试
node --test test/p31-reference-driven-generation.test.mjs

# 运行 P30 回归
node --test test/content-creation-modes.test.mjs
```
