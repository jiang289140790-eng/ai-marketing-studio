import { requireSupabase } from './supabase-client';

export async function createNotification(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('notifications')
    .insert({
      user_id: userId,
      type: payload.type || 'system',
      channel: payload.channel || 'in_app',
      title: payload.title,
      message: payload.message || null,
      status: payload.status || 'unread',
      metadata: payload.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  await trySendAdminNotification(data);
  return data;
}

export async function listNotifications(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.type) query = query.eq('type', filters.type);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function markNotificationRead(id) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('notifications')
    .update({ status: 'read', read_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function recordCost(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('cost_records')
    .insert({
      user_id: userId,
      cost_date: payload.cost_date || new Date().toISOString().slice(0, 10),
      category: payload.category,
      source: payload.source || null,
      amount: Number(payload.amount || 0),
      revenue: Number(payload.revenue || 0),
      metadata: payload.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listCostRecords(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('cost_records')
    .select('*')
    .eq('user_id', userId)
    .order('cost_date', { ascending: false });

  if (filters.category) query = query.eq('category', filters.category);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function recordToolUsage(userId, payload) {
  const client = requireSupabase();
  const totalCost = payload.total_cost === undefined
    ? Number(payload.units || 1) * Number(payload.unit_cost || 0)
    : Number(payload.total_cost || 0);
  const { data, error } = await client
    .from('tool_usage')
    .insert({
      user_id: userId,
      tool_name: payload.tool_name,
      provider: payload.provider || null,
      usage_type: payload.usage_type || 'operation',
      units: Number(payload.units || 1),
      unit_cost: Number(payload.unit_cost || 0),
      total_cost: totalCost,
      related_content_id: payload.related_content_id || null,
      related_agent_run_id: payload.related_agent_run_id || null,
      metadata: payload.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listToolUsage(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('tool_usage')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.usageType) query = query.eq('usage_type', filters.usageType);
  if (filters.contentId) query = query.eq('related_content_id', filters.contentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createAuditLog(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('audit_logs')
    .insert({
      user_id: userId,
      entity_type: payload.entity_type,
      entity_id: payload.entity_id || null,
      action: payload.action,
      before_data: payload.before_data || null,
      after_data: payload.after_data || null,
      metadata: payload.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function listAuditLogs(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('audit_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.entityType) query = query.eq('entity_type', filters.entityType);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export function summarizeCosts(records) {
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = records.filter((record) => String(record.cost_date) === today);
  const totalCost = records.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const totalRevenue = records.reduce((sum, record) => sum + Number(record.revenue || 0), 0);
  const todayCost = todayRecords.reduce((sum, record) => sum + Number(record.amount || 0), 0);
  const todayRevenue = todayRecords.reduce((sum, record) => sum + Number(record.revenue || 0), 0);
  const byCategory = groupCost(records);

  return {
    totalCost,
    totalRevenue,
    profit: totalRevenue - totalCost,
    todayCost,
    todayRevenue,
    todayProfit: todayRevenue - todayCost,
    aiCost: byCategory.ai || 0,
    workflowCost: byCategory.workflow || 0,
    apiCost: byCategory.api || 0,
    trend: buildDailyTrend(records),
  };
}

export function summarizeToolUsage(records, contents = []) {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const todayRecords = records.filter((record) => String(record.created_at || '').slice(0, 10) === today);
  const monthRecords = records.filter((record) => String(record.created_at || '').slice(0, 7) === month);
  const todayAiCost = todayRecords
    .filter((record) => ['text_generation', 'image_generation', 'video_generation', 'workflow', 'api'].includes(record.usage_type))
    .reduce((sum, record) => sum + Number(record.total_cost || 0), 0);
  const monthCost = monthRecords.reduce((sum, record) => sum + Number(record.total_cost || 0), 0);
  const contentCount = Math.max(1, contents.length);

  return {
    todayAiCost,
    monthCost,
    averageContentCost: Number((monthCost / contentCount).toFixed(4)),
    textCost: monthRecords.filter((record) => record.usage_type === 'text_generation').reduce((sum, record) => sum + Number(record.total_cost || 0), 0),
    imageCost: monthRecords.filter((record) => record.usage_type === 'image_generation').reduce((sum, record) => sum + Number(record.total_cost || 0), 0),
    videoCost: monthRecords.filter((record) => record.usage_type === 'video_generation').reduce((sum, record) => sum + Number(record.total_cost || 0), 0),
    apiCost: monthRecords.filter((record) => record.usage_type === 'api').reduce((sum, record) => sum + Number(record.total_cost || 0), 0),
  };
}

export function summarizeSystemHealth({ collectorRuns = [], agentTasks = [], workflowRuns = [], publishTasks = [], automationRuns = [], notifications = [] }) {
  const groups = [
    { name: 'Collector', rows: collectorRuns },
    { name: 'Agent', rows: agentTasks },
    { name: 'Workflow', rows: workflowRuns },
    { name: 'Publish', rows: publishTasks },
    { name: 'Automation', rows: automationRuns },
  ];
  const allRows = groups.flatMap((group) => group.rows.map((row) => ({ ...row, group: group.name })));
  const failed = allRows.filter((row) => ['failed', 'error'].includes(row.status));
  const success = allRows.filter((row) => ['success', 'published'].includes(row.status));
  const running = allRows.filter((row) => ['queued', 'running', 'publishing', 'pending'].includes(row.status));

  return {
    totalTasks: allRows.length,
    successRate: allRows.length ? Math.round((success.length / allRows.length) * 100) : 0,
    failureRate: allRows.length ? Math.round((failed.length / allRows.length) * 100) : 0,
    queueCount: running.length,
    failedCount: failed.length,
    unreadNotifications: notifications.filter((item) => item.status === 'unread').length,
    apiStatus: failed.length > 0 ? 'needs_attention' : 'ok',
    groups: groups.map((group) => {
      const total = group.rows.length;
      const groupFailed = group.rows.filter((row) => ['failed', 'error'].includes(row.status)).length;
      const groupSuccess = group.rows.filter((row) => ['success', 'published'].includes(row.status)).length;
      return {
        name: group.name,
        total,
        successRate: total ? Math.round((groupSuccess / total) * 100) : 0,
        failed: groupFailed,
        queued: group.rows.filter((row) => ['queued', 'running', 'publishing', 'pending'].includes(row.status)).length,
      };
    }),
  };
}

export function canRetry(item) {
  return Number(item.retry_count || 0) < Number(item.max_retry || 0);
}

export function nextRetryCount(item) {
  return Number(item.retry_count || 0) + 1;
}

function groupCost(records) {
  return records.reduce((map, record) => {
    map[record.category] = (map[record.category] || 0) + Number(record.amount || 0);
    return map;
  }, {});
}

function buildDailyTrend(records) {
  const map = records.reduce((days, record) => {
    const day = String(record.cost_date);
    const current = days[day] || { date: day, cost: 0, revenue: 0, profit: 0 };
    current.cost += Number(record.amount || 0);
    current.revenue += Number(record.revenue || 0);
    current.profit = current.revenue - current.cost;
    days[day] = current;
    return days;
  }, {});

  return Object.values(map).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-14);
}

async function trySendAdminNotification(notification) {
  if (notification.channel !== 'telegram') return;

  try {
    const client = requireSupabase();
    await client.functions.invoke('platform', {
      body: {
        platform: 'Telegram',
        action: 'notifyAdmin',
        title: notification.title,
        message: notification.message,
        source: notification.type,
      },
    });
  } catch {
    // Admin notification delivery is best-effort; in-app notification remains the source of truth.
  }
}
