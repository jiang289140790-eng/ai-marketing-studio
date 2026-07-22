import { fetchWithSafeHeaders, requireSupabase, supabaseAnonKey, supabaseUrl } from './supabase-client';

export const EXECUTION_ACTIONS = new Set([
  'create_campaign',
  'generate_strategy',
  'approve_strategy',
  'reject_strategy',
  'generate_content',
  'rewrite_content',
  'save_draft',
  'import_x_reference',
  'upload_reference_asset',
  'generate_character_image',
  'generate_character_video',
  'poll_asset_status',
  'review_generated_asset',
  'regenerate_asset',
  'finalize_content_package',
  'approve_publish',
  'reject_publish',
  'execute_publish',
  'sync_x_account',
  'analyze_account',
]);

export const asyncActions = new Set([
  'generate_strategy',
  'generate_content',
  'rewrite_content',
  'import_x_reference',
  'generate_character_image',
  'generate_character_video',
  'regenerate_asset',
  'execute_publish',
  'sync_x_account',
  'analyze_account',
]);

let healthCache;
let healthCacheAt = 0;
const HEALTH_CACHE_MS = 15_000;

export async function getExecutionStatus({ force = false } = {}) {
  if (!force && healthCache && Date.now() - healthCacheAt < HEALTH_CACHE_MS) return healthCache;

  healthCache = loadExecutionStatus();
  healthCacheAt = Date.now();
  return healthCache;
}

async function loadExecutionStatus() {
  try {
    const data = await callGatewayFunction('ops-health', { method: 'GET' });
    const status = data?.status || {};
    const connected = Boolean(status.edge_function && status.bridge_configured && status.bridge && status.mcp);

    return {
      connected,
      status,
      label: connected ? '执行网关已连接' : '执行网关未完整连接',
      reason: connected ? '' : buildHealthReason(status),
      details: buildHealthDetails(status),
    };
  } catch (error) {
    return {
      connected: false,
      status: null,
      label: '执行网关未连接',
      reason: error?.message || 'ops-health 尚未部署，或当前登录状态无法访问执行网关。',
      details: [
        ['Supabase', '已连接'],
        ['Edge Function', '不可访问'],
        ['MCP Bridge', '等待 Edge Function'],
        ['AI Marketing Studio MCP', '等待 Bridge'],
        ['X MCP', '等待 Bridge'],
      ],
    };
  }
}

export async function executeAction({ action, resourceType, resourceId, payload = {}, idempotencyKey }) {
  if (!EXECUTION_ACTIONS.has(action)) {
    throw new Error('不允许的执行动作。');
  }

  const key = idempotencyKey || makeIdempotencyKey({ action, resourceType, resourceId, payload });
  const data = await callGatewayFunction('ops-execute', {
    method: 'POST',
    headers: {
      'x-idempotency-key': key,
    },
    body: JSON.stringify({
      action,
      resourceType,
      resourceId,
      payload,
      idempotencyKey: key,
    }),
  });

  if (!data?.ok) {
    const wrapped = new Error(data?.message || '执行失败。');
    wrapped.code = data?.code;
    wrapped.runId = data?.run_id;
    throw wrapped;
  }

  return data;
}

export async function getRunStatus(runId) {
  const data = await callGatewayFunction(`ops-status?run_id=${encodeURIComponent(runId)}`, { method: 'GET' });
  if (!data?.ok) throw new Error(data?.message || '无法读取执行状态。');
  return data.run;
}

export function getUnavailableReason(actionName) {
  return `${actionName} 暂不可执行：执行网关或 MCP Runtime Bridge 尚未连接。`;
}

export function isTerminalStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(status);
}

export function buildHealthReason(status) {
  if (!status) return '执行服务状态暂时无法读取，请稍后刷新。';
  if (!status.bridge_configured) return '执行服务暂未连接。请先完成 MCP Bridge 部署，之后才能运行自动化操作。';
  if (!status.bridge) return '执行服务暂时无法访问，请检查 MCP Bridge 的公网健康状态。';
  if (!status.mcp) return 'MCP 服务尚未准备完成，自动化操作暂不可用。';
  return '执行服务尚未完全就绪。';
}

function buildHealthDetails(status = {}) {
  const yesNo = (value, yes = '已连接', no = '未连接') => (value ? yes : no);

  return [
    ['Supabase', '已连接'],
    ['Edge Function', yesNo(status.edge_function, '已部署', '不可访问')],
    ['MCP Bridge', status.bridge_configured ? yesNo(status.bridge, '已连接', '不可访问') : '未配置'],
    ['AI Marketing Studio MCP', status.bridge ? yesNo(status.mcp, '已连接', '等待 MCP') : '等待 Bridge'],
    ['X MCP', status.bridge ? yesNo(status.x_mcp || status.x_tools, '已连接', '等待 MCP') : '等待 Bridge'],
  ];
}

function makeIdempotencyKey({ action, resourceType, resourceId, payload }) {
  const stable = JSON.stringify({ action, resourceType, resourceId, payload: payload || {} });
  let hash = 0;
  for (let index = 0; index < stable.length; index += 1) {
    hash = ((hash << 5) - hash + stable.charCodeAt(index)) | 0;
  }
  return `${action}:${resourceType || 'none'}:${resourceId || 'none'}:${Math.abs(hash)}`;
}

async function callGatewayFunction(nameWithQuery, init = {}) {
  const client = requireSupabase();
  const { data: sessionData } = await client.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) throw new Error('请先登录后再执行。');

  const url = `${supabaseUrl}/functions/v1/${nameWithQuery}`;
  const response = await fetchWithSafeHeaders(url, {
    ...init,
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const wrapped = new Error(data?.message || `执行网关请求失败：${response.status}`);
    wrapped.code = data?.code;
    wrapped.runId = data?.run_id;
    throw wrapped;
  }
  return data;
}
