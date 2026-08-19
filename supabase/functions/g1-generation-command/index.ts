// G1 百炼图片/视频生成执行层：Edge Function（未部署；本地可测试契约）。
//
// - 仅验证签名后的 JWT 并强制 staging 访问角色（api.p19_staging_role，
//   fail closed）；user_id 只从已验证 claims 的 subject 派生
//   （deriveUserIdFromClaims），绝不接受请求输入或 user_metadata 中的身份；
// - 全部业务校验与幂等在 generation-core.mjs（纯模块，node:test 直接测试）
//   与 SQL 边界（api.g1_*）中原子完成；
// - 只通过 service-role 服务端客户端调用 api 架构的数据库边界函数
//   （api.g1_get_provider_registry / api.g1_list_reference_assets /
//   api.g1_quote_request / api.g1_approve_submit / api.g1_get_job /
//   api.g1_list_jobs / api.g1_get_artifact）。默认 public 架构无法解析
//   api.g1_*，因此每一个 RPC 调用都显式 supabase.schema('api').rpc(...)，
//   绝不使用默认路径、绝不以任何形式命名 ams_private；anon/authenticated
//   对这些函数零 EXECUTE（迁移内已 revoke）；
// - artifact 动作只返回短时签名 URL（storage createSignedUrl，900 秒），
//   绝不返回任何公开 bucket 转换或长期 URL；
// - 有界错误码（G1_QUOTE_STALE / G1_QUOTE_EXPIRED /
//   G1_PROJECT_REVISION_STALE / G1_IDEMPOTENCY_CONFLICT / G1_APPROVAL_MISMATCH
//   等）映射为有界 HTTP 状态（409），绝不降级为 INTERNAL_ERROR；
// - 不执行任何模型/网络/提供商/路由/发布行为；本函数不读取任何 Secret。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  ACTION_ALLOWLIST,
  BOUNDED_STATUS,
  G1_EDGE_SCHEMA_VERSION,
  buildBoundaryApproval,
  buildBoundaryRequest,
  boundedDiagnosticsFrom,
  deriveUserIdFromClaims,
  hasRequiredRole,
  mapBoundaryError,
  parseEdgeRequest,
} from './generation-core.mjs';

const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);
const MAX_BODY = 96 * 1024;
const PRIVATE_BUCKET = 'g1-generation-artifacts';
const SIGNED_URL_SECONDS = 900;

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

async function readBoundedBody(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY) {
    const error = new Error('请求体超过有界上限。');
    error.code = 'BODY_TOO_LARGE';
    throw error;
  }
  return text;
}

/**
 * 基于 service-role 客户端的 db 适配器：全部读写经由 api 架构的数据库边界
 * 函数（service-role 唯一被授予 EXECUTE 的角色）。客户端代码绝不命名
 * ams_private；边界错误以 {code, message} 抛出（G1_<CODE> 前缀）。
 */
function createDbAdapter(supabase) {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await supabase.schema('api').rpc(name, args);
    if (error) throw new Error(`G1_RPC_FAILED(${name}): ${error.message}`);
    return data;
  }

  return {
    async getStagingRole(userId: string) {
      const data = await rpc('p19_staging_role', { p_user_id: userId });
      return String(data || '');
    },
    async getProviderRegistry() {
      return rpc('g1_get_provider_registry', {});
    },
    async listReferenceAssets(userId: string) {
      const data = await rpc('g1_list_reference_assets', { p_user_id: userId });
      return Array.isArray(data) ? data : [];
    },
    async quoteRequest(userId: string, request: Record<string, unknown>) {
      try {
        return await rpc('g1_quote_request', { p_user_id: userId, p_request: request });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async approveSubmit(userId: string, meta: Record<string, unknown>) {
      try {
        return await rpc('g1_approve_submit', {
          p_user_id: userId,
          p_idempotency_key: meta.idempotency_key,
          p_request: meta.request,
          p_approval: meta.approval,
          p_expected_revision: meta.expected_revision ?? null,
        });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async getJob(userId: string, jobId: string) {
      try {
        return await rpc('g1_get_job', { p_user_id: userId, p_job_id: jobId });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async listJobs(userId: string, projectId: string, limit: number) {
      try {
        return await rpc('g1_list_jobs', { p_user_id: userId, p_project_id: projectId, p_limit: limit });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async getArtifact(userId: string, jobId: string, artifactId: string) {
      try {
        return await rpc('g1_get_artifact', { p_user_id: userId, p_job_id: jobId, p_artifact_id: artifactId });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) });
  if (request.method !== 'POST') return json(request, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST。' }, 405);

  let userId: string;
  let accessRole: string;
  let supabase;
  try {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new Error('MISSING_TOKEN: 缺少 Bearer 令牌。');
    const authUrl = Deno.env.get('SUPABASE_URL');
    const publishableKey = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!authUrl || !publishableKey || !serviceKey) throw new Error('SERVICE_CONFIG_MISSING: 服务端配置缺失。');
    const authClient = createClient(authUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData?.user?.id) throw new Error('AUTH_FAILED: signed-in user could not be verified.');
    userId = deriveUserIdFromClaims({ sub: authData.user.id });
    supabase = createClient(authUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const db = createDbAdapter(supabase);
    accessRole = await db.getStagingRole(userId);
    if (!accessRole) throw new Error('STAGING_ROLE_DENIED: 当前账号不在已验收的 staging 访问清单内，已 fail closed。');
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    const code = String(message.split(':')[0] || 'AUTH_FAILED').slice(0, 80);
    const status = code === 'STAGING_ROLE_DENIED' ? 403 : code === 'SERVICE_CONFIG_MISSING' ? 503 : 401;
    return json(request, {
      ok: false,
      code,
      message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
      diagnostics: { issues: ['身份验证失败：未使用任何请求输入或 user_metadata。'] },
    }, status);
  }

  let raw: string;
  try {
    raw = await readBoundedBody(request);
  } catch (error) {
    return json(request, {
      ok: false,
      code: error?.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'BODY_READ_FAILED',
      message: '请求体读取失败。',
      diagnostics: { issues: [] },
    }, error?.code === 'BODY_TOO_LARGE' ? 413 : 400);
  }

  try {
    const db = createDbAdapter(supabase);
    let input: unknown;
    try { input = JSON.parse(raw); } catch { return json(request, { ok: false, code: 'INVALID_JSON', message: '请求体不是合法 JSON。', diagnostics: { issues: [] } }, 400); }
    const parsed = parseEdgeRequest(input);
    if (!parsed.ok) {
      return json(request, { ok: false, ...parsed, diagnostics: parsed.diagnostics || { issues: [] } }, 400);
    }
    const definition = ACTION_ALLOWLIST[parsed.action];
    if (!hasRequiredRole(accessRole, definition.role)) {
      return json(request, {
        ok: false,
        code: 'ROLE_DENIED',
        message: `当前 staging 角色无权执行 ${definition.label}（需要 ${definition.role}）。`,
        diagnostics: { issues: [] },
      }, 403);
    }

    if (parsed.action === 'providers') {
      const registry = await db.getProviderRegistry();
      return json(request, { ok: true, schema_version: G1_EDGE_SCHEMA_VERSION, action: 'providers', data: { registry } });
    }
    if (parsed.action === 'list_reference_assets') {
      const assets = await db.listReferenceAssets(userId);
      return json(request, { ok: true, schema_version: G1_EDGE_SCHEMA_VERSION, action: 'list_reference_assets', data: { assets } });
    }
    if (parsed.action === 'quote') {
      const boundaryRequest = buildBoundaryRequest(parsed);
      const result = await db.quoteRequest(userId, boundaryRequest);
      const quote = result?.quote || result || {};
      return json(request, {
        ok: true,
        schema_version: G1_EDGE_SCHEMA_VERSION,
        action: 'quote',
        data: { quote },
        entity: { type: 'quote', id: quote.quote_id || null },
      });
    }
    if (parsed.action === 'approve_submit') {
      const boundaryRequest = buildBoundaryRequest(parsed);
      const approval = buildBoundaryApproval(parsed);
      const result = await db.approveSubmit(userId, {
        idempotency_key: parsed.idempotency_key,
        request: boundaryRequest,
        approval,
        expected_revision: parsed.payload.expected_revision ?? null,
      });
      const job = result?.job || result || {};
      return json(request, {
        ok: true,
        schema_version: G1_EDGE_SCHEMA_VERSION,
        action: 'approve_submit',
        data: { job },
        entity: { type: 'generation_job', id: job.id || null },
      });
    }
    if (parsed.action === 'status') {
      const result = await db.getJob(userId, parsed.payload.job_id);
      return json(request, {
        ok: true,
        schema_version: G1_EDGE_SCHEMA_VERSION,
        action: 'status',
        data: {
          job: result?.job || result,
          attempts: result?.attempts || [],
          artifacts: result?.artifacts || [],
          events: result?.events || [],
        },
        entity: { type: 'generation_job', id: result?.job?.id || parsed.payload.job_id || null },
      });
    }
    if (parsed.action === 'list') {
      const jobs = await db.listJobs(userId, parsed.payload.project_id, parsed.payload.limit || 20);
      return json(request, { ok: true, schema_version: G1_EDGE_SCHEMA_VERSION, action: 'list', data: { jobs } });
    }
    if (parsed.action === 'artifact') {
      const result = await db.getArtifact(userId, parsed.payload.job_id, parsed.payload.artifact_id);
      const artifact = result?.artifact;
      if (!artifact?.storage_path) {
        return json(request, { ok: false, code: 'ARTIFACT_NOT_FOUND', message: '产物不存在或不属于当前项目。', diagnostics: { issues: [] } }, 404);
      }
      const { data: signed, error: signedError } = await supabase
        .storage
        .from(PRIVATE_BUCKET)
        .createSignedUrl(String(artifact.storage_path), SIGNED_URL_SECONDS);
      if (signedError || !signed?.signedUrl) {
        return json(request, { ok: false, code: 'SIGNED_URL_FAILED', message: '无法创建短期下载链接（产物可能尚未落盘）。', diagnostics: { issues: [] } }, 404);
      }
      return json(request, {
        ok: true,
        schema_version: G1_EDGE_SCHEMA_VERSION,
        action: 'artifact',
        data: {
          artifact,
          signed_url: signed.signedUrl,
          expires_in_seconds: SIGNED_URL_SECONDS,
          note: '短时签名 URL（15 分钟）；请勿公开或长期保存。',
        },
        entity: { type: 'generation_artifact', id: artifact.id || null },
      });
    }
    return json(request, { ok: false, code: 'ACTION_DENIED', message: '动作未实现。', diagnostics: { issues: [] } }, 400);
  } catch (error) {
    const code = String(error?.code || '');
    const mapped = mapBoundaryError(error);
    const boundedCode = String(mapped?.code || code || 'INTERNAL_ERROR');
    if (BOUNDED_STATUS[boundedCode]) {
      return json(request, { ok: false, code: boundedCode, message: String(mapped?.message || error?.message || '').slice(0, 200), diagnostics: boundedDiagnosticsFrom(mapped || error) }, BOUNDED_STATUS[boundedCode]);
    }
    if (boundedCode !== 'INTERNAL_ERROR') {
      return json(request, { ok: false, code: boundedCode, message: String(mapped?.message || error?.message || '').slice(0, 200), diagnostics: boundedDiagnosticsFrom(mapped || error) }, 400);
    }
    console.error('G1 generation command failed unexpectedly.', error);
    const message = '服务暂时无法完成该命令；内部细节已隐藏，请稍后重试或联系管理员。';
    return json(request, { ok: false, code: 'INTERNAL_ERROR', message, diagnostics: { issues: [message] } }, 500);
  }
});
