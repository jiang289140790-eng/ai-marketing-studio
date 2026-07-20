# workflows-production

This folder contains production-ready or production-candidate ComfyUI workflows for AI Marketing Studio.

Do not store secrets here. Workflow JSON files may contain model names, LoRA names, ControlNet names, and node mappings, but must not contain API keys or private service tokens.

## Folder structure

```text
workflows-production/
├── character/  # character_generation: portraits, character consistency, lifestyle images
├── face/       # face_swap: ReActor, InstantID, IPAdapter Face
├── clothing/   # clothing_transfer: inpainting, outfit/garment transfer
├── pose/       # motion_transfer: OpenPose, DW-Pose, pose ControlNet
├── image/      # general image smoke tests and reusable image workflows
└── video/      # video_generation; not prioritized in Phase 3.7.3
```

## Metadata standard

Each workflow JSON should include a top-level `_registry` block:

```json
{
  "_registry": {
    "name": "Workflow display name",
    "version": "1.0.0",
    "category": "character_generation",
    "mode": "image",
    "checkpoint": "model-name.safetensors",
    "lora": [],
    "controlnet": [],
    "required_inputs": ["positive_prompt", "negative_prompt", "seed", "width", "height"],
    "node_mapping": {
      "positive_prompt": { "node_id": "6", "input": "text" },
      "negative_prompt": { "node_id": "7", "input": "text" },
      "seed": { "node_id": "3", "input": "seed" },
      "width": { "node_id": "5", "input": "width" },
      "height": { "node_id": "5", "input": "height" }
    },
    "status": "active",
    "priority": 20,
    "tags": ["image", "smoke-test"]
  }
}
```

Supported categories:

- `character_generation`
- `motion_transfer`
- `face_swap`
- `clothing_transfer`
- `video_generation`

Phase 3.7.3 intentionally does not prioritize video workflows.
