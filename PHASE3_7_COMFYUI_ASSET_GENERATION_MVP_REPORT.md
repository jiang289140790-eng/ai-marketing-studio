# Phase 3.7 ComfyUI Asset Generation MVP Report

## Scope

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase implements the first ComfyUI image asset generation MVP:

```text
Content Library
  ↓
Asset Generation Task
  ↓
Media Gateway
  ↓
ComfyUI Adapter
  ↓
Self-hosted ComfyUI
  ↓
Supabase Storage
  ↓
assets
```

RunningHub was not integrated. Video generation, Kling, and multi-model routing were not implemented.

## Completed

### 1. ComfyUI Workflow Management Foundation

Added migration:

- `supabase/migrations/20260720074218_phase3_7_comfyui_asset_generation_mvp.sql`

New table:

- `comfy_workflows`

Purpose:

- store ComfyUI workflow JSON
- store workflow version
- store model/checkpoint
- store LoRA list
- store input schema
- store node mappings
- connect workflow assets to executable ComfyUI runtime

Key fields:

- `asset_id`
- `name`
- `mode`
- `version`
- `status`
- `workflow_json`
- `input_schema`
- `output_schema`
- `model`
- `checkpoint`
- `loras`
- `default_params`
- `node_mappings`

Security:

- RLS enabled
- guarded policies for select / insert / update / delete own rows
- authenticated grants added

### 2. Media Gateway Frontend Service

Added:

- `src/services/media-gateway-service.js`

Implemented:

- `listComfyWorkflows()`
- `createComfyWorkflow()`
- `generateImageAssetForContent()`

The service creates:

- Asset Generation Agent if missing
- `agent_tasks`
- `agent_runs`
- `workflow_runs`

Then it invokes:

- `supabase.functions.invoke('media-gateway')`

### 3. Supabase Edge Function Media Gateway

Added:

- `supabase/functions/media-gateway/index.ts`

Implemented action:

- `generateImage`

Responsibilities:

- authenticate user
- load and validate `workflow_runs`
- load source `content_library`
- load `comfy_workflows`
- load linked Prompt and Character when available
- build positive prompt
- inject prompt/checkpoint/LoRA/params into ComfyUI workflow JSON through node mappings
- submit to ComfyUI `/prompt`
- poll ComfyUI `/history/{prompt_id}`
- fetch output image from ComfyUI `/view`
- upload result to Supabase Storage bucket `marketing-assets`
- create `assets` row
- update `content_library.asset_id`
- update `content_library.media_url`
- update `workflow_runs.status/output_data/error_message`
- write `cost_records`

### 4. Content Library Entry Point

Updated:

- `src/pages/ContentLibrary.jsx`

Added button:

- `生成素材`

Behavior:

- button creates the full generation task chain
- successful result refreshes Content Library
- generated image appears through `media_url`
- failure message is shown to the user

### 5. Error Recording

Failures are recorded into:

- `workflow_runs.status = failed`
- `workflow_runs.error_message`
- `workflow_runs.last_error`
- `agent_runs.status = failed`
- `agent_runs.error_message`
- `agent_tasks.status = failed`
- `agent_tasks.last_error`

Normalized error categories in Media Gateway:

- `comfyui_not_configured`
- `comfyui_timeout`
- `comfyui_missing_model`
- `comfyui_missing_lora`
- `storage_upload_failed`
- `unauthorized`
- `comfyui_generation_failed`

### 6. Environment Configuration

Updated:

- `.env.example`

Added/kept ComfyUI-only Media Gateway settings:

- `COMFYUI_BASE_URL`
- `COMFYUI_API_KEY`
- `COMFYUI_TIMEOUT_MS`
- `COMFYUI_POLL_INTERVAL_MS`
- `COMFYUI_MAX_POLL_MS`

Removed RunningHub env placeholders from the active workflow runtime section.

### 7. RunningHub Exclusion

No RunningHub provider, service, adapter, or environment variable was added.

Old UI placeholder mentions of RunningHub were removed from:

- `src/pages/SystemHealth.jsx`
- `src/pages/WorkflowRuns.jsx`
- `src/database/schema.md`

## Required Production Setup

Before real generation works, configure Supabase Edge Function Secrets:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
COMFYUI_BASE_URL
COMFYUI_API_KEY              # only if your ComfyUI reverse proxy requires auth
COMFYUI_TIMEOUT_MS
COMFYUI_POLL_INTERVAL_MS
COMFYUI_MAX_POLL_MS
```

Then deploy:

```text
supabase functions deploy media-gateway
```

Also add at least one `comfy_workflows` row with:

- `mode = image`
- `status = active`
- valid ComfyUI API-format `workflow_json`
- valid `node_mappings` for at least `positive_prompt`

## Validation

Passed:

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

Migration checker:

- Overall status: `safe`
- No unsafe duplicate `CREATE POLICY`, `CREATE TABLE`, or `CREATE INDEX` statements detected.

RunningHub check:

- No active RunningHub references remain in `.env.example`, `src`, `supabase/functions`, or `supabase/migrations`.

## Current Limitations

This MVP only supports:

- ComfyUI
- image generation
- one active/default ComfyUI workflow
- `/prompt → /history → /view` execution flow

Not implemented yet:

- video generation
- workflow picker UI
- ComfyUI workflow import UI
- node mapping editor
- queue status UI
- cancellation
- batch generation
- LoRA asset resolver from Asset Library files

## Next Recommended Phase

Phase 3.8 should focus on real ComfyUI setup validation:

1. Add one active `comfy_workflows` row.
2. Configure `COMFYUI_BASE_URL` in Edge Function Secrets.
3. Deploy `media-gateway`.
4. Run one real image generation from Content Library.
5. Verify:
   - `workflow_runs.status = success`
   - `assets` row created
   - generated file exists in Supabase Storage
   - `content_library.media_url` updated
