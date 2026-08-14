/* global clearTimeout, setTimeout */
import { spawn } from 'node:child_process';
import { clearTaskArtifactRefs, consumeTaskArtifactRefs } from './plugins/ams-tools/artifact-journal.mjs';

const MAX_STDOUT = 32_000;
const MAX_STDERR = 4_000;

function appendBounded(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(next.length - limit);
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
  executable = process.env.HARNESS_EXECUTABLE || '/app/node_modules/.bin/dsh',
  workspace = process.env.HARNESS_WORKSPACE || '/workspace',
  timeoutMs = Number(process.env.HARNESS_TASK_TIMEOUT_MS || 600_000),
} = {}) {
  return (request, taskId, signal, runtimeContext = null) => new Promise((resolve, reject) => {
    const prompt = buildHarnessPrompt(request, taskId);
    const harnessHome = process.env.HARNESS_HOME || '/data/harness';
    clearTaskArtifactRefs(harnessHome, taskId);
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
    const child = spawn(executable, ['--profile', 'ams', prompt], {
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
    const terminate = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const timer = setTimeout(terminate, timeoutMs);
    signal?.addEventListener('abort', terminate, { once: true });
    child.once('error', (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      error.code = 'HARNESS_SPAWN_FAILED';
      clearTaskArtifactRefs(harnessHome, taskId);
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code === 0) {
        try {
          return resolve({ final_response: stdout.trim(), artifact_refs: consumeTaskArtifactRefs(harnessHome, taskId) });
        } catch (error) {
          error.code ||= 'ARTIFACT_JOURNAL_INVALID';
          return reject(error);
        }
      }
      clearTaskArtifactRefs(harnessHome, taskId);
      const error = new Error(`Harness process failed with code ${code ?? 'none'}${exitSignal ? ` (${exitSignal})` : ''}.`);
      error.code = code == null ? 'HARNESS_TIMEOUT' : 'HARNESS_EXIT_FAILED';
      // stderr is intentionally not attached to the durable task or API result.
      void stderr;
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
