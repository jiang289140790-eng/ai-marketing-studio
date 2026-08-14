/* global clearTimeout, setTimeout */
import { spawn } from 'node:child_process';

const MAX_STDOUT = 32_000;
const MAX_STDERR = 4_000;

function appendBounded(current, chunk, limit) {
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(next.length - limit);
}

export function buildHarnessPrompt(request, taskId) {
  if (request?.approval?.paid_external_calls !== true) {
    throw Object.assign(new Error('Paid model execution requires explicit approval.'), { code: 'PAID_EXTERNAL_APPROVAL_REQUIRED' });
  }
  return [
    'You are the AI Marketing Studio orchestration worker.',
    'H1 diagnostic profile: do not access business systems or mutate files.',
    `Task id: ${taskId}`,
    `User intent: ${request.intent}`,
    'Return a concise plan only.',
  ].join('\n');
}

export function createHarnessRunner({
  executable = process.env.HARNESS_EXECUTABLE || '/app/node_modules/.bin/dsh',
  workspace = process.env.HARNESS_WORKSPACE || '/workspace',
  timeoutMs = Number(process.env.HARNESS_TASK_TIMEOUT_MS || 600_000),
} = {}) {
  return (request, taskId, signal) => new Promise((resolve, reject) => {
    const prompt = buildHarnessPrompt(request, taskId);
    const env = {
      PATH: process.env.PATH || '',
      HOME: process.env.HARNESS_HOME || '/data/harness',
      DSH_HOME: process.env.HARNESS_HOME || '/data/harness',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '',
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
    };
    const child = spawn(executable, ['--profile', 'headless', prompt], {
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
      reject(error);
    });
    child.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (code === 0) return resolve({ final_response: stdout.trim(), artifact_refs: [] });
      const error = new Error(`Harness process failed with code ${code ?? 'none'}${exitSignal ? ` (${exitSignal})` : ''}.`);
      error.code = code == null ? 'HARNESS_TIMEOUT' : 'HARNESS_EXIT_FAILED';
      // stderr is intentionally not attached to the durable task or API result.
      void stderr;
      reject(error);
    });
  });
}

export function harnessReadiness(env = process.env) {
  return {
    executable_configured: Boolean(env.HARNESS_EXECUTABLE),
    model_credential_configured: Boolean(env.DEEPSEEK_API_KEY && env.DEEPSEEK_BASE_URL),
    workspace_configured: Boolean(env.HARNESS_WORKSPACE),
  };
}
