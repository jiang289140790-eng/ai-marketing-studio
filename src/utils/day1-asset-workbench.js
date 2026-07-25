const JOB_STATUS_LABELS = {
  pending: '排队中',
  queued: '排队中',
  running: '运行中',
  generating: '运行中',
  success: '已完成',
  completed: '已完成',
  failed: '失败',
  error: '失败',
  cancelled: '已取消',
  canceled: '已取消',
};

export { JOB_STATUS_LABELS };

export function normalizeGenerationJob(run = {}) {
  const input = objectValue(run.input_data);
  const output = objectValue(run.output_data);
  const lifecycle = String(input.lifecycle_status || run.status || 'pending').toLowerCase();
  return {
    id: run.id,
    campaignId: input.campaign_id || null,
    contentPackageId: input.content_package_id || input.content_id || null,
    contentItemId: input.content_item_id || null,
    characterId: run.character_id || input.character_id || null,
    lora: objectValue(input.lora),
    workflowId: input.comfy_workflow_id || input.workflow_id || run.workflow_id || null,
    workflowName: input.workflow_name || run.tool_id || '生成工作流',
    prompt: input.prompt || '',
    provider: input.provider || 'autodl',
    assetType: input.asset_type || 'image',
    status: lifecycle,
    statusLabel: JOB_STATUS_LABELS[lifecycle] || lifecycle,
    progress: Number(output.progress || input.progress || (['success', 'completed'].includes(lifecycle) ? 100 : 0)),
    outputReferences: output.asset_ids || output.output_references || run.asset_ids || [],
    errorSummary: run.error_message || run.last_error || output.error || null,
    createdAt: run.created_at,
    completedAt: run.completed_at,
    retryCount: Number(run.retry_count || 0),
    raw: run,
  };
}

export function listJobsForContent(runs = [], contentPackageId) {
  return runs
    .map(normalizeGenerationJob)
    .filter((job) => String(job.contentPackageId || '') === String(contentPackageId || ''))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export function inspectAssetAvailability(asset = {}) {
  const raw = asset.raw || asset;
  const metadata = objectValue(raw.metadata);
  const status = String(asset.status || raw.status || '').toLowerCase();
  const url = asset.url || raw.output_url || raw.media_url || raw.storage_url || '';
  const storagePath = raw.output_storage_path || metadata.storage_path || '';
  const reasons = [];

  if (!['completed', 'approved', 'ready'].includes(status)) reasons.push('素材尚未生成完成');
  if (!url && !storagePath) reasons.push('任务完成但没有输出文件');
  if (url && !isSafeMediaUrl(url)) reasons.push('素材 URL 无效');
  if (metadata.broken === true || metadata.usability === 'unavailable') reasons.push('素材已标记为不可用');
  if (metadata.storage_missing === true) reasons.push('Storage 文件不存在');
  if (metadata.signed_url_expired === true) reasons.push('Signed URL 已过期');

  return {
    usable: reasons.length === 0,
    reasons,
    url,
    storagePath,
  };
}

export function filterUsableAssets(assets = []) {
  return assets.filter((asset) => inspectAssetAvailability(asset).usable);
}

export function getCharacterLoras(character = {}, contentBinding = {}) {
  const safeCharacter = objectValue(character);
  const safeContentBinding = objectValue(contentBinding);
  const sources = [
    safeContentBinding.loraInfo,
    safeCharacter.lora_info,
    safeCharacter.lora,
    safeCharacter.loras,
    safeCharacter.lora_configs,
  ];
  const values = sources.flatMap((source) => {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (typeof source === 'string') return [{ name: source, model: source }];
    return [source];
  });
  const seen = new Set();
  return values.filter((value) => {
    if (!value || typeof value !== 'object') return false;
    const key = String(value.id || value.model || value.filename || value.path || value.name || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getRecommendedWorkflows(character = {}, workflows = [], assetType = 'image') {
  const safeCharacter = objectValue(character);
  const recommendations = arrayValue(safeCharacter.recommended_workflows);
  const recommendationKeys = new Set(recommendations.flatMap((item) => {
    if (typeof item === 'string') return [item.toLowerCase()];
    return [item?.id, item?.name, item?.workflow_id].filter(Boolean).map((value) => String(value).toLowerCase());
  }));
  return workflows
    .filter((workflow) => workflow.status === 'active' && (!workflow.mode || workflow.mode === assetType))
    .sort((a, b) => {
      const aRecommended = recommendationKeys.has(String(a.id).toLowerCase()) || recommendationKeys.has(String(a.name).toLowerCase());
      const bRecommended = recommendationKeys.has(String(b.id).toLowerCase()) || recommendationKeys.has(String(b.name).toLowerCase());
      if (aRecommended !== bRecommended) return aRecommended ? -1 : 1;
      return Number(a.priority || 100) - Number(b.priority || 100);
    });
}

function isSafeMediaUrl(value) {
  try {
    const parsed = new globalThis.URL(value);
    return ['https:', 'http:', 'blob:', 'data:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}
