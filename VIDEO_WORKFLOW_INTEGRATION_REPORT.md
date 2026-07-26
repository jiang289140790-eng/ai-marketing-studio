# VIDEO_WORKFLOW_INTEGRATION_REPORT

## 交付结果

AI Marketing Studio 已接通 AutoDL ComfyUI 图片与视频生成链路。生成任务通过现有 MCP Runtime Bridge 调用远端网关，结果写入现有 Supabase Storage 与 `asset_library`，没有新增平行业务表，也没有触发真实发布。

## 已接入的生产工作流

| 工作流 | 能力 | 主要输入 | 输出 |
| --- | --- | --- | --- |
| `emma-s1-sdxl-t2i` | Emma LoRA 文生图 | 文案、视觉提示词、LoRA、尺寸、种子 | 图片 |
| `krea2-image-edit` | 参考图编辑 | 参考图、编辑提示词、尺寸 | 图片 |
| `flux-multiscene` | 多场景图片生成 | 内容主题、场景描述、尺寸 | 图片 |
| `wan-remix-i2v` | 单图生成视频 | 参考图、动作描述、帧数 | 视频 |
| `wan-remix-first-last` | 首尾帧生成视频 | 首帧、尾帧、动作描述 | 视频 |
| `ltx23-image-to-video` | 快速图生视频 | 参考图、镜头运动、时长 | 视频 |

## 与网站业务计划的关系

内容工作台创建任务时会传递并保留：

- `campaign_id`
- `strategy_plan_id`
- `content_package_id`
- `content_item_id`
- Day 与平台
- 标题、Hook、正文、CTA
- 内容计划主题与目标
- `character_id`
- LoRA 名称、版本与权重
- 参考素材
- 选中的工作流与生成模式

视觉提示词由当前内容包文案、策略、平台、角色和当天计划共同构成。生成结果因此不是独立文件，而是当前 Campaign 与 Day 内容生产流程的一部分。

## 真实验证结果

以下任务均在 AutoDL RTX 5090 环境完成，并真实写入生产素材库：

| 测试 | 素材 ID | 结果 |
| --- | --- | --- |
| Emma SDXL 图片 | `bc8dd10c-ccce-43d4-b6c9-9d65aef582e8` | 完成 |
| Wan 单图视频 | `6f167d02-7658-4e3e-bd7f-8379ee11f7f3` | 完成 |
| Krea 图片编辑 | `a059af1b-d413-418b-9bb5-732ab0d21010` | 完成 |
| Flux 多场景图片 | `c09990af-cc83-4b44-b3a6-3afed73d035e` | 完成 |
| LTX 图生视频 | `b6620d9f-1d03-4b5d-b9d2-81d3e1151ad0` | 完成 |
| Wan 首尾帧视频 | `029ed568-76ee-4d3e-a170-0f951fbcc288` | 完成 |
| Day 1 业务入口图片任务 | `037592c3-9a60-43be-8354-43dbf371a3a9` | 完成 |

Day 1 业务入口生成任务 ID：

`d6970e20-edd8-4284-8e13-51b95b35bed0`

所有测试都关联到现有 Campaign、策略、内容包和 Emma 角色，且 `publish_triggered = false`。

## 运行架构

1. 内容工作台根据当前 Campaign、Day 和内容包创建生成任务。
2. AI Marketing Studio MCP 生成带业务上下文的参数。
3. MCP Runtime Bridge 将安全请求转发至 AutoDL 网关。
4. 网关调用 ComfyUI 工作流并轮询任务结果。
5. 输出文件写入 Supabase Storage。
6. 素材记录写入现有素材库，并关联原内容包。
7. 用户在内容工作台确认素材后，才可继续终审和发布预检。

## 安全边界

- 前端不保存或展示 AutoDL、Supabase、Provider 的密钥。
- 网关内网地址和凭据不写入报告。
- 未审核素材不会自动成为最终素材。
- 生成完成不会自动触发发布。
- 工作流调用只在用户明确点击“创建生成任务”时执行。

## 回滚方式

- 前端：回滚本次网站提交即可移除生产工作流展示和选择逻辑。
- MCP Runtime：恢复部署前保留的 Bridge 容器。
- AutoDL：停止网关进程并恢复旧配置文件。
- 已生成素材作为历史结果保留，不自动删除。

