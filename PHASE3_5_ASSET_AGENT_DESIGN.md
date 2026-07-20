# Phase 3.5 Asset Generation Agent Design

## Positioning

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase only designs the Asset Generation Agent architecture. It does not connect a real image or video model yet, and it does not add SaaS, billing, subscription, membership, pricing, or multi-tenant features.

## Goal

Build a future-proof asset production chain:

```text
content_library
  ↓
asset_generation_task
  ↓
workflow execution
  ↓
assets
```

The first implementation should reuse the existing tables and services where possible:

- `content_library`
- `agent_tasks`
- `agent_runs`
- `workflow_runs`
- `assets`
- `cost_records`
- `notifications`

## Current Foundation

Already available:

- `agents.type = asset_generator`
- `agent_tasks.task_type = asset_generation`
- `workflow_runs`
- `assets`
- `workflow-service.js`
- `asset-service.js`
- retry fields on task/runtime tables
- cost recording through `cost_records`
- Supabase Storage bucket: `marketing-assets`

The existing Agent Center already creates a workflow run for `asset_generator`. Phase 3.5 should preserve that behavior and later route it through a real Media Gateway.

## Gateway Separation

### 1. LLM Gateway

Purpose:

- text reasoning
- content analysis
- content draft generation
- prompt refinement
- visual prompt rewriting

Current providers:

- DeepSeek
- OpenAI placeholder
- Anthropic placeholder

Existing service:

- `src/services/ai-gateway-service.js`
- `supabase/functions/ai-gateway`

Output examples:

- content analysis JSON
- social post draft
- image prompt
- video prompt
- storyboard

### 2. Media Gateway

Purpose:

- image generation
- video generation
- workflow execution
- model/LoRA/workflow asset runtime
- result polling
- media URL normalization
- cost/duration/status tracking

Future service:

- `src/services/media-gateway-service.js`
- `supabase/functions/media-gateway`

The frontend must not call ComfyUI, RunningHub, Kling, or any provider key directly.

## Asset Generation Agent Flow

```text
Content Library draft
  ↓
Asset Generation Agent
  ↓
agent_tasks row
  ↓
agent_runs row
  ↓
workflow_runs row
  ↓
Media Gateway
  ↓
Provider Adapter
  ↓
generated image/video/audio
  ↓
assets row
  ↓
content_library.asset_id updated
```

## Runtime Responsibilities

### Asset Generation Agent

Responsible for:

- selecting source `content_library` item
- reading linked `prompt_id`, `character_id`, `asset_id`
- deciding required asset type:
  - image
  - video
  - audio
  - thumbnail
  - workflow result
- creating `agent_tasks`
- creating `agent_runs`
- creating `workflow_runs`
- passing normalized input to Media Gateway

Not responsible for:

- storing provider API keys
- calling media providers directly
- uploading files with secret credentials from the browser
- deciding provider-specific low-level payload details

### Media Gateway

Responsible for:

- selecting provider adapter
- validating required inputs
- reading provider secrets from Supabase Edge Function Secrets
- submitting provider job
- polling provider job if async
- normalizing output into a common response format
- recording cost, duration, model, workflow, and status

### Provider Adapter

Responsible for:

- provider-specific request mapping
- provider-specific response mapping
- provider-specific error handling
- provider-specific cost and status interpretation

## Proposed Data Model

Phase 3.5 should prefer existing tables first.

### `agent_tasks`

Use existing row:

```json
{
  "task_type": "asset_generation",
  "status": "pending | running | success | failed",
  "workflow_id": "optional workflow asset id",
  "input_data": {
    "content_id": "content_library id",
    "asset_type": "image | video | audio",
    "provider": "comfyui | runninghub | kling",
    "model": "provider model name",
    "prompt_id": "prompt id",
    "character_id": "character id",
    "source_analysis_id": "content_analysis id",
    "platform": "Telegram | X | Instagram | TikTok | YouTube",
    "brief": "generation brief"
  },
  "result": {
    "workflow_run_id": "workflow run id",
    "asset_id": "asset id",
    "content_id": "content id"
  },
  "retry_count": 0,
  "max_retry": 3,
  "last_error": null
}
```

### `agent_runs`

Use existing row:

```json
{
  "agent_name": "Asset Generation Agent",
  "input": {
    "content_id": "...",
    "asset_type": "image",
    "provider": "runninghub",
    "workflow_id": "...",
    "prompt": "normalized prompt"
  },
  "output": {
    "workflow_run_id": "...",
    "asset_id": "...",
    "url": "...",
    "thumbnail": "..."
  },
  "status": "running | success | failed",
  "cost": 0,
  "duration": 0,
  "error_message": null
}
```

### `workflow_runs`

Use as the core `generation_task` runtime table.

Current fields already support:

- `workflow_id`
- `tool_id`
- `character_id`
- `prompt_id`
- `asset_ids`
- `input_data`
- `output_data`
- `status`
- `cost`
- `error_message`
- `created_at`
- `completed_at`
- retry fields from stability phase

Recommended normalized `input_data`:

```json
{
  "source": "asset_generation_agent",
  "content_id": "content_library id",
  "agent_task_id": "agent task id",
  "agent_run_id": "agent run id",
  "provider": "runninghub",
  "asset_type": "image",
  "model": "provider model name",
  "workflow": {
    "id": "workflow asset id",
    "name": "workflow name",
    "version": "optional"
  },
  "prompt": {
    "positive": "generation prompt",
    "negative": "negative prompt",
    "source_prompt_id": "prompt id"
  },
  "content_context": {
    "title": "content title",
    "platform": "target platform",
    "content_type": "content type",
    "cta": "content CTA"
  }
}
```

Recommended normalized `output_data`:

```json
{
  "provider": "runninghub",
  "external_task_id": "provider task id",
  "asset_id": "assets id",
  "content_id": "content_library id",
  "url": "public asset URL",
  "thumbnail": "public thumbnail URL",
  "model": "actual model",
  "workflow": {
    "id": "workflow asset id",
    "snapshot": {}
  },
  "usage": {
    "credits": 0,
    "seconds": 0
  },
  "raw": {}
}
```

### `assets`

Save final generated media here.

Recommended payload:

```json
{
  "name": "Generated asset title",
  "type": "image | video | audio | workflow",
  "url": "public URL",
  "thumbnail": "thumbnail URL",
  "prompt": "final prompt",
  "model": "actual model",
  "workflow": {
    "workflow_run_id": "...",
    "provider": "runninghub",
    "external_task_id": "...",
    "input": {},
    "output": {}
  },
  "tags": ["ai-generated", "content:<id>", "provider:runninghub"],
  "source": "workflow-runtime"
}
```

### `content_library`

After successful generation:

- set `asset_id`
- optionally set `media_url`
- keep `status = draft` or current status
- add generation metadata into `generation_brief.asset_generation`

No status should be moved to `scheduled` automatically.

## Provider Adapter Design

Future directory:

```text
src/services/media/
  media-gateway-service.js
  media-types.js
  adapters/
    comfyui-adapter.js
    runninghub-adapter.js
    kling-adapter.js

supabase/functions/media-gateway/
  index.ts
  adapters/
    comfyui.ts
    runninghub.ts
    kling.ts
```

Frontend service responsibilities:

- create generation request
- call Edge Function
- receive safe normalized response

Edge Function responsibilities:

- authenticate Supabase user
- validate ownership of content/workflow/prompt/assets
- read provider secrets
- call provider adapter
- write or return normalized provider result

## Unified Media Gateway Interface

```ts
type MediaGenerationRequest = {
  provider: 'comfyui' | 'runninghub' | 'kling';
  mode: 'image' | 'video' | 'audio' | 'workflow';
  content_id?: string;
  workflow_id?: string;
  prompt_id?: string;
  character_id?: string;
  asset_ids?: string[];
  model?: string;
  prompt: {
    positive: string;
    negative?: string;
  };
  parameters?: Record<string, unknown>;
};

type MediaGenerationResult = {
  status: 'queued' | 'running' | 'success' | 'failed';
  provider: string;
  external_task_id?: string;
  url?: string;
  thumbnail?: string;
  model?: string;
  workflow?: Record<string, unknown>;
  cost: {
    amount: number;
    currency: 'USD' | 'CNY' | 'credits';
    unit?: string;
  };
  duration_ms: number;
  raw?: Record<string, unknown>;
  error?: string;
};
```

## Provider Notes

### ComfyUI

Best for:

- local/self-hosted workflows
- SDXL / Flux / Wan / custom model workflows
- LoRA and ControlNet-heavy generation

Future secrets:

- `COMFYUI_BASE_URL`
- optional `COMFYUI_API_KEY`

Adapter methods:

- `submitWorkflow()`
- `getStatus()`
- `getResult()`
- `cancel()`

Main risk:

- generated files may live on a private machine; Media Gateway must upload final files to Supabase Storage before saving `assets.url`.

### RunningHub

Best for:

- hosted ComfyUI-style workflows
- workflow marketplace testing
- paid workflow runtime without owning GPU

Future secrets:

- `RUNNINGHUB_API_KEY`
- `RUNNINGHUB_BASE_URL`

Adapter methods:

- `submitWorkflow()`
- `getTaskStatus()`
- `getTaskOutputs()`
- `cancelTask()`

Main risk:

- provider-specific workflow node input mapping can drift. Store each workflow asset with a `workflow` JSON schema describing required inputs.

### Kling

Best for:

- video generation
- image-to-video
- product/social short video generation

Future secrets:

- `KLING_ACCESS_KEY`
- `KLING_SECRET_KEY`
- optional `KLING_BASE_URL`

Adapter methods:

- `createImageToVideoTask()`
- `createTextToVideoTask()`
- `getTaskStatus()`
- `getTaskResult()`

Main risk:

- async task duration and quota failures. Must support polling, timeout, retry, and partial failure logs.

## Status Model

Use consistent status across agent task and workflow run:

```text
pending
running
success
failed
```

Optional Media Gateway internal states:

```text
queued
running
success
failed
cancelled
timeout
```

Map internal states back to existing DB status:

| Media Gateway | workflow_runs | agent_tasks |
| --- | --- | --- |
| queued | pending | running |
| running | running | running |
| success | success | success |
| failed | failed | failed |
| cancelled | failed | failed |
| timeout | failed | failed |

## Cost and Duration

Record cost in:

- `workflow_runs.cost`
- `agent_runs.cost`
- `cost_records`

Recommended `cost_records` payload:

```json
{
  "category": "workflow",
  "source": "runninghub",
  "amount": 0,
  "metadata": {
    "provider": "runninghub",
    "model": "model name",
    "workflow_run_id": "workflow run id",
    "agent_task_id": "agent task id",
    "asset_id": "asset id",
    "duration_ms": 0
  }
}
```

Duration should be recorded in:

- `agent_runs.duration`
- `workflow_runs.output_data.duration_ms`

If a later migration is acceptable, add:

- `workflow_runs.duration_ms`
- `workflow_runs.provider`
- `workflow_runs.external_task_id`

For Phase 3.5 design, these can stay inside `input_data` and `output_data` to avoid changing schema immediately.

## Error Handling

All provider errors should normalize to:

```json
{
  "code": "provider_auth_error | provider_quota_error | provider_timeout | provider_rate_limited | provider_model_error | provider_unknown_error",
  "message": "safe user-facing message",
  "provider": "runninghub",
  "retryable": true
}
```

Save failures to:

- `agent_tasks.last_error`
- `agent_runs.error_message`
- `workflow_runs.error_message`
- `notifications`

Never expose raw provider secrets or full provider request headers in frontend logs.

## Security Strategy

- Provider API keys live only in Supabase Edge Function Secrets.
- Frontend only uses Supabase Auth session.
- Edge Function validates:
  - user is authenticated
  - `content_library.user_id = auth.uid()`
  - `workflow_runs.user_id = auth.uid()`
  - `assets.user_id = auth.uid()`
  - `prompts.user_id = auth.uid()`
- Generated files should be copied to Supabase Storage before being saved as durable assets.
- `service_role` stays server-side only.

## Suggested Implementation Phases

### Phase 3.6: Media Gateway Skeleton

- Create `media-gateway-service.js`
- Create `supabase/functions/media-gateway`
- Add adapter interface only
- No real provider call
- Add safe error normalization

### Phase 3.7: Asset Generation Agent MVP

- Add button in Content Library: `生成素材`
- Create `agent_task`
- Create `agent_run`
- Create `workflow_run`
- Call Media Gateway skeleton
- Save placeholder status, not fake success

### Phase 3.8: RunningHub First Real Provider

- Use RunningHub as first real workflow runtime
- Submit workflow
- Poll status
- Save output to Supabase Storage
- Save asset row
- Link asset to content draft

### Phase 3.9: ComfyUI Local Adapter

- Add local/self-hosted ComfyUI URL support
- Upload resulting files to Supabase Storage

### Phase 3.10: Kling Video Adapter

- Add video generation task support
- Add long-running polling and timeout handling

## Non-goals

Do not implement in this phase:

- real image generation
- real video generation
- direct frontend provider calls
- automatic publishing
- new billing or SaaS features
- provider API keys in `.env.example` as real values
- hardcoded model credentials

## Final Design Decision

Use this architecture:

```text
LLM Gateway = text intelligence and prompt/content generation
Media Gateway = image/video/workflow execution
Asset Generation Agent = orchestration layer
workflow_runs = generation task runtime table
assets = final durable media library
content_library.asset_id = content-to-asset connection
```

This keeps the current system stable and gives a clean path to connect RunningHub, ComfyUI, and Kling later without rewriting Agent Center.
