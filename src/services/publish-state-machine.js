import {
  collectConnectionPermissions,
  connectionIsActive,
  getUnifiedConnectionState,
} from '../utils/platform-connection-summary.js';

export const CONTENT_APPROVAL = {
  pending: { label: '待审核', tone: 'pending' },
  approved: { label: '已批准', tone: 'approved' },
  needs_revision: { label: '需要修改', tone: 'review' },
  rejected: { label: '已拒绝', tone: 'rejected' },
};

export const PUBLISH_TASK_STATE = {
  draft: { label: '草稿', group: 'pending' },
  pending_approval: { label: '待批准', group: 'pending' },
  scheduled: { label: '已排期', group: 'calendar' },
  publishing: { label: '发布中', group: 'publishing' },
  published: { label: '已发布', group: 'history' },
  failed: { label: '发布失败', group: 'pending' },
  cancelled: { label: '已取消', group: 'history' },
};

export const EXECUTION_MODE = {
  dry_run: { label: '测试执行', description: '不会执行真实发布' },
  live: { label: '正式发布', description: '满足安全条件后调用平台' },
};

export function getContentApprovalState(task = {}, content = {}) {
  const workbench = content.raw?.source_insights?.content_workbench || {};
  const raw = String(
    task.publish_content?.content_approval_status
    || content.reviewStatus
    || content.raw?.review_status
    || '',
  ).toLowerCase();
  if (raw === 'approved' || workbench.copy_approved === true || content.approvedForPublishing) return 'approved';
  if (['needs_revision', 'revision_requested', 'review'].includes(raw)) return 'needs_revision';
  if (raw === 'rejected') return 'rejected';
  return 'pending';
}

export function getPublishTaskState(task = {}) {
  const status = String(task.status || 'draft').toLowerCase();
  const approval = String(task.approval_status || 'pending').toLowerCase();
  if (['scheduled', 'publishing', 'published', 'failed', 'cancelled'].includes(status)) return status;
  if (['rejected', 'cancelled'].includes(approval)) return 'cancelled';
  if (approval !== 'approved') return 'pending_approval';
  return 'draft';
}

export function getExecutionMode(task = {}) {
  const result = asObject(task.publish_result || task.result);
  return result.execution_mode || result.last_execution?.mode || 'dry_run';
}

export function getDryRunPresentation(task = {}) {
  const result = asObject(task.publish_result || task.result);
  const preflight = asObject(result.preflight);
  const lastExecution = asObject(result.last_execution);
  if (lastExecution.mode !== 'dry_run' && !preflight.checked_at) return null;
  return {
    passed: preflight.passed === true,
    title: preflight.passed ? '上次安全预演通过' : '上次安全预演未通过',
    summary: preflight.passed
      ? '测试执行完成，未执行真实发布。'
      : '未执行真实发布；具体结果以当前业务检查和执行条件为准。',
    checkedAt: preflight.checked_at || lastExecution.completed_at,
  };
}

export function getPublishReadiness({ checks = [], task = {}, humanAuthorized = false } = {}) {
  const businessPassed = checks.filter((item) => item.passed).length;
  const businessTotal = checks.length;
  const storedPreflightPassed = task.publish_result?.preflight?.passed === true;
  const executionConditionsMet = storedPreflightPassed && humanAuthorized;
  return {
    businessPassed,
    businessTotal,
    businessReady: businessTotal > 0 && businessPassed === businessTotal,
    storedPreflightPassed,
    executionConditionsMet,
    finalState: executionConditionsMet ? 'ready' : 'blocked',
    finalLabel: executionConditionsMet ? '可以发布' : '暂不可发布',
  };
}

export function buildPublishPreflightChecksLegacy({ task = {}, content = {}, connection = {}, account = {}, asset = {}, now = new Date() }) {
  const platform = String(task.platform || content.platform || connection.platform || '').toLowerCase();
  const body = String(task.publish_content?.body || task.final_text || task.content_text || content.body || '').trim();
  const contentApproved = getContentApprovalState(task, content) === 'approved';
  const assetUrl = asset.url || asset.raw?.output_url || task.publish_content?.assets?.[0]?.output_url || '';
  const assetApproved = Boolean(
    asset.approvedForPublishing
    || asset.raw?.approved_for_publishing
    || task.publish_content?.asset_approved,
  );
  const accountConnected = Boolean(
    connectionIsActive(connection)
    && (account.id || connection.account_id),
  );
  const scopes = normalizeList(connection.permissions || connection.scopes || connection.metadata?.scopes);
  const permissionValid = accountConnected && (
    platform === 'telegram'
    || connection.can_publish === true
    || connection.metadata?.can_publish === true
    || scopes.some((item) => /(write|publish|tweet\.write|messages)/i.test(item))
  );
  const formatLimit = platform === 'telegram' ? 4096 : platform === 'x' || platform.includes('twitter') ? 280 : 10000;
  const formatValid = body.length > 0 && body.length <= formatLimit;
  const assetUrlValid = isValidHttpsUrl(assetUrl);
  const schedule = task.scheduled_at || task.scheduled_time || task.publish_time;
  const scheduleValid = !schedule || (!Number.isNaN(new Date(schedule).getTime()) && new Date(schedule).getTime() >= now.getTime() - 60_000);
  const executionMode = getExecutionMode(task);

  return [
    check('content_approved', '内容已批准', contentApproved, '请先回到内容工作台批准文案'),
    check('asset_approved', '素材已批准', assetApproved, '请先确认主素材'),
    check('account_connected', '账号已连接', accountConnected, '请检查平台连接'),
    check('publish_permission', '发布权限有效', permissionValid, '当前连接没有可验证的发布权限'),
    check('platform_format', '平台格式有效', formatValid, `正文 ${body.length}/${formatLimit} 字符`),
    check('asset_url', '素材 URL 有效', assetUrlValid, '主素材链接不可用'),
    check('schedule_valid', '排期有效', scheduleValid, '发布时间已过期或格式无效'),
    check('execution_mode', '执行模式明确', ['dry_run', 'live'].includes(executionMode), '请选择测试执行或正式发布'),
  ];
}

export function buildPublishPreflightChecks({ task = {}, content = {}, connection = {}, account = {}, asset = {}, now = new Date() }) {
  const platform = String(task.platform || content.platform || connection.platform || '').toLowerCase();
  const body = String(task.publish_content?.body || task.final_text || task.content_text || content.body || '').trim();
  const contentApproved = getContentApprovalState(task, content) === 'approved';
  const embeddedAssets = Array.isArray(task.publish_content?.assets) ? task.publish_content.assets : [];
  const selectedIds = new Set([
    ...(Array.isArray(task.publish_content?.selected_asset_ids) ? task.publish_content.selected_asset_ids : []),
    task.publish_content?.selected_asset_id,
  ].filter(Boolean).map(String));
  const selectedEmbeddedAssets = selectedIds.size
    ? embeddedAssets.filter((item) => selectedIds.has(String(item.id)))
    : embeddedAssets;
  const mediaAssets = selectedEmbeddedAssets.length
    ? selectedEmbeddedAssets.map((item) => ({
      url: item.output_url || item.url || '',
      type: String(item.type || item.asset_type || '').toLowerCase(),
      approved: item.approved_for_publishing !== false && item.status !== 'failed',
    }))
    : [{
      url: asset.url || asset.raw?.output_url || '',
      type: String(asset.type || asset.raw?.asset_type || '').toLowerCase(),
      approved: Boolean(asset.approvedForPublishing || asset.raw?.approved_for_publishing || task.publish_content?.asset_approved),
    }].filter((item) => item.url);
  const mediaOptional = mediaAssets.length === 0 && body.length > 0 && (platform === 'x' || platform === 'telegram');
  const assetApproved = mediaOptional || (mediaAssets.length > 0 && mediaAssets.every((item) => item.approved));
  const accountConnected = Boolean(connectionIsActive(connection) && (account.id || connection.account_id));
  const scopes = normalizeList(connection.permissions || connection.scopes || connection.metadata?.scopes);
  const permissionValid = accountConnected && (
    platform === 'telegram'
    || connection.can_publish === true
    || connection.metadata?.can_publish === true
    || scopes.some((item) => /(write|publish|tweet\.write|messages)/i.test(item))
  );
  const formatLimit = platform === 'telegram' ? 4096 : platform === 'x' || platform.includes('twitter') ? 280 : 10000;
  const imageCount = mediaAssets.filter((item) => item.type !== 'video').length;
  const videoCount = mediaAssets.filter((item) => item.type === 'video').length;
  const mediaFormatValid = platform !== 'x' || (imageCount <= 4 && videoCount <= 1 && !(imageCount && videoCount));
  const formatValid = (body.length > 0 || mediaAssets.length > 0) && body.length <= formatLimit && mediaFormatValid;
  const assetUrlValid = mediaOptional || (mediaAssets.length > 0 && mediaAssets.every((item) => isValidHttpsUrl(item.url)));
  const schedule = task.scheduled_at || task.scheduled_time || task.publish_time;
  const scheduleValid = !schedule || (!Number.isNaN(new Date(schedule).getTime()) && new Date(schedule).getTime() >= now.getTime() - 60_000);
  const executionMode = getExecutionMode(task);
  const mediaSummary = videoCount ? '1 个视频' : `${imageCount} 张图片`;

  return [
    check('content_approved', '内容已批准', contentApproved, '请先回到内容工作台批准文案'),
    check('asset_approved', '素材已批准', assetApproved, '请先确认所有待发布素材'),
    check('account_connected', '账号已连接', accountConnected, '请检查平台连接'),
    check('publish_permission', '发布权限有效', permissionValid, '当前连接没有可验证的发布权限'),
    check('platform_format', '平台格式有效', formatValid, mediaFormatValid ? `正文 ${body.length}/${formatLimit} 字符 · ${mediaSummary}` : 'X 仅支持最多 4 张图，或单独 1 个视频'),
    check('asset_url', '素材链接有效', assetUrlValid, '一个或多个素材链接不可用'),
    check('schedule_valid', '排期有效', scheduleValid, '发布时间已过期或格式无效'),
    check('execution_mode', '执行模式明确', ['dry_run', 'live'].includes(executionMode), '请选择安全预演或正式发布'),
  ];
}

export function buildPublishPreflightGroups({
  task = {},
  content = {},
  connection = {},
  account = {},
  asset = {},
  campaign = {},
  now = new Date(),
} = {}) {
  const platform = normalizePlatform(task.platform || content.platform || connection.platform);
  const body = String(task.publish_content?.body || task.final_text || task.content_text || content.body || '').trim();
  const media = resolvePublishMedia(task, asset);
  const contentApproved = getContentApprovalState(task, content) === 'approved';
  const mediaOptional = media.length === 0 && body.length > 0 && ['x', 'telegram'].includes(platform);
  const assetApproved = mediaOptional || (media.length > 0 && media.every((item) => item.approved));
  const formatLimit = platform === 'telegram' ? 4096 : platform === 'x' ? 280 : 10000;
  const images = media.filter((item) => item.type !== 'video').length;
  const videos = media.filter((item) => item.type === 'video').length;
  const mediaFormatValid = platform !== 'x' || (images <= 4 && videos <= 1 && !(images && videos));
  const formatValid = (body.length > 0 || media.length > 0) && body.length <= formatLimit && mediaFormatValid;
  const campaignValid = Boolean(
    campaign.id
    || task.campaign_id
    || content.campaignId
    || content.campaign_id,
  );
  const schedule = task.scheduled_at || task.scheduled_time || task.publish_time;
  const scheduleValid = !schedule || (
    !Number.isNaN(new Date(schedule).getTime())
    && new Date(schedule).getTime() >= now.getTime() - 60_000
  );

  const registered = Boolean(account.id || connection.account_id || task.platform_account_id || task.account_id);
  const unifiedConnection = getUnifiedConnectionState(connection.id ? [connection] : [], now);
  const oauthValid = connectionIsActive(connection, now) && unifiedConnection.oauthValid;
  const permissions = collectConnectionPermissions(connection.id ? [connection] : []);
  const metadata = asObject(connection.metadata);
  const quotaDepleted = String(metadata.credits_status || metadata.quota_status || '').toLowerCase() === 'depleted'
    || Number(metadata.credits_remaining ?? metadata.quota_remaining) === 0;
  const tokenExpired = Boolean(
    connection.expires_at
    && new Date(connection.expires_at).getTime() <= now.getTime()
    && !oauthValid,
  );
  const permissionDeclared = (
    connection.can_publish === true
    || metadata.can_publish === true
    || permissions.some((item) => /(write|publish|tweet\.write|messages|media\.write)/i.test(item))
    || platform === 'telegram'
  );
  const publishCapability = oauthValid && permissionDeclared && !quotaDepleted && !tokenExpired;
  const executionMode = getExecutionMode(task);
  const humanApproved = String(task.approval_status || '').toLowerCase() === 'approved'
    || Boolean(task.approved_at || task.publish_result?.human_authorized);

  const contentChecks = [
    check('content_approved', '文案已批准', contentApproved, '返回内容工作台完成文案审核'),
    check('asset_approved', '素材已批准', assetApproved, mediaOptional ? '当前为纯文字内容' : '确认全部待发布素材'),
    check(
      'platform_format',
      '格式有效',
      formatValid,
      mediaFormatValid ? `正文 ${body.length}/${formatLimit} 字符` : 'X 只能发布最多 4 张图片，或单独 1 个视频',
    ),
    check('campaign_valid', '运营活动有效', campaignValid, '关联当前运营活动'),
    check('schedule_valid', '时间有效', scheduleValid, '修改已过期或无效的发布时间'),
  ];
  const platformChecks = [
    check('account_registered', '账号已登记', registered, '先在账号矩阵登记发布账号'),
    check(
      'oauth_valid',
      'OAuth 有效',
      oauthValid,
      registered ? (tokenExpired ? 'OAuth 已过期，请重新连接账号' : '到平台连接完成 OAuth') : '尚未绑定平台账号',
    ),
    check(
      'publish_capability',
      '发布能力可用',
      publishCapability,
      quotaDepleted ? '平台额度已用尽' : !permissionDeclared ? '当前授权缺少发布权限' : '当前账号不可发布',
    ),
  ];
  const executionAuthorization = {
    mode: executionMode,
    modeLabel: EXECUTION_MODE[executionMode]?.label || '未设置',
    modeValid: ['dry_run', 'live'].includes(executionMode),
    humanApproved,
    label: executionMode === 'dry_run'
      ? '安全预演，无需真实发布授权'
      : humanApproved ? '人工授权已确认' : '等待人工确认正式发布',
  };
  const contentPassed = contentChecks.filter((item) => item.passed).length;
  const platformPassed = platformChecks.filter((item) => item.passed).length;
  const businessReady = contentPassed === contentChecks.length && platformPassed === platformChecks.length;
  const executionReady = executionAuthorization.modeValid
    && (executionMode === 'dry_run' || humanApproved);

  return {
    contentChecks,
    platformChecks,
    executionAuthorization,
    contentPassed,
    contentTotal: contentChecks.length,
    platformPassed,
    platformTotal: platformChecks.length,
    businessReady,
    executionReady,
    finalState: businessReady && executionReady ? 'ready' : 'blocked',
    finalLabel: businessReady && executionReady ? '可以执行' : '暂不可发布',
    blockers: [...contentChecks, ...platformChecks].filter((item) => !item.passed),
    connection: {
      registered,
      oauthValid,
      publishCapability,
      quotaDepleted,
      tokenExpired,
    },
  };
}

export function getPublishErrorPresentation(task = {}) {
  const result = asObject(task.publish_result || task.result);
  const error = asObject(result.error);
  if (getPublishTaskState(task) !== 'failed' && !task.error_message && !task.last_error) return null;
  const raw = String(error.summary || task.error_message || task.last_error || '');
  return {
    code: error.code || 'PUBLISH_FAILED',
    summary: safePublishErrorSummary(raw),
    impact: error.impact || '当前任务没有完成发布，已保存的内容和素材不会丢失。',
    retryable: error.retryable !== false && Number(task.retry_count || 0) < Number(task.max_retries || task.max_retry || 3),
    recommendedAction: error.recommended_action || '检查平台连接后重试',
    technicalDetail: sanitizePublishTechnicalDetail(raw),
  };
}

export function getPublishPrimaryActions(task = {}) {
  const state = getPublishTaskState(task);
  if (state === 'pending_approval') return ['preflight', 'approve_and_schedule', 'return_to_workspace'];
  if (state === 'draft') return ['schedule', 'return_to_workspace'];
  if (state === 'scheduled') return ['reschedule', 'publish_now', 'cancel'];
  if (state === 'failed') return ['view_error', 'retry', 'return_to_workspace'];
  return [];
}

function check(code, label, passed, failedMessage) {
  return { code, label, passed: Boolean(passed), message: passed ? '已通过' : failedMessage };
}

function isValidHttpsUrl(value) {
  try {
    return new globalThis.URL(String(value || '')).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  return String(value).split(/[\s,]+/).filter(Boolean);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function resolvePublishMedia(task, asset) {
  const embeddedAssets = Array.isArray(task.publish_content?.assets) ? task.publish_content.assets : [];
  const selectedIds = new Set([
    ...(Array.isArray(task.publish_content?.selected_asset_ids) ? task.publish_content.selected_asset_ids : []),
    task.publish_content?.selected_asset_id,
  ].filter(Boolean).map(String));
  const selected = selectedIds.size
    ? embeddedAssets.filter((item) => selectedIds.has(String(item.id)))
    : embeddedAssets;
  const rows = selected.length ? selected : asset?.url || asset?.raw?.output_url ? [asset] : [];
  return rows.map((item) => ({
    url: item.output_url || item.url || item.raw?.output_url || '',
    type: String(item.type || item.asset_type || item.raw?.asset_type || '').toLowerCase(),
    approved: Boolean(
      item.approved_for_publishing !== false
      && item.status !== 'failed'
      && (item.approved_for_publishing || item.approvedForPublishing || item.raw?.approved_for_publishing),
    ),
  }));
}

function normalizePlatform(value) {
  const platform = String(value || '').trim().toLowerCase();
  return platform === 'twitter' ? 'x' : platform;
}

function safePublishErrorSummary(value) {
  const text = String(value || '');
  if (!text) return '平台未能完成发布。';
  if (/oauth|token|unauthorized|401|403/i.test(text)) return '平台授权已失效或缺少发布权限。';
  if (/rate.?limit|quota|credit|429/i.test(text)) return '平台额度或调用频率暂时受限。';
  if (/timeout|network|fetch|connection/i.test(text)) return '发布服务暂时无法连接平台。';
  if (/media|image|video|upload|format/i.test(text)) return '素材上传或平台格式检查未通过。';
  return '平台未能完成本次发布。';
}

function sanitizePublishTechnicalDetail(value) {
  return String(value || '未提供技术详情')
    .replace(/(token|secret|password|authorization|apikey|api_key)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?[^\s]*/gi, '[内部地址已隐藏]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[敏感标识已隐藏]')
    .slice(0, 500);
}
