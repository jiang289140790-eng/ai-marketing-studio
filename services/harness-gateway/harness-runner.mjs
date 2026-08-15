/* global clearTimeout, setTimeout */
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { clearTaskArtifactRefs, consumeTaskArtifactRefs } from './plugins/ams-tools/artifact-journal.mjs';
import { clearRequiredFailure, consumeRequiredFailure } from './plugins/ams-tools/required-failure-journal.mjs';

const MAX_STDOUT = 32_000;
const MAX_STDERR = 4_000;
const DSH_BIN = fileURLToPath(new URL('./node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));

export function resolveHarnessLaunch(configuredExecutable = '') {
  const executable = String(configuredExecutable).trim();
  if (executable) return Object.freeze({ executable, profileArgs: Object.freeze(['--profile', 'ams']) });
  // DSH's persisted-profile watcher uses cordis-plugin-hmr. Node intentionally
  // withholds the internal ESM loader unless the child itself is launched with
  // --expose-internals; NODE_OPTIONS rejects this flag. Keep the capability
  // scoped to the Harness child rather than exposing internals to the gateway.
  return Object.freeze({
    executable: process.execPath,
    profileArgs: Object.freeze(['--expose-internals', DSH_BIN, '--profile', 'ams']),
  });
}

// Fail-closed structured diagnostic produced when a Harness child process
// exits non-zero. Only this allowlisted shape (and nothing derived from raw
// stderr/stdout) may ever be persisted on a task. Every field has an explicit
// size/type boundary enforced again by normalizeDiagnostic in gateway-core.
export const HARNESS_DIAGNOSTIC_CODES = Object.freeze(['HARNESS_EXIT_FAILED', 'HARNESS_TIMEOUT', 'HARNESS_SPAWN_FAILED']);
export const HARNESS_DIAGNOSTIC_CATEGORIES = Object.freeze(['model_upstream', 'ams_tool_plugin', 'ams_tool_bridge', 'delegated_auth', 'timeout_termination', 'harness_runtime_unknown']);
export const HARNESS_DIAGNOSTIC_STAGES = Object.freeze(['model_call', 'tool_call', 'bridge_request', 'authorization', 'timeout', 'terminated', 'unknown', 'spawn']);
export const MAX_HARNESS_DIAGNOSTIC_SUMMARY = 240;

function appendBounded(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(next.length - limit);
}

// Patterns whose full extent is replaced by [REDACTED]. Over-redaction is
// safe by design; a false positive only hides benign text.
const SENSITIVE_PATTERN = new RegExp([
  // Authorization headers with any scheme (Bearer, Basic, Digest, ApiKey,
  // synthetic/unknown): scheme plus credential payload. The first payload
  // token is consumed whole; later tokens are only consumed when they look
  // like credential material (key=value or quoted), so benign same-line
  // trailing words ("... failed") and the following line survive.
  String.raw`\b(?:authorization|proxy-authorization)\b[ \t]*:[ \t]*(?:basic|digest|apikey|[a-z][a-z0-9._-]*)[ \t]+(?:[^\s"']+|"[^"\r\n]*")+(?:[ \t]+(?=[^ \t\r\n]*[="])(?:[^\s"']+|"[^"\r\n]*")+)*`,
  // JWT-like header.payload.signature where every segment is long.
  String.raw`[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}`,
  // Bearer tokens (with or without an "Authorization:" prefix).
  String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`,
  // Common provider key formats.
  String.raw`\bsk-[A-Za-z0-9]{16,}\b`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bghp_[A-Za-z0-9]{20,}\b`,
  String.raw`\bxox[baprs]-[A-Za-z0-9-]{10,}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{20,}\b`,
  // key=value / key: value / key "value" credential assignments.
  String.raw`\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?[^"'\s,;]+`,
  // Credentials embedded in URL query strings.
  String.raw`[?&](?:api[_-]?key|key|token|secret|password|sig|signature|X-Amz-Credential|X-Amz-Signature|X-Amz-Security-Token)=[^&\s"']+`,
  // Cookie/Set-Cookie header values: the complete value through the line
  // boundary so every semicolon-separated pair is covered. Set-Cookie is
  // listed first so it is replaced whole rather than leaving a fragment.
  String.raw`\bset-cookie\b[ \t]*:[ \t]*[^\r\n]+`,
  String.raw`\bcookie\b[ \t]*[:=][ \t]*[^\r\n]+`,
].join('|'), 'gi');

export function redactSensitive(text) {
  return String(text ?? '').replace(SENSITIVE_PATTERN, '[REDACTED]');
}

// Marker sets are checked in strict priority order: delegated auth before the
// transport layers (bridge before plugin) so a rejected bearer token or a
// failed bridge request is attributed to the outer cause, and model upstream
// last because its markers are the most generic (bare 4xx/5xx status codes).
// Anything unmatched falls back to an unknown Harness runtime category.
const DELEGATED_AUTH_MARKERS = [
  /DELEGATED_AUTHORIZATION/i,
  /\b(?:authorization|authentication)\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bbearer\b/i,
  /\bjwt\b/i,
  /\baccess denied\b/i,
  /\btoken (?:invalid|expired|revoked|rejected|missing)\b/i,
];
const AMS_TOOL_BRIDGE_MARKERS = [
  /harness-tool-bridge/i,
  /\btool bridge\b/i,
  /\bTOOL_BRIDGE/i,
  /\btool-proxy\b/i,
  /\bfetch failed\b/i,
  /\bECONNREFUSED\b/,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
];
const AMS_TOOL_PLUGIN_MARKERS = [
  /\bams_call\b/i,
  /\bTOOL_CALL/i,
  /tool call failed/i,
  /tool execution failed/i,
  /\bplugin\b/i,
];
const MODEL_UPSTREAM_MARKERS = [
  /\bdeepseek\b/i,
  /\bmodel[ _-]proxy\b/i,
  /\bupstream\b/i,
  /MODEL_UPSTREAM/i,
  /api\.deepseek\.com/i,
  /chat\/completions/i,
  /insufficient balance/i,
  /invalid api key/i,
  /payment required/i,
  /\b(?:401|402|403|429|5\d{2})\b/,
];

function diagnostic(code, category, stage, exitCode, summary) {
  return Object.freeze({
    code,
    category,
    stage,
    exit_code: Number.isSafeInteger(exitCode) ? exitCode : null,
    summary: redactSensitive(summary).slice(0, MAX_HARNESS_DIAGNOSTIC_SUMMARY),
  });
}

/**
 * Classify a non-zero Harness child exit into a bounded, redacted diagnostic.
 * `stderr` is consumed only here (as a marker source) and never persisted;
 * summaries are fixed templates plus at most a validated 4xx/5xx status code.
 * Input is deterministically sliced to MAX_STDERR characters, so oversized or
 * multibyte stderr cannot grow the diagnostic or the memory it uses.
 */
export function classifyHarnessExit({ exitCode = null, timedOut = false, stderr = '' } = {}) {
  const bounded = String(stderr ?? '').slice(0, MAX_STDERR);
  // The runner terminates the child itself on timeout; a killed process may
  // report an arbitrary exit code, so the runner's own timedOut flag is the
  // authoritative timeout signal. A null exit code with no runner timeout is
  // an external process termination.
  if (timedOut || exitCode == null) {
    return diagnostic(
      'HARNESS_TIMEOUT',
      'timeout_termination',
      timedOut ? 'timeout' : 'terminated',
      null,
      timedOut
        ? 'Harness process exceeded its allowed time budget and was terminated.'
        : 'Harness process was terminated before completing.',
    );
  }
  const status = (bounded.match(/\b(?:4\d{2}|5\d{2})\b/) || [null])[0];
  const statusSuffix = status ? ` (HTTP ${status})` : '';
  if (DELEGATED_AUTH_MARKERS.some((marker) => marker.test(bounded))) {
    return diagnostic('HARNESS_EXIT_FAILED', 'delegated_auth', 'authorization', exitCode, 'Delegated authorization or authentication was rejected.');
  }
  if (AMS_TOOL_BRIDGE_MARKERS.some((marker) => marker.test(bounded))) {
    return diagnostic('HARNESS_EXIT_FAILED', 'ams_tool_bridge', 'bridge_request', exitCode, `AMS tool bridge request failed${statusSuffix}.`);
  }
  if (AMS_TOOL_PLUGIN_MARKERS.some((marker) => marker.test(bounded))) {
    return diagnostic('HARNESS_EXIT_FAILED', 'ams_tool_plugin', 'tool_call', exitCode, 'AMS tool or plugin execution failed.');
  }
  if (MODEL_UPSTREAM_MARKERS.some((marker) => marker.test(bounded))) {
    return diagnostic('HARNESS_EXIT_FAILED', 'model_upstream', 'model_call', exitCode, `Model upstream (DeepSeek proxy) rejected the request${statusSuffix}.`);
  }
  return diagnostic('HARNESS_EXIT_FAILED', 'harness_runtime_unknown', 'unknown', exitCode, 'Harness process failed with an unrecognized runtime error.');
}

export function buildHarnessPrompt(request, taskId) {
  if (request?.approval?.paid_external_calls !== true) {
    throw Object.assign(new Error('Harness model execution requires explicit paid external call approval.'), { code: 'PAID_EXTERNAL_APPROVAL_REQUIRED' });
  }
  return [
    'You are the AI Marketing Studio orchestration worker.',
    'Use only the ams_call tool and only operations needed for this request.',
    `Task id: ${taskId}`,
    `Trusted bound project id (JSON; use this exact value for project-scoped tools): ${JSON.stringify(request.project_id || null)}`,
    `User intent: ${request.intent}`,
    `Paid external tools approved: ${request?.approval?.paid_external_calls === true}`,
    `Online writes approved: ${request?.approval?.online_writes === true}`,
    `Generation handoff approved: ${request?.approval?.handoff_creation === true}`,
    'First state a concise plan. Execute only scopes already approved in the trusted task envelope; never call a paid tool, write online data, or create a generation handoff unless its corresponding approval is true.',
  ].join('\n');
}

export function createHarnessRunner({
  executable,
  workspace = process.env.HARNESS_WORKSPACE || '/workspace',
  timeoutMs = Number(process.env.HARNESS_TASK_TIMEOUT_MS || 600_000),
  // Tests may inject both fields. Production resolves to a fixed Node + DSH
  // argv that also supports the persisted-profile HMR watcher.
  profileArgs,
} = {}) {
  const defaults = resolveHarnessLaunch(executable);
  executable = defaults.executable;
  profileArgs ||= defaults.profileArgs;
  return (request, taskId, signal, runtimeContext = null) => new Promise((resolve, reject) => {
    const prompt = buildHarnessPrompt(request, taskId);
    const harnessHome = process.env.HARNESS_HOME || '/data/harness';
    clearTaskArtifactRefs(harnessHome, taskId);
    clearRequiredFailure(harnessHome, taskId);
    const env = {
      PATH: process.env.PATH || '',
      HOME: process.env.HARNESS_HOME || '/data/harness',
      DSH_HOME: process.env.HARNESS_HOME || '/data/harness',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '',
      AMS_TASK_ID: taskId,
      AMS_USER_ID: request.user_id,
      AMS_PROJECT_ID: request.project_id || '',
      AMS_TASK_APPROVAL: JSON.stringify(request.approval || {}),
      AMS_TOOL_BRIDGE_URL: process.env.AMS_TOOL_BRIDGE_URL || '',
      AMS_TOOL_BRIDGE_SECRET_FILE: process.env.AMS_TOOL_BRIDGE_SECRET_FILE || '',
      AMS_TOOL_CLIENT_MODULE: process.env.AMS_TOOL_CLIENT_MODULE || '/app/tool-client.mjs',
      AMS_DELEGATED_AUTHORIZATION: runtimeContext?.delegatedAuthorization || '',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
    };
    const child = spawn(executable, [...profileArgs, prompt], {
      cwd: workspace,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk, MAX_STDOUT); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk, MAX_STDERR); });
    let forceTimer = null;
    let timedOut = false;
    const terminate = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      error.code = 'HARNESS_SPAWN_FAILED';
      // The OS spawn error message may embed the configured executable path
      // (an environment-derived value); persist only the safe diagnostic.
      error.diagnostic = diagnostic('HARNESS_SPAWN_FAILED', 'harness_runtime_unknown', 'spawn', null, 'Harness executable could not be started.');
      clearTaskArtifactRefs(harnessHome, taskId);
      clearRequiredFailure(harnessHome, taskId);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      const requiredFailure = consumeRequiredFailure(harnessHome, taskId);
      if (code === 0 && !requiredFailure) {
        try {
          return resolve({ final_response: stdout.trim(), artifact_refs: consumeTaskArtifactRefs(harnessHome, taskId) });
        } catch (error) {
          error.code ||= 'ARTIFACT_JOURNAL_INVALID';
          return reject(error);
        }
      }
      const artifactRefs = consumeTaskArtifactRefs(harnessHome, taskId);
      const error = new Error(`Harness process failed with code ${code ?? 'none'}${exitSignal ? ` (${exitSignal})` : ''}.`);
      error.code = requiredFailure?.tool_code || (timedOut || code == null ? 'HARNESS_TIMEOUT' : 'HARNESS_EXIT_FAILED');
      if (requiredFailure) {
        error.diagnostic = requiredFailure;
        error.partialResult = {
          final_response: stdout.trim(),
          artifact_refs: artifactRefs,
          partial_completion: artifactRefs.length > 0,
        };
        return reject(error);
      }
      // Bounded stderr is consumed by the classifier as a marker source only;
      // the durable task and API result carry just the redacted diagnostic.
      error.diagnostic = classifyHarnessExit({ exitCode: code, timedOut, stderr });
      reject(error);
    });
  });
}

export function harnessReadiness(env = process.env) {
  const bridgeUrl = String(env.AMS_TOOL_BRIDGE_URL || '');
  return {
    executable_configured: Boolean(env.HARNESS_EXECUTABLE),
    model_credential_configured: Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_BASE_URL),
    workspace_configured: Boolean(env.HARNESS_WORKSPACE),
    tool_bridge_configured: /^https:\/\/[^/?#]+\/functions\/v1\/harness-tool-bridge$/.test(bridgeUrl)
      && Boolean(env.AMS_TOOL_BRIDGE_SECRET_FILE),
  };
}
