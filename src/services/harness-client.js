import { supabase } from './supabase-client.js';
import { PROJECT_ID_PATTERN } from './p19-contracts.js';

export const HARNESS_EDGE_SCHEMA_VERSION = 'ams_harness_edge_v1';
export const HARNESS_ACTIVE_PROJECT_KEY = 'p19_active_project_v1';

const CAPABILITY_QUERY_PATTERN = /^(?:你)?(?:现在|目前|当前)?(?:能|可以|能够)?(?:做|干|处理|完成)(?:哪些|什么|啥)(?:事情|任务|工作|功能)?[？?。!！]*$/u;

export function normalizeHarnessIntent(intent) {
  const value = String(intent ?? '').trim();
  return CAPABILITY_QUERY_PATTERN.test(value) ? `能力：${value}` : value;
}

export function readHarnessActiveProject(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(HARNESS_ACTIVE_PROJECT_KEY);
    return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function boundedError(code, message) {
  const error = new Error(String(message || 'AI 工作台暂时不可用。').slice(0, 240));
  error.code = String(code || 'HARNESS_REQUEST_FAILED').slice(0, 80);
  return error;
}

export function createHarnessClient({ client = supabase } = {}) {
  async function invoke(body) {
    if (!client) throw boundedError('HARNESS_NOT_CONFIGURED', 'AI 工作台尚未连接 staging。');
    const sessionResult = ['plan', 'confirm', 'retry_failed_step'].includes(body.action)
      ? await client.auth.refreshSession()
      : await client.auth.getSession();
    const { data: sessionData, error: sessionError } = sessionResult;
    const token = sessionData?.session?.access_token;
    if (sessionError || !token) throw boundedError('AUTH_REQUIRED', '请先登录后再运行 AI 任务。');
    const { data, error } = await client.functions.invoke('harness-command', {
      headers: { Authorization: `Bearer ${token}` },
      body: { schema_version: HARNESS_EDGE_SCHEMA_VERSION, ...body },
    });
    if (error) {
      const context = typeof error.context?.json === 'function'
        ? await error.context.json().catch(() => null)
        : (error.context && typeof error.context === 'object' ? error.context : null);
      const code = context?.code || 'HARNESS_EDGE_UNAVAILABLE';
      const message = context?.message || context?.error || (context?.code
        ? `AI 任务未被接受（${context.code}）。`
        : 'AI 任务入口暂时不可用。');
      throw boundedError(code, message);
    }
    if (!data || data.ok !== true) throw boundedError(data?.code || 'HARNESS_RESPONSE_INVALID', data?.message || 'AI 任务未被接受。');
    return data;
  }

  // Every browser submission goes through plan then confirm; the legacy
  // direct /v1/tasks submit action is deliberately not exposed here so no
  // browser code path can bypass the authoritative plan.
  return Object.freeze({
    plan({ requestId, projectId = null, intent }) {
      return invoke({ action: 'plan', request_id: requestId, project_id: projectId, intent });
    },
    confirm({ taskId, planFingerprint, approval }) {
      return invoke({ action: 'confirm', task_id: taskId, plan_fingerprint: planFingerprint, approval });
    },
    retryFailedStep({ taskId, planFingerprint, stepId, approval }) {
      return invoke({ action: 'retry_failed_step', task_id: taskId, plan_fingerprint: planFingerprint, step_id: stepId, approval });
    },
    read(taskId) { return invoke({ action: 'read', task_id: taskId }); },
    list(limit = 30) { return invoke({ action: 'list', limit }); },
    cancel(taskId) { return invoke({ action: 'cancel', task_id: taskId }); },
  });
}

export function newHarnessRequestId(randomId = () => globalThis.crypto?.randomUUID?.()) {
  const value = randomId();
  if (typeof value !== 'string' || !value) throw boundedError('REQUEST_ID_UNAVAILABLE', '无法创建安全任务编号。');
  return `web-${value}`;
}
