# CONTENT_WORKSPACE_SEQUENCE_OPTIMIZATION_REPORT

## 完成范围

本次只对现有 AI Marketing Studio 内容工作台做增量优化，保留深色 Command Center 视觉风格、角色模型（LoRA）、素材库、图片生成、视频生成、审核和发布能力，没有重写整体网站，也没有新增数据库字段或 migration。

## 修复的排序逻辑

- 新增 `normalizeContentPackageSequence()`，把内容包标准化为：
  - `id`
  - `dayIndex`
  - `dayLabel`
  - `pillar`
  - `platform`
  - `status`
  - `productionStep`
  - `isCurrent`
  - `isCompleted`
  - `isBlocked`
- Day 信息按以下优先级解析：
  1. 内容包已有的 `day_index`、`plan_day` 或 `day`
  2. `source_insights`
  3. `image_requirements` / `video_requirements`
  4. 标题中的 `Day 1` / `第 1 天`
  5. 与 `strategy_plans.daily_plan` 的内容支柱匹配
  6. `created_at` 升序兜底
- 最终排序固定为：
  1. `dayIndex` 升序
  2. `created_at` 升序
  3. `title` 升序
- 默认选择第一个未完成内容包。Day 1 完成后默认进入 Day 2，不再使用“最新创建优先”，因此不会默认打开 Day 7。

## 策略批准后如何进入 Day 1

- “批准策略”按钮调整为“批准策略并进入 Day 1”。
- 批准请求会携带：
  - `strategy_id`
  - 标准化后的 `daily_plan`
  - Day 标题格式 `Day {day_index}｜{pillar}`
- 批准完成后：
  1. 自动刷新策略数据
  2. 尝试在现有 `title`、`source_insights`、`image_requirements`、`video_requirements` 中补齐 Day 信息
  3. 自动跳转到 `#/workspace?strategy_id=xxx&day=1`
- 如果服务端暂未写入 Day 元数据，前端顺序解析仍会兜底，不阻塞进入 Day 1。

## 内容工作台布局调整

### 顶部策略进度条

显示当前运营活动、当前策略、当前 Day、当前生产阶段，以及六个主阶段：

1. 文案确认
2. 角色 / LoRA 确认
3. 素材引用
4. 视觉生成
5. 结果审核
6. 发布队列

### 左侧 Day Plan

- 按 Day 1 到 Day 7 顺序展示。
- 每天显示内容支柱、平台、当前阶段、完成或阻塞状态。
- 点击某一天，只切换右侧对应内容包。

### 右侧当前内容生产台

- 页面只渲染当前选中的 Day 内容。
- 文案、角色与素材、视觉生成、结果审核改为可折叠步骤。
- 默认只展开当前未完成或阻塞的步骤。
- 其它复杂设置保留在“完整设置、素材导入与终审发布”折叠区。
- Day 审核通过并加入发布队列后，自动进入下一天。

## 保留的生产能力

- 角色选择：保留
- 角色模型（LoRA）选择与状态：保留
- 素材库引用：保留
- 本地素材上传：保留
- X 链接导入：保留
- 图片生成：保留
- 视频生成及多种视频模式：保留
- 生成结果回传、确认可用、重新生成：保留
- 人工审核及发布队列：保留

## 响应式与页面稳定性

- 主布局使用 `minmax(0, 1fr)` 防止内容撑出横向滚动。
- 1366×768 下使用左侧日程 + 右侧生产台布局。
- 较窄桌面自动压缩顶部策略信息。
- 移动端切换为单列；Day 列表改为横向滑动卡片。
- 保留现有移动端导航展开与独立滚动规则，避免导航裁切。

## 测试结果

- Day 7 晚创建时仍按 Day 1、Day 2、Day 7 排序：通过
- 全部未开始时默认 Day 1：通过
- Day 1 完成后默认 Day 2：通过
- `strategy_id` / `day` 路由解析与生成：通过
- 未完成步骤自动展开，其它步骤折叠：通过（逻辑与样式检查）
- 角色 / LoRA / 素材 / 图片视频生成保留：通过
- 横向溢出防护：通过（CSS 结构检查）
- 1366×768 布局规则：通过（响应式规则检查）
- 移动端导航与 Day 列表规则：通过（响应式规则检查）
- `npm run lint`：通过
- `npm run build`：通过

## 修改文件

- `src/App.jsx`
- `src/pages/CampaignStrategyPage.jsx`
- `src/pages/ContentWorkspacePage.jsx`
- `src/services/ops-service.js`
- `src/styles.css`
- `src/utils/app-route.js`
- `src/utils/content-package-sequence.js`

## 最新功能提交 SHA

`dd5787a02408eb1096eb2a5e2fea9871d9378440`
