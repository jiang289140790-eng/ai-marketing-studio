import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import { fixedGatewayBase, signGatewayRequest, validateEdgeRequest } from './edge-core.mjs';

const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);
const MAX_BODY = 64 * 1024;
// Covers one complete valid gateway task: a 12,000-code-unit UTF-8 intent,
// 12 KiB final response, and 50 bounded 500-code-unit artifact references.
const MAX_RESPONSE = 192 * 1024;

function headers(request: Request) {
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

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: headers(request) });
  if (request.method !== 'POST') return json(request, { ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return json(request, { ok: false, code: 'AUTH_REQUIRED' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const publishableKey = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const gatewaySecret = Deno.env.get('AMS_HARNESS_GATEWAY_HMAC_SECRET') || '';
  const gatewayRaw = Deno.env.get('AMS_HARNESS_GATEWAY_URL') || '';
  if (!supabaseUrl || !publishableKey || !serviceKey || gatewaySecret.length < 32 || !gatewayRaw) {
    return json(request, { ok: false, code: 'SERVICE_CONFIG_MISSING' }, 503);
  }

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData?.user?.id) return json(request, { ok: false, code: 'AUTH_FAILED' }, 401);
  const userId = String(authData.user.id);
  const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: roleData, error: roleError } = await serviceClient.schema('api').rpc('p19_staging_role', { p_user_id: userId });
  if (roleError) return json(request, { ok: false, code: 'ROLE_LOOKUP_FAILED' }, 503);
  const accessRole = String(roleData || '');

  let input: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return json(request, { ok: false, code: 'BODY_TOO_LARGE' }, 413);
    input = JSON.parse(raw);
  } catch {
    return json(request, { ok: false, code: 'INVALID_JSON' }, 400);
  }
  const checked = validateEdgeRequest(input, { userId, accessRole });
  if (!checked.ok) return json(request, checked, checked.code === 'OPERATOR_REQUIRED' || checked.code === 'STAGING_ROLE_DENIED' ? 403 : 400);

  try {
    const gateway = fixedGatewayBase(gatewayRaw);
    const rawBody = checked.body == null ? '' : JSON.stringify(checked.body);
    const timestamp = String(Date.now());
    const { signature } = await signGatewayRequest(gatewaySecret, {
      method: checked.method,
      path: checked.path,
      userId,
      timestamp,
      rawBody,
      delegatedAuthorization: authorization,
    });
    const target = new URL(checked.path, `${gateway.toString()}/`);
    const response = await fetch(target, {
      method: checked.method,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-ams-user-id': userId,
        'x-ams-timestamp': timestamp,
        'x-ams-signature': signature,
        'x-ams-delegated-authorization': authorization,
      },
      body: checked.method === 'POST' ? rawBody : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE) throw new Error('GATEWAY_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE) throw new Error('GATEWAY_RESPONSE_TOO_LARGE');
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, code: 'GATEWAY_RESPONSE_INVALID' }; }
    return json(request, body, response.status);
  } catch {
    return json(request, { ok: false, code: 'HARNESS_GATEWAY_UNAVAILABLE' }, 503);
  }
});
