const verifiedAt = '2026-07-26T10:30:00.000Z';

export const productionWorkflowCapabilities = [
  {
    id: 'emma-s1-sdxl-t2i',
    name: 'Emma S1 SDXL 文生图',
    description: '根据当前内容文案、策略视觉方向和 Emma 角色模型生成图片。',
    mode: 'image',
    category: 'character_generation',
    status: 'validated',
    model: 'SDXL 1.0',
    checkpoint: 'DreamShaper XL',
    loras: ['Emma S1 SDXL LoRA'],
    input_schema: { required: ['prompt'], properties: { prompt: {}, negative_prompt: {}, width: {}, height: {}, seed: {} } },
    output_schema: { properties: { image: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 60, production_enabled: true },
    tags: ['emma', 'sdxl', 'lora', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
  {
    id: 'wan-remix-i2v',
    name: 'Wan 2.2 Remix 图生视频',
    description: '把内容工作台中已确认的图片生成 5–8 秒短视频。',
    mode: 'video',
    category: 'video_generation',
    status: 'validated',
    model: 'Wan 2.2 Remix',
    loras: [],
    input_schema: { required: ['prompt', 'image_url'], properties: { prompt: {}, image_url: {}, duration: {}, seed: {} } },
    output_schema: { properties: { video: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 150, production_enabled: true },
    tags: ['wan22', 'image-to-video', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
  {
    id: 'wan-remix-first-last',
    name: 'Wan 2.2 Remix 首尾帧视频',
    description: '使用两张已确认素材生成可控的首尾帧转场视频。',
    mode: 'video',
    category: 'video_generation',
    status: 'validated',
    model: 'Wan 2.2 Remix',
    loras: [],
    input_schema: { required: ['prompt', 'image_url', 'last_frame'], properties: { prompt: {}, image_url: {}, last_frame: {}, duration: {}, seed: {} } },
    output_schema: { properties: { video: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 210, production_enabled: true },
    tags: ['wan22', 'first-last-frame', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
  {
    id: 'ltx23-image-to-video',
    name: 'LTX 2.3 人物动作视频',
    description: '使用角色图片和内容脚本生成人物动作镜头。',
    mode: 'video',
    category: 'video_generation',
    status: 'validated',
    model: 'LTX 2.3',
    loras: ['LTX 2.3 Distilled LoRA'],
    input_schema: { required: ['prompt', 'image_url'], properties: { prompt: {}, negative_prompt: {}, image_url: {}, width: {}, height: {} } },
    output_schema: { properties: { video: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 90, production_enabled: true },
    tags: ['ltx23', 'character-motion', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
  {
    id: 'krea2-image-edit',
    name: 'Krea 2 人物图片编辑',
    description: '根据当前文案和视觉方向编辑角色参考图片。',
    mode: 'image',
    category: 'image_edit',
    status: 'validated',
    model: 'Krea 2',
    loras: ['Krea 2 Identity Edit'],
    input_schema: { required: ['prompt', 'image_url'], properties: { prompt: {}, negative_prompt: {}, image_url: {}, seed: {} } },
    output_schema: { properties: { image: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 60, production_enabled: true },
    tags: ['krea2', 'image-edit', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
  {
    id: 'flux-multiscene',
    name: 'Flux 多场景分镜图',
    description: '根据角色参考图生成多角度、多场景内容素材。',
    mode: 'image',
    category: 'storyboard',
    status: 'validated',
    model: 'Flux Klein 9B',
    loras: [],
    input_schema: { required: ['prompt', 'image_url'], properties: { prompt: {}, image_url: {}, seed: {} } },
    output_schema: { properties: { images: {} } },
    default_params: { provider: 'AutoDL / ComfyUI', estimated_seconds: 120, production_enabled: true },
    tags: ['flux', 'storyboard', 'multiscene', 'production'],
    source: 'gateway_registry',
    last_synced_at: verifiedAt,
  },
];

export function workflowRunsFromAssets(assets = []) {
  return assets
    .filter((asset) => asset.generation_provider === 'autodl' && asset.generation_workflow)
    .map((asset) => ({
      id: `asset-run:${asset.id}`,
      workflow_id: asset.generation_workflow,
      tool_id: asset.generation_workflow,
      character_id: asset.metadata?.character_id || null,
      campaign_id: asset.campaign_id || null,
      content_package_id: asset.content_package_id || null,
      asset_ids: [asset.id],
      status: asset.status === 'completed' ? 'success' : asset.status,
      created_at: asset.created_at,
      completed_at: asset.status === 'completed' ? asset.updated_at : null,
      output_data: { asset_id: asset.id, storage_path: asset.output_storage_path || null },
      input_data: { source: 'asset_library', provider: 'autodl' },
      cost: Number(asset.cost_estimate?.estimated_usd || 0),
    }));
}

export function mergeProductionWorkflows(rows = []) {
  const merged = new Map();
  [...productionWorkflowCapabilities, ...rows].forEach((workflow) => {
    const key = workflow.id || workflow.workflow_id || workflow.slug || workflow.name;
    if (!key) return;
    merged.set(key, {
      ...(merged.get(key) || {}),
      ...workflow,
    });
  });
  return [...merged.values()];
}

export function mergeWorkflowRuns(rows = [], assets = []) {
  const merged = new Map();
  [...workflowRunsFromAssets(assets), ...rows].forEach((run) => {
    const key = run.id;
    if (!key) return;
    merged.set(key, {
      ...(merged.get(key) || {}),
      ...run,
    });
  });
  return [...merged.values()];
}
