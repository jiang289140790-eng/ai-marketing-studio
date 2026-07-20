# Phase 3.7.3 Workflow Library Report

## Scope

AI Marketing Studio remains a Personal AI Ops Workspace.

This phase establishes the first production workflow library structure for self-hosted ComfyUI.

Not changed:

- Agent architecture
- Provider architecture
- RunningHub integration
- Video generation

## Completed

### 1. Production workflow directory

Created:

```text
workflows-production/
├── character/
├── face/
├── clothing/
├── pose/
├── image/
└── video/
```

Purpose:

- `character/`: portraits, character consistency, lifestyle photos
- `face/`: face swap workflows such as ReActor, InstantID, IPAdapter Face
- `clothing/`: clothing transfer, inpainting, reference outfit workflows
- `pose/`: pose control, OpenPose, DW-Pose, motion transfer workflows
- `image/`: general image workflows and smoke tests
- `video/`: reserved for later; not used in this phase

Added:

- `workflows-production/README.md`
- `.gitkeep` files for empty category folders

### 2. Workflow metadata standard

Defined top-level `_registry` metadata for each workflow JSON.

Required fields:

- `name`
- `version`
- `category`
- `mode`
- `checkpoint`
- `lora`
- `controlnet`
- `required_inputs`
- `node_mapping`
- `status`
- `priority`
- `tags`

Example:

```json
{
  "_registry": {
    "name": "Basic Image Smoke Test",
    "version": "1.0.0",
    "category": "character_generation",
    "mode": "image",
    "checkpoint": "sd_xl_base_1.0.safetensors",
    "lora": [],
    "controlnet": [],
    "required_inputs": [
      "positive_prompt",
      "negative_prompt",
      "seed",
      "width",
      "height"
    ],
    "node_mapping": {
      "positive_prompt": { "node_id": "6", "input": "text" },
      "negative_prompt": { "node_id": "7", "input": "text" },
      "seed": { "node_id": "3", "input": "seed" },
      "width": { "node_id": "5", "input": "width" },
      "height": { "node_id": "5", "input": "height" }
    }
  }
}
```

The registry script reads `_registry` metadata but strips it from `workflow_json` before output/sync, so ComfyUI receives a clean API prompt.

### 3. First test workflow

Added:

- `workflows-production/image/basic-image-smoke-test.json`

Mode:

- `image`

Supported inputs:

- `positive_prompt`
- `negative_prompt`
- `seed`
- `width`
- `height`
- `steps`
- `cfg`
- `checkpoint`

Default checkpoint:

- `sd_xl_base_1.0.safetensors`

Important:

- This checkpoint name must match the actual model installed in the AutoDL ComfyUI instance before real generation.

### 4. Registry script enhancement

Updated:

- `scripts/comfy-workflow-registry.mjs`

Enhancements:

- Adds `workflows-production/` as a default scan directory
- Supports explicit `_registry` metadata
- Uses metadata for name/category/mode/checkpoint/LoRA/ControlNet/required inputs/node mapping/version
- Strips `_registry` before saving `workflow_json`
- Keeps auto-detection as fallback

### 5. Dry-run validation

Executed:

```bash
node scripts/comfy-workflow-registry.mjs --dir workflows-production --json --output docs/workflow-registry-dry-run.json
```

Result:

```json
{
  "scanned_files": 1,
  "parsed_workflows": 1,
  "recommended_workflows": 1,
  "categories": {
    "character_generation": 1
  },
  "errors": 0,
  "synced": 0
}
```

Generated:

- `docs/workflow-registry-dry-run.json`

Validated:

- JSON parsing works
- Category detected as `character_generation`
- Mode detected as `image`
- Checkpoint detected
- Node mapping detected
- No parse errors

## Files Added

- `workflows-production/README.md`
- `workflows-production/character/.gitkeep`
- `workflows-production/face/.gitkeep`
- `workflows-production/clothing/.gitkeep`
- `workflows-production/pose/.gitkeep`
- `workflows-production/video/.gitkeep`
- `workflows-production/image/basic-image-smoke-test.json`
- `docs/workflow-registry-dry-run.json`
- `PHASE3_7_3_WORKFLOW_LIBRARY_REPORT.md`

## Files Modified

- `scripts/comfy-workflow-registry.mjs`

## Validation

Passed:

- `node scripts/comfy-workflow-registry.mjs --dir workflows-production --json --output docs/workflow-registry-dry-run.json`
- `npm run lint`
- `npm run build`
- `npm run migrations:check`

## Not Done Yet

No real ComfyUI generation was executed in this phase because the task was workflow library registration, not AutoDL runtime testing.

Still required for real generation:

1. Confirm the checkpoint name exists in AutoDL ComfyUI.
2. Configure `COMFYUI_BASE_URL` in Supabase Edge Function Secrets.
3. Sync the workflow to `comfy_workflows`.
4. Run it from Workflow Test Center.

## Next Recommended Step

Replace or add the first real production workflow from AutoDL:

```text
workflows-production/character/flux-character-portrait.json
```

Then dry-run:

```bash
node scripts/comfy-workflow-registry.mjs --dir workflows-production --json
```

After verifying node mappings, sync selected workflows to Supabase.
