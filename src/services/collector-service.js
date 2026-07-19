import { fetchMessages, normalizeContent } from './collectors/telegram-collector';
import { canRetry, createNotification, nextRetryCount } from './stability-service';
import { requireSupabase } from './supabase-client';

const taskSelect = '*, content_sources(id,name,platform,source_type,account,category,status,url,channel,username,last_message_id,sync_time)';
const runSelect = '*, collection_tasks(frequency,content_sources(name,platform,source_type,account,channel,username))';

export async function listSources(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('content_sources')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.sourceType) query = query.eq('source_type', filters.sourceType);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.search) query = query.or(`name.ilike.%${filters.search}%,account.ilike.%${filters.search}%,category.ilike.%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createSource(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_sources')
    .insert({
      user_id: userId,
      platform: payload.platform,
      source_type: payload.source_type,
      name: payload.name,
      url: payload.url || null,
      account: payload.account || null,
      channel: payload.channel || null,
      username: payload.username || null,
      last_message_id: payload.last_message_id || null,
      sync_time: payload.sync_time || null,
      category: payload.category || null,
      status: payload.status || 'active',
      last_sync: payload.last_sync || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSource(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('content_sources').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSource(id) {
  const client = requireSupabase();
  const { error } = await client.from('content_sources').delete().eq('id', id);
  if (error) throw error;
}

export async function listCollectionTasks(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('collection_tasks')
    .select(taskSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.sourceId) query = query.eq('source_id', filters.sourceId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.frequency) query = query.eq('frequency', filters.frequency);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createTask(userId, payload) {
  const client = requireSupabase();
  const nextRun = payload.next_run || calculateNextRun(payload.frequency);
  const { data, error } = await client
    .from('collection_tasks')
    .insert({
      user_id: userId,
      source_id: payload.source_id,
      frequency: payload.frequency || 'manual',
      status: payload.status || 'active',
      next_run: nextRun,
    })
    .select(taskSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updateTask(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('collection_tasks').update(payload).eq('id', id).select(taskSelect).single();
  if (error) throw error;
  return data;
}

export async function deleteTask(id) {
  const client = requireSupabase();
  const { error } = await client.from('collection_tasks').delete().eq('id', id);
  if (error) throw error;
}

export async function listCollectionRuns(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('collection_runs')
    .select(runSelect)
    .eq('user_id', userId)
    .order('started_at', { ascending: false });

  if (filters.taskId) query = query.eq('task_id', filters.taskId);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function runCollection(userId, task) {
  const client = requireSupabase();
  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  const { data: run, error: runError } = await client
    .from('collection_runs')
    .insert({
      user_id: userId,
      task_id: task.id,
      started_at: startedAt,
      status: 'running',
      items_found: 0,
      retry_count: Number(task.retry_count || 0),
      max_retry: Number(task.max_retry || 3),
    })
    .select(runSelect)
    .single();

  if (runError) throw runError;

  try {
    const collectionResult = await executeCollection(userId, task);
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Math.round(Date.now() - startTime));

    const { data: updatedRun, error: updateRunError } = await client
      .from('collection_runs')
      .update({
        finished_at: finishedAt,
        duration_ms: durationMs,
        items_found: collectionResult.items_found,
        status: collectionResult.status,
        error: collectionResult.error,
      })
      .eq('id', run.id)
      .select(runSelect)
      .single();

    if (updateRunError) throw updateRunError;

    const nextRun = calculateNextRun(task.frequency);
    const { error: taskError } = await client
      .from('collection_tasks')
      .update({
        last_run: finishedAt,
        next_run: nextRun,
        status: collectionResult.status === 'success' ? task.status : 'error',
        retry_count: collectionResult.status === 'success' ? 0 : nextRetryCount(task),
        last_error: collectionResult.error || null,
      })
      .eq('id', task.id);

    if (taskError) throw taskError;

    if (task.source_id) {
      const { error: sourceError } = await client
        .from('content_sources')
        .update({
          last_sync: finishedAt,
          sync_time: finishedAt,
          last_message_id: collectionResult.last_message_id || task.content_sources?.last_message_id || null,
          status: collectionResult.status === 'success' ? 'active' : 'error',
        })
        .eq('id', task.source_id);

      if (sourceError) throw sourceError;
    }

    return updatedRun;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Math.round(Date.now() - startTime));

    const { data: failedRun, error: updateRunError } = await client
      .from('collection_runs')
      .update({
        finished_at: finishedAt,
        duration_ms: durationMs,
        items_found: 0,
        status: 'failed',
        error: error.message,
        last_error: error.message,
        retry_count: nextRetryCount(task),
        max_retry: Number(task.max_retry || 3),
      })
      .eq('id', run.id)
      .select(runSelect)
      .single();

    if (updateRunError) throw updateRunError;

    await client.from('collection_tasks').update({
      last_run: finishedAt,
      status: canRetry(task) ? 'active' : 'error',
      retry_count: nextRetryCount(task),
      last_error: error.message,
    }).eq('id', task.id);
    if (task.source_id) {
      await client.from('content_sources').update({ sync_time: finishedAt, status: 'error' }).eq('id', task.source_id);
    }

    await createNotification(userId, {
      type: 'collector_failed',
      channel: 'telegram',
      title: 'Collector failed',
      message: error.message,
      metadata: {
        task_id: task.id,
        source_id: task.source_id,
        retry_count: nextRetryCount(task),
        can_retry: canRetry(task),
      },
    });

    return failedRun;
  }
}

export function getCollectorStats(sources, tasks, runs) {
  const successRuns = runs.filter((run) => run.status === 'success').length;
  const itemsFound = runs.reduce((sum, run) => sum + Number(run.items_found || 0), 0);
  const platformCounts = new Map();

  for (const source of sources) {
    platformCounts.set(source.platform, (platformCounts.get(source.platform) || 0) + 1);
  }

  return {
    sources: sources.length,
    activeTasks: tasks.filter((task) => task.status === 'active').length,
    runs: runs.length,
    itemsFound,
    successRate: runs.length ? Math.round((successRuns / runs.length) * 100) : 0,
    topPlatform: [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
  };
}

async function executeCollection(userId, task) {
  const source = task.content_sources;
  if (isTelegramSource(source)) {
    return collectTelegram(userId, task);
  }

  return simulateCollectionResult(task);
}

async function collectTelegram(userId, task) {
  const source = task.content_sources;
  const messages = await fetchMessages(source, { limit: 20 });
  const normalizedItems = normalizeContent(messages, source);
  const inserted = await saveTelegramViralContents(userId, normalizedItems);
  const lastMessageId = findLastMessageId(normalizedItems) || source.last_message_id || null;

  return {
    status: 'success',
    items_found: inserted.length,
    error: null,
    last_message_id: lastMessageId,
  };
}

async function saveTelegramViralContents(userId, items) {
  if (items.length === 0) return [];
  const client = requireSupabase();
  const urls = items.map((item) => item.url).filter(Boolean);
  const { data: existing, error: existingError } = await client
    .from('viral_contents')
    .select('url')
    .eq('user_id', userId)
    .in('url', urls);

  if (existingError) throw existingError;

  const existingUrls = new Set((existing || []).map((item) => item.url));
  const rows = items
    .filter((item) => item.url && !existingUrls.has(item.url))
    .map((item) => ({
      user_id: userId,
      account_id: null,
      platform: 'Telegram',
      url: item.url,
      title: item.title,
      content_text: item.content_text,
      media_url: item.media_url,
      views: item.views,
      likes: item.likes,
      comments: item.comments,
      published_at: item.published_at,
    }));

  if (rows.length === 0) return [];

  const { data, error } = await client.from('viral_contents').insert(rows).select();
  if (error) throw error;
  return data || [];
}

function isTelegramSource(source) {
  return source?.platform === 'Telegram' || source?.source_type === 'telegram';
}

function findLastMessageId(items) {
  return items
    .map((item) => item.source_message_id)
    .filter(Boolean)
    .sort((a, b) => Number(b) - Number(a))[0];
}

function calculateNextRun(frequency) {
  if (!frequency || frequency === 'manual') return null;
  const next = new Date();
  if (frequency === 'hourly') next.setHours(next.getHours() + 1);
  if (frequency === 'daily') next.setDate(next.getDate() + 1);
  if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  return next.toISOString();
}

function simulateCollectionResult(task) {
  const source = task.content_sources;
  if (!source || source.status === 'error') {
    return {
      status: 'failed',
      items_found: 0,
      error: '数据源不可用，未执行真实平台 API。',
    };
  }

  const seed = `${source.platform}-${source.source_type}-${source.name}-${Date.now()}`;
  const itemsFound = (seed.length % 7) + 1;

  return {
    status: 'success',
    items_found: itemsFound,
    error: null,
  };
}
