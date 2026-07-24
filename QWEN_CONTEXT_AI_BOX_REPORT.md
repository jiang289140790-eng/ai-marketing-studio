# QWEN_CONTEXT_AI_BOX_REPORT

## 1. Qwen 接入位置

- 服务端入口：`supabase/functions/ai-gateway/index.ts`
- 前端统一调用入口：`src/services/ai-gateway-service.js`
- Context AI 业务编排：`src/services/context-ai-service.js`
- 前端不会直接请求 DashScope，不保存或读取百炼 API Key。
- AI Gateway 支持 `qwen`、`dashscope`、`aliyun`、`bailian` 四种 provider 别名。
- 支持模型：`qwen-plus`、`qwen-max`、`qwen3.6-plus`，并保留 DeepSeek、OpenAI、Anthropic 原有路径。

## 2. Supabase Secrets 配置

线上项目 `qtrlymiqohbjvklwegsw` 已配置：

- `DASHSCOPE_API_KEY`
- `DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1`

密钥只存在于 Supabase Edge Function Secrets。未写入：

- GitHub Pages 构建变量
- 前端 `.env`
- Git 仓库
- localStorage
- 页面请求头或业务报告

后续轮换方式：

```bash
supabase secrets set DASHSCOPE_API_KEY="<new-key>" --project-ref qtrlymiqohbjvklwegsw
```

## 3. 新增组件与服务

### `src/components/ContextAIBox.jsx`

提供以下能力：

- 文案优化
- Hook 生成
- 图片提示词生成
- 视频脚本生成
- 角色 / LoRA 提示词补全
- 内容策略生成
- Prompt 模板生成
- Qwen / DeepSeek 模型切换
- 生成、重新生成、复制、应用、保存 Prompt
- `idle / generating / success / failed` 状态
- 密钥、额度、模型、超时等友好错误提示

### `src/services/context-ai-service.js`

提供：

- `buildContentContext()`
- `buildContextPrompt()`
- `generateContextAI()`
- `parseContextAIResult()`
- `contextResultToPrompt()`

上下文包含内容、Campaign、策略、目标账号、账号画像、角色、LoRA、参考素材、爆款内容、当前文案、图片/视频要求、品牌规则和负面规则。

## 4. 内容工作台接入

已在内容卡片工作室加入：

- `AI 优化文案`
- `AI 生成 Hook`
- `AI 生成图片提示词`
- `AI 生成视频脚本`
- `AI 补全角色 / LoRA`

生成结果先进入 Context AI Box 供人工检查，不会自动覆盖原内容。

只有点击“应用到当前内容”后才写回：

- 文案：`title / hook / body / cta / hashtags / keywords / language_style`
- 图片：`image_requirements`
- 视频：`video_requirements`
- LoRA：复用 `image_requirements / video_requirements` 中的 `lora_info`
- 策略：复用 `source_insights.context_ai_strategy`

没有新增数据库字段或 migration。

## 5. Prompt 库接入

- Prompt 库已加入左侧资产中心导航和页面路由。
- 新增“AI 生成 Prompt 模板”按钮。
- 支持爆款分析、X 文案、图片、视频、LoRA 角色、账号画像等模板模式。
- AI 结果可人工确认后保存到原有 `prompts` 表。
- 保存字段沿用 `title / category / content / platform / character`。

## 6. 内容情报接入

- 默认 Analysis Agent 模型改为 `qwen-plus`。
- 默认 Content Generation Agent 模型改为 `qwen-plus`。
- 页面模型选择支持：
  - `qwen-plus`
  - `qwen-max`
  - `qwen3.6-plus`
  - `deepseek-chat`
- 分析结果继续写入 `content_analysis`，保留 `provider / model / usage / cost / duration_ms / social_account_id`。
- 生成结果继续写入 `content_library`，保留原有内容生产链路。

## 7. AI Gateway 与错误处理

Qwen 使用 OpenAI-compatible `POST /chat/completions`：

- system / user messages
- temperature
- max_tokens
- response_format

统一响应包含：

- `content`
- `usage`
- `raw_provider_id`
- `provider`
- `model`
- `cost`
- `duration`

成本保持估算模式 `estimated: true`，未破坏原有成本记录。

## 8. 验证结果

已通过：

- `npm run lint`
- `npm run build`
- `npm run migrations:check`
- `git diff --check`
- Supabase Edge Function `ai-gateway` 部署
- GitHub Pages 构建与部署
- 线上登录态、导航与 Supabase 数据读取 smoke test
- 线上 Prompt 库导航显示
- 真实 Qwen Gateway 调用

真实调用结果：

- `status: success`
- `provider: qwen`
- `model: qwen-plus`
- 返回了 token usage、duration 和 estimated cost
- 验证用临时 Auth 用户在测试后已删除

## 9. 未完成与已知限制

- 浏览器自动化在打开 Context AI 弹窗后的深层交互阶段出现连接超时，因此没有自动点击“应用到当前内容”以避免误改真实业务数据。
- 真实 AI Gateway 调用已通过独立的受控测试用户完成，证明 Qwen 服务端链路可用。
- `qwen3.6-plus` 是否对当前百炼账号开放取决于阿里百炼模型授权；默认使用已验证的 `qwen-plus`。
- Vite 构建仍有现有主包超过 500 kB 的提示，不影响发布，本次未做页面架构或代码分包重构。

## 10. 部署、提交与下一步

- Supabase 项目：`qtrlymiqohbjvklwegsw`
- Edge Function：`ai-gateway`
- GitHub Pages：`https://jiang289140790-eng.github.io/ai-marketing-studio/`
- Qwen 主实现提交：`c656f16`
- Prompt 库路由修复提交：`6789163`

建议下一步：

1. 在内容工作台选择一个真实内容包，点击 `AI 优化文案`，检查结果后再点击应用。
2. 在 Prompt 库生成一条 X 文案模板并保存，确认后续 Content Agent 可复用。
3. 在内容情报使用 `qwen-plus` 分析一条真实内容机会，确认 `content_analysis` 的 provider/model/usage。
4. 百炼额度或模型授权变化时，只轮换 Supabase Secret，不修改前端。
