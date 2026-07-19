import { createContentItem, listContent } from './content-service';
import { buildIntelligenceStrategy, listViralContents } from './intelligence-service';
import { buildRoiOptimizationStrategy, createContentStrategy, listCampaignLinks, listContentMetrics } from './performance-service';
import { createNotification, nextRetryCount } from './stability-service';
import { requireSupabase } from './supabase-client';
import { createWorkflowRun } from './workflow-service';

const agentSelect = '*';
const taskSelect = '*, agents(name,type,model,status)';
const runSelect = '*, agents(name,type,model), agent_tasks(task_type,status)';

export async function listAgents(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('agents')
    .select(agentSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.type) query = query.eq('type', filters.type);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.search) query = query.ilike('name', `%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createAgent(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('agents')
    .insert({
      user_id: userId,
      name: payload.name,
      description: payload.description || null,
      type: payload.type,
      model: payload.model || null,
      system_prompt: payload.system_prompt || null,
      status: payload.status || 'active',
      schedule: payload.schedule || {},
    })
    .select(agentSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updateAgent(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('agents').update(payload).eq('id', id).select(agentSelect).single();
  if (error) throw error;
  return data;
}

export async function deleteAgent(id) {
  const client = requireSupabase();
  const { error } = await client.from('agents').delete().eq('id', id);
  if (error) throw error;
}

export async function listAgentTasks(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('agent_tasks')
    .select(taskSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.agentId) query = query.eq('agent_id', filters.agentId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.taskType) query = query.eq('task_type', filters.taskType);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function listAgentRuns(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('agent_runs')
    .select(runSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.agentId) query = query.eq('agent_id', filters.agentId);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createAgentTask(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('agent_tasks')
    .insert({
      user_id: userId,
      agent_id: payload.agent_id,
      task_type: payload.task_type,
      input_data: payload.input_data || {},
      workflow_id: payload.workflow_id || null,
      status: payload.status || 'pending',
      result: payload.result || null,
      retry_count: Number(payload.retry_count || 0),
      max_retry: Number(payload.max_retry || 3),
    })
    .select(taskSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updateAgentTaskStatus(taskId, status, payload = {}) {
  const client = requireSupabase();
  const update = { status };

  if (payload.result !== undefined) update.result = payload.result;
  if (payload.retry_count !== undefined) update.retry_count = payload.retry_count;
  if (payload.last_error !== undefined) update.last_error = payload.last_error;
  if (['success', 'failed'].includes(status)) {
    update.completed_at = payload.completed_at || new Date().toISOString();
  }

  const { data, error } = await client
    .from('agent_tasks')
    .update(update)
    .eq('id', taskId)
    .select(taskSelect)
    .single();

  if (error) throw error;
  return data;
}

async function createAgentRun(userId, agent, task, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      agent_task_id: task.id,
      agent_name: agent.name,
      input: payload || {},
      status: 'running',
    })
    .select(runSelect)
    .single();

  if (error) throw error;
  return data;
}

async function updateAgentRun(runId, status, payload = {}) {
  const client = requireSupabase();
  const update = {
    status,
    output: payload.output || {},
    cost: Number(payload.cost || 0),
    duration: Number(payload.duration || 0),
    error_message: payload.error_message || null,
  };
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();

  const { data, error } = await client
    .from('agent_runs')
    .update(update)
    .eq('id', runId)
    .select(runSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function executeAgentTask(userId, agent, payload) {
  const startedAt = Date.now();
  const taskType = resolveTaskType(agent.type);
  const task = await createAgentTask(userId, {
    agent_id: agent.id,
    task_type: taskType,
    workflow_id: payload.workflow_id || null,
    input_data: payload,
    status: 'pending',
  });
  const run = await createAgentRun(userId, agent, task, payload);

  await updateAgentTaskStatus(task.id, 'running');

  try {
    const result = await runAgentAction(userId, agent, payload, task);
    const duration = Math.max(0, Date.now() - startedAt);
    await updateAgentRun(run.id, 'success', {
      output: result,
      cost: Number(payload.cost || result.cost || 0),
      duration,
    });
    return updateAgentTaskStatus(task.id, 'success', { result });
  } catch (error) {
    const duration = Math.max(0, Date.now() - startedAt);
    await updateAgentRun(run.id, 'failed', {
      output: { error: error.message },
      cost: Number(payload.cost || 0),
      duration,
      error_message: error.message,
    });
    const failedTask = await updateAgentTaskStatus(task.id, 'failed', {
      result: { error: error.message },
      retry_count: nextRetryCount(task),
      last_error: error.message,
    });
    await createNotification(userId, {
      type: 'agent_failed',
      channel: 'telegram',
      title: `Agent failed: ${agent.name}`,
      message: error.message,
      metadata: {
        agent_id: agent.id,
        agent_task_id: task.id,
        agent_run_id: run.id,
        retry_count: nextRetryCount(task),
      },
    });
    return failedTask;
  }
}

async function runAgentAction(userId, agent, payload, task) {
  if (agent.type === 'content_generator') {
    const draft = await createContentItem(userId, {
      title: payload.title || `${payload.platform || '社媒'} 内容草稿`,
      content_text: buildContentDraft(agent, payload),
      content_type: payload.content_type || 'text',
      platform: payload.platform || null,
      account_category: payload.account_category || 'brand',
      character_id: payload.character_id || null,
      prompt_id: payload.prompt_id || null,
      source_intelligence_id: payload.source_intelligence_id || null,
      source_analysis_id: payload.source_analysis_id || null,
      idea_notes: payload.goal || payload.brief || '',
      generation_brief: payload,
      pipeline_stage: 'draft',
      status: 'draft',
    });

    return {
      kind: 'content_draft',
      content_id: draft.id,
      title: draft.title,
      next_step: '进入内容库审核，再进入发布中心排期。',
    };
  }

  if (agent.type === 'asset_generator') {
    const workflowRun = await createWorkflowRun(userId, {
      workflow_id: payload.workflow_id || null,
      tool_id: payload.tool_id || 'agent-runtime',
      character_id: payload.character_id || null,
      prompt_id: payload.prompt_id || null,
      asset_ids: payload.asset_ids || [],
      input_data: {
        source_agent_task_id: task.id,
        goal: payload.goal || '',
        platform: payload.platform || null,
        account_category: payload.account_category || 'brand',
      },
    });

    return {
      kind: 'workflow_run',
      workflow_run_id: workflowRun.id,
      status: workflowRun.status,
      next_step: '进入 Workflow Center 保存生成结果。',
    };
  }

  const [contentItems, viralContents, contentMetrics, campaignLinks] = await Promise.all([
    listContent(userId),
    listViralContents(userId),
    listContentMetrics(userId),
    listCampaignLinks(userId),
  ]);
  const recent = contentItems.slice(0, 5).map((item) => ({
    title: item.title,
    status: item.pipeline_stage || item.status,
    platform: item.platform,
    type: item.content_type,
  }));
  const intelligenceStrategy = buildIntelligenceStrategy(viralContents);
  const optimizationStrategy = buildRoiOptimizationStrategy(contentMetrics, viralContents, campaignLinks);
  const savedStrategy = await createContentStrategy(userId, {
    title: `${agent.name} 运营优化策略`,
    source: 'analysis-agent',
    input_data: {
      agent_id: agent.id,
      task_id: task.id,
      viral_contents_count: viralContents.length,
      content_metrics_count: contentMetrics.length,
      campaign_links_count: campaignLinks.length,
      recent_content: recent,
    },
    optimization_strategy: optimizationStrategy,
  });

  return {
    kind: 'analysis',
    summary: `已读取 ${contentItems.length} 条内容记录，生成个人运营优化建议。`,
    suggestions: [
      '优先把 draft 内容推进到 review，减少草稿堆积。',
      '为每个平台保留独立标题、开头 3 秒钩子和 CTA。',
      '把表现好的内容沉淀为 Prompt 模板，再交给素材生成 Agent 复用。',
    ],
    intelligence_strategy: intelligenceStrategy,
    optimization_strategy: optimizationStrategy,
    content_strategy_id: savedStrategy.id,
    recent_content: recent,
  };
}

function buildContentDraft(agent, payload) {
  const account = payload.account_name ? `账号：${payload.account_name}` : '账号：未指定';
  const platform = payload.platform ? `平台：${payload.platform}` : '平台：未指定';
  const goal = payload.goal || '提升账号内容稳定产出';
  const character = payload.character_name ? `角色：${payload.character_name}` : '角色：未指定';

  return [
    `${agent.name} 生成的内容草稿`,
    account,
    platform,
    character,
    `目标：${goal}`,
    '',
    payload.brief || '请在这里补充最终文案、视觉方向和发布说明。',
  ].join('\n');
}

function resolveTaskType(agentType) {
  if (agentType === 'asset_generator') return 'asset_generation';
  if (agentType === 'analysis') return 'analysis';
  return 'content_generation';
}

export function getAgentStats(agents, tasks) {
  const totalTasks = tasks.length;
  const runningTasks = tasks.filter((task) => task.status === 'running').length;
  const successTasks = tasks.filter((task) => task.status === 'success').length;
  const failedTasks = tasks.filter((task) => task.status === 'failed').length;
  const activeAgents = agents.filter((agent) => agent.status === 'active').length;

  return {
    totalAgents: agents.length,
    activeAgents,
    totalTasks,
    runningTasks,
    successRate: totalTasks ? Math.round((successTasks / totalTasks) * 100) : 0,
    failedTasks,
  };
}
