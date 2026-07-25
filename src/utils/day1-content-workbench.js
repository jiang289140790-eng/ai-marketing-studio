export const CONTENT_STATUS_LABELS = {
  pending_generation: '待生成',
  generating: '生成中',
  pending_review: '待审核',
  needs_revision: '需要修改',
  approved: '已批准',
  media_pending_generation: '素材待生成',
  media_pending_confirmation: '素材待确认',
  ready_to_publish: '准备发布',
  scheduled: '已排期',
  published: '已发布',
};

export function getVersionsForPackage(contentRows = [], contentPackageId) {
  return (contentRows || [])
    .filter((item) => String(asObject(item.generation_brief).content_package_id || '') === String(contentPackageId || ''))
    .map((item) => {
      const brief = asObject(item.generation_brief);
      return {
        id: item.id,
        versionNumber: Number(brief.version_number || 0),
        revisionType: brief.revision_type || 'generated',
        parentVersionId: brief.parent_version_id || null,
        title: item.title || '',
        hook: brief.hook || '',
        body: item.content_text || '',
        cta: item.cta || brief.cta || '',
        hashtags: normalizeList(item.hashtags || brief.hashtags),
        languageStyle: brief.language_style || '',
        model: item.model || '',
        createdAt: item.created_at,
        raw: item,
      };
    })
    .sort((left, right) => left.versionNumber - right.versionNumber || String(left.createdAt).localeCompare(String(right.createdAt)));
}

export function getWorkbenchMetadata(contentPackage) {
  return asObject(asObject(contentPackage?.raw?.source_insights).content_workbench);
}

export function inspectContentRisks(copy, platform) {
  const text = `${copy?.title || ''}\n${copy?.hook || ''}\n${copy?.body || ''}\n${copy?.cta || ''}`;
  const blocking = [];
  const warnings = [];
  if (!String(copy?.body || '').trim()) blocking.push('缺少正文');
  if (!String(copy?.cta || '').trim()) blocking.push('缺少行动引导');
  if (/guaranteed|100% guaranteed|稳赚|保赚|绝对有效/i.test(text)) blocking.push('包含绝对化或保证性表述');
  if (String(platform || '').toLowerCase() === 'x' && text.length > 1200) warnings.push('内容对于 X 平台可能过长');
  if (!String(copy?.hook || '').trim()) warnings.push('缺少明确开头');
  if (!normalizeList(copy?.hashtags).length) warnings.push('尚未设置标签');
  return { blocking, warnings };
}

export function deriveContentDisplayStatus({ contentPackage, assets = [], publishTask = null, selectedVersionId = '' }) {
  const metadata = getWorkbenchMetadata(contentPackage);
  const approvedAssets = assets.filter((item) => (
    item.status === 'completed'
    && (item.raw?.approved_for_publishing === true || item.approvedForPublishing === true)
  ));
  if (publishTask?.status === 'published' || contentPackage?.reviewStatus === 'published') return 'published';
  if (publishTask?.status === 'scheduled' || publishTask?.scheduled_at || publishTask?.scheduled_time) return 'scheduled';
  if (publishTask) return 'ready_to_publish';
  if (metadata.copy_approved && approvedAssets.length) return 'ready_to_publish';
  if (metadata.copy_approved && !assets.length) return 'media_pending_generation';
  if (metadata.copy_approved && !approvedAssets.length) return 'media_pending_confirmation';
  if (metadata.copy_approved || contentPackage?.reviewStatus === 'approved') return 'approved';
  if (metadata.revision_requested || contentPackage?.reviewStatus === 'rejected') return 'needs_revision';
  if (contentPackage?.reviewStatus === 'review' || selectedVersionId) return 'pending_review';
  if (metadata.generation_status === 'running') return 'generating';
  return 'pending_generation';
}

export function buildReadiness({ contentPackage, copy, assets = [], publishTask = null, character, lora }) {
  const metadata = getWorkbenchMetadata(contentPackage);
  const selectedVersionId = metadata.selected_version_id || '';
  const approvedAssets = assets.filter((item) => (
    item.status === 'completed'
    && (item.raw?.approved_for_publishing === true || item.approvedForPublishing === true)
  ));
  const risks = inspectContentRisks(copy, contentPackage?.platform);
  const checks = {
    selectedVersion: Boolean(selectedVersionId),
    copyComplete: Boolean(String(copy?.body || '').trim() && String(copy?.cta || '').trim()),
    copyApproved: metadata.copy_approved === true,
    characterReady: Boolean(character && hasLora(lora)),
    mediaConfirmed: approvedAssets.length > 0,
    risksClear: risks.blocking.length === 0,
    publishTaskCreated: Boolean(publishTask),
  };
  return {
    checks,
    risks,
    approvedAssets,
    readyForPublishTask: checks.selectedVersion && checks.copyApproved && checks.mediaConfirmed && checks.risksClear,
  };
}

export function statusPrimaryAction(status) {
  const map = {
    pending_generation: '生成候选文案',
    generating: '等待生成结果',
    pending_review: '审核或修改主版本',
    needs_revision: '按意见生成新版本',
    approved: '确认角色与素材',
    media_pending_generation: '生成图片或视频',
    media_pending_confirmation: '确认可用素材',
    ready_to_publish: '创建待发布任务',
    scheduled: '等待排期执行',
    published: '查看发布结果',
  };
  return map[status] || '继续处理';
}

function hasLora(lora) {
  return Boolean(lora && (lora.id || lora.name || lora.model || lora.filename || lora.path || lora.url));
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value).flat().map(String).filter(Boolean);
  return String(value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
