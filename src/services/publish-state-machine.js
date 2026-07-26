export const CONTENT_APPROVAL = {
  pending: { label: '待审核', tone: 'pending' },
  approved: { label: '已批准', tone: 'approved' },
  needs_revision: { label: '需要修改', tone: 'review' },
  rejected: { label: '已拒绝', tone: 'rejected' },
};

export const PUBLISH_TASK_STATE = {
  draft: { label: '草稿', group: 'pending' },
  pending_approval: { label: '待批准', group: 'pending' },
  scheduled: { label: '已排期', group: 'scheduled' },
  publishing: { label: '发布中', group: 'publishing' },
  published: { label: '已发布', group: 'published' },
  failed: { label: '发布失败', group: 'failed' },
  cancelled: { label: '已取消', group: 'cancelled' },
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

export function buildPublishPreflightChecks({ task = {}, content = {}, connection = {}, account = {}, asset = {}, now = new Date() }) {
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

export function getPublishErrorPresentation(task = {}) {
  const result = asObject(task.publish_result || task.result);
  const error = asObject(result.error);
  if (getPublishTaskState(task) !== 'failed' && !task.error_message && !task.last_error) return null;
  return {
    code: error.code || 'PUBLISH_FAILED',
    summary: error.summary || task.error_message || task.last_error || '平台未能完成发布。',
    retryable: error.retryable !== false && Number(task.retry_count || 0) < Number(task.max_retries || task.max_retry || 3),
    recommendedAction: error.recommended_action || '检查平台连接后重试',
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
import { connectionIsActive } from '../utils/platform-connection-summary.js';
