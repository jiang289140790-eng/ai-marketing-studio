import { requireSupabase } from '../supabase-client';
import { adapterResult, createPreparedAdapter } from './base-adapter';

async function invokeXPlatform(action, payload) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke('platform', {
    body: {
      platform: 'X',
      action,
      ...payload,
    },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export const xAdapter = {
  ...createPreparedAdapter('X', {
    auth_type: 'oauth2',
    required_config: [
      'X_CLIENT_ID',
      'X_CLIENT_SECRET',
      'X_REDIRECT_URI',
      'X_POST_WRITE_SCOPE',
    ],
    docs: 'https://developer.x.com/',
  }),
  connect: (payload = {}) => invokeXPlatform('connect', payload),
  disconnect: ({ connection_id }) => invokeXPlatform('disconnect', { connection_id }),
  reconnect: ({ connection_id }) => invokeXPlatform('reconnect', { connection_id }),
  status: ({ connection_id } = {}) => invokeXPlatform('status', { connection_id }),
  publish: async ({ task, connection }) => {
    const result = await invokeXPlatform('publish', {
      publish_task_id: task.id,
      connection_id: task.platform_connection_id || connection?.id,
    });
    return adapterResult({
      success: true,
      platform: 'X',
      tweet_id: result.tweet_id || result.external_id || null,
      external_id: result.external_id || result.tweet_id || null,
      url: result.url || null,
      published_at: result.published_at || null,
      raw: result,
    });
  },
  getMetrics: ({ task }) => invokeXPlatform('getMetrics', {
    publish_task_id: task.id,
  }),
};
