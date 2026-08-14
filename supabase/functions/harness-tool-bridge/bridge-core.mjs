/* global TextDecoder, TextEncoder, structuredClone */
export const BRIDGE_SCHEMA_VERSION = 'ams_harness_bridge_v1';

export async function readBoundedText(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('BODY_LIMIT_INVALID');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* best-effort stream cancellation */ }
      const error = new Error('Request body exceeded the bounded bridge limit.');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export const OPERATIONS = Object.freeze({
  'workspace.project.list': ['p19-workspace-command', 'command', 'project.list'],
  'workspace.project.read': ['p19-workspace-command', 'command', 'project.read'],
  'workspace.lineage.audit': ['p19-workspace-command', 'command', 'lineage.audit'],
  'workspace.project.create': ['p19-workspace-command', 'command', 'project.create'],
  'workspace.project.update': ['p19-workspace-command', 'command', 'project.update'],
  'workspace.evidence.create': ['p19-workspace-command', 'command', 'evidence.create'],
  'workspace.analysis.create': ['p19-workspace-command', 'command', 'analysis.create'],
  'workspace.card.create': ['p19-workspace-command', 'command', 'card.create'],
  'workspace.brief.assemble': ['p19-workspace-command', 'command', 'brief.assemble'],
  'workspace.handoff.create': ['p19-workspace-command', 'command', 'handoff.create'],
  'research.status': ['p22-research-assist', 'action', 'status'],
  'research.collect_url': ['p22-research-assist', 'action', 'collect_url'],
  'research.search_x': ['p22-research-assist', 'action', 'search'],
  'research.search_reddit': ['p22-research-assist', 'action', 'search_reddit'],
  'research.analyze_persisted': ['p22-research-assist', 'action', 'analyze_persisted'],
  'research.generate_similar': ['p22-research-assist', 'action', 'generate_similar'],
});

function fail(code, field = null) {
  return { ok: false, code, diagnostics: { field } };
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function boundedClone(value, { stringLimit, arrayLimit, depthLimit }, depth = 0) {
  if (typeof value === 'string') return value.length > stringLimit ? `${value.slice(0, stringLimit)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= depthLimit) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) => boundedClone(item, { stringLimit, arrayLimit, depthLimit }, depth + 1));
  }
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    output[key] = boundedClone(item, { stringLimit, arrayLimit, depthLimit }, depth + 1);
  }
  return output;
}

function boundAnyResponse(operation, body, maxBytes) {
  const source = structuredClone(body);
  const originalBytes = jsonBytes(source);
  if (originalBytes <= maxBytes) return source;
  for (const limits of [
    { stringLimit: 1500, arrayLimit: 20, depthLimit: 6 },
    { stringLimit: 500, arrayLimit: 20, depthLimit: 5 },
    { stringLimit: 160, arrayLimit: 10, depthLimit: 4 },
  ]) {
    const bounded = boundedClone(source, limits);
    bounded.harness_summary = {
      bounded: true,
      content_truncated: true,
      operation,
      original_bytes: originalBytes,
    };
    if (jsonBytes(bounded) <= maxBytes) return bounded;
  }
  const error = new Error('Bridge response could not be represented inside the gateway limit.');
  error.code = 'BRIDGE_RESPONSE_TOO_LARGE';
  throw error;
}

export function summarizeBridgeResponse(operation, body, maxBytes = 60 * 1024) {
  // P22 collection proofs bind exact text, URLs, platform, media identities,
  // and metadata. Never truncate a proof-bound research response: return the
  // exact bounded value or fail closed so Harness cannot persist a mutation
  // that the P19 verifier will necessarily reject.
  if (operation.startsWith('research.')) {
    const exact = structuredClone(body);
    if (jsonBytes(exact) > maxBytes) {
      const error = new Error('Exact research response exceeded the gateway limit.');
      error.code = 'BRIDGE_RESPONSE_TOO_LARGE';
      throw error;
    }
    return exact;
  }
  if (operation !== 'workspace.project.read') return boundAnyResponse(operation, body, maxBytes);
  const exact = structuredClone(body);
  if (jsonBytes(exact) > maxBytes) {
    const error = new Error('Exact project response exceeded the gateway limit.');
    error.code = 'PROJECT_SUMMARY_TOO_LARGE';
    throw error;
  }
  return exact;
}

export function validateBridgeEnvelope(input, verifiedUserId) {
  if (!plainObject(input) || input.schema_version !== BRIDGE_SCHEMA_VERSION) return fail('BRIDGE_SCHEMA_INVALID');
  if (!plainObject(input.call) || !plainObject(input.boundary)) return fail('BRIDGE_ENVELOPE_INVALID');
  if (input.call.schema_version !== 'ams_harness_tool_v1') return fail('TOOL_SCHEMA_INVALID');
  if (input.call.user_id !== verifiedUserId) return fail('USER_BINDING_MISMATCH', 'user_id');
  const expected = OPERATIONS[input.call.operation];
  if (!expected) return fail('OPERATION_DENIED', 'operation');
  const [endpoint, discriminator, value] = expected;
  if (input.boundary.endpoint !== endpoint || !plainObject(input.boundary.body)
    || input.boundary.body[discriminator] !== value) return fail('BOUNDARY_BINDING_MISMATCH', discriminator);
  const allowedBoundary = endpoint === 'p19-workspace-command'
    ? new Set(['schema_version', 'command', 'idempotency_key', 'payload'])
    : new Set(['action', 'idempotency_key', ...Object.keys(input.call.payload || {})]);
  const unknown = Object.keys(input.boundary.body).find((key) => !allowedBoundary.has(key));
  if (unknown) return fail('BOUNDARY_UNKNOWN_FIELD', unknown);
  return { ok: true, endpoint, operation: input.call.operation, body: structuredClone(input.boundary.body) };
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function verifyToolBridgeSignature({ secret, timestamp, authorizationDigest, rawBody, signature, now = Date.now() }) {
  if (typeof secret !== 'string' || secret.length < 32 || !/^\d{13}$/.test(timestamp)
    || !/^[0-9a-f]{64}$/.test(authorizationDigest) || !/^[0-9a-f]{64}$/.test(signature)
    || Math.abs(now - Number(timestamp)) > 60_000) return false;
  return await hmacHex(secret, `${timestamp}\n${authorizationDigest}\n${rawBody}`) === signature;
}

export async function sha256Hex(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((value) => value.toString(16).padStart(2, '0')).join('');
}
