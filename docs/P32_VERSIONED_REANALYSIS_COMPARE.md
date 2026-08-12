# P32-A：版本化 Qwen 重新分析、多帖证据库与比较

## 概述

P32-A 在现有 `#/research` 工作台中引入三项核心能力：

1. **追加式 Qwen 重新分析** — 每次分析创建新版本，绝不覆写
2. **同项目多帖证据库** — 直观展示所有已保存证据及其分析状态  
3. **多选比较** — 2-5 条证据的确定性逐条对比

## 架构

```
p19-contracts.js (v2 schema + validation)
    ↓
p19-workspace-service.js (recordVersionedReanalysis + helpers)
    ↓
P19WorkbenchPanels.jsx (P32EvidenceLibrary, P32ComparisonView, P32AnalysisHistory)
    ↓
ResearchWorkspacePage.jsx (handlers + selection state)
    ↓
ResearchWorkspacePage.css (P32 styles)
```

## 数据设计

### 分析版本化

- 每个分析记录拥有唯一的 `id`（`an-{24hex}`），基于 `{project_id, evidence_id, version, timestamp}` 确定性生成
- `version` 字段为该证据下的顺序递增版本号（1, 2, 3, …）
- 多条分析记录可共享同一 `evidence_id`，追加不覆写
- 去重：相同 `_request_identity` 的重放请求不创建重复版本

### 模型扩展版本

| Schema | 用途 | 字段 |
|--------|------|------|
| `p29_multimodal_model_v1` | 旧版（只读） | text_expression, media_analysis[media_id, visual_content, composition, people, scene, emotion], virality_drivers, reusable_methods, signals, risks |
| `p32_multimodal_model_v2` | 新版（重新分析） | v1 全部 + hook, copy_pattern, target_audience, audience_need_emotion, rewrite_suggestions, 每条媒体的 visual_selling_points[], style_pattern |

### 比较摘要

比较是纯确定性的——从选定记录的精确数据派生，不调用任何模型。摘要包含：
- 共同传播驱动力
- 共同风险点
- 最高互动信号
- 差异化钩子

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/services/p19-contracts.js` | P32 v2 常量、`validateP32ModelAnalysis()`、更新的 `validateAnalysis` |
| `src/services/p19-workspace-service.js` | `recordVersionedReanalysis()`、`getLatestAnalysisForEvidence()`、`getAllAnalysisVersionsForEvidence()`、`generateEvidenceComparison()`、更新的 `computeStaleness` |
| `src/components/integrated-workspace/P19WorkbenchPanels.jsx` | `P32EvidenceLibrary`、`P32ComparisonView`、`P32AnalysisHistory` |
| `src/pages/ResearchWorkspacePage.jsx` | `handleVersionedReanalyze`、比较选择状态、新组件集成 |
| `src/pages/ResearchWorkspacePage.css` | P32 UI 样式（~250 行）|
| `supabase/functions/p22-research-assist/assist-core.mjs` | v2 结果解析、扩展的 Qwen 多模态提示词 |
| `test/p32-versioned-reanalysis-compare.test.mjs` | 单元/对抗性测试（~16 个测试）|
| `test/p32-versioned-reanalysis-compare.browser.test.mjs` | 浏览器流存根（~9 个测试）|

## 安全边界

- 追加永不覆写删除旧版本
- 重新分析失败关闭：缺失/过时证据、缺失媒体、身份不匹配、重复响应、畸形输出、归档项目、查看者角色
- 比较失败关闭：重复 ID、缺失/过时分析、<2 或 >5 条记录
- 绝不静默省略选定记录
- 四项执行标志保持严格 `false`
- 不可变证据：指纹、版本、内容、媒体与来源在重新分析前后完全相同

## 兼容性

- 旧版 `p29_multimodal_model_v1` 分析保持可读
- 确定性本地分析保持清晰标注（从不伪装为 Qwen 结果）
- 手工录入证据标注为 `手工录入`，不同于 P22 采集证据
- 知识卡创建使用显式选定的最新分析版本
- Brief 引用旧知识卡保持有效（新版本不自动使旧链接失效）
- 项目切换清除比较选择
