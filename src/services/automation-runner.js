import { executeAgentTask, listAgents } from './agent-service';
import { listCollectionTasks, runCollection } from './collector-service';
import { createPublishTask, executePublishTask, getPublishTask } from './publish-service';
import { createWorkflowRun, saveWorkflowResult, updateWorkflowStatus } from './workflow-service';

export async function runAutomationJob(userId, job) {
  if (job.status === 'paused') {
    throw new Error('自动化任务已暂停，不能执行。');
  }

  if (job.type === 'collector') {
    return runCollectorJob(userId, job);
  }

  if (job.type === 'agent') {
    return runAgentJob(userId, job);
  }

  if (job.type === 'workflow') {
    return runWorkflowJob(userId, job);
  }

  if (job.type === 'platform') {
    return runPlatformJob(userId, job);
  }

  throw new Error(`不支持的自动化任务类型：${job.type}`);
}

export async function runCollectorJob(userId, job) {
  const task = await resolveCollectionTask(userId, job);
  const run = await runCollection(userId, task);

  return {
    kind: 'collector_execution',
    collection_task_id: task.id,
    collection_run_id: run.id,
    source: task.content_sources?.name || null,
    items_found: run.items_found,
    status: run.status,
  };
}

export async function runAgentJob(userId, job) {
  const agent = await resolveAgent(userId, job);
  const payload = {
    ...(job.config || {}),
    ...(job.target || {}),
    automation_job_id: job.id,
    automation_job_name: job.name,
  };
  const task = await executeAgentTask(userId, agent, payload);

  return {
    kind: 'agent_execution',
    agent_id: agent.id,
    agent_task_id: task.id,
    task_type: task.task_type,
    status: task.status,
    result: task.result,
  };
}

export async function runWorkflowJob(userId, job) {
  const target = job.target || {};
  const config = job.config || {};
  const workflowRun = await createWorkflowRun(userId, {
    workflow_id: target.workflow_id || config.workflow_id || null,
    tool_id: config.tool_id || target.tool_id || 'automation-runner',
    character_id: target.character_id || config.character_id || null,
    prompt_id: target.prompt_id || config.prompt_id || null,
    asset_ids: target.asset_ids || config.asset_ids || [],
    input_data: {
      automation_job_id: job.id,
      automation_job_name: job.name,
      goal: config.goal || target.goal || '',
      platform: config.platform || target.platform || null,
      account_category: config.account_category || target.account_category || 'brand',
    },
    status: 'pending',
    cost: Number(config.cost || 0),
  });

  const runningRun = await updateWorkflowStatus(workflowRun.id, 'running');
  const saved = await saveWorkflowResult(userId, runningRun, {
    title: config.result_title || `${job.name} 生成结果`,
    text: config.result_text || config.prompt || target.prompt || 'Automation Workflow 生成的内容草稿。',
    url: config.result_url || '',
    thumbnail: config.thumbnail || config.result_url || '',
    type: config.result_type || 'image',
    model: config.model || '',
    cost: Number(config.cost || 0),
    metadata: {
      automation_job_id: job.id,
      automation_job_type: job.type,
      execution_mode: 'internal-runner',
    },
  });

  return {
    kind: 'workflow_execution',
    workflow_run_id: saved.run.id,
    asset_id: saved.asset.id,
    content_id: saved.content.id,
    status: saved.run.status,
  };
}

export async function runPlatformJob(userId, job) {
  const action = job.config?.action || job.target?.action || 'sync_metrics';
  if (action === 'publish') {
    return runPublishJob(userId, job);
  }

  return {
    kind: 'platform_placeholder',
    user_id: userId,
    platform: job.target?.platform || job.config?.platform || null,
    action,
    supported_future_actions: ['publish', 'sync_metrics'],
    message: 'Platform jobs are reserved for Supabase Edge Function execution. No platform API call was made.',
  };
}

export async function runPublishJob(userId, job) {
  const target = job.target || {};
  const config = job.config || {};
  const existingTaskId = target.publish_task_id || target.task_id || config.publish_task_id;

  let task;
  if (existingTaskId) {
    task = await getPublishTask(existingTaskId);
  } else {
    const contentId = target.content_id || config.content_id;
    const platform = target.platform || config.platform;
    if (!contentId) throw new Error('Publish automation 缺少 content_id。');
    if (!platform) throw new Error('Publish automation 缺少 platform。');

    task = await createPublishTask(userId, {
      content_id: contentId,
      platform_connection_id: target.platform_connection_id || config.platform_connection_id || null,
      platform,
      scheduled_time: target.scheduled_time || config.scheduled_time || new Date().toISOString(),
      status: 'scheduled',
    });
  }

  const result = await executePublishTask(userId, task);
  return {
    kind: 'publish_execution',
    publish_task_id: result.id,
    content_id: result.content_id,
    platform: result.platform,
    status: result.status,
    external_id: result.external_id,
    error_message: result.error_message,
  };
}

async function resolveCollectionTask(userId, job) {
  const target = job.target || {};
  const config = job.config || {};
  const targetTaskId = target.collection_task_id || target.task_id || config.collection_task_id;
  const tasks = await listCollectionTasks(userId);

  if (targetTaskId) {
    const task = tasks.find((item) => item.id === targetTaskId);
    if (!task) throw new Error('未找到 automation job 指定的 collection task。');
    return task;
  }

  const firstActiveTask = tasks.find((task) => task.status === 'active') || tasks[0];
  if (!firstActiveTask) throw new Error('没有可执行的 Collection Task。');
  return firstActiveTask;
}

async function resolveAgent(userId, job) {
  const target = job.target || {};
  const config = job.config || {};
  const targetAgentId = target.agent_id || config.agent_id;
  const agents = await listAgents(userId);

  if (targetAgentId) {
    const agent = agents.find((item) => item.id === targetAgentId);
    if (!agent) throw new Error('未找到 automation job 指定的 Agent。');
    return agent;
  }

  const firstActiveAgent = agents.find((agent) => agent.status === 'active') || agents[0];
  if (!firstActiveAgent) throw new Error('没有可执行的 Agent。');
  return firstActiveAgent;
}
