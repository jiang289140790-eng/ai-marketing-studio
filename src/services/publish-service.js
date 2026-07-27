import { getPlatformAdapter } from './platforms/platform-adapter';
import { canRetry, createNotification, nextRetryCount } from './stability-service';
import { requireSupabase } from './supabase-client';

const publishTaskSelect = `
  *,
  content_library(title, content_text, media_url, content_type, status),
  platform_connections(
    platform,
    status,
    connected_at,
    last_sync,
    social_accounts(account_name, account_url, avatar)
  )
`;

const publishCampaignLinkSelect = 'id, content_id, url, utm_source, utm_campaign, clicks, registrations, revenue';

export async function listPublishTasks(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('publish_tasks')
    .select(publishTaskSelect)
    .eq('user_id', userId)
    .order('scheduled_time', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.platform) query = query.eq('platform', filters.platform);

  const { data, error } = await query;
  if (error) throw error;
  return enrichPublishTasksWithCampaignLinks(client, data || [], userId);
}

export async function getPublishTask(taskId) {
  const client = requireSupabase();
  const { data, error } = await client.from('publish_tasks').select(publishTaskSelect).eq('id', taskId).single();
  if (error) throw error;
  return (await enrichPublishTasksWithCampaignLinks(client, [data], data.user_id))[0];
}

export async function createPublishTask(userId, payload) {
  const client = requireSupabase();
  const scheduledTime = payload.scheduled_time || payload.publish_time || null;
  const publishContent = {
    ...(payload.publish_content || {}),
    ...(payload.campaign_link_id ? { campaign_link_id: payload.campaign_link_id } : {}),
  };
  const { data, error } = await client
    .from('publish_tasks')
    .insert({
      user_id: userId,
      content_id: payload.content_id || null,
      content_package_id: payload.content_package_id || null,
      platform_connection_id: payload.platform_connection_id || null,
      campaign_id: payload.campaign_id || null,
      platform_account_id: payload.platform_account_id || payload.account_id || null,
      platform: payload.platform,
      scheduled_time: scheduledTime,
      publish_time: scheduledTime,
      scheduled_at: scheduledTime,
      status: 'draft',
      approval_status: 'pending',
      publish_content: publishContent,
      publish_result: {
        execution_mode: payload.execution_mode === 'live' ? 'live' : 'dry_run',
        source: payload.source || 'manual_publish_center',
        created_for_approval: true,
      },
      result: payload.result || null,
      error_message: null,
    })
    .select(publishTaskSelect)
    .single();

  if (error) throw error;
  return (await enrichPublishTasksWithCampaignLinks(client, [data], userId))[0];
}

export async function updatePublishTask(taskId, payload) {
  const client = requireSupabase();
  const scheduledTime = payload.scheduled_time || payload.publish_time || null;
  const updatePayload = cleanPayload({
    content_id: payload.content_id,
    platform_connection_id: payload.platform_connection_id,
    campaign_id: payload.campaign_id,
    platform: payload.platform,
    scheduled_time: scheduledTime,
    publish_time: scheduledTime,
    status: payload.status,
    external_id: payload.external_id,
    result: payload.result,
    error_message: payload.error_message,
    published_at: payload.published_at,
  });

  const { data, error } = await client
    .from('publish_tasks')
    .update(updatePayload)
    .eq('id', taskId)
    .select(publishTaskSelect)
    .single();

  if (error) throw error;
  return (await enrichPublishTasksWithCampaignLinks(client, [data], data.user_id))[0];
}

export async function updatePublishStatus(taskId, status, payload = {}) {
  const client = requireSupabase();
  const updatePayload = cleanPayload({
    status,
    result: payload.result,
    error_message: payload.error_message ?? null,
    external_id: payload.external_id,
    published_at: status === 'published' ? payload.published_at || new Date().toISOString() : payload.published_at,
    retry_count: payload.retry_count,
    last_error: payload.last_error,
  });

  const { data, error } = await client
    .from('publish_tasks')
    .update(updatePayload)
    .eq('id', taskId)
    .select(publishTaskSelect)
    .single();

  if (error) throw error;
  return (await enrichPublishTasksWithCampaignLinks(client, [data], data.user_id))[0];
}

export async function executePublishTask(userId, taskOrId) {
  const task = typeof taskOrId === 'string' ? await getPublishTask(taskOrId) : taskOrId;
  if (!task || task.user_id !== userId) throw new Error('发布任务不存在或无权执行。');

  await updatePublishStatus(task.id, 'publishing', { error_message: null });

  try {
    const adapter = getPlatformAdapter(task.platform);
    const result = await adapter.publish({
      task,
      content: task.content_library,
      connection: task.platform_connections,
    });

    if (result?.success === false) {
      throw new Error(result.error || `${task.platform} publish failed.`);
    }

    return updatePublishStatus(task.id, 'published', {
      result,
      external_id: result?.message_id || result?.external_id || result?.id || null,
      published_at: result?.published_at,
      error_message: null,
    });
  } catch (error) {
    const failedTask = await updatePublishStatus(task.id, 'failed', {
      result: {
        adapter: task.platform,
        mode: task.platform === 'Telegram' ? 'edge-function' : 'placeholder',
      },
      error_message: error.message,
      retry_count: nextRetryCount(task),
      last_error: error.message,
    });
    await createNotification(userId, {
      type: 'publish_failed',
      channel: 'telegram',
      title: `Publish failed: ${task.platform}`,
      message: error.message,
      metadata: {
        publish_task_id: task.id,
        platform: task.platform,
        retry_count: nextRetryCount(task),
        can_retry: canRetry(task),
      },
    });
    return failedTask;
  }
}

export async function syncPublishTaskMetrics(userId, taskOrId) {
  const task = typeof taskOrId === 'string' ? await getPublishTask(taskOrId) : taskOrId;
  if (!task || task.user_id !== userId) throw new Error('发布任务不存在或无权同步指标。');

  const adapter = getPlatformAdapter(task.platform);
  return adapter.getMetrics({ task });
}

export async function getPublishHistory(userId, filters = {}) {
  return listPublishTasks(userId, filters);
}

export function summarizePublishTasks(tasks) {
  return {
    total: tasks.length,
    draft: tasks.filter((task) => task.status === 'draft').length,
    scheduled: tasks.filter((task) => task.status === 'scheduled').length,
    publishing: tasks.filter((task) => task.status === 'publishing').length,
    published: tasks.filter((task) => task.status === 'published').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
  };
}

function cleanPayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

async function enrichPublishTasksWithCampaignLinks(client, tasks, userId) {
  const contentIds = [...new Set(tasks.map((task) => task.content_id).filter(Boolean))];
  if (!contentIds.length) return tasks.map((task) => ({ ...task, campaign_links: null }));

  const { data, error } = await client
    .from('campaign_links')
    .select(publishCampaignLinkSelect)
    .eq('user_id', userId)
    .in('content_id', contentIds);

  if (error) throw error;
  const linksByContent = new Map((data || []).map((link) => [String(link.content_id), link]));
  return tasks.map((task) => ({
    ...task,
    campaign_links: linksByContent.get(String(task.content_id)) || null,
  }));
}
