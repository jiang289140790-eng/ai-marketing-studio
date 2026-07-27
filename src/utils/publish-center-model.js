import { getPublishTaskState, PUBLISH_TASK_STATE } from '../services/publish-state-machine.js';

const DAY_MS = 86_400_000;

export const PUBLISH_CENTER_TABS = [
  { id: 'pending', label: '待处理' },
  { id: 'calendar', label: '发布日历' },
  { id: 'publishing', label: '发布中' },
  { id: 'history', label: '历史记录' },
];

export function filterPublishCenterTasks(tasks = [], tab = 'pending', detailId = '') {
  if (detailId) {
    const selected = tasks.find((task) => String(task.id) === String(detailId));
    if (selected) return [selected];
  }
  if (tab === 'calendar') return tasks.filter((task) => getPublishTaskState(task) === 'scheduled');
  return tasks.filter((task) => PUBLISH_TASK_STATE[getPublishTaskState(task)]?.group === tab);
}

export function summarizePublishCenter(tasks = [], metrics = [], now = new Date()) {
  const todayKey = localDateKey(now);
  const metricsTaskIds = new Set(metrics.map((item) => String(item.publish_task_id || '')).filter(Boolean));
  return {
    awaitingApproval: tasks.filter((task) => getPublishTaskState(task) === 'pending_approval').length,
    todayScheduled: tasks.filter((task) => (
      getPublishTaskState(task) === 'scheduled'
      && localDateKey(task.scheduled_at || task.scheduled_time || task.publish_time) === todayKey
    )).length,
    publishing: tasks.filter((task) => getPublishTaskState(task) === 'publishing').length,
    failed: tasks.filter((task) => getPublishTaskState(task) === 'failed').length,
    metricsPending: tasks.filter((task) => (
      getPublishTaskState(task) === 'published'
      && !metricsTaskIds.has(String(task.id))
    )).length,
  };
}

export function buildSevenDayCalendar(tasks = [], now = new Date()) {
  const start = startOfDay(now);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const key = localDateKey(date);
    return {
      key,
      date,
      label: index === 0 ? '今天' : weekdayLabel(date),
      tasks: tasks
        .filter((task) => (
          getPublishTaskState(task) === 'scheduled'
          && localDateKey(task.scheduled_at || task.scheduled_time || task.publish_time) === key
        ))
        .sort((left, right) => taskTime(left) - taskTime(right)),
    };
  });
}

export function getCampaignLinkId(task = {}) {
  return task.publish_content?.campaign_link_id
    || task.publish_content?.tracking_link_id
    || task.campaign_link_id
    || task.campaign_links?.id
    || null;
}

export function getCampaignLink(task = {}, links = []) {
  const linkId = getCampaignLinkId(task);
  if (linkId) return links.find((link) => String(link.id) === String(linkId)) || null;
  if (task.content_id) {
    return links.find((link) => String(link.content_id) === String(task.content_id)) || null;
  }
  return null;
}

export function metricsCapabilityForTask(task = {}, connection = {}) {
  const platform = String(task.platform || connection.platform || '').toLowerCase();
  const permissions = normalizeList(connection.permissions || connection.metadata?.permissions || connection.metadata?.scopes);
  const declared = connection.can_collect_metrics === true
    || connection.metadata?.can_collect_metrics === true
    || permissions.some((item) => /(metric|analytic|insight|stat|tweet\.read|read:analytics)/i.test(item))
    || platform === 'telegram';
  return {
    available: declared,
    label: declared ? '可以同步指标' : '当前平台未提供指标同步',
  };
}

export function connectionContextLabel({ registered, oauthValid, publishCapability } = {}) {
  if (!registered) return '账号未绑定';
  if (!oauthValid) return 'OAuth 已过期或未连接';
  if (!publishCapability) return '已连接，但当前不可发布';
  return 'OAuth 有效，可以发布';
}

function taskTime(task) {
  const value = new Date(task.scheduled_at || task.scheduled_time || task.publish_time || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function startOfDay(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function weekdayLabel(date) {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value).flat().map(String);
  return String(value).split(/[\s,，、]+/).filter(Boolean);
}
