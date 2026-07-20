# ComfyUI Connection Setup

AI Marketing Studio 当前只接自建 ComfyUI，不接 RunningHub。

## 当前连接状态

- ComfyUI 实例：AutoDL / zealman-ComfyUI v8.88
- GPU：RTX 5090 30GB
- 项目代码已支持 Media Gateway → ComfyUI API → Supabase Storage → assets
- 当前仓库未发现真实 `COMFYUI_BASE_URL` 配置，因此本地不能直接确认 AutoDL 实例已连通

## 必需配置

这些值应配置在 Supabase Edge Function Secrets，不要放进前端代码：

| 变量 | 用途 | 是否必须 |
| --- | --- | --- |
| `COMFYUI_BASE_URL` | AutoDL ComfyUI API 基础地址，例如 `https://your-comfy.example.com` | 必须 |
| `COMFYUI_API_KEY` | 如果 ComfyUI 反代或网关要求鉴权，则作为 Bearer token 使用 | 可选 |
| `COMFYUI_TIMEOUT_MS` | 单次生成超时时间，建议 `180000` 到 `300000` | 可选 |
| `COMFYUI_POLL_INTERVAL_MS` | 查询 `/history` 的间隔，建议 `1500` 到 `3000` | 可选 |

## 需要验证的 API

| API | 方法 | 用途 | 预期 |
| --- | --- | --- | --- |
| `/queue` | `GET` | 查看当前队列 | 返回运行中和等待中的任务 |
| `/prompt` | `POST` | 提交 workflow JSON | 返回 `prompt_id` |
| `/history/{prompt_id}` | `GET` | 查询生成结果 | 返回输出节点和图片文件信息 |
| `/view` | `GET` | 下载生成图片 | 返回图片二进制 |

## 连接检查建议

在配置好 `COMFYUI_BASE_URL` 后，先验证：

```bash
curl "$COMFYUI_BASE_URL/queue"
```

如有 API Key：

```bash
curl "$COMFYUI_BASE_URL/queue" \
  -H "Authorization: Bearer $COMFYUI_API_KEY"
```

然后用 Workflow Test Center 提交一次轻量图片 workflow。成功标准：

1. `workflow_runs.status` 从 `pending/running` 变为 `success`
2. Supabase Storage 的 `marketing-assets` bucket 出现生成图片
3. `assets` 表出现新素材
4. `content_library.asset_id` 和 `media_url` 被更新

## 生产建议

- AutoDL ComfyUI 最好通过 HTTPS 反向代理暴露，避免浏览器或 Edge Function 访问非 TLS 地址。
- 如果公网暴露 ComfyUI，建议至少加一层 API Key 或 IP 白名单。
- RTX 5090 30GB 优先接入 Flux 人物生成、角色一致性、换脸、换装、动作迁移，复杂视频工作流放到后续。
- 不要在 GitHub Pages 前端保存 ComfyUI 地址、token 或任何后端密钥。
