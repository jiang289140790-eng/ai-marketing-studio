import { requireSupabase } from './supabase-client';

const defaultAssetAgentModel = 'comfyui';

export const comfyWorkflowCategories = [
  { value: 'character_generation', label: '角色图片生成' },
  { value: 'motion_transfer', label: '动作迁移' },
  { value: 'face_swap', label: '换脸' },
  { value: 'clothing_transfer', label: '换装' },
  { value: 'video_generation', label: '视频生成' },
];

export async function listComfyWorkflows(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('comfy_workflows')
    .select('*, assets(name,type,model)')
    .eq('user_id', userId)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });

  if (filters.mode) query = query.eq('mode', filters.mode);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.category) query = query.eq('category', filters.category);

  const { data, error } = await query;
  if (error) throw error;

  const rows = data || [];
  if (!filters.search) return rows;

  const keyword = filters.search.toLowerCase();
  return rows.filter((workflow) => [
    workflow.name,
    workflow.description,
    workflow.model,
    workflow.checkpoint,
    workflow.category,
    ...(workflow.loras || []),
    ...(workflow.tags || []),
  ].filter(Boolean).join(' ').toLowerCase().includes(keyword));
}

export async function createComfyWorkflow(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('comfy_workflows')
    .insert({
      user_id: userId,
      asset_id: payload.asset_id || null,
      name: payload.name,
      description: payload.description || null,
      mode: payload.mode || 'image',
      version: payload.version || '1.0.0',
      status: payload.status || 'active',
      workflow_json: payload.workflow_json || {},
      input_schema: payload.input_schema || {},
      output_schema: payload.output_schema || {},
      model: payload.model || null,
      checkpoint: payload.checkpoint || null,
      loras: payload.loras || [],
      default_params: payload.default_params || {},
      node_mappings: payload.node_mappings || {},
      category: payload.category || 'character_generation',
      priority: payload.priority || 100,
      detected_nodes: payload.detected_nodes || {},
      detected_models: payload.detected_models || {},
      controlnets: payload.controlnets || [],
      tags: payload.tags || [],
      last_synced_at: payload.last_synced_at || new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function generateImageAssetForContent(userId, contentItem, options = {}) {
  const client = requireSupabase();
  const agent = await getOrCreateAssetGenerationAgent(client, userId);
  const workflow = await selectImageWorkflow(client, userId, contentItem, options);

  if (!workflow) {
    throw new Error('还没有可用的 ComfyUI 图片 Workflow。请先用 Workflow Registry 同步并启用一个 active/image workflow。');
  }

  const task = await createAssetGenerationTask(client, userId, agent, contentItem, workflow, options);
  const run = await createAssetGenerationRun(client, userId, agent, task, contentItem, workflow, options);
  const workflowRun = await createWorkflowRunRecord(client, userId, contentItem, workflow, task, run, options);

  try {
    const { data, error } = await client.functions.invoke('media-gateway', {
      body: {
        action: 'generateImage',
        workflow_run_id: workflowRun.id,
      },
    });

    if (error) throw error;
    if (data?.status === 'failed' || data?.error) {
      throw new Error(data?.error?.message || data?.error || 'ComfyUI 素材生成失败。');
    }

    await updateAgentRun(client, run.id, 'success', {
      output: {
        kind: 'asset_generation',
        workflow_run_id: workflowRun.id,
        asset_id: data.asset_id || null,
        url: data.url || null,
      },
      cost: Number(data.cost?.amount || data.cost || 0),
      duration: Number(data.duration_ms || 0),
    });
    await updateAgentTask(client, task.id, 'success', {
      result: {
        kind: 'asset_generation',
        workflow_run_id: workflowRun.id,
        asset_id: data.asset_id || null,
        content_id: contentItem.id,
      },
    });

    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ComfyUI 素材生成失败。';
    await markWorkflowRunFailed(client, workflowRun.id, message);
    await updateAgentRun(client, run.id, 'failed', {
      output: { error: message, workflow_run_id: workflowRun.id },
      error_message: message,
    });
    await updateAgentTask(client, task.id, 'failed', {
      result: { error: message, workflow_run_id: workflowRun.id },
      last_error: message,
    });
    throw error;
  }
}

async function getOrCreateAssetGenerationAgent(client, userId) {
  const { data: existing, error: existingError } = await client
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .eq('type', 'asset_generator')
    .order('created_at', { ascending: true })
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.[0]) return existing[0];

  const { data, error } = await client
    .from('agents')
    .insert({
      user_id: userId,
      name: 'Asset Generation Agent',
      description: 'Create image assets from content drafts through Media Gateway and ComfyUI.',
      type: 'asset_generator',
      model: defaultAssetAgentModel,
      system_prompt: 'Use Media Gateway for all media generation. Never call providers directly.',
      status: 'active',
      schedule: { mode: 'manual' },
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getComfyWorkflow(client, userId, workflowId) {
  const { data, error } = await client
    .from('comfy_workflows')
    .select('*')
    .eq('user_id', userId)
    .eq('id', workflowId)
    .single();
  if (error) throw error;
  return data;
}

async function getDefaultImageWorkflow(client, userId) {
  const { data, error } = await client
    .from('comfy_workflows')
    .select('*')
    .eq('user_id', userId)
    .eq('mode', 'image')
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function selectImageWorkflow(client, userId, contentItem, options) {
  const explicitWorkflowId = options.comfy_workflow_id || options.workflow_id;
  if (explicitWorkflowId) {
    return getComfyWorkflow(client, userId, explicitWorkflowId);
  }

  if (contentItem.character_id) {
    const characterWorkflow = await getCharacterMatchedWorkflow(client, userId, contentItem.character_id, options);
    if (characterWorkflow) return characterWorkflow;
  }

  if (options.category) {
    const categoryWorkflow = await getCategoryWorkflow(client, userId, options.category);
    if (categoryWorkflow) return categoryWorkflow;
  }

  return getDefaultImageWorkflow(client, userId);
}

async function getCharacterMatchedWorkflow(client, userId, characterId, options) {
  const { data: character, error: characterError } = await client
    .from('characters')
    .select('id,name,lora,tags')
    .eq('user_id', userId)
    .eq('id', characterId)
    .single();
  if (characterError) return null;

  const { data, error } = await client
    .from('comfy_workflows')
    .select('*')
    .eq('user_id', userId)
    .eq('mode', 'image')
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) throw error;

  const workflows = data || [];
  const loraText = normalizeText(character?.lora);
  const tagText = normalizeText(character?.tags);
  const preferredCategory = options.category || 'character_generation';

  return workflows.find((workflow) => {
    if (workflow.category !== preferredCategory) return false;
    const workflowText = normalizeText([
      workflow.name,
      workflow.checkpoint,
      workflow.model,
      workflow.loras,
      workflow.tags,
    ]);
    return (loraText && workflowText.includes(loraText))
      || (tagText && tagText.split(' ').some((tag) => tag && workflowText.includes(tag)));
  }) || workflows.find((workflow) => workflow.category === preferredCategory) || null;
}

async function getCategoryWorkflow(client, userId, category) {
  const { data, error } = await client
    .from('comfy_workflows')
    .select('*')
    .eq('user_id', userId)
    .eq('mode', 'image')
    .eq('status', 'active')
    .eq('category', category)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function createAssetGenerationTask(client, userId, agent, contentItem, workflow, options) {
  const { data, error } = await client
    .from('agent_tasks')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      task_type: 'asset_generation',
      workflow_id: workflow.asset_id || null,
      input_data: {
        content_id: contentItem.id,
        comfy_workflow_id: workflow.id,
        workflow_version: workflow.version,
        provider: 'comfyui',
        mode: 'image',
        category: workflow.category || 'character_generation',
        platform: contentItem.platform || null,
        prompt_id: contentItem.prompt_id || null,
        character_id: contentItem.character_id || null,
        options,
      },
      status: 'running',
      retry_count: 0,
      max_retry: 3,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function createAssetGenerationRun(client, userId, agent, task, contentItem, workflow, options) {
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      agent_task_id: task.id,
      agent_name: agent.name,
      input: {
        content_id: contentItem.id,
        comfy_workflow_id: workflow.id,
        workflow_version: workflow.version,
        provider: 'comfyui',
        mode: 'image',
        category: workflow.category || 'character_generation',
        options,
      },
      status: 'running',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function createWorkflowRunRecord(client, userId, contentItem, workflow, task, run, options) {
  const { data, error } = await client
    .from('workflow_runs')
    .insert({
      user_id: userId,
      workflow_id: workflow.asset_id || null,
      tool_id: 'comfyui',
      character_id: contentItem.character_id || null,
      prompt_id: contentItem.prompt_id || null,
      asset_ids: contentItem.asset_id ? [contentItem.asset_id] : [],
      input_data: {
        source: 'asset_generation_agent',
        provider: 'comfyui',
        mode: 'image',
        content_id: contentItem.id,
        agent_task_id: task.id,
        agent_run_id: run.id,
        comfy_workflow_id: workflow.id,
        workflow_version: workflow.version,
        workflow_snapshot: {
          id: workflow.id,
          asset_id: workflow.asset_id,
          name: workflow.name,
          version: workflow.version,
          mode: workflow.mode,
          category: workflow.category || 'character_generation',
          priority: workflow.priority || 100,
          model: workflow.model,
          checkpoint: workflow.checkpoint,
          loras: workflow.loras || [],
          controlnets: workflow.controlnets || [],
          tags: workflow.tags || [],
          input_schema: workflow.input_schema || {},
          node_mappings: workflow.node_mappings || {},
        },
        content_context: {
          title: contentItem.title,
          text: contentItem.content_text || contentItem.idea_notes || '',
          platform: contentItem.platform || null,
          content_type: contentItem.content_type || 'image',
        },
        options,
      },
      status: 'pending',
      cost: 0,
      retry_count: 0,
      max_retry: 3,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateAgentTask(client, taskId, status, payload = {}) {
  const update = { status };
  if (payload.result !== undefined) update.result = payload.result;
  if (payload.last_error !== undefined) update.last_error = payload.last_error;
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();
  const { error } = await client.from('agent_tasks').update(update).eq('id', taskId);
  if (error) throw error;
}

async function updateAgentRun(client, runId, status, payload = {}) {
  const update = {
    status,
    output: payload.output || {},
    cost: Number(payload.cost || 0),
    duration: Number(payload.duration || 0),
    error_message: payload.error_message || null,
  };
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();
  const { error } = await client.from('agent_runs').update(update).eq('id', runId);
  if (error) throw error;
}

async function markWorkflowRunFailed(client, workflowRunId, message) {
  await client
    .from('workflow_runs')
    .update({
      status: 'failed',
      error_message: message,
      last_error: message,
      completed_at: new Date().toISOString(),
    })
    .eq('id', workflowRunId);
}

function normalizeText(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(normalizeText).join(' ').toLowerCase();
  if (typeof value === 'object') return JSON.stringify(value).toLowerCase();
  return String(value).toLowerCase();
}
