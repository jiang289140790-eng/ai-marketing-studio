function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function getAssetContext(asset = {}) {
  const raw = asset.raw || asset;
  const metadata = asObject(raw.metadata);
  const workflow = asObject(raw.workflow);
  const context = asObject(workflow.asset_context);
  return {
    campaignId: asset.campaignId || raw.campaign_id || context.campaign_id || '',
    day: Number(metadata.day || context.day || 0) || null,
    characterId: asset.characterId || raw.character_id || metadata.character_id || context.character_id || '',
    contentId: asset.contentId || raw.content_package_id || context.content_package_id || '',
    purpose: metadata.purpose || context.purpose || (asset.isPrimary ? '最终发布' : '内容生产'),
    source: context.source || asset.source || raw.generation_provider || '手动上传',
    rights: context.rights || metadata.rights || '',
  };
}

function looksTechnicalName(value) {
  return /^(?:[0-9a-f]{8}-[0-9a-f-]{20,}|comfyui[_ -]?\d+|z-image[_ -]?\d+|[\w-]+_0000\d+)$/i.test(String(value || '').trim());
}

export function buildAssetBusinessName(asset, {
  characterName = '',
  campaignName = '',
  index = 1,
} = {}) {
  const rawName = asset.name || asset.raw?.name || asset.raw?.output_storage_path?.split('/').pop() || '';
  if (rawName && !looksTechnicalName(rawName) && !/^(image|video|audio|asset|未命名素材)$/i.test(rawName)) return rawName;
  const context = getAssetContext(asset);
  const type = String(asset.type || asset.raw?.asset_type || 'image').toLowerCase();
  const typeLabel = type === 'video' ? '候选视频' : type === 'audio' ? '候选音频' : '候选图';
  const owner = characterName || campaignName || '运营素材';
  const day = context.day ? ` · Day ${context.day}` : '';
  return `${owner}${day} ${typeLabel} ${String(index).padStart(2, '0')}`;
}

export function classifyAsset(asset) {
  const context = getAssetContext(asset);
  const raw = asset.raw || asset;
  if (asset.isPrimary || asset.approvedForPublishing || raw.approved_for_publishing) return 'final';
  if (context.contentId) return 'current';
  if (asset.generationJobId || raw.generation_task_id) return 'generated';
  if (context.source === 'upload' || asset.source === 'upload') return 'uploaded';
  return 'reference';
}

export function isAssetReferenced(asset, {
  contentItems = [],
  publishTasks = [],
} = {}) {
  const id = String(asset.id || '');
  const context = getAssetContext(asset);
  if (context.contentId || asset.approvedForPublishing || asset.isPrimary) return true;
  if (contentItems.some((item) => String(item.asset_id || '') === id)) return true;
  return publishTasks.some((task) => JSON.stringify(task.publish_content || {}).includes(id));
}
