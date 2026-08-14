import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import { readBoundedText, sha256Hex, summarizeBridgeResponse, validateBridgeEnvelope, verifyToolBridgeSignature } from './bridge-core.mjs';

// The signed bridge envelope intentionally carries the validated tool call and
// its exact downstream boundary copy. A 64 KiB business payload can therefore
// occupy slightly over 128 KiB on the wire; keep the external business limit
// unchanged while bounding this internal duplicated envelope at 192 KiB.
const MAX_BODY = 192 * 1024;
const MAX_RESPONSE = 2 * 1024 * 1024 + 64 * 1024;
const MAX_UPSTREAM_RESPONSE = 2 * 1024 * 1024;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readBounded(response: Response, limit: number) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const timestamp = request.headers.get('x-ams-bridge-timestamp') || '';
  const signature = request.headers.get('x-ams-bridge-signature') || '';
  const declaredDigest = request.headers.get('x-ams-authorization-sha256') || '';
  const secret = Deno.env.get('AMS_HARNESS_TOOL_BRIDGE_SECRET') || '';
  if (!token || secret.length < 32) return json({ ok: false, code: 'UNAUTHORIZED' }, 401);

  let rawBody: string;
  try {
    rawBody = await readBoundedText(request, MAX_BODY);
  } catch (error) {
    return json({ ok: false, code: error?.code === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'BODY_READ_FAILED' }, error?.code === 'BODY_TOO_LARGE' ? 413 : 400);
  }
  const actualDigest = await sha256Hex(authorization);
  if (actualDigest !== declaredDigest || !(await verifyToolBridgeSignature({ secret, timestamp, authorizationDigest: actualDigest, rawBody, signature }))) {
    return json({ ok: false, code: 'UNAUTHORIZED' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const publishableKey = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  if (!supabaseUrl || !publishableKey) return json({ ok: false, code: 'SERVICE_CONFIG_MISSING' }, 503);
  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData?.user?.id) return json({ ok: false, code: 'AUTH_FAILED' }, 401);

  let envelope;
  try { envelope = JSON.parse(rawBody); } catch { return json({ ok: false, code: 'INVALID_JSON' }, 400); }
  const checked = validateBridgeEnvelope(envelope, String(authData.user.id));
  if (!checked.ok) return json(checked, checked.code === 'USER_BINDING_MISMATCH' ? 403 : 400);

  try {
    const target = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/${checked.endpoint}`;
    const response = await fetch(target, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization, apikey: publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify(checked.body),
      signal: AbortSignal.timeout(140_000),
    });
    const text = await readBounded(response, MAX_UPSTREAM_RESPONSE);
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, code: 'UPSTREAM_RESPONSE_INVALID' }; }
    const summarized = summarizeBridgeResponse(checked.operation, body, MAX_RESPONSE - 1024);
    return json(summarized, response.status);
  } catch (error) {
    if (error?.code === 'PROJECT_SUMMARY_TOO_LARGE' || error?.code === 'BRIDGE_RESPONSE_TOO_LARGE') {
      return json({ ok: false, code: error.code, diagnostics: { issues: ['Boundary response exceeds the bounded Harness response contract.'] } }, 502);
    }
    return json({ ok: false, code: 'UPSTREAM_UNAVAILABLE', diagnostics: { issues: ['Existing P19/P22 boundary could not be reached.'] } }, 503);
  }
});
