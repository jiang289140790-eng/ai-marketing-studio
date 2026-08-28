import { supabase } from './supabase-client.js';
import { PROJECT_ID_PATTERN } from './p19-contracts.js';

export const HARNESS_EDGE_SCHEMA_VERSION = 'ams_harness_edge_v1';
export const HARNESS_ACTIVE_PROJECT_KEY = 'p19_active_project_v1';
export const HARNESS_DEMO_USER_KEY = 'ams_harness_demo_user_v1';
export const HARNESS_THREAD_SCHEMA_VERSION = 1;
export const HARNESS_APPROVAL_SCOPES = Object.freeze(['paid_external_calls', 'online_writes', 'handoff_creation']);

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

export function readHarnessDemoUser(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem?.(HARNESS_DEMO_USER_KEY);
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) return value;
  } catch {
    // fall through to generation
  }
  const next = globalThis.crypto?.randomUUID?.() || null;
  if (next) {
    try { storage?.setItem?.(HARNESS_DEMO_USER_KEY, next); } catch { /* best-effort */ }
  }
  return next;
}

function boundedError(code, message) {
  const error = new Error(String(message || 'AI 工作台暂时不可用。').slice(0, 240));
  error.code = String(code || 'HARNESS_REQUEST_FAILED').slice(0, 80);
  return error;
}

const runtimeEnv = import.meta.env || {};
const demoEdgeBase = String(runtimeEnv.VITE_HARNESS_EDGE_BASE_URL || '').trim();

export function createHarnessClient({
  client = supabase,
  fetchImpl = globalThis.fetch,
  edgeBase = demoEdgeBase,
  demoUser = null,
} = {}) {
  async function accessToken(refresh = false) {
    if (!client) return demoUser || '';
    const { data, error } = refresh ? await client.auth.refreshSession() : await client.auth.getSession();
    const token = data?.session?.access_token;
    if (error || !token) throw boundedError('AUTH_REQUIRED', '请先登录后再使用 AI 工作区。');
    return token;
  }

  async function invoke(body) {
    if (client) {
      let sessionResult = ['plan', 'confirm', 'retry_failed_step'].includes(body.action)
        ? await client.auth.refreshSession()
        : await client.auth.getSession();
      if (body.action === 'native_bootstrap') {
        const currentToken = sessionResult?.data?.session?.access_token;
        if (!currentToken) sessionResult = await client.auth.refreshSession();
      }
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
    // demo/测试模式：直连固定 base（本地测试注入 fake edge），与 G1 一致；
    // 仅当 VITE_HARNESS_EDGE_BASE_URL 显式配置时启用，产品运行时绝不进入。
    if (!edgeBase) throw boundedError('HARNESS_NOT_CONFIGURED', 'AI 工作台尚未连接 staging。');
    const target = `${String(edgeBase).replace(/\/$/, '')}/functions/v1/harness-command`;
    const response = await fetchImpl(target, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${demoUser || ''}`,
        ...(demoUser ? { 'x-ams-demo-user': demoUser } : {}),
      },
      body: JSON.stringify({ schema_version: HARNESS_EDGE_SCHEMA_VERSION, ...body }),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw boundedError('HARNESS_RESPONSE_INVALID', 'AI 任务入口返回了无效响应。');
    }
    if (!response.ok || !payload || payload.ok !== true) {
      throw boundedError(payload?.code || 'HARNESS_EDGE_UNAVAILABLE', payload?.message || 'AI 任务入口暂时不可用。');
    }
    return payload;
  }

  // New browser submissions use the native Harness agent path first. The
  // legacy plan/confirm methods remain available only for historical task
  // recovery and explicit fallback screens.
  return Object.freeze({
    createNativeBootstrap({ projectId = null, requestId }) {
      return invoke({ action: 'native_bootstrap', project_id: projectId, request_id: requestId });
    },
    createThread({ workspaceId, projectId = null, requestId, title = null }) {
      return invoke({ action: 'thread_create', workspace_id: workspaceId, project_id: projectId, request_id: requestId, title });
    },
    getThread(threadId) { return invoke({ action: 'thread_get', thread_id: threadId }); },
    sendMessage({ threadId, requestId, content, attachments = [], clientMessageId = null }) {
      return invoke({ action: 'thread_send', thread_id: threadId, request_id: requestId, content, attachments, client_message_id: clientMessageId });
    },
    sendAgentMessage({ threadId, requestId, content, attachments = [], clientMessageId = null }) {
      return invoke({ action: 'thread_send_agent', thread_id: threadId, request_id: requestId, content, attachments, client_message_id: clientMessageId });
    },
    confirmThreadPlan({ taskId, planFingerprint, approval }) {
      return invoke({ action: 'confirm', task_id: taskId, plan_fingerprint: planFingerprint, approval });
    },
    listMessages(threadId, cursor = 0, limit = 100) {
      return invoke({ action: 'thread_messages', thread_id: threadId, cursor: String(cursor), limit });
    },
    stopGeneration(threadId) { return invoke({ action: 'thread_stop', thread_id: threadId }); },
    async uploadAttachment({ threadId, requestId, file }) {
      if (!client) throw boundedError('ATTACHMENT_UPLOAD_UNAVAILABLE', '附件上传仅在已认证的 staging 工作区可用。');
      const { data, error } = await client.auth.getSession();
      const userId = data?.session?.user?.id;
      if (error || !userId) throw boundedError('AUTH_REQUIRED', '请先登录后再上传附件。');
      const safeName = String(file?.name || 'attachment').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'attachment';
      const path = `${userId}/${threadId}/${requestId}/${safeName}`;
      const uploaded = await client.storage.from('harness-thread-attachments').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
      if (uploaded.error) throw boundedError('ATTACHMENT_UPLOAD_FAILED', uploaded.error.message);
      return { bucket: 'harness-thread-attachments', path, name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream' };
    },
    async createAttachmentPreview({ ref, name = 'attachment', download = false }) {
      if (!client) throw boundedError('ATTACHMENT_PREVIEW_UNAVAILABLE', '附件预览仅在已认证的 staging 工作区可用。');
      const match = /^harness-thread-attachments:([^\\\s]{1,900})$/.exec(String(ref || ''));
      if (!match || match[1].split('/').some((part) => !part || part === '.' || part === '..')) {
        throw boundedError('ATTACHMENT_REF_INVALID', '附件身份无效，已拒绝生成预览地址。');
      }
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (sessionError || !userId) throw boundedError('AUTH_REQUIRED', '请先登录后再预览附件。');
      const path = match[1];
      if (!path.startsWith(`${userId}/`)) throw boundedError('ATTACHMENT_BINDING_MISMATCH', '附件不属于当前登录账号。');
      const safeName = String(name || 'attachment').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || 'attachment';
      const options = download ? { download: safeName } : undefined;
      const { data, error } = await client.storage.from('harness-thread-attachments').createSignedUrl(path, 300, options);
      if (error || !data?.signedUrl) throw boundedError('ATTACHMENT_PREVIEW_FAILED', '无法创建附件的临时预览地址。');
      return { signedUrl: data.signedUrl, expiresIn: 300 };
    },
    async streamThreadEvents({ threadId, cursor = 0, signal, onEvent, onStatus }) {
      let nextCursor = Number(cursor) || 0;
      onStatus?.('connecting');
      const token = await accessToken(false);
      const base = client?.supabaseUrl || String(edgeBase).replace(/\/$/, '');
      if (!base) throw boundedError('HARNESS_NOT_CONFIGURED', 'AI 工作区尚未连接 staging。');
      const target = `${base}/functions/v1/harness-command/threads/${encodeURIComponent(threadId)}/events?cursor=${nextCursor}&limit=200`;
      let response;
      try {
        response = await fetchImpl(target, { method: 'GET', redirect: 'error', headers: { authorization: `Bearer ${token}`, apikey: client?.supabaseKey || '' }, signal });
      } catch (error) {
        if (signal?.aborted) return nextCursor;
        onStatus?.('disconnected');
        throw boundedError('EVENT_STREAM_DISCONNECTED', error?.message);
      }
      if (!response.ok || !response.body) throw boundedError('EVENT_STREAM_UNAVAILABLE', `事件流连接失败（${response.status}）`);
      onStatus?.('connected');
      const reader = response.body.getReader();
      const decoder = new globalThis.TextDecoder();
      let pending = '';
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop() || '';
        for (const frame of frames) {
          if (!frame || frame.startsWith(':')) continue;
          const lines = frame.split(/\r?\n/);
          const id = lines.find((line) => line.startsWith('id:'))?.slice(3).trim();
          const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
          const dataLine = lines.find((line) => line.startsWith('data:'))?.slice(5).trim();
          if (!dataLine) continue;
          const event = JSON.parse(dataLine);
          if (id && Number.isSafeInteger(Number(id))) nextCursor = Math.max(nextCursor, Number(id));
          onEvent?.({ type, event, cursor: nextCursor });
        }
        if (done) break;
      }
      return nextCursor;
    },
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
