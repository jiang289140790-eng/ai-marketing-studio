# Phase 3.7.2 ComfyUI Workflow Registry Report

## Scope

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase connects the existing self-hosted ComfyUI direction into the product architecture. RunningHub was not added or used.

Target ComfyUI environment:

- GPU: RTX 5090 30GB
- ComfyUI: zealman-ComfyUI v8.88
- Provider: self-hosted AutoDL ComfyUI

## Completed

### 1. ComfyUI connection setup

Added:

- `docs/COMFYUI_CONNECTION_SETUP.md`

The document records:

- Required `COMFYUI_BASE_URL`
- Optional `COMFYUI_API_KEY`
- Timeout settings
- Required API checks:
  - `GET /queue`
  - `POST /prompt`
  - `GET /history/{prompt_id}`
  - `GET /view`

Current status:

- Code can call Media Gateway and ComfyUI once `COMFYUI_BASE_URL` is configured.
- The repository does not currently contain a real AutoDL `COMFYUI_BASE_URL`, so live connection verification was not claimed.

### 2. Workflow Registry database fields

Added migration:

- `supabase/migrations/20260720080512_phase3_7_2_comfy_workflow_registry.sql`

Enhanced `comfy_workflows` with:

- `category`
- `priority`
- `detected_nodes`
- `detected_models`
- `controlnets`
- `tags`
- `last_synced_at`

Supported production categories:

- `character_generation`
- `motion_transfer`
- `face_swap`
- `clothing_transfer`
- `video_generation`

### 3. Workflow automatic scan and registry script

Added:

- `scripts/comfy-workflow-registry.mjs`

Capabilities:

- Scans workflow JSON directories
- Supports ComfyUI API-format JSON and UI workflow JSON
- Extracts:
  - workflow name
  - version
  - node classes
  - checkpoint
  - LoRA
  - ControlNet
  - prompt/seed/steps/cfg/size mappings
  - model family
  - production category
- Marks production candidates as `active`
- Marks lower-confidence workflows as `draft`
- Can dry-run locally
- Can sync to Supabase with `--sync`

Dry-run result in current repo:

```json
{
  "scanned_files": 0,
  "parsed_workflows": 0,
  "recommended_workflows": 0,
  "categories": {},
  "errors": 0,
  "synced": 0
}
```

Reason:

- No ComfyUI workflow JSON files were found in the default workflow directories inside this repository.

Example usage:

```bash
node scripts/comfy-workflow-registry.mjs --dir "C:/path/to/workflows" --json
```

Sync recommended workflows:

```bash
node scripts/comfy-workflow-registry.mjs \
  --dir "C:/path/to/workflows" \
  --recommended-only \
  --sync \
  --user-id "<your-user-id>"
```

Sync requires:

- `SUPABASE_URL` or `VITE_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is only for local/admin sync and must not be exposed to GitHub Pages.

### 4. Production workflow categories

The registry prioritizes:

1. Flux character/image generation
2. Character consistency workflows
3. Face swap
4. Clothing transfer
5. Motion transfer
6. Simple image-to-video workflows

Complex video workflows are intentionally not prioritized.

### 5. Character Library relation path

Enhanced:

- `src/services/media-gateway-service.js`

Generation selection now supports:

1. Explicit `workflow_id`
2. Character-matched workflow through `character.lora`
3. Requested workflow category
4. Default active image workflow

This enables:

```text
Character
↓
LoRA
↓
Workflow
↓
Generation
```

### 6. Media Gateway workflow_id support

Enhanced:

- `src/services/media-gateway-service.js`
- `supabase/functions/media-gateway/index.ts`

Media Gateway now supports workflow records produced by the registry and accepts the registry mapping format:

```json
{
  "positive_prompt": { "node_id": "6", "input": "text" },
  "seed": { "node_id": "3", "input": "seed" },
  "width": { "node_id": "5", "input": "width" }
}
```

The Edge Function now also passes:

- `steps`
- `cfg`
- first resolved LoRA name
- workflow category metadata

### 7. Workflow Test Center

Added page:

- `src/pages/WorkflowTestCenter.jsx`

Added navigation entry:

- `Workflow Test`

The page supports:

- Listing registered ComfyUI workflows
- Filtering by category/status/search
- Showing model/checkpoint/LoRA/ControlNet/input mapping
- Selecting a content draft
- Running test image generation through Media Gateway
- Saving successful output to Supabase Storage and `assets`

## Files Added

- `docs/COMFYUI_CONNECTION_SETUP.md`
- `scripts/comfy-workflow-registry.mjs`
- `src/pages/WorkflowTestCenter.jsx`
- `supabase/migrations/20260720080512_phase3_7_2_comfy_workflow_registry.sql`
- `PHASE3_7_2_COMFYUI_WORKFLOW_REGISTRY_REPORT.md`

## Files Modified

- `src/App.jsx`
- `src/data/navigation.js`
- `src/services/media-gateway-service.js`
- `supabase/functions/media-gateway/index.ts`

## Validation

Passed:

- `npm run lint`
- `npm run build`
- `npm run migrations:check`

Migration check status:

- Overall status: safe
- Unsafe duplicate policies: 0
- Unsafe duplicate tables: 0
- Unsafe duplicate indexes: 0

## Remaining Setup Required

To complete real AutoDL production validation:

1. Configure Supabase Edge Function Secrets:
   - `COMFYUI_BASE_URL`
   - optional `COMFYUI_API_KEY`
   - optional timeout settings
2. Export or copy production ComfyUI workflow JSON files into a local scan directory.
3. Run the registry script against that directory.
4. Sync selected workflows into `comfy_workflows`.
5. Open Workflow Test Center and run one small Flux/portrait workflow.

## Next Recommended Step

Prepare a small production workflow folder first, for example:

```text
workflows-production/
├─ flux-character-portrait.json
├─ character-consistency-lora.json
├─ face-swap-reactor.json
├─ clothing-inpaint.json
└─ openpose-character.json
```

Then run:

```bash
node scripts/comfy-workflow-registry.mjs --dir workflows-production --json
```

Review the detected categories before syncing to Supabase.
