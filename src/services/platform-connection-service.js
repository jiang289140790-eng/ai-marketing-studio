import { requireSupabase } from './supabase-client';

const connectionSelect = '*, social_accounts(account_name,account_url,avatar,status,api_status)';

export async function listPlatformConnections(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('platform_connections')
    .select(connectionSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.status) query = query.eq('status', filters.status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createPlatformConnection(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('platform_connections')
    .insert({
      user_id: userId,
      platform: payload.platform,
      account_id: payload.account_id || null,
      status: payload.status || 'pending',
      connected_at: payload.connected_at || null,
      last_sync: payload.last_sync || null,
    })
    .select(connectionSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function updatePlatformConnection(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('platform_connections')
    .update(payload)
    .eq('id', id)
    .select(connectionSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function connectTelegramPlatform(payload) {
  return invokeTelegramConnectionAction('connect', {
    chat_id: payload.chat_id,
    account_name: payload.account_name,
  });
}

export async function reconnectTelegramPlatform(connectionId, payload = {}) {
  return invokeTelegramConnectionAction('reconnect', {
    connection_id: connectionId,
    chat_id: payload.chat_id,
    account_name: payload.account_name,
  });
}

export async function disconnectTelegramPlatform(connectionId) {
  return invokeTelegramConnectionAction('disconnect', {
    connection_id: connectionId,
  });
}

export async function getTelegramPlatformStatus(connectionId) {
  return invokeTelegramConnectionAction('status', {
    connection_id: connectionId,
  });
}

export async function connectXPlatform(payload = {}) {
  return invokePlatformConnectionAction('X', 'connect', payload);
}

export async function reconnectXPlatform(connectionId) {
  return invokePlatformConnectionAction('X', 'reconnect', {
    connection_id: connectionId,
  });
}

export async function disconnectXPlatform(connectionId) {
  return invokePlatformConnectionAction('X', 'disconnect', {
    connection_id: connectionId,
  });
}

export async function getXPlatformStatus(connectionId) {
  return invokePlatformConnectionAction('X', 'status', {
    connection_id: connectionId,
  });
}

async function invokeTelegramConnectionAction(action, payload = {}) {
  return invokePlatformConnectionAction('Telegram', action, payload);
}

async function invokePlatformConnectionAction(platform, action, payload = {}) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke('platform', {
    body: {
      platform,
      action,
      ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined && value !== '')),
    },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export function summarizeConnections(connections) {
  return {
    total: connections.length,
    connected: connections.filter((item) => item.status === 'connected').length,
    pending: connections.filter((item) => item.status === 'pending').length,
    errors: connections.filter((item) => item.status === 'error').length,
  };
}
