// G1 百炼图片/视频生成执行层：浏览器服务端契约（未部署；本地可测试）。
//
// - 真实模式（VITE_SUPABASE_URL 已配置）：经 supabase-js functions.invoke
//   携带会话令牌调用 g1-generation-command Edge Function；user_id 只由
//   Edge Function 从已验证 JWT 派生，本服务发送的 user_id 仅用于本地
//   demo/fake 作用域，真实边界一律忽略；
// - demo/测试模式（VITE_G1_EDGE_BASE_URL 已配置）：直连固定 base
//   （本地测试注入 fake edge），浏览器本地 demo 用户由 localStorage 派生；
// - 全部返回有界结构化结果与有界错误码（绝不回显 SQL/堆栈/密钥/raw 载荷）；
// - 本服务不执行任何模型/网络/提供商调用，只发起有界请求并解析有界响应。

import { isSupabaseConfigured, supabase } from './supabase-client';
import { PROJECT_ID_PATTERN } from './p19-contracts';

export const G1_EDGE_SCHEMA_VERSION = 'g1_generation_command_v1';
export const G1_DEMO_USER_KEY = 'g1_demo_user_v1';
export const G1_ACTIVE_PROJECT_KEY = 'p19_active_project_v1';
export const G1_MODES = Object.freeze(['image', 'video_t2v', 'video_i2v']);
export const G1_ASPECT_RATIOS = Object.freeze(['1:1', '4:3', '3:4', '16:9', '9:16', '21:9']);
export const G1_RESOLUTIONS = Object.freeze(['720p', '1080p']);
export const G1_STATUS_LABELS = Object.freeze({
  queued: '排队中',
  running: '生成中',
  completed: '已完成',
  failed: '失败',
  needs_attention: '需要关注',
});

const runtimeEnv = import.meta.env || {};
const demoEdgeBase = String(runtimeEnv.VITE_G1_EDGE_BASE_URL || '').trim();

export function readGenerationActiveProject(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(G1_ACTIVE_PROJECT_KEY);
    return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function readGenerationDemoUser(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(G1_DEMO_USER_KEY);
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return value;
  } catch {
    // fall through to generation
  }
  const next = globalThis.crypto?.randomUUID?.() || null;
  if (next) {
    try { storage?.setItem?.(G1_DEMO_USER_KEY, next); } catch { /* best-effort */ }
  }
  return next;
}

function boundedError(code, message) {
  const error = new Error(String(message || '生成任务暂时不可用。').slice(0, 240));
  error.code = String(code || 'G1_REQUEST_FAILED').slice(0, 80);
  return error;
}

function isDemoMode() {
  return !isSupabaseConfigured && Boolean(demoEdgeBase);
}

/**
 * 创建 G1 浏览器客户端。`client`/`fetchImpl`/`edgeBase`/`demoUser` 可注入
 * （本地确定性测试）。
 */
export function createGenerationClient({
  client = supabase,
  fetchImpl = globalThis.fetch,
  edgeBase = demoEdgeBase,
  demoUser = null,
} = {}) {
  async function readToken() {
    if (!client) return '';
    const { data, error } = await client.auth.getSession();
    if (error) throw boundedError('AUTH_REQUIRED', '请先登录后再发起生成任务。');
    return data?.session?.access_token || '';
  }

  async function invoke(body) {
    const envelope = { schema_version: G1_EDGE_SCHEMA_VERSION, ...body };
    if (client && !isDemoMode()) {
      const token = await readToken();
      if (!token) throw boundedError('AUTH_REQUIRED', '请先登录后再发起生成任务。');
      const { data, error } = await client.functions.invoke('g1-generation-command', {
        headers: { Authorization: `Bearer ${token}` },
        body: envelope,
      });
      if (error) {
        const context = typeof error.context?.json === 'function' ? await error.context.json().catch(() => null) : null;
        throw boundedError(context?.code || 'G1_EDGE_UNAVAILABLE', context?.message || '生成任务入口暂时不可用。');
      }
      if (!data || data.ok !== true) throw boundedError(data?.code || 'G1_RESPONSE_INVALID', data?.message || '生成任务未被接受。');
      return data;
    }
    // demo/测试模式：直连固定 base（本地测试注入 fake edge）。
    if (!edgeBase) throw boundedError('G1_NOT_CONFIGURED', '生成任务尚未连接 staging（缺少 VITE_SUPABASE_URL 或 VITE_G1_EDGE_BASE_URL）。');
    const target = `${String(edgeBase).replace(/\/$/, '')}/functions/v1/g1-generation-command`;
    const response = await fetchImpl(target, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${demoUser || ''}`,
        ...(demoUser ? { 'x-ams-demo-user': demoUser } : {}),
      },
      body: JSON.stringify(envelope),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw boundedError('G1_RESPONSE_INVALID', '生成任务入口返回了无效响应。');
    }
    if (!response.ok || !payload || payload.ok !== true) {
      throw boundedError(payload?.code || 'G1_EDGE_UNAVAILABLE', payload?.message || '生成任务入口暂时不可用。');
    }
    return payload;
  }

  return Object.freeze({
    quote(request) {
      return invoke({ action: 'quote', ...request });
    },
    approveSubmit(request) {
      return invoke({ action: 'approve_submit', ...request });
    },
    status({ jobId }) {
      return invoke({ action: 'status', job_id: jobId });
    },
    list({ projectId, limit = 20 }) {
      return invoke({ action: 'list', project_id: projectId, limit });
    },
    artifact({ jobId, artifactId }) {
      return invoke({ action: 'artifact', job_id: jobId, artifact_id: artifactId });
    },
    providers() {
      return invoke({ action: 'providers' });
    },
    listReferenceAssets() {
      return invoke({ action: 'list_reference_assets' });
    },
  });
}

export function newGenerationRequestId(randomId = () => globalThis.crypto?.randomUUID?.()) {
  const value = randomId();
  if (typeof value !== 'string' || !value) throw boundedError('REQUEST_ID_UNAVAILABLE', '无法创建安全的任务编号。');
  return `g1-${value}`;
}

export function g1StatusLabel(status) {
  return G1_STATUS_LABELS[status] || String(status || 'queued');
}
