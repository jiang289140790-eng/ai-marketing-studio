# AI Marketing Studio 内容工作台迁移报告

## 功能对照表

| 本地功能 | 线上是否存在 | 对应组件 | 对应数据表 | 迁移方式 | 完成状态 |
| --- | --- | --- | --- | --- | --- |
| 内容审核列表 | 已存在但过简 | `ContentWorkspacePage` / `ContentPackageCard` | `content_packages`、`content_library` | 合并双数据源，恢复完整卡片字段 | 已完成 |
| 内容详情弹窗 | 原为卡片展开 | `ContentDetailDrawer` | `content_packages`、`content_library` | 改为大尺寸右侧抽屉 | 已完成 |
| 文案审核与编辑 | 不完整 | `ContentDetailDrawer` 文案区 | `content_packages`、`content_library` | 恢复标题、Hook、正文、CTA、标签、Agent 改写入口 | 已完成 |
| 图片要求渲染 | 不完整 | `RequirementGrid` | `image_requirements`、`asset_requirement`、`visual_brief` | 转为可读字段，不展示原始 JSON | 已完成 |
| 视频要求渲染 | 不完整 | `RequirementGrid` / `ModeInputs` | `video_requirements`、`asset_requirement` | 转为可读字段，支持分镜与视频模式输入 | 已完成 |
| 人物 LoRA 图片/视频生成模块 | 线上缺少完整流程 | `ContentDetailDrawer` 角色 LoRA 区 | `characters`、`content_packages` | 复用角色、LoRA、权重、图片/视频可用性字段 | 已完成 |
| 素材库选择器 | 不完整 | `AssetPreview` / `asset-selector-grid` | `assets`、`asset_library` | 展示缩略图、类型、来源、权限、使用状态 | 已完成 |
| 角色选择器 | 只有跳转 | `ContentDetailDrawer` 角色选择 | `characters` | 在详情抽屉内直接选择角色并显示 LoRA | 已完成 |
| X 链接导入 | 线上按钮弱化 | `ContentDetailDrawer` X 导入区 | 通过 `import_x_reference` 动作写入素材 | 验证 X status URL，前端不接触 Token/Secret | 已完成 |
| 文件上传 | 不完整 | `upload-dropzone` + `upload_reference_asset` | `assets`、`asset_library`、Storage | 选择文件、显示队列、通过执行网关提交 | 已完成；真实上传依赖 Bridge |
| 图片生成 | 按钮存在但 payload 不完整 | `generate_character_image` | `workflow_runs`、`assets` | payload 增加 Campaign、策略、角色、LoRA、参考素材、图片要求 | 已完成；真实执行依赖 Bridge |
| 视频生成 | 按钮存在但模式不足 | `generate_character_video` + `ModeInputs` | `workflow_runs`、`assets` | 增加 7 种视频生成方式和动态输入 | 已完成；真实执行依赖 Bridge |
| 生成结果回传 | 不完整 | `GenerationResults` | `workflow_runs`、`assets` | 显示 run_id、状态、成本、错误、回传/重生成/确认/驳回 | 已完成 |
| 审核通过 | 过简 | 终审区 `finalize_content_package` | `publish_tasks` | 增加文案、CTA、标签、角色 LoRA、素材、权限检查 | 已完成；真实执行依赖 Bridge |
| 重新生成 | 不完整 | `GenerationResults` | `workflow_runs`、`assets` | 绑定 `regenerate_asset` | 已完成；真实执行依赖 Bridge |
| 驳回 | 不完整 | `GenerationResults` | `assets` | 绑定 `review_generated_asset` approved=false | 已完成；真实执行依赖 Bridge |
| 发布队列关联 | 仅局部显示 | 基础信息 / 终审区 | `publish_tasks` | 显示已关联发布任务，终审成功后创建/更新发布任务 | 已完成；真实执行依赖 Bridge |

## 复用的本地能力

- 本地 `http://localhost:3001` 的 `renderContent()` 工作流结构。
- 本地 Express 后端动作：`upload-reference-asset`、`import-reference-url`、`generate_character_image`、`generate_character_video`、`poll_asset_status`、`review_generated_asset`、`regenerate_asset`、`finalize_content_package`。
- 线上已有 Edge/MCP 动作名称，没有新增数据库表。

## 修改文件

- `src/pages/ContentWorkspacePage.jsx`
- `src/services/ops-service.js`
- `src/styles.css`

## 验证结果

- `npm run lint`：通过
- `npm run build`：通过
- `npm run migrations:check`：safe

## 当前限制

线上真实执行仍依赖公网 MCP Runtime Bridge 与 Supabase Edge Function Secrets。若 Bridge 未配置，页面会显示可操作工作流，但生成、上传、X 导入、终审等按钮会被执行网关禁用。

