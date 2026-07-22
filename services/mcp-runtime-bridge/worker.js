import { createClient } from '@supabase/supabase-js';
import { getActionDefinition, NOT_CONFIGURED_ACTIONS } from './action-registry.js';
import { sanitizeError } from './auth.js';
import { callMcpTool } from './mcp-client.js';

const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export function createSupabaseAdmin() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRole) throw new Error('Bridge 缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY。');
  return createClient(url, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function updateRun(client, runId, patch) {
  const update = {
    ...patch,
    updated_at: new Date().toISOString(),
  };
  if (terminalStatuses.has(update.status)) {
    update.completed_at = update.completed_at || new Date().toISOString();
    update.progress = update.progress ?? 100;
  }
  const { error } = await client.from('ops_runs').update(update).eq('id', runId);
  if (error) throw error;
}

export async function executeAction(body) {
  const client = createSupabaseAdmin();
  const { run_id: runId, action, payload = {} } = body;
  const notConfigured = NOT_CONFIGURED_ACTIONS[action];
  if (notConfigured) {
    await updateRun(client, runId, {
      status: 'failed',
      error_code: 'MCP_UNAVAILABLE',
      error_message: notConfigured,
      retryable: true,
    });
    return;
  }

  const definition = getActionDefinition(action);
  if (!definition) {
    await updateRun(client, runId, {
      status: 'failed',
      error_code: 'INVALID_INPUT',
      error_message: '该 action 未加入 Bridge allowlist。',
      retryable: false,
    });
    return;
  }

  try {
    await updateRun(client, runId, {
      status: 'running',
      progress: 15,
      started_at: new Date().toISOString(),
    });

    const args = definition.transform ? definition.transform(payload) : payload;
    const result = await callMcpTool(definition.tool, args);
    const status = result.status || result.ok;
    const failed = status === 'error' || status === 'failed' || result.error;

    await updateRun(client, runId, {
      status: failed ? 'failed' : 'completed',
      progress: 100,
      result_summary: summarizeResult(result),
      error_code: failed ? (result.code || 'MCP_UNAVAILABLE') : null,
      error_message: failed ? sanitizeError(result.error || result.message || 'MCP tool returned failure.') : null,
      retryable: Boolean(failed),
    });
  } catch (error) {
    await updateRun(client, runId, {
      status: 'failed',
      error_code: 'MCP_UNAVAILABLE',
      error_message: sanitizeError(error),
      retryable: true,
    });
  }
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return { result };
  const summary = {};
  for (const key of ['status', 'id', 'campaign_id', 'strategy_id', 'content_package_ids', 'asset_id', 'publish_task_id', 'message', 'summary']) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (!Object.keys(summary).length) summary.status = result.status || 'completed';
  return summary;
}
