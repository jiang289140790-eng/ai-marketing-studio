# Phase 3.6 ComfyUI Media Gateway Design

## Positioning

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase designs the Media Gateway and ComfyUI Adapter for a self-hosted ComfyUI instance. It does not connect RunningHub, does not add another media provider, and does not change the existing Agent architecture.

## Goal

Create the standard path:

```text
Asset Generation Agent
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

Supported media modes:

- image generation
- video generation
- workflow execution

## Non-goals

Do not implement in this phase:

- RunningHub integration
- Kling integration
- direct frontend calls to ComfyUI
- direct Agent calls to ComfyUI
- automatic publishing
- new billing / subscription / membership / SaaS features
- provider secrets in frontend code

## Architecture Overview

```text
content_library draft
  ↓
Asset Generation Agent
  ↓
agent_tasks / agent_runs
  ↓
workflow_runs
  ↓
Media Gateway Edge Function
  ↓
ComfyUI Adapter
  ↓
ComfyUI /prompt API
  ↓
ComfyUI /history + /view
  ↓
Supabase Storage marketing-assets bucket
  ↓
assets row
  ↓
content_library.asset_id / media_url
```

## Layer Responsibilities

### 1. Asset Generation Agent

The Agent is an orchestration layer only.

Responsibilities:

- select source `content_library` item
- read linked character, prompt, workflow, and existing assets
- create `agent_tasks`
- create `agent_runs`
- create `workflow_runs`
- pass normalized request to Media Gateway

The Agent must not:

- call ComfyUI directly
- know ComfyUI node IDs as business logic
- store ComfyUI credentials
- download or upload raw generated files itself

### 2. Media Gateway

The Media Gateway is the unified media runtime boundary.

Future location:

```text
src/services/media-gateway-service.js
supabase/functions/media-gateway/index.ts
```

Responsibilities:

- authenticate current Supabase user
- validate ownership of content, workflow, character, prompt, and source assets
- normalize media generation input
- call the selected media adapter
- record status, cost, duration, model, workflow, and error
- upload durable outputs to Supabase Storage
- create or update `assets`
- update `workflow_runs`
- optionally link result back to `content_library`

### 3. ComfyUI Adapter

Future location:

```text
supabase/functions/media-gateway/adapters/comfyui.ts
```

Responsibilities:

- map normalized Media Gateway request to ComfyUI workflow JSON
- inject prompt, negative prompt, seed, dimensions, model, LoRA, checkpoint, image inputs
- submit workflow to ComfyUI `/prompt`
- poll `/history/{prompt_id}`
- fetch output files from `/view`
- return normalized output to Media Gateway

The adapter should be stateless. Workflow versioning and schema should live in Supabase, not in adapter code.

## ComfyUI API Shape

The adapter should use ComfyUI as a headless runtime.

Expected ComfyUI endpoints:

- `POST /prompt`
- `GET /history/{prompt_id}`
- `GET /view?filename=...&subfolder=...&type=...`
- optional `GET /queue`
- optional `POST /interrupt`

Recommended Edge Function secrets:

```text
COMFYUI_BASE_URL
COMFYUI_API_KEY          # optional, if reverse proxy requires auth
COMFYUI_TIMEOUT_MS
COMFYUI_POLL_INTERVAL_MS
COMFYUI_MAX_POLL_MS
```

Do not expose these values to GitHub Pages or frontend JavaScript.

## Media Gateway Interface

Frontend service call:

```js
generateMedia({
  mode: 'image' | 'video' | 'workflow',
  provider: 'comfyui',
  content_id,
  comfy_workflow_id,
  workflow_version,
  character_id,
  prompt_id,
  asset_ids,
  input: {
    positive_prompt,
    negative_prompt,
    width,
    height,
    seed,
    steps,
    cfg,
    duration,
    fps
  }
})
```

Edge Function normalized request:

```ts
type MediaGatewayRequest = {
  provider: 'comfyui';
  mode: 'image' | 'video' | 'workflow';
  content_id?: string;
  workflow_run_id?: string;
  comfy_workflow_id?: string;
  workflow_version?: string;
  character_id?: string;
  prompt_id?: string;
  asset_ids?: string[];
  input: {
    positive_prompt?: string;
    negative_prompt?: string;
    model?: string;
    checkpoint?: string;
    loras?: Array<{
      name: string;
      strength_model?: number;
      strength_clip?: number;
    }>;
    width?: number;
    height?: number;
    seed?: number;
    steps?: number;
    cfg?: number;
    sampler?: string;
    scheduler?: string;
    duration?: number;
    fps?: number;
    source_image_url?: string;
  };
};
```

Normalized response:

```ts
type MediaGatewayResult = {
  status: 'queued' | 'running' | 'success' | 'failed';
  provider: 'comfyui';
  mode: 'image' | 'video' | 'workflow';
  external_task_id?: string;
  workflow_run_id?: string;
  asset_id?: string;
  content_id?: string;
  url?: string;
  thumbnail?: string;
  model?: string;
  checkpoint?: string;
  loras?: unknown[];
  cost: {
    amount: number;
    currency: 'USD' | 'CNY' | 'credits' | 'local';
  };
  duration_ms: number;
  raw?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};
```

For a self-hosted ComfyUI instance, `cost.currency = 'local'` is acceptable. Cost can later map to GPU hourly cost or cloud machine cost.

## Proposed Database Design

Current project can already store workflow assets in `assets.type = 'workflow'`. For better ComfyUI management, add a dedicated table in a future implementation phase.

### `comfy_workflows`

Purpose:

- manage reusable ComfyUI workflow definitions
- version workflow schemas
- track checkpoint, LoRA, model, and input mapping
- connect Workflow Library to real ComfyUI runtime

Proposed fields:

```sql
create table public.comfy_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_id uuid references public.assets(id) on delete set null,
  name text not null,
  description text,
  mode text not null check (mode in ('image', 'video', 'workflow')),
  version text not null default '1.0.0',
  status text not null default 'active' check (status in ('active', 'archived', 'draft')),
  workflow_json jsonb not null default '{}',
  input_schema jsonb not null default '{}',
  output_schema jsonb not null default '{}',
  model text,
  checkpoint text,
  loras jsonb not null default '[]',
  default_params jsonb not null default '{}',
  node_mappings jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Recommended indexes:

```sql
create index comfy_workflows_user_id_idx on public.comfy_workflows(user_id);
create index comfy_workflows_asset_id_idx on public.comfy_workflows(asset_id);
create index comfy_workflows_mode_idx on public.comfy_workflows(mode);
create index comfy_workflows_status_idx on public.comfy_workflows(status);
create index comfy_workflows_loras_idx on public.comfy_workflows using gin(loras);
```

RLS:

- `select`: user can read own workflows
- `insert`: user can create own workflows
- `update`: user can update own workflows
- `delete`: user can delete own workflows

### Workflow Versioning

Use immutable versions for workflow execution.

Recommended rule:

- Editing `workflow_json`, `input_schema`, `node_mappings`, checkpoint, or LoRA list creates a new version.
- Existing `workflow_runs` keep the exact snapshot in `input_data.workflow_snapshot`.
- Do not retroactively mutate historical runs.

Example workflow snapshot:

```json
{
  "comfy_workflow_id": "uuid",
  "asset_id": "workflow asset uuid",
  "name": "AI Character Portrait Workflow",
  "version": "1.0.3",
  "mode": "image",
  "model": "flux-dev",
  "checkpoint": "flux1-dev.safetensors",
  "loras": [
    {
      "name": "character-style.safetensors",
      "strength_model": 0.75,
      "strength_clip": 0.75
    }
  ],
  "node_mappings": {}
}
```

## Input Schema Design

`input_schema` describes what the UI and Agent can safely provide without knowing raw ComfyUI internals.

Example:

```json
{
  "required": ["positive_prompt"],
  "fields": {
    "positive_prompt": {
      "type": "string",
      "label": "Positive Prompt",
      "target": "node:6.inputs.text"
    },
    "negative_prompt": {
      "type": "string",
      "label": "Negative Prompt",
      "target": "node:7.inputs.text"
    },
    "width": {
      "type": "number",
      "default": 1024,
      "target": "node:5.inputs.width"
    },
    "height": {
      "type": "number",
      "default": 1024,
      "target": "node:5.inputs.height"
    },
    "seed": {
      "type": "number",
      "default": -1,
      "target": "node:3.inputs.seed"
    }
  }
}
```

The adapter should apply this schema to a workflow JSON copy, never mutate the stored base workflow.

## Node Mapping Design

`node_mappings` is for workflow-specific technical mapping.

Example:

```json
{
  "positive_prompt": {
    "node_id": "6",
    "path": ["inputs", "text"]
  },
  "negative_prompt": {
    "node_id": "7",
    "path": ["inputs", "text"]
  },
  "checkpoint": {
    "node_id": "4",
    "path": ["inputs", "ckpt_name"]
  },
  "lora_1": {
    "node_id": "12",
    "path": ["inputs", "lora_name"]
  },
  "save_image": {
    "node_id": "9",
    "output_type": "image"
  }
}
```

This lets the Agent say “generate image for this draft” while the adapter handles exact ComfyUI node wiring.

## Model / Checkpoint / LoRA Strategy

### Checkpoint

Save checkpoint on the workflow:

```json
{
  "checkpoint": "realisticVisionXL.safetensors",
  "model": "SDXL"
}
```

### LoRA

Character Library already has `characters.lora`.

Recommended resolution order:

1. task-level LoRA override
2. character `lora`
3. workflow default `loras`
4. no LoRA

Normalized LoRA payload:

```json
[
  {
    "name": "character_lora.safetensors",
    "strength_model": 0.8,
    "strength_clip": 0.8,
    "source": "character"
  }
]
```

### Model field

Use `model` for human-friendly model family:

- `SDXL`
- `Flux`
- `Wan`
- `AnimateDiff`
- `HunyuanVideo`
- `Custom`

Use `checkpoint` for exact ComfyUI filename.

## Relationship Design

### Character Library

`characters` contributes:

- appearance
- personality
- prompt
- lora
- tags

Asset Agent should combine:

```text
content draft
+ prompt template
+ character.prompt
+ character.appearance
+ character.lora
```

### Workflow Library

Current workflow assets:

- `assets.type = workflow`
- `assets.workflow = workflow JSON / metadata`
- `assets.model = model name`
- `assets.tags`

Future `comfy_workflows.asset_id` links a workflow asset to a runnable ComfyUI workflow version.

### Asset Library

Input assets:

- reference image
- previous output
- LoRA asset
- workflow asset
- prompt asset

Output assets:

- generated image
- generated video
- generated thumbnail
- generated workflow result

Saved output should include:

```json
{
  "source": "workflow-runtime",
  "workflow": {
    "provider": "comfyui",
    "workflow_run_id": "uuid",
    "comfy_workflow_id": "uuid",
    "workflow_version": "1.0.0",
    "prompt_id": "uuid",
    "character_id": "uuid",
    "content_id": "uuid",
    "checkpoint": "model.safetensors",
    "loras": []
  },
  "tags": ["ai-generated", "comfyui", "image"]
}
```

## workflow_runs Mapping

Use existing `workflow_runs` as the task execution record.

Recommended `input_data`:

```json
{
  "source": "asset_generation_agent",
  "provider": "comfyui",
  "mode": "image",
  "content_id": "uuid",
  "agent_task_id": "uuid",
  "agent_run_id": "uuid",
  "comfy_workflow_id": "uuid",
  "workflow_version": "1.0.0",
  "workflow_snapshot": {},
  "input_schema": {},
  "resolved_inputs": {
    "positive_prompt": "...",
    "negative_prompt": "...",
    "width": 1024,
    "height": 1024,
    "checkpoint": "model.safetensors",
    "loras": []
  }
}
```

Recommended `output_data`:

```json
{
  "provider": "comfyui",
  "comfy_prompt_id": "prompt id from /prompt",
  "asset_id": "uuid",
  "content_id": "uuid",
  "files": [
    {
      "filename": "ComfyUI_00001_.png",
      "subfolder": "",
      "type": "output",
      "storage_path": "user-id/generated/file.png",
      "public_url": "https://..."
    }
  ],
  "model": "SDXL",
  "checkpoint": "model.safetensors",
  "loras": [],
  "duration_ms": 0,
  "cost": {
    "amount": 0,
    "currency": "local"
  },
  "raw_history": {}
}
```

## Service Layout

Recommended frontend service:

```text
src/services/media-gateway-service.js
```

Functions:

```js
createMediaGenerationTask()
runMediaGeneration()
getMediaGenerationStatus()
saveMediaGenerationResult()
```

Recommended Edge Function:

```text
supabase/functions/media-gateway/
  index.ts
  adapters/
    comfyui.ts
  schemas/
    media-types.ts
```

Recommended adapter methods:

```ts
connect()
submitWorkflow()
pollWorkflow()
fetchOutputs()
normalizeOutputs()
```

## ComfyUI Adapter Execution Steps

### 1. Validate request

- authenticated user exists
- user owns source content
- user owns workflow
- user owns character
- user owns prompt
- mode is supported
- workflow input schema can be satisfied

### 2. Resolve prompt

Inputs:

- content draft text
- Prompt Library prompt
- Character prompt
- Character appearance
- negative prompt
- model/checkpoint
- LoRA

Output:

- `positive_prompt`
- `negative_prompt`
- final schema inputs

### 3. Build workflow payload

- clone base `workflow_json`
- inject node values through `node_mappings`
- apply checkpoint
- apply LoRA
- apply image/video params

### 4. Submit to ComfyUI

Call:

```text
POST {COMFYUI_BASE_URL}/prompt
```

Store returned `prompt_id` in `workflow_runs.output_data.comfy_prompt_id` or interim `input_data`.

### 5. Poll result

Call:

```text
GET {COMFYUI_BASE_URL}/history/{prompt_id}
```

Timeout rules:

- image: default 5 minutes
- video: default 30 minutes
- workflow: configurable

### 6. Fetch files

Call:

```text
GET {COMFYUI_BASE_URL}/view?filename=...&subfolder=...&type=output
```

### 7. Save to Supabase Storage

Path pattern:

```text
{user_id}/generated/{workflow_run_id}/{filename}
```

### 8. Create assets row

Create `assets` with:

- type: image/video/audio
- url
- thumbnail
- prompt
- model
- workflow metadata
- source: `workflow-runtime`

### 9. Update content_library

For source content:

- `asset_id = generated asset id`
- `media_url = generated public URL`
- keep status as `draft` unless user explicitly changes it

### 10. Complete records

Update:

- `workflow_runs.status`
- `agent_runs.status`
- `agent_tasks.status`
- `cost_records`
- `notifications` on failure

## Error Model

Normalize ComfyUI errors:

```json
{
  "code": "comfyui_unreachable | comfyui_auth_error | comfyui_invalid_workflow | comfyui_missing_model | comfyui_missing_lora | comfyui_timeout | comfyui_generation_failed | storage_upload_failed",
  "message": "safe user-facing message",
  "retryable": true
}
```

Examples:

- missing checkpoint: failed, not retryable until model is installed
- missing LoRA: failed, not retryable until LoRA exists
- ComfyUI offline: failed, retryable
- generation timeout: failed, retryable
- Storage upload failed: failed, retryable

Save the safe message to:

- `workflow_runs.error_message`
- `agent_runs.error_message`
- `agent_tasks.last_error`

Do not expose:

- ComfyUI private URL if sensitive
- API key
- reverse proxy credentials
- raw headers

## Security Boundary

Frontend:

- can request media generation through Supabase session
- cannot call ComfyUI directly
- cannot see ComfyUI secrets
- cannot see service role key

Supabase Edge Function:

- reads `COMFYUI_BASE_URL`
- reads optional `COMFYUI_API_KEY`
- uses service role only server-side when needed
- validates row ownership before executing

ComfyUI:

- should sit behind a private network, VPN, or reverse proxy
- should not be exposed publicly without auth
- should restrict upload/output access if exposed

Storage:

- final generated media is saved under user folder in `marketing-assets`
- existing RLS/storage folder ownership strategy should be preserved

## Compatibility with Existing Agent Architecture

Keep existing Agent shape:

```text
agents
agent_tasks
agent_runs
workflow_runs
assets
```

Do not make Asset Agent provider-specific.

Provider-specific details belong in:

```text
Media Gateway
ComfyUI Adapter
comfy_workflows.workflow_json
comfy_workflows.input_schema
comfy_workflows.node_mappings
```

The existing `agent-service.js` behavior can later be upgraded from:

```text
asset_generator → create workflow_run placeholder
```

to:

```text
asset_generator → create workflow_run → call Media Gateway → save asset
```

without changing the user-facing Agent model.

## Suggested Implementation Phases

### Phase 3.7: Database and Service Skeleton

- Add `comfy_workflows` migration
- Add RLS policies
- Add `media-gateway-service.js`
- Add `supabase/functions/media-gateway`
- Add ComfyUI adapter interface only
- Do not execute real generation yet

### Phase 3.8: ComfyUI Connectivity Smoke Test

- Configure `COMFYUI_BASE_URL`
- Call `/queue` or a safe health endpoint
- Verify Edge Function can reach ComfyUI
- No generation yet

### Phase 3.9: First Image Workflow Execution

- Import one ComfyUI workflow JSON
- Map positive/negative prompt nodes
- Submit `/prompt`
- Poll `/history`
- Fetch `/view`
- Save output to Supabase Storage
- Create `assets` row

### Phase 3.10: Content Library Asset Button

- Add `生成素材` button to content drafts
- Let user choose:
  - workflow
  - character
  - prompt
  - image/video mode
- Run Asset Agent through Media Gateway

### Phase 3.11: Video Workflow Support

- Add video workflow mode
- Add longer timeout/polling rules
- Save video outputs to Storage

## Final Decision

Use this final architecture:

```text
Asset Generation Agent = orchestration
Media Gateway = secure media runtime boundary
ComfyUI Adapter = self-hosted ComfyUI API integration
comfy_workflows = workflow version/model/LoRA/input schema registry
workflow_runs = execution task log
assets = durable generated media library
content_library = final content + linked generated media
```

RunningHub is intentionally excluded from this phase.
