# Phase 3.7.4 Flux Workflow Registration Report

## Scope

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase focuses on registering the first Flux character-generation workflow candidate for self-hosted AutoDL ComfyUI.

Not changed:

- Agent architecture
- Provider architecture
- Video generation
- RunningHub integration

## Completed

### 1. Real workflow import path prepared

Target directory:

```text
workflows-production/
```

Priority directory:

```text
workflows-production/character/
```

This matches the production workflow library structure created in Phase 3.7.3.

### 2. Flux character workflow added

Added:

- `workflows-production/character/flux-character-portrait-v1.json`

Workflow metadata:

```json
{
  "name": "Flux Character Portrait",
  "version": "1.0.0",
  "category": "character_generation",
  "mode": "image",
  "model": "Flux",
  "checkpoint": "flux1-dev-fp8.safetensors",
  "lora": ["character-consistency-lora.safetensors"]
}
```

Supported runtime inputs:

- `positive_prompt`
- `negative_prompt`
- `seed`
- `width`
- `height`
- `steps`
- `cfg`
- `checkpoint`
- `lora`

Node mapping:

```json
{
  "positive_prompt": { "node_id": "8", "input": "text" },
  "negative_prompt": { "node_id": "9", "input": "text" },
  "seed": { "node_id": "10", "input": "seed" },
  "steps": { "node_id": "10", "input": "steps" },
  "cfg": { "node_id": "10", "input": "cfg" },
  "width": { "node_id": "7", "input": "width" },
  "height": { "node_id": "7", "input": "height" },
  "checkpoint": { "node_id": "4", "input": "ckpt_name" },
  "lora": { "node_id": "5", "input": "lora_name" }
}
```

Important:

- The workflow is a production candidate using standard ComfyUI API prompt structure.
- Before live generation, confirm these files exist in the AutoDL ComfyUI instance:
  - `flux1-dev-fp8.safetensors`
  - `character-consistency-lora.safetensors`
- If your actual AutoDL model or LoRA filenames differ, update the `_registry.checkpoint`, `_registry.lora`, and matching node inputs.

### 3. Registry scan validation

Executed:

```bash
node scripts/comfy-workflow-registry.mjs --dir workflows-production --json --output docs/workflow-registry-phase3-7-4-dry-run.json
```

Result:

```json
{
  "scanned_files": 2,
  "parsed_workflows": 2,
  "recommended_workflows": 2,
  "categories": {
    "character_generation": 2
  },
  "errors": 0,
  "synced": 0
}
```

Generated:

- `docs/workflow-registry-phase3-7-4-dry-run.json`

Validated:

- Workflow JSON parsing works
- Flux workflow category is `character_generation`
- Mode is `image`
- Model is `Flux`
- Checkpoint is detected
- LoRA is detected
- Node mapping is detected
- No registry parse errors

### 4. Database sync test

Attempted:

```bash
node scripts/comfy-workflow-registry.mjs --dir workflows-production --recommended-only --sync --user-id 00000000-0000-0000-0000-000000000000 --json
```

Result:

```text
Sync requires SUPABASE_URL/VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
```

Status:

- No data was written to Supabase.
- This is expected and safe because the current shell does not expose the required server-side Supabase credentials.
- The script correctly refused to sync without `SUPABASE_SERVICE_ROLE_KEY`.

Required for real sync:

```bash
$env:SUPABASE_URL="https://qtrlymiqohbjvklwegsw.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"
$env:COMFYUI_WORKFLOW_USER_ID="<your-auth-user-id>"

node scripts/comfy-workflow-registry.mjs `
  --dir workflows-production `
  --recommended-only `
  --sync
```

Do not commit or expose `SUPABASE_SERVICE_ROLE_KEY`.

## Files Added

- `workflows-production/character/flux-character-portrait-v1.json`
- `docs/workflow-registry-phase3-7-4-dry-run.json`
- `PHASE3_7_4_FLUX_WORKFLOW_REGISTRATION_REPORT.md`

## Validation

Passed:

- `node scripts/comfy-workflow-registry.mjs --dir workflows-production --json --output docs/workflow-registry-phase3-7-4-dry-run.json`
- `npm run lint`
- `npm run build`
- `npm run migrations:check`

Migration check status:

- Overall status: safe
- Unsafe duplicate policies: 0
- Unsafe duplicate tables: 0
- Unsafe duplicate indexes: 0

## Current Capability

AI Marketing Studio can now register and parse a Flux character-generation workflow candidate with:

- checkpoint metadata
- LoRA metadata
- required inputs
- node mapping
- image mode
- character-generation category

Once synced into `comfy_workflows`, it will appear in Workflow Test Center and can be used by Media Gateway.

## Next Step

To complete actual production registration:

1. Confirm the exact checkpoint and LoRA filenames in AutoDL ComfyUI.
2. Provide or configure server-side Supabase sync credentials locally.
3. Run the registry sync command.
4. Open Workflow Test Center.
5. Select `Flux Character Portrait`.
6. Run one image generation test.
