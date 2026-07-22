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

export async function getRun(runId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(runId || ''))) {
    return { ok: false, code: 'INVALID_INPUT', message: 'run_id 不是有效 ID。' };
  }
  const client = createSupabaseAdmin();
  const { data, error } = await client.from('ops_runs').select('*').eq('id', runId).maybeSingle();
  if (error) return { ok: false, code: 'RESOURCE_NOT_FOUND', message: error.message };
  if (!data) return { ok: false, code: 'RESOURCE_NOT_FOUND', message: '执行记录不存在。' };
  return { ok: true, run: data };
}

export async function executeAction(body) {
  const client = createSupabaseAdmin();
  const { run_id: runId, user_id: userId, action, resource_type: resourceType, resource_id: resourceId, payload = {} } = body;
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

    const actionContext = {
      __ops_user_id: userId,
      __ops_run_id: runId,
      __ops_resource_type: resourceType || null,
      __ops_resource_id: resourceId || null,
    };
    const args = {
      ...(definition.transform ? definition.transform(payload, actionContext) : payload),
      ...actionContext,
    };
    const result = await callMcpTool(definition.tool, args);
    await stampUserOwnership(client, userId, action, result);
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

async function stampUserOwnership(client, userId, action, result = {}) {
  if (!userId || !result || typeof result !== 'object') return;
  const updates = [];

  if (result.campaign?.id || result.campaign_id) {
    updates.push(stampTable(client, 'campaigns', result.campaign?.id || result.campaign_id, userId));
  }
  if (result.plan?.id || result.strategy_id) {
    updates.push(stampTable(client, 'strategy_plans', result.plan?.id || result.strategy_id, userId));
  }
  if (Array.isArray(result.created_packages)) {
    for (const item of result.created_packages) {
      if (item?.id) updates.push(stampTable(client, 'content_packages', item.id, userId));
    }
  }
  if (Array.isArray(result.content_package_ids)) {
    for (const id of result.content_package_ids) updates.push(stampTable(client, 'content_packages', id, userId));
  }
  if (result.content_package_id) {
    updates.push(stampTable(client, 'content_packages', result.content_package_id, userId));
  }
  if (result.asset_id) {
    updates.push(stampTable(client, 'asset_library', result.asset_id, userId));
    updates.push(stampTable(client, 'assets', result.asset_id, userId));
  }
  if (result.publish_task_id) {
    updates.push(stampTable(client, 'publish_tasks', result.publish_task_id, userId));
  }
  if (result.connection_id) {
    updates.push(stampTable(client, 'platform_connections', result.connection_id, userId));
  }

  const settled = await Promise.allSettled(updates);
  const failed = settled.filter((item) => item.status === 'rejected');
  if (failed.length) {
    console.warn(`[ops bridge] ownership stamping warnings for ${action}: ${failed.length}`);
  }
}

async function stampTable(client, table, id, userId) {
  if (!id) return;
  const { error } = await client.from(table).update({ user_id: userId }).eq('id', id);
  if (error && !/column .*user_id|Could not find/i.test(error.message || '')) throw error;
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
