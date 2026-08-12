// P30 内容创建 Edge Function — 三模式智能内容生成。
//
// - 只接受 POST/OPTIONS，严格 CORS allowlist
// - JWT 验证 + staging role（viewer 可读 status；generate/revise 需要 operator）
// - 动作：status / generate_quick / generate_from_brief / revise
// - 只调用 Qwen/DashScope，固定 qwen-plus、低温度、有界 tokens、有界超时
// - 函数只生成结构化内容，不写数据库、不创建外部作业
// - 日志和错误脱敏

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import {
  ACTIONS,
  ALLOWED_MODEL,
  LIMITS,
  P30Error,
  buildQuickPrompt,
  buildBriefPrompt,
  formatSummaryLine,
  parseRequest,
  sanitizeError,
  validateGeneratedContent,
} from './content-core.mjs';

export { P30Error };

const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:4178',
]);

export function isAllowedOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // CLI/server-to-server calls may omit Origin, but every browser Origin must be allowlisted.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Content-Type': 'application/json',
  };
}

function respond(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

/**
 * 验证 JWT 并返回 userId 和 role。
 * 使用 Supabase auth 验证 token，然后通过 api.p19_staging_role 检查角色。
 */
async function verifyAuth(request: Request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) {
    throw new P30Error('AUTH_REQUIRED', '请先登录。', 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    throw new P30Error('SERVICE_CONFIG_MISSING', '服务端配置不完整。', 500);
  }

  // 验证用户 token
  const authClient = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  if (userError || !userData?.user?.id) {
    throw new P30Error('AUTH_FAILED', '登录状态无效，请重新登录。', 401);
  }

  const userId = userData.user.id;

  // 检查 staging role
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: roleResult, error: roleError } = await db
    .schema('api')
    .rpc('p19_staging_role', { p_user_id: userId });

  if (roleError || !roleResult) {
    throw new P30Error('STAGING_ROLE_DENIED', '当前账号不在 staging 访问清单内。', 403);
  }

  const role = String(roleResult);

  return { userId, role, db, authClient };
}

/**
 * 调用 Qwen/DashScope 进行内容生成。
 * 使用固定的 qwen-plus 模型、低温度、JSON 输出格式。
 */
async function callQwen(prompt: string, signal?: AbortSignal) {
  const apiKey = Deno.env.get('DASHSCOPE_API_KEY');
  if (!apiKey) {
    throw new P30Error('QWEN_NOT_CONFIGURED', 'AI 生成服务尚未配置。', 503);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LIMITS.TIMEOUT_MS);

  // 如果外部已传入 signal，链接它
  if (signal) {
    signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: ALLOWED_MODEL,
          temperature: LIMITS.TEMPERATURE,
          max_tokens: LIMITS.MAX_TOKENS,
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const statusCode = response.status;
      // 不输出原始响应正文
      throw new P30Error(
        'QWEN_REQUEST_FAILED',
        `AI 生成失败（服务端状态：${statusCode}）。请稍后重试。`,
        502,
      );
    }

    const payload = await response.json();

    // 验证用量
    const totalTokens = Number(payload?.usage?.total_tokens);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
      throw new P30Error('QWEN_COST_UNVERIFIABLE', '无法验证 AI 调用用量。', 502);
    }

    // 提取 JSON 内容
    const content = payload?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new P30Error('QWEN_EMPTY_RESPONSE', 'AI 未返回有效内容。', 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new P30Error('QWEN_JSON_PARSE_FAILED', 'AI 返回了无法解析的响应。', 502);
    }

    const validated = validateGeneratedContent(parsed);

    return {
      result: validated,
      summary: formatSummaryLine(validated),
      usage: {
        total_tokens: totalTokens,
        model: payload.model || ALLOWED_MODEL,
        provider: 'dashscope/qwen',
      },
    };
  } catch (error) {
    if (error instanceof P30Error) throw error;
    if (error?.name === 'AbortError') {
      throw new P30Error('QWEN_TIMEOUT', 'AI 生成超时，请稍后重试。', 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function handleP30Request(request: Request, dependencies: {
  verifyAuth?: typeof verifyAuth;
  callQwen?: typeof callQwen;
} = {}) {
  const authVerifier = dependencies.verifyAuth || verifyAuth;
  const modelCaller = dependencies.callQwen || callQwen;
  if (!isAllowedOrigin(request)) {
    return respond(request, { ok: false, code: 'ORIGIN_DENIED', message: '请求来源不在允许列表中。' }, 403);
  }
  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return respond(request, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只接受 POST 请求。' }, 405);
  }

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return respond(request, {
        ok: false,
        code: 'INVALID_JSON',
        message: '请求正文必须为有效 JSON。',
      }, 400);
    }

    // 解析并验证请求
    const parsed = parseRequest(body);

    // status 动作：轻量健康检查（viewer 及以上可访问）
    if (parsed.action === ACTIONS.STATUS) {
      const { userId, role } = await authVerifier(request);
      return respond(request, {
        ok: true,
        code: 'READY',
        message: 'P30 内容创建服务就绪。',
        data: {
          schema_version: 'p30_content_create_v1',
          model: ALLOWED_MODEL,
          role,
          user_id: userId,
        },
      });
    }

    // 生成/修改动作：需要 operator 角色
    const { userId, role, authClient } = await authVerifier(request);
    const allowedRoles = new Set(['operator', 'admin', 'owner']);
    if (!allowedRoles.has(role.toLowerCase())) {
      return respond(request, {
        ok: false,
        code: 'ROLE_DENIED',
        message: '内容生成至少需要 operator 角色。当前角色为 viewer，只能查看状态。',
      }, 403);
    }

    let prompt;
    if (parsed.action === ACTIONS.GENERATE_QUICK) {
      prompt = buildQuickPrompt(parsed.input_text, parsed.previous_version);
    } else if (parsed.action === ACTIONS.GENERATE_FROM_BRIEF) {
      const { data: briefRows, error: briefError } = await authClient
        .schema('api')
        .from('ke_content_briefs_v1')
        .select('brief_id, brief_version, brief_schema_version, brief_status, knowledge_citation_ids, evidence_provenance, payload, payload_sha256')
        .eq('brief_id', parsed.brief_id)
        .eq('brief_version', parsed.brief_version)
        .limit(2);
      if (briefError) {
        throw new P30Error('BRIEF_LOOKUP_FAILED', '无法安全验证 Brief。', 502);
      }
      if (!Array.isArray(briefRows) || briefRows.length !== 1) {
        throw new P30Error('BRIEF_NOT_UNIQUE', '找不到唯一且属于当前账号的已批准 Brief。', 409);
      }
      const serverBrief = briefRows[0];
      if (serverBrief.brief_status !== 'approved') {
        throw new P30Error('BRIEF_NOT_APPROVED', '只有已批准的 Brief 才能生成内容。', 409);
      }
      if (serverBrief.payload_sha256 !== parsed.brief_fingerprint) {
        throw new P30Error('BRIEF_STALE', 'Brief 已发生变化，请刷新后重试。', 409);
      }
      const payload = serverBrief.payload && typeof serverBrief.payload === 'object' ? serverBrief.payload : {};
      if (
        payload.id !== serverBrief.brief_id
        || Number(payload.version) !== serverBrief.brief_version
        || payload.schema_version !== serverBrief.brief_schema_version
        || payload.status !== serverBrief.brief_status
        || JSON.stringify(payload.knowledge_citation_ids) !== JSON.stringify(serverBrief.knowledge_citation_ids)
        || JSON.stringify(payload.evidence_provenance) !== JSON.stringify(serverBrief.evidence_provenance)
      ) {
        throw new P30Error('BRIEF_IDENTITY_MISMATCH', 'Brief 身份、版本、状态或来源链不一致。', 409);
      }
      prompt = buildBriefPrompt({
        brief_topic: payload.topic || null,
        brief_objective: payload.objective || null,
        brief_target_audience: payload.target_audience || payload.audience || null,
        brief_channels: payload.channel || payload.channels || payload.platforms || null,
        brief_constraints: payload.constraints || null,
        brief_summary: payload.summary || payload.objective || payload.description || null,
        structural_guidance: payload.structural_guidance || [],
        knowledge_citation_ids: serverBrief.knowledge_citation_ids,
        evidence_provenance: serverBrief.evidence_provenance,
      });
    } else if (parsed.action === ACTIONS.REVISE) {
      prompt = buildQuickPrompt(
        parsed.revision_feedback,
        parsed.previous_version,
      );
    }

    const generation = await modelCaller(prompt);

    return respond(request, {
      ok: true,
      code: 'GENERATED',
      message: '内容生成完成。',
      data: {
        ...generation.result,
        summary: generation.summary,
      },
      meta: {
        schema_version: 'p30_content_create_v1',
        provider: generation.usage.provider,
        model: generation.usage.model,
        total_tokens: generation.usage.total_tokens,
        user_id: userId,
        role,
      },
    });
  } catch (error) {
    const sanitized = sanitizeError(error);
    console.error('P30 error:', JSON.stringify({ code: sanitized.code, status: sanitized.status }));
    // 日志中不输出完整消息以防信息泄露
    return respond(request, {
      ok: false,
      code: sanitized.code,
      message: sanitized.message,
    }, sanitized.status);
  }
}

Deno.serve(handleP30Request);
