function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function workflowMatchesCharacter(workflow, character) {
  return asArray(character?.recommended_workflows).some((entry) => {
    const id = typeof entry === 'object' ? entry.id || entry.workflow_id : entry;
    const name = typeof entry === 'object' ? entry.name || entry.workflow_name : entry;
    return String(id || '') === String(workflow.id)
      || normalizedText(name) === normalizedText(workflow.name);
  });
}

function providerForWorkflow(workflow, characters) {
  const binding = characters
    .flatMap((character) => asArray(character.recommended_workflows))
    .find((entry) => typeof entry === 'object'
      && (String(entry.id || entry.workflow_id || '') === String(workflow.id)
        || normalizedText(entry.name || entry.workflow_name) === normalizedText(workflow.name)));
  return binding?.provider
    || workflow.default_params?.provider
    || workflow.workflow_json?.provider
    || (normalizedText(workflow.name).includes('comfy') ? 'ComfyUI' : 'AutoDL / ComfyUI');
}

function runDuration(run) {
  if (!run?.completed_at || !run?.created_at) return null;
  const duration = new Date(run.completed_at).getTime() - new Date(run.created_at).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function buildWorkflowCapability(workflow, {
  characters = [],
  prompts = [],
  runs = [],
  assets = [],
} = {}) {
  const relatedRuns = runs.filter((run) => (
    String(run.workflow_id || '') === String(workflow.id)
    || normalizedText(run.tool_id) === normalizedText(workflow.name)
  ));
  const successfulRuns = relatedRuns.filter((run) => ['success', 'completed'].includes(normalizedText(run.status)));
  const durations = relatedRuns.map(runDuration).filter((value) => value != null);
  const costs = relatedRuns.map((run) => Number(run.cost)).filter(Number.isFinite);
  const latestRun = [...relatedRuns].sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))[0] || null;
  const latestAssetId = asArray(latestRun?.asset_ids)[0]
    || latestRun?.output_data?.asset_id
    || latestRun?.output_data?.asset_ids?.[0];
  const latestAsset = assets.find((asset) => String(asset.id) === String(latestAssetId)) || null;
  const boundCharacters = characters.filter((character) => workflowMatchesCharacter(workflow, character));
  const boundPromptIds = [
    workflow.default_params?.prompt_template_id,
    ...asArray(workflow.default_params?.prompt_template_ids),
  ].filter(Boolean).map(String);
  const boundPrompts = prompts.filter((prompt) => boundPromptIds.includes(String(prompt.id)));
  const supportsLora = asArray(workflow.loras).length > 0
    || Boolean(workflow.input_schema?.properties?.lora_name)
    || asArray(workflow.input_schema?.required).some((key) => String(key).includes('lora'));
  const active = ['active', 'validated', 'enabled'].includes(normalizedText(workflow.status));
  const validated = successfulRuns.length > 0;

  return {
    ...workflow,
    provider: providerForWorkflow(workflow, characters),
    baseModel: workflow.model || workflow.checkpoint || '未声明',
    inputType: workflow.mode === 'video' ? '文本 / 图片' : '文本',
    outputType: workflow.mode === 'video' ? '视频' : '图片',
    supportsLora,
    boundCharacters,
    boundPrompts,
    productionEnabled: active,
    availabilityStatus: validated ? 'validated' : active ? 'active' : workflow.status || 'inactive',
    latestRun,
    latestTestAt: latestRun?.completed_at || latestRun?.created_at || null,
    latestTestAsset: latestAsset,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    estimatedCost: costs.length ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null,
    runCount: relatedRuns.length,
    successCount: successfulRuns.length,
  };
}

export function deriveModelAssets(workflows = []) {
  const entries = [];
  const seen = new Set();
  const add = (name, type, workflow) => {
    if (!name || seen.has(`${type}:${name}`)) return;
    seen.add(`${type}:${name}`);
    entries.push({
      id: `${type}:${name}`,
      name,
      type,
      workflowName: workflow.name,
      status: workflow.status,
      provider: workflow.provider || '工作流运行环境',
    });
  };

  workflows.forEach((workflow) => {
    add(workflow.checkpoint || workflow.model, '基础模型 / Checkpoint', workflow);
    asArray(workflow.detected_models).forEach((model) => add(
      typeof model === 'object' ? model.name || model.filename : model,
      typeof model === 'object' ? model.type || '通用模型' : '通用模型',
      workflow,
    ));
    asArray(workflow.controlnets).forEach((model) => add(
      typeof model === 'object' ? model.name || model.filename : model,
      'ControlNet',
      workflow,
    ));
  });

  return entries;
}

