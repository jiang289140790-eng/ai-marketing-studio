import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

export const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

export const ACTIONS = new Set([
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

export const RESOURCE_TABLES: Record<string, string> = {
  campaign: 'campaigns',
  strategy: 'strategy_plans',
  content_package: 'content_packages',
  content: 'content_library',
  asset: 'assets',
  legacy_asset: 'asset_library',
  character: 'characters',
  publish_task: 'publish_tasks',
  account: 'social_accounts',
  platform_connection: 'platform_connections',
};

const OWNERSHIP_PARENT_FIELDS = [
  { field: 'campaign_id', resourceType: 'campaign' },
  { field: 'strategy_plan_id', resourceType: 'strategy' },
  { field: 'content_package_id', resourceType: 'content_package' },
  { field: 'content_id', resourceType: 'content' },
  { field: 'account_id', resourceType: 'account' },
  { field: 'platform_connection_id', resourceType: 'platform_connection' },
];

export type GatewayErrorCode =
  | 'AUTH_REQUIRED'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_FORBIDDEN'
  | 'INVALID_INPUT'
  | 'RATE_LIMITED'
  | 'GATEWAY_UNAVAILABLE'
  | 'MCP_UNAVAILABLE';

export class GatewayError extends Error {
  code: GatewayErrorCode;
  status: number;
  retryable: boolean;

  constructor(code: GatewayErrorCode, message: string, status = 400, retryable = false) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://jiang289140790-eng.github.io';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function jsonResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function createServiceClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new GatewayError('GATEWAY_UNAVAILABLE', 'Supabase 服务端配置缺失。', 500, true);
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireUser(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw new GatewayError('AUTH_REQUIRED', '请先登录后再执行。', 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    throw new GatewayError('GATEWAY_UNAVAILABLE', 'Supabase Auth 配置缺失。', 500, true);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) {
    throw new GatewayError('AUTH_REQUIRED', '登录状态无效，请重新登录。', 401);
  }
  return data.user;
}

export async function parseJsonBody(request: Request) {
  const text = await request.text();
  if (text.length > 64 * 1024) {
    throw new GatewayError('INVALID_INPUT', '请求内容过大。', 413);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new GatewayError('INVALID_INPUT', '请求 JSON 格式不正确。', 400);
  }
}

export function assertAction(action: unknown): string {
  if (typeof action !== 'string' || !ACTIONS.has(action)) {
    throw new GatewayError('INVALID_INPUT', '不允许的执行动作。', 400);
  }
  return action;
}

export function assertUuid(value: unknown, field: string, required = false): string | null {
  if (!value && !required) return null;
  const text = String(value || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new GatewayError('INVALID_INPUT', `${field} 不是有效 ID。`, 400);
  }
  return text;
}

export async function verifyResourceOwnership(
  client: ReturnType<typeof createServiceClient>,
  userId: string,
  resourceType?: string,
  resourceId?: string | null,
  visited = new Set<string>(),
) {
  if (!resourceType || !resourceId) return;
  const table = RESOURCE_TABLES[resourceType];
  if (!table) throw new GatewayError('INVALID_INPUT', '不支持的资源类型。', 400);
  const visitKey = `${resourceType}:${resourceId}`;
  if (visited.has(visitKey)) {
    throw new GatewayError('RESOURCE_FORBIDDEN', '无法确认资源归属。', 403);
  }
  visited.add(visitKey);

  const { data, error } = await client.from(table).select('*').eq('id', resourceId).maybeSingle();
  if (error) throw new GatewayError('RESOURCE_NOT_FOUND', '无法读取目标资源。', 404);
  if (!data) throw new GatewayError('RESOURCE_NOT_FOUND', '目标资源不存在。', 404);

  if ('user_id' in data) {
    if (data.user_id && String(data.user_id) === userId) return;
    if (data.user_id && String(data.user_id) !== userId) {
      throw new GatewayError('RESOURCE_FORBIDDEN', '你无权操作该资源。', 403);
    }
  }

  for (const parent of OWNERSHIP_PARENT_FIELDS) {
    const parentId = data[parent.field];
    if (parentId && !(parent.resourceType === resourceType && String(parentId) === String(resourceId))) {
      await verifyResourceOwnership(client, userId, parent.resourceType, String(parentId), visited);
      return;
    }
  }

  throw new GatewayError('RESOURCE_FORBIDDEN', '无法确认资源属于当前用户，已拒绝执行。', 403);
}

export async function enforceRateLimit(client: ReturnType<typeof createServiceClient>, userId: string) {
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error } = await client
    .from('ops_runs')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  if (!error && typeof count === 'number' && count > 30) {
    throw new GatewayError('RATE_LIMITED', '执行请求过于频繁，请稍后再试。', 429, true);
  }
}

export async function signBody(body: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function publicRun(row: Record<string, unknown>) {
  return {
    id: row.id,
    action: row.action,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    status: row.status,
    progress: row.progress,
    input_summary: row.input_summary,
    result_summary: row.result_summary,
    error_code: row.error_code,
    error_message: row.error_message,
    retryable: row.retryable,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function handleGatewayError(request: Request, error: unknown) {
  if (error instanceof GatewayError) {
    return jsonResponse(request, {
      ok: false,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    }, error.status);
  }
  return jsonResponse(request, {
    ok: false,
    code: 'GATEWAY_UNAVAILABLE',
    message: error instanceof Error ? error.message : '执行网关异常。',
    retryable: true,
  }, 500);
}
