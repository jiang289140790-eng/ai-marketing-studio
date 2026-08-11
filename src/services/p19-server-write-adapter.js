import { supabase, isSupabaseConfigured } from './supabase-client.js';
import { clonePlain, isPlainObject } from './p19-contracts.js';
import { workbenchError } from './p19-workspace-service.js';

export const P19_COMMAND_SCHEMA_VERSION = 'p19_command_contract_v1';
export const P19_SERVER_WRITE_ENABLED = isSupabaseConfigured;
const MAX_MESSAGE = 300;

export const DEPLOYMENT_GATE_MESSAGE =
  '在线工作区尚未配置。当前修改只会保存在本机草稿中，不会伪装成已同步。';

export function isServerWriteEnabled() {
  return P19_SERVER_WRITE_ENABLED === true;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .replace(/((?:service[_-]?role|secret|token|password))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

function boundedError(code, message) {
  return workbenchError(
    String(code || 'ONLINE_COMMAND_FAILED').slice(0, 80),
    redactSensitiveText(message || '在线工作区暂时无法完成该操作。').slice(0, MAX_MESSAGE),
  );
}

function makeIdempotencyKey(command, randomId = () => globalThis.crypto?.randomUUID?.()) {
  const suffix = String(randomId() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 100);
  return `p20-${String(command).replace(/[^a-z.]/g, '').slice(0, 40)}-${suffix}`;
}

export function createP19CommandClient({ client = supabase, randomId } = {}) {
  async function invoke(command, payload = {}, { idempotencyKey } = {}) {
    if (!client) throw boundedError('SERVER_WRITE_DISABLED', DEPLOYMENT_GATE_MESSAGE);
    if (typeof command !== 'string' || !command.trim()) throw boundedError('COMMAND_INVALID', '在线命令缺失。');
    if (!isPlainObject(payload)) throw boundedError('PAYLOAD_INVALID', '在线命令数据必须是对象。');

    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken || !sessionData?.session?.user?.id) {
      throw boundedError('AUTH_REQUIRED', '登录状态无效或已过期，请重新登录后重试。');
    }

    const { data, error } = await client.functions.invoke('p19-workspace-command', {
      headers: { Authorization: `Bearer ${accessToken}` },
      body: {
        schema_version: P19_COMMAND_SCHEMA_VERSION,
        command,
        idempotency_key: idempotencyKey || makeIdempotencyKey(command, randomId),
        payload: clonePlain(payload),
      },
    });

    if (error) {
      const context = typeof error.context?.json === 'function'
        ? await error.context.json().catch(() => null)
        : null;
      throw boundedError(context?.code || 'ONLINE_REQUEST_FAILED', context?.message || error.message);
    }
    if (!isPlainObject(data) || data.ok !== true || data.schema_version !== P19_COMMAND_SCHEMA_VERSION) {
      throw boundedError(data?.code || 'ONLINE_RESPONSE_INVALID', data?.message || '在线工作区返回了无效响应。');
    }
    return clonePlain(data);
  }

  return Object.freeze({ invoke });
}

export async function submitWorkspaceCommand(command, payload, options) {
  if (!isServerWriteEnabled()) throw boundedError('SERVER_WRITE_DISABLED', DEPLOYMENT_GATE_MESSAGE);
  return createP19CommandClient().invoke(command, payload, options);
}
