const SUCCESS_STATES = new Set(['success', 'completed', 'published']);
const FAILED_STATES = new Set(['failed', 'error']);
const CANCELLED_STATES = new Set(['cancelled', 'canceled']);
const WAITING_STATES = new Set(['queued', 'pending', 'running', 'processing', 'publishing', 'scheduled']);

export const HEALTH_TIME_RANGES = [
  { value: '24h', label: '最近 24 小时', hours: 24 },
  { value: '7d', label: '最近 7 天', hours: 24 * 7 },
  { value: '30d', label: '最近 30 天', hours: 24 * 30 },
];

export function filterRowsByTimeRange(rows = [], range = '24h', now = new Date()) {
  const hours = HEALTH_TIME_RANGES.find((item) => item.value === range)?.hours || 24;
  const cutoff = now.getTime() - hours * 60 * 60 * 1000;
  return rows.filter((row) => {
    const timestamp = getTimestamp(row);
    return timestamp && timestamp >= cutoff;
  });
}

export function summarizeRuntime(rowsByKind = {}, range = '24h', now = new Date()) {
  const groups = Object.entries(rowsByKind).map(([kind, rows]) => {
    const filtered = filterRowsByTimeRange(rows, range, now);
    return summarizeGroup(kind, filtered, now);
  });
  const all = groups.flatMap((group) => group.rows);
  const ended = all.filter(isEnded);
  const successful = ended.filter((row) => SUCCESS_STATES.has(normalizeStatus(row.status)));
  const failed = all.filter((row) => FAILED_STATES.has(normalizeStatus(row.status)));
  const overdue = all.filter((row) => isOverdue(row, now));
  return {
    groups,
    total: all.length,
    ended: ended.length,
    successful: successful.length,
    failed: failed.length,
    overdue: overdue.length,
    completionRate: ended.length ? Math.round((successful.length / ended.length) * 100) : null,
    formula: ended.length
      ? `${successful.length} 个成功任务 ÷ ${ended.length} 个已结束任务`
      : '暂无已结束任务；草稿、未开始和运行中任务不进入分母',
  };
}

export function buildHealthExceptions(rowsByKind = {}, range = '24h', now = new Date()) {
  return Object.entries(rowsByKind).flatMap(([kind, rows]) => (
    filterRowsByTimeRange(rows, range, now)
      .filter((row) => FAILED_STATES.has(normalizeStatus(row.status)) || isOverdue(row, now))
      .map((row) => normalizeException(kind, row, now))
  )).sort((left, right) => new Date(right.time || 0) - new Date(left.time || 0));
}

export function sanitizeTechnicalDetails(value) {
  if (Array.isArray(value)) return value.map(sanitizeTechnicalDetails);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return value
      .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?[^\s]*/gi, '[内部地址已隐藏]')
      .replace(/(?:bearer\s+)?[a-z0-9_-]{24,}\.[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}/gi, '[凭据已隐藏]')
      .replace(/\b(?:sk|key|token|secret)[-_a-z0-9]{12,}\b/gi, '[凭据已隐藏]')
      .replace(/\n\s*at\s+.+/g, '\n[调用栈已隐藏]');
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/(secret|token|authorization|api[_-]?key|password|cookie|signed[_-]?url)/i.test(key)) {
      return [key, '已隐藏'];
    }
    if (/(raw_response|provider_response|stack|sql|query)/i.test(key)) {
      return [key, '高级原始信息已隐藏'];
    }
    return [key, sanitizeTechnicalDetails(entry)];
  }));
}

export function buildCoreServices({
  configured = false,
  userId,
  executionStatus,
  comfyWorkflows = [],
  workflowRuns = [],
  publishTasks = [],
  metricRows = [],
  assets = [],
}) {
  const gateway = executionStatus?.status || {};
  const hasComfyWorkflow = comfyWorkflows.some((row) => {
    const status = normalizeStatus(row.status);
    return ['active', 'enabled', 'verified', 'success'].includes(status);
  });
  const hasSuccessfulComfy = workflowRuns.some((row) => SUCCESS_STATES.has(normalizeStatus(row.status))
    && /comfy/i.test(`${row.input_data?.provider || ''} ${row.input_data?.workflow_name || ''} ${row.provider || ''}`));
  const hasAutoDl = workflowRuns.some((row) => /autodl/i.test(`${row.input_data?.provider || ''} ${row.provider || ''}`));
  const publishFailures = publishTasks.filter((row) => FAILED_STATES.has(normalizeStatus(row.status)));
  const metricFailures = metricRows.filter((row) => FAILED_STATES.has(normalizeStatus(row.status)));
  const xMcp = gateway.x_mcp === 'connected' && gateway.x_tools === true;

  return [
    service('supabase', 'Supabase', configured ? 'healthy' : 'error', configured ? '数据服务可访问' : '数据服务未配置', '整个运营工作台'),
    service('auth', 'Auth', userId ? 'healthy' : 'error', userId ? '当前登录有效' : '登录状态无效', '所有用户数据'),
    service('storage', 'Storage', configured ? 'healthy' : 'error', assets.length ? '素材记录可读取' : '存储服务已配置，当前范围无素材', '素材预览与回传'),
    service('edge', 'Edge Function', gateway.edge_function ? 'healthy' : 'error', gateway.edge_function ? '执行入口可访问' : '执行入口不可访问', '安全执行动作'),
    service('bridge', 'MCP Bridge', gateway.bridge ? 'healthy' : gateway.bridge_configured ? 'error' : 'warning', gateway.bridge ? '服务桥接正常' : gateway.bridge_configured ? '桥接服务不可访问' : '桥接服务未配置', '自动化与工具调用'),
    service('marketing-mcp', 'AI Marketing Studio MCP', gateway.mcp ? 'healthy' : 'error', gateway.mcp ? '业务工具可调用' : '业务工具暂不可调用', 'Campaign、内容与资产操作'),
    service('x-mcp', 'X MCP', xMcp ? 'healthy' : 'warning', xMcp ? 'X 读取工具可用' : 'X MCP 或读取工具未就绪', 'X 内容读取与指标回收'),
    service('autodl', 'AutoDL', hasAutoDl ? 'healthy' : 'warning', hasAutoDl ? '最近存在 AutoDL 工作流记录' : '未检测到当前范围的 AutoDL 运行记录', '图片生成'),
    service('comfyui', 'ComfyUI', hasComfyWorkflow || hasSuccessfulComfy ? 'healthy' : 'warning', hasComfyWorkflow || hasSuccessfulComfy ? '已检测到可用或已验证工作流' : '未检测到可用 ComfyUI 工作流', '图片生成'),
    service('publisher', '发布执行器', !gateway.mcp ? 'warning' : publishFailures.length ? 'error' : 'healthy', !gateway.mcp ? '执行网关未完全就绪' : publishFailures.length ? `${publishFailures.length} 个发布任务失败` : '未检测到发布异常', '内容发布'),
    service('metrics', '指标回收器', !xMcp ? 'warning' : metricFailures.length ? 'error' : 'healthy', !xMcp ? 'X 指标读取能力未就绪' : metricFailures.length ? `${metricFailures.length} 个回收任务失败` : '未检测到指标回收异常', '数据分析与 AI 复盘'),
  ];
}

function summarizeGroup(kind, rows, now) {
  const ended = rows.filter(isEnded);
  const successful = ended.filter((row) => SUCCESS_STATES.has(normalizeStatus(row.status))).length;
  const failed = rows.filter((row) => FAILED_STATES.has(normalizeStatus(row.status))).length;
  const overdue = rows.filter((row) => isOverdue(row, now)).length;
  return {
    kind,
    rows,
    total: rows.length,
    ended: ended.length,
    successful,
    failed,
    overdue,
    completionRate: ended.length ? Math.round((successful / ended.length) * 100) : null,
  };
}

function normalizeException(kind, row, now) {
  const overdue = isOverdue(row, now);
  const technical = row.error_message || row.last_error || row.error || row.result?.error || '';
  const code = row.error_code || row.result?.error_code || `${kind.toUpperCase()}-${overdue ? 'TIMEOUT' : 'FAILED'}`;
  const route = {
    agent: 'health',
    workflow: 'generation',
    publish: 'publish',
    metrics: 'data-analytics',
  }[kind] || 'health';
  return {
    id: `${kind}-${row.id || row.created_at}`,
    kind,
    title: row.title || row.name || row.agent_name || row.platform || kindLabel(kind),
    impactObject: kindLabel(kind),
    impactScope: readImpactScope(row),
    reason: overdue ? '任务等待时间过长，可能阻塞后续流程。' : businessReason(kind, technical),
    retryable: Number(row.retry_count || 0) < Number(row.max_retry || row.max_retries || 3),
    recommendation: overdue ? '打开相关页面检查任务状态，确认后再重试。' : recommendation(kind),
    errorCode: String(code).slice(0, 64),
    time: row.updated_at || row.completed_at || row.created_at,
    targetPage: route,
    technical: sanitizeTechnicalDetails({
      status: row.status,
      error_code: code,
      error_message: technical,
      retry_count: row.retry_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
    raw: row,
  };
}

function isEnded(row) {
  const status = normalizeStatus(row.status);
  return SUCCESS_STATES.has(status) || FAILED_STATES.has(status) || CANCELLED_STATES.has(status);
}

function isOverdue(row, now) {
  if (!WAITING_STATES.has(normalizeStatus(row.status))) return false;
  const timestamp = getTimestamp(row);
  if (!timestamp) return false;
  return now.getTime() - timestamp > 60 * 60 * 1000;
}

function getTimestamp(row) {
  const value = row.updated_at || row.created_at || row.started_at || row.publish_time || row.scheduled_at;
  const timestamp = new Date(value || '').getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function service(id, name, status, summary, impact) {
  return { id, name, status, summary, impact };
}

function kindLabel(kind) {
  return {
    agent: 'Agent 运行',
    workflow: '工作流运行',
    publish: '发布任务',
    metrics: '指标回收任务',
  }[kind] || '系统任务';
}

function readImpactScope(row) {
  const input = row.input_data || row.input || {};
  return [
    input.campaign_id || row.campaign_id ? '当前运营活动' : '',
    input.day || row.day ? `Day ${input.day || row.day}` : '',
    row.platform || input.platform || '',
  ].filter(Boolean).join(' · ') || '当前数据范围';
}

function businessReason(kind, technical) {
  const text = String(technical || '').toLowerCase();
  if (/timeout|timed out/.test(text)) return '服务响应超时，任务没有在预期时间内完成。';
  if (/permission|unauthorized|forbidden|401|403/.test(text)) return '当前连接缺少执行所需权限。';
  if (/not found|missing|404/.test(text)) return '任务依赖的内容、素材或工作流不可用。';
  if (kind === 'publish') return '发布任务执行失败，尚未完成平台提交。';
  if (kind === 'metrics') return '平台指标未能正常回收。';
  if (kind === 'workflow') return '生成工作流未能完成。';
  return '任务执行失败，需要人工检查。';
}

function recommendation(kind) {
  return {
    workflow: '打开生成任务检查输入和工作流后重试。',
    publish: '返回发布中心检查预检结果后重试。',
    metrics: '检查平台连接和读取权限后重新回收。',
    agent: '查看相关业务对象，确认输入后重试。',
  }[kind] || '查看相关页面后重试。';
}
