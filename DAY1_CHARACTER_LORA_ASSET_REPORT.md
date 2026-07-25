# DAY1_CHARACTER_LORA_ASSET_REPORT

## 实施结果

Day 1 内容已与角色库、LoRA、推荐工作流、生成任务和素材库建立完整关系。

角色库继续作为独立的“持续生成身份”，素材库继续表示已生成或上传的真实文件。没有合并角色库与素材库，没有新建第二套角色表，也没有新增数据库 migration。

## 复用的现有结构

### 角色库

继续使用 `characters`：

- 名称：`name` / `display_name`
- 人物身份：`content_positioning` / `description`
- 外观：`appearance` / `visual_spec`
- 性格：`personality` / `personality_traits`
- 文案语气：`prompt_templates.copy_tone`
- 基础 Prompt：`prompt` / `prompt_templates.base_prompt`
- Negative Prompt：`prompt_templates.negative_prompt`
- LoRA：`lora` / `lora_info`
- LoRA 版本和权重：`lora_info.version` / `lora_info.weight`
- 推荐工作流：`recommended_workflows`
- 绑定账号：`lora_info.bound_account_ids`
- 参考图：`visual_spec.reference_images` 及角色参考素材
- 可用状态：`status`

角色编辑表单已补齐以上业务配置。现有角色记录保持兼容。

### 生成任务

继续使用 `workflow_runs` 作为生成任务主记录：

- `input_data.campaign_id`
- `input_data.content_package_id`
- `input_data.content_item_id`
- `character_id`
- `input_data.lora`
- `input_data.comfy_workflow_id`
- `input_data.prompt`
- `input_data.provider`
- `status`
- `output_data.output_references`
- `error_message`

数据库原生状态为 `pending / running / success / failed`。页面统一映射为：

- 排队中
- 运行中
- 已完成
- 失败
- 已取消

“已取消”兼容存储在 `input_data.lifecycle_status`，避免为状态命名差异修改数据库约束。

### 素材库

继续使用 `asset_library` 作为真实文件和生成成果：

- Campaign：`campaign_id`
- Day / Content Item：`metadata.content_item_id` 和内容包 Day 信息
- 内容包：`content_package_id`
- 角色：`metadata.character_id`
- 生成任务：`metadata.generation_job_id`
- Storage：`output_storage_path`
- 外部结果：`output_url`
- 使用状态：`metadata.usability`
- 主素材：`metadata.is_primary`
- 人工批准：`approved_for_publishing`

没有把任务记录直接当作可发布素材。历史生成工具产生的 pending 素材行作为兼容性临时记录存在，但不会进入“可用素材”区域。

## Day 1 角色绑定

内容工作台支持：

- 自动读取 Campaign 默认角色；
- 为当前 Day 1 手动更换角色；
- 查看绑定账号；
- 查看和选择 LoRA；
- 调整本次 LoRA 权重；
- 选择角色推荐工作流；
- 使用角色参考素材；
- 保存当前 Day 1 覆盖配置。

当前内容的权重、工作流和 LoRA 选择写入 `content_packages.image_requirements` 与 `video_requirements`，不会覆盖角色库全局配置。

## 生成任务与进度

用户点击“创建图片生成任务”或“创建视频生成任务”后：

1. 创建 `workflow_runs` 任务；
2. 记录 Campaign、Day 1 内容包、当前文案版本、角色、LoRA、工作流、Prompt 和 Provider；
3. 调用已有角色图片或视频生成能力；
4. 保存输出引用和错误摘要；
5. 页面显示排队、运行、完成或失败状态；
6. 失败任务可以重试，并保留原任务。

生成任务不会自动批准素材，也不会触发发布。

## 素材操作

Day 1 内容工作台内可以：

- 从当前 Campaign 素材库选择成果；
- 创建生成任务；
- 刷新任务进度；
- 关联素材；
- 设为主素材；
- 更换主素材；
- 重新生成；
- 标记不可用；
- 人工批准素材。

用户不需要离开工作台到 AI 成果页面查找 Day 1 素材。AI 成果和素材库页面仍然保留。

## 损坏素材处理

以下记录默认不会进入可用素材区：

- 状态不是 completed；
- 已完成但没有 `output_url` 或 `output_storage_path`；
- URL 格式无效；
- Storage Signed URL 无法生成；
- Storage 路径不存在；
- 已标记不可用；
- 图片或视频在浏览器中加载失败。

Storage 素材在工作台加载时重新生成短期 Signed URL。损坏和未完成记录显示在折叠的诊断区域，不参与主素材选择和发布就绪计算。

## 发布安全

- 素材选择不等于素材批准；
- 主素材必须人工批准后才满足发布准备；
- 未经审核的素材不会自动进入正式发布；
- 本任务没有创建外部发布；
- 本任务没有修改 Secrets。

## MCP 工具

新增或完善：

- `get_character_for_campaign`
- `list_character_loras`
- `create_asset_generation_job`
- `get_generation_job`
- `retry_generation_job`
- `list_assets_for_content`
- `attach_asset_to_content`
- `set_primary_asset`
- `approve_asset`

所有写操作校验当前用户所有权、Campaign、Day 1 内容包和素材关系。

## 数据库只读验证

验证时数据库实际存在：

- 角色：2
- 生成任务：0
- 带真实输出位置的 completed 素材候选：1
- completed 但没有输出文件的记录：0

没有为测试写入生成任务或假素材。

## 测试结果

前端：

- `npm run typecheck`：通过
- `npm run lint`：通过
- `npm test`：17/17 通过
- `npm run build`：通过

MCP：

- `npm run lint`：通过
- `npm test`：通过
- `npm run build`：通过

## 提交记录

- 前端、角色库与执行网关：`f5fb200`
- MCP 角色/任务/素材工具：`c42403f`

