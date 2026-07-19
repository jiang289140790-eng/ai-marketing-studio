import { requireSupabase } from './supabase-client';
import { nextRetryCount, recordCost } from './stability-service';

const workflowRunSelect = `
  *,
  workflow:assets!workflow_runs_workflow_id_fkey(name,type,model),
  characters(name),
  prompts(title,content)
`;

export async function listWorkflowRuns(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('workflow_runs')
    .select(workflowRunSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.workflowId) query = query.eq('workflow_id', filters.workflowId);
  if (filters.characterId) query = query.eq('character_id', filters.characterId);
  if (filters.toolId) query = query.ilike('tool_id', `%${filters.toolId}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createWorkflowRun(userId, payload) {
  const client = requireSupabase();
  const runPayload = {
    user_id: userId,
    workflow_id: payload.workflow_id || null,
    tool_id: payload.tool_id || null,
    character_id: payload.character_id || null,
    prompt_id: payload.prompt_id || null,
    asset_ids: payload.asset_ids || [],
    input_data: payload.input_data || {},
    status: payload.status || 'pending',
    cost: payload.cost || 0,
    retry_count: Number(payload.retry_count || 0),
    max_retry: Number(payload.max_retry || 3),
    last_error: payload.last_error || null,
  };

  const { data, error } = await client
    .from('workflow_runs')
    .insert(runPayload)
    .select(workflowRunSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updateWorkflowStatus(runId, status, payload = {}) {
  const client = requireSupabase();
  let currentRun = null;

  if (status === 'failed' && payload.retry_count === undefined) {
    const { data, error } = await client
      .from('workflow_runs')
      .select('retry_count,max_retry')
      .eq('id', runId)
      .single();

    if (error) throw error;
    currentRun = data;
  }

  const update = {
    status,
    error_message: payload.error_message || null,
  };

  if (['success', 'failed'].includes(status)) {
    update.completed_at = payload.completed_at || new Date().toISOString();
  }

  if (payload.cost !== undefined) update.cost = payload.cost;
  if (payload.output_data !== undefined) update.output_data = payload.output_data;
  if (payload.retry_count !== undefined) {
    update.retry_count = payload.retry_count;
  } else if (status === 'failed') {
    update.retry_count = nextRetryCount(currentRun || {});
  }
  if (payload.max_retry !== undefined) update.max_retry = payload.max_retry;
  if (payload.last_error !== undefined) {
    update.last_error = payload.last_error;
  } else if (status === 'failed') {
    update.last_error = payload.error_message || 'Workflow failed';
  } else if (status === 'success') {
    update.last_error = null;
  }

  const { data, error } = await client
    .from('workflow_runs')
    .update(update)
    .eq('id', runId)
    .select(workflowRunSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function saveWorkflowResult(userId, run, result) {
  const client = requireSupabase();
  const outputData = {
    title: result.title || 'Workflow 生成结果',
    text: result.text || '',
    url: result.url || '',
    thumbnail: result.thumbnail || result.url || '',
    type: result.type || 'image',
    model: result.model || run.workflow?.model || '',
    metadata: result.metadata || {},
  };

  const { data: asset, error: assetError } = await client
    .from('assets')
    .insert({
      user_id: userId,
      name: outputData.title,
      type: outputData.type,
      url: outputData.url || null,
      thumbnail: outputData.thumbnail || null,
      prompt: outputData.text || run.prompts?.content || null,
      model: outputData.model || null,
      workflow: {
        run_id: run.id,
        workflow_id: run.workflow_id,
        tool_id: run.tool_id,
        output: outputData.metadata,
      },
      tags: ['workflow-result'],
      source: 'workflow-runtime',
    })
    .select()
    .single();

  if (assetError) throw assetError;

  const { data: content, error: contentError } = await client
    .from('content_library')
    .insert({
      user_id: userId,
      title: outputData.title,
      content_text: outputData.text || run.prompts?.content || '',
      media_url: outputData.url || null,
      content_type: outputData.type === 'video' ? 'video' : outputData.type === 'image' ? 'image' : 'text',
      platform: run.input_data?.platform || null,
      account_category: run.input_data?.account_category || 'brand',
      asset_id: asset.id,
      character_id: run.character_id || null,
      prompt_id: run.prompt_id || null,
      status: 'draft',
    })
    .select()
    .single();

  if (contentError) throw contentError;

  const updatedRun = await updateWorkflowStatus(run.id, 'success', {
    cost: Number(result.cost || run.cost || 0),
    output_data: {
      ...outputData,
      asset_id: asset.id,
      content_id: content.id,
    },
  });

  if (Number(result.cost || run.cost || 0) > 0) {
    await recordCost(userId, {
      category: 'workflow',
      source: run.tool_id || run.workflow?.name || 'workflow-runtime',
      amount: Number(result.cost || run.cost || 0),
      metadata: {
        workflow_run_id: run.id,
        asset_id: asset.id,
        content_id: content.id,
      },
    });
  }

  return { run: updatedRun, asset, content };
}

export function getWorkflowStats(runs) {
  const total = runs.length;
  const success = runs.filter((run) => run.status === 'success').length;
  const cost = runs.reduce((sum, run) => sum + Number(run.cost || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todayRuns = runs.filter((run) => String(run.created_at || '').slice(0, 10) === today).length;
  const workflowCounts = new Map();
  const characterCounts = new Map();

  for (const run of runs) {
    const workflowName = run.workflow?.name || run.tool_id || '未命名 Workflow';
    workflowCounts.set(workflowName, (workflowCounts.get(workflowName) || 0) + 1);

    if (run.characters?.name) {
      characterCounts.set(run.characters.name, (characterCounts.get(run.characters.name) || 0) + 1);
    }
  }

  const topWorkflow = [...workflowCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  const topCharacter = [...characterCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  return {
    total,
    todayRuns,
    successRate: total ? Math.round((success / total) * 100) : 0,
    cost,
    topWorkflow,
    topCharacter,
  };
}
