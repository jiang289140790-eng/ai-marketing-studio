/* global AbortController, Buffer, URL, clearTimeout, setTimeout */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeToolResult, toBoundaryRequest, validateToolCall } from './tool-contract.mjs';

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 64 * 1024;

function sign(secret, timestamp, authorizationDigest, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}\n${authorizationDigest}\n${rawBody}`).digest('hex');
}

export function verifyBridgeSignature(secret, timestamp, authorizationDigest, rawBody, signature) {
  if (typeof secret !== 'string' || secret.length < 32 || !/^\d{13}$/.test(timestamp)
    || !/^[0-9a-f]{64}$/.test(authorizationDigest) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = sign(secret, timestamp, authorizationDigest, rawBody);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export function createToolClient({
  bridgeUrl,
  bridgeSecret,
  fetchImpl = globalThis.fetch,
  timeoutMs = 145_000,
  allowInternalHttp = false,
  delegatedAuthorization = '',
} = {}) {
  const internalHttp = allowInternalHttp && /^http:\/\/tool-proxy(?::\d+)?\//.test(String(bridgeUrl));
  if (typeof bridgeUrl !== 'string' || (!/^https:\/\//.test(bridgeUrl) && !internalHttp)) throw new TypeError('A fixed HTTPS bridgeUrl is required.');
  if (typeof bridgeSecret !== 'string' || bridgeSecret.length < 32) throw new TypeError('A bridge secret of at least 32 characters is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required.');
  if (!/^Bearer [A-Za-z0-9._~-]{20,8192}$/.test(delegatedAuthorization)) throw new TypeError('A delegated bearer authorization is required.');
  const fixedUrl = new URL(bridgeUrl);
  if (fixedUrl.username || fixedUrl.password || fixedUrl.hash || fixedUrl.search) throw new TypeError('bridgeUrl must not contain credentials, query, or fragment.');

  // The single canonical contract: `call` is always the external
  // ams_harness_tool_v1 tool call ({schema_version, operation, payload,
  // idempotency_key, expected_revision?}) exactly as a caller proposed it.
  // This client performs the one bridge-boundary validation on that shape;
  // trusted identity (task_id/user_id/project_id) comes only from
  // `trustedContext`, and any caller-supplied envelope extra — including the
  // internally enriched executor value — fails closed with the exact
  // offending field. The enriched validated value never crosses this
  // boundary; it exists only inside the signed bridge envelope below.
  return async function invokeTool(rawCall, trustedContext, signal) {
    const checked = validateToolCall(rawCall, trustedContext);
    if (!checked.ok) return normalizeToolResult({ task_id: trustedContext?.task_id || 'invalid', operation: rawCall?.operation || 'invalid' }, checked);
    const boundary = toBoundaryRequest(checked.value);
    const envelope = {
      schema_version: 'ams_harness_bridge_v1',
      call: checked.value,
      boundary,
    };
    const rawBody = JSON.stringify(envelope);
    const timestamp = String(Date.now());
    const authorizationDigest = createHash('sha256').update(delegatedAuthorization).digest('hex');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(fixedUrl, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-ams-bridge-timestamp': timestamp,
          'x-ams-bridge-signature': sign(bridgeSecret, timestamp, authorizationDigest, rawBody),
          'x-ams-authorization-sha256': authorizationDigest,
          authorization: delegatedAuthorization,
        },
        body: rawBody,
        signal: controller.signal,
      });
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Tool bridge response exceeded the limit.'), { code: 'TOOL_RESPONSE_TOO_LARGE' });
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw Object.assign(new Error('Tool bridge response exceeded the limit.'), { code: 'TOOL_RESPONSE_TOO_LARGE' });
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = { ok: false, code: 'TOOL_RESPONSE_INVALID', diagnostics: { issues: ['Bridge returned invalid JSON.'] } }; }
      if (!response.ok && parsed.ok !== false) parsed = { ok: false, code: 'TOOL_BRIDGE_HTTP_ERROR', diagnostics: { issues: [`HTTP ${response.status}`] } };
      return normalizeToolResult(checked.value, parsed);
    } catch (error) {
      return normalizeToolResult(checked.value, { ok: false, code: error?.name === 'AbortError' ? 'TOOL_TIMEOUT' : error?.code || 'TOOL_BRIDGE_UNAVAILABLE', diagnostics: { issues: ['Tool bridge request failed.'] } });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}
