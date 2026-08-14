// P19 本地后端命令边界（未部署；本地可测试契约的 Deno 包装器）。
//
// - 仅验证签名后的 JWT 且强制边界条件：exp 未过期、nbf 不晚于现在、
//   iss/aud 精确匹配（默认 supabase/authenticated，可经环境覆盖）；
//   user_id 只从已验证 claims 的 subject 派生（deriveUserIdFromClaims），
//   绝不接受请求输入或 user_metadata 中的身份；
// - 要求已验收的 staging 访问角色（查 api.p19_staging_role，fail closed）；
// - 全部业务校验与幂等在 command-core.mjs（纯模块，node:test 直接测试）；
// - 只通过 service-role 服务端客户端调用 api 架构的数据库边界函数
//   （api.p19_apply_entity_write / api.p19_remove_evidence / api.p19_get_project /
//   api.p19_list_project_entities / api.p19_staging_role）。默认 public 架构
//   无法解析 api.p19_*，因此**每一个 RPC 调用都显式
//   supabase.schema('api').rpc(...)**，绝不使用默认路径、绝不以任何形式
//   命名 ams_private（边界函数在单个事务内原子完成规范化 JSONB 哈希校验 +
//   幂等预留 + 受修订保护的写入）；anon/authenticated 对这些函数零 EXECUTE
//   （迁移内已 revoke）；service-role 密钥只存在于服务端环境变量，绝不暴露给浏览器；
// - 有界错误码（PROJECT_REVISION_STALE / PROJECT_ARCHIVED / EVIDENCE_NOT_FOUND /
//   PAYLOAD_HASH_MISMATCH）映射为有界 HTTP 状态：PROJECT_REVISION_STALE 以
//   409（Conflict）返回（与 SQL 边界 P19_PROJECT_REVISION_STALE 对齐），
//   绝不降级为 INTERNAL_ERROR；
// - 不执行任何模型/网络/提供商/路由/发布行为。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  COMMAND_ALLOWLIST,
  COMMAND_SCHEMA_VERSION,
  deriveUserIdFromClaims,
  executeCommand,
  hasRequiredRole,
  parseCommandRequest,
} from './command-core.mjs';
import { verifyCollectionProof } from '../p22-research-assist/assist-core.mjs';
const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

/**
 * 有界错误 → HTTP 状态映射。PROJECT_REVISION_STALE 是并发冲突
 * （409-equivalent），绝不降级为 INTERNAL_ERROR（500）；其余有界
 * 失败保持 400。
 */
const BOUNDED_STATUS = Object.freeze({
  PROJECT_REVISION_STALE: 409,
  PROJECT_ARCHIVED: 409,
  IDEMPOTENCY_CONFLICT: 409,
});

async function verifyP22EvidenceRecord(proofSecret: string, userId: string, record: Record<string, unknown>) {
  const provenance = record?.provenance as Record<string, unknown>;
  const media = record?.media_metadata as Record<string, unknown>;
  const sourcePlatform = String(provenance?.source_platform || '').toLowerCase();
  if (!['x', 'reddit'].includes(sourcePlatform)) throw new Error('P22_SOURCE_PLATFORM_INVALID');
  const item = {
    id: provenance.source_id,
    source_url: record.source_url,
    label: record.label,
    platform: sourcePlatform,
    content_text: record.content_text,
    external_id: provenance.external_id,
    content_sha256: media?.sha256,
    source_metadata: record?.source_metadata,
    media_assets: record?.media_assets,
    provenance: {
      schema_version: 'p22_collected_source_v1',
      provider: provenance.provider,
      run_id: provenance.run_id,
      collected_at: provenance.collected_at,
      usage_total_usd: provenance.usage_total_usd,
      budget_reservation_id: provenance.budget_reservation_id,
    },
  };
  return verifyCollectionProof(proofSecret, userId, item, provenance.collection_proof);
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
  };
}

function json(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

/**
 * 基于 service-role 客户端的 db 适配器：全部读写经由 api 架构的
 * 数据库边界函数（service-role 唯一被授予 EXECUTE 的角色）。
 * 默认 public 架构无法解析 api.p19_*，因此每个 RPC 都显式
 * supabase.schema('api').rpc(...)；客户端代码绝不命名 ams_private。
 */
function createDbAdapter(supabase) {
  async function rpc(name: string, args: Record<string, unknown>) {
    const { data, error } = await supabase.schema('api').rpc(name, args);
    if (error) throw new Error(`P19_RPC_FAILED(${name}): ${error.message}`);
    return data;
  }

  /**
   * 边界以 P19_<CODE> 前缀抛错（如 SQL 的 P19_PROJECT_REVISION_STALE /
   * P19_PROJECT_ARCHIVED / P19_EVIDENCE_NOT_FOUND）；去掉 P19_ 前缀得到
   * 有界公开错误码 {code, message} 供命令核心识别，绝不透传 INTERNAL_ERROR。
   */
  function mapBoundaryError(error: unknown) {
    const message = String(error instanceof Error ? error.message : error);
    const matched = message.match(/P(?:19|20)_([A-Z_]+)/);
    if (matched) {
      const mapped = new Error(message);
      mapped.code = matched[1];
      return mapped;
    }
    return error;
  }

  return {
    async getCommandReplay(userId: string, idempotencyKey: string) {
      return await rpc('p19_get_command_replay', {
        p_user_id: userId,
        p_idempotency_key: idempotencyKey,
      });
    },
    async listProjects(userId: string) {
      const data = await rpc('p20_list_projects', { p_user_id: userId });
      return Array.isArray(data) ? data : [];
    },
    async getProject(userId: string, projectId: string) {
      const data = await rpc('p19_get_project', { p_user_id: userId, p_project_id: projectId });
      return data || null;
    },
    async listProjectEntities(userId: string, projectId: string) {
      const data = await rpc('p19_list_project_entities', { p_user_id: userId, p_project_id: projectId });
      return data && typeof data === 'object'
        ? data
        : { evidence: [], analyses: [], cards: [], brief: null, handoff: null };
    },
    async importProject(userId: string, meta: Record<string, unknown>) {
      try {
        return await rpc('p20_import_project', {
          p_user_id: userId,
          p_idempotency_key: meta.idempotency_key,
          p_package: meta.package,
        });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async writeEntity(userId: string, meta: Record<string, unknown>) {
      try {
        return await rpc('p19_apply_entity_write_v2', {
          p_user_id: userId,
          p_idempotency_key: meta.idempotency_key,
          p_command: meta.command,
          p_entity_type: meta.entity_type,
          p_entity_id: meta.entity_id,
          p_request_summary: meta.request_summary || {},
          p_table: meta.table,
          p_payload: meta.payload,
          p_declared_sha: meta.declared_sha || null,
          p_expected_base_version: meta.expected_base_version ?? null,
          p_expected_entity_fingerprint: meta.expected_entity_fingerprint ?? null,
          p_expected_project_revision: meta.expected_project_revision ?? null,
        });
      } catch (error) {
        throw mapBoundaryError(error);
      }
    },
    async removeEvidence(userId: string, meta: Record<string, unknown>) {
      try {
        return await rpc('p19_remove_evidence', {
          p_user_id: userId,
          p_idempotency_key: meta.idempotency_key,
          p_command: meta.command,
          p_request_summary: meta.request_summary || {},
          p_project_id: meta.project_id,
          p_evidence_id: meta.evidence_id,
          p_expected_entity_fingerprint: meta.expected_entity_fingerprint,
        });
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
  try {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new Error('MISSING_TOKEN: 缺少 Bearer 令牌。');
    const authUrl = Deno.env.get('SUPABASE_URL');
    const publishableKey = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY');
    if (!authUrl || !publishableKey) throw new Error('SERVICE_CONFIG_MISSING: public Auth configuration is unavailable.');
    const authClient = createClient(authUrl, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData?.user?.id) throw new Error('AUTH_FAILED: signed-in user could not be verified.');
    userId = deriveUserIdFromClaims({ sub: authData.user.id });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error);
    return json(request, {
      ok: false,
      code: message.split(':')[0] || 'AUTH_FAILED',
      message: message.length > 200 ? `${message.slice(0, 200)}…` : message,
      diagnostics: { issues: ['身份验证失败：未使用任何请求输入或 user_metadata。'] },
    }, 401);
  }

  try {
    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const proofSecret = Deno.env.get('P22_COLLECTION_PROOF_SECRET');
    if (!url || !serviceKey || !proofSecret) {
      return json(request, { ok: false, code: 'SERVICE_CONFIG_MISSING', message: '服务端配置缺失（不暴露任何密钥给浏览器）。', diagnostics: { issues: [] } }, 500);
    }
    const supabase = createClient(url, serviceKey);
    const db = createDbAdapter(supabase);
    const { data: roleData, error: roleError } = await supabase.schema('api').rpc('p19_staging_role', { p_user_id: userId });
    if (roleError) throw roleError;
    accessRole = roleData ? String(roleData) : '';
    if (!hasRequiredRole(accessRole, 'viewer')) {
      return json(request, { ok: false, code: 'STAGING_ROLE_DENIED', message: '当前账号不在已验收的 staging 访问清单内，已 fail closed。', diagnostics: { issues: [] } }, 403);
    }

    const parsed = parseCommandRequest(await request.json());
    if (!parsed.ok) {
      return json(request, { ok: false, ...parsed, diagnostics: parsed.diagnostics || { issues: [parsed.message] } }, 400);
    }
    const definition = COMMAND_ALLOWLIST[parsed.command];
    const result = await executeCommand(
      { ...parsed, user_id: userId, access_role: accessRole },
      { db, verifyP22Evidence: (boundUserId, record) => verifyP22EvidenceRecord(proofSecret, boundUserId, record) },
    );
    if (!result.ok) return json(request, result, BOUNDED_STATUS[result.code] || 400);
    return json(request, {
      ...result,
      ok: true,
      schema_version: COMMAND_SCHEMA_VERSION,
      command_definition: { label: definition.label, required_role: definition.role },
      message: result.applied ? '命令已应用（幂等键已记录）。' : '命令为幂等重放，未重复写入。',
    });
  } catch (error) {
    console.error('P19 workspace command failed unexpectedly.', error);
    const message = '服务暂时无法完成该命令；内部细节已隐藏，请稍后重试或联系管理员。';
    return json(request, { ok: false, code: 'INTERNAL_ERROR', message, diagnostics: { issues: [message] } }, 500);
  }
});
