import { requireSupabase } from '../supabase-client';
import { adapterResult, createPlaceholderAdapter } from './base-adapter';

const placeholder = createPlaceholderAdapter('Telegram');

async function invokeTelegramPlatform(action, payload) {
  const client = requireSupabase();
  const { data, error } = await client.functions.invoke('platform', {
    body: {
      platform: 'Telegram',
      action,
      ...payload,
    },
  });

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export const telegramAdapter = {
  ...placeholder,
  publish: async ({ task, content, connection }) => {
    const result = await invokeTelegramPlatform('publish', {
      publish_task_id: task.id,
      connection_id: task.platform_connection_id || connection?.id,
      content,
    });
    return adapterResult({
      success: true,
      platform: 'Telegram',
      message_id: result.message_id || result.external_id || result.safe_result?.message_id || null,
      url: result.url || result.safe_result?.url || null,
      raw: result,
    });
  },
  getMetrics: ({ task }) => invokeTelegramPlatform('getMetrics', {
    publish_task_id: task.id,
  }),
};
