import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

type PlatformAction = 'connect' | 'disconnect' | 'getAccount' | 'fetchContent' | 'publish' | 'getMetrics' | 'setWebhook' | 'notifyAdmin';

const supportedActions: PlatformAction[] = ['connect', 'disconnect', 'getAccount', 'fetchContent', 'publish', 'getMetrics', 'setWebhook', 'notifyAdmin'];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  try {
    if (request.method === 'GET') {
      const { client } = createServiceClient();
      return handleCampaignRedirect(client, request);
    }

    if (request.headers.get('x-tracking-event-secret')) {
      const { client } = createServiceClient();
      const body = await request.json().catch(() => ({}));
      return jsonResponse(await handleCampaignConversionEvent(client, request, body));
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader && request.headers.get('x-telegram-bot-api-secret-token')) {
      const { client } = createServiceClient();
      const update = await request.json().catch(() => ({}));
      return jsonResponse(await handleTelegramWebhook(client, request, update));
    }

    if (!authHeader) {
      return jsonResponse({ error: 'Missing Authorization header.' }, 401);
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action as PlatformAction | undefined;
    const platform = body.platform || 'Telegram';

    if (!action || !supportedActions.includes(action)) {
      return jsonResponse({ error: 'Unsupported platform action.' }, 400);
    }

    if (platform !== 'Telegram') {
      return jsonResponse({
        ok: true,
        action,
        mode: 'placeholder',
        message: 'Only Telegram is implemented in this phase. Other platforms are still placeholders.',
        safe_result: {
          platform,
          connection_id: body.connection_id || null,
          token_exposed: false,
        },
      });
    }

    const { client, user } = await createAuthorizedClient(authHeader);

    if (action === 'notifyAdmin') {
      return jsonResponse(await sendAdminTelegramNotification(user.id, body));
    }

    if (action === 'connect') {
      return jsonResponse(await connectTelegram(client, user.id, body));
    }

    if (action === 'publish') {
      return jsonResponse(await publishTelegram(client, user.id, body));
    }

    if (action === 'getMetrics') {
      return jsonResponse(await getTelegramMetrics(client, user.id, body));
    }

    if (action === 'setWebhook') {
      return jsonResponse(await setTelegramWebhook(client, user.id, body));
    }

    return jsonResponse({
      ok: true,
      action,
      mode: 'placeholder',
      message: 'Telegram action boundary is ready, but this action is not implemented yet.',
      safe_result: {
        platform,
        connection_id: body.connection_id || null,
        token_exposed: false,
      },
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Unknown platform function error.' }, 500);
  }
});

async function createAuthorizedClient(authHeader: string) {
  const { client } = createServiceClient();
  const jwt = authHeader.replace('Bearer ', '');
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) throw new Error('Invalid user session.');
  return { client, user: data.user };
}

function createServiceClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Edge Function environment.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return { client };
}

async function connectTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const botToken = String(body.bot_token || '').trim();
  const chatId = normalizeTelegramChatId(String(body.chat_id || body.account_url || '').trim());
  const accountName = String(body.account_name || chatId || 'Telegram Channel');
  if (!botToken) throw new Error('Missing Telegram bot token.');
  if (!chatId) throw new Error('Missing Telegram chat_id or @channel username.');

  const botInfo = await callTelegram(botToken, 'getMe', {});

  const { data: account, error: accountError } = await client
    .from('social_accounts')
    .insert({
      user_id: userId,
      platform: 'Telegram',
      account_name: accountName,
      account_url: chatId,
      avatar: null,
      status: 'active',
    })
    .select('id, account_name, account_url')
    .single();
  if (accountError) throw accountError;

  const { data: connection, error: connectionError } = await client
    .from('platform_connections')
    .insert({
      user_id: userId,
      platform: 'Telegram',
      account_id: account.id,
      status: 'connected',
      connected_at: new Date().toISOString(),
      last_sync: new Date().toISOString(),
    })
    .select('id, platform, status')
    .single();
  if (connectionError) throw connectionError;

  const { error: credentialError } = await client
    .from('platform_credentials')
    .insert({
      connection_id: connection.id,
      encrypted_token: botToken,
      refresh_token: null,
      expires_at: null,
    });
  if (credentialError) throw credentialError;

  const webhook = await trySetTelegramWebhook(botToken);

  return {
    ok: true,
    action: 'connect',
    platform: 'Telegram',
    connection_id: connection.id,
    account,
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      first_name: botInfo.first_name,
    },
    webhook,
    token_exposed: false,
  };
}

async function publishTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const task = await loadPublishTask(client, userId, body);
  const connectionId = task.platform_connection_id || body.connection_id;
  if (!connectionId) throw new Error('Telegram publish requires platform_connection_id.');

  const connection = await loadTelegramConnection(client, userId, String(connectionId));
  const token = await loadTelegramToken(client, String(connectionId));
  const chatId = normalizeTelegramChatId(connection.social_accounts?.account_url || connection.social_accounts?.account_name || body.chat_id);
  if (!chatId) throw new Error('Telegram connection is missing chat_id or @channel username.');

  const content = task.content_library || body.content || {};
  const text = String(content.content_text || content.title || body.text || '').trim();
  const title = String(content.title || '').trim();
  const mediaUrl = String(content.media_url || '').trim();
  const contentType = String(content.content_type || '').trim();
  const campaignUrl = buildCampaignPublishUrl(task);
  const publishText = appendCampaignLink(text || title, campaignUrl);
  if (!text && !mediaUrl) throw new Error('Telegram publish requires content text or media_url.');

  const telegramMessage = await sendTelegramMessage(token, {
    chatId,
    text: publishText,
    mediaUrl,
    contentType,
  });

  const externalId = String(telegramMessage.message_id);
  const metrics = normalizeTelegramMetrics(telegramMessage);
  await writeMetricsSnapshot(client, userId, task, metrics, telegramMessage);

  return {
    ok: true,
    action: 'publish',
    platform: 'Telegram',
    external_id: externalId,
    published_at: new Date((telegramMessage.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    telegram_message: sanitizeTelegramMessage(telegramMessage),
    metrics,
    token_exposed: false,
  };
}

async function getTelegramMetrics(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const task = await loadPublishTask(client, userId, body);
  const storedMessage = task.result?.telegram_message || {};
  const metrics = normalizeTelegramMetrics(storedMessage);
  await writeMetricsSnapshot(client, userId, task, metrics, storedMessage);

  return {
    ok: true,
    action: 'getMetrics',
    platform: 'Telegram',
    publish_task_id: task.id,
    external_id: task.external_id,
    metrics,
    note: 'Telegram Bot API has limited pull-based historical message metrics. Reactions/views should be enhanced later through allowed_updates webhooks or MTProto.',
    token_exposed: false,
  };
}

async function loadPublishTask(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const taskId = body.publish_task_id || body.task_id || (body.task as Record<string, unknown> | undefined)?.id;
  if (!taskId) throw new Error('Missing publish_task_id.');

  const { data, error } = await client
    .from('publish_tasks')
    .select('*, content_library(title, content_text, media_url, content_type, platform), campaign_links(id, url, clicks, registrations, revenue)')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  if (!data || data.platform !== 'Telegram') throw new Error('Publish task is not a Telegram task.');
  return data;
}

async function setTelegramWebhook(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  if (!connectionId) throw new Error('Missing connection_id.');
  await loadTelegramConnection(client, userId, connectionId);
  const token = await loadTelegramToken(client, connectionId);
  const webhook = await trySetTelegramWebhook(token, String(body.webhook_url || '').trim());
  return {
    ok: true,
    action: 'setWebhook',
    platform: 'Telegram',
    connection_id: connectionId,
    webhook,
    token_exposed: false,
  };
}

async function loadTelegramConnection(client: ReturnType<typeof createClient>, userId: string, connectionId: string) {
  const { data, error } = await client
    .from('platform_connections')
    .select('*, social_accounts(account_name, account_url)')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .eq('platform', 'Telegram')
    .single();
  if (error) throw error;
  return data;
}

async function loadTelegramToken(client: ReturnType<typeof createClient>, connectionId: string) {
  const { data, error } = await client
    .from('platform_credentials')
    .select('encrypted_token')
    .eq('connection_id', connectionId)
    .single();
  if (error) throw error;
  if (!data?.encrypted_token) throw new Error('Telegram credential is missing.');
  return data.encrypted_token;
}

async function sendTelegramMessage(token: string, payload: { chatId: string; text: string; mediaUrl: string; contentType: string }) {
  if (payload.mediaUrl && payload.contentType === 'image') {
    return callTelegram(token, 'sendPhoto', {
      chat_id: payload.chatId,
      photo: payload.mediaUrl,
      caption: payload.text,
    });
  }

  if (payload.mediaUrl && payload.contentType === 'video') {
    return callTelegram(token, 'sendVideo', {
      chat_id: payload.chatId,
      video: payload.mediaUrl,
      caption: payload.text,
    });
  }

  return callTelegram(token, 'sendMessage', {
    chat_id: payload.chatId,
    text: payload.text,
    disable_web_page_preview: false,
  });
}

async function callTelegram(token: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(json.description || `Telegram ${method} failed.`);
  }
  return json.result;
}

async function sendAdminTelegramNotification(userId: string, body: Record<string, unknown>) {
  const token = Deno.env.get('TELEGRAM_ADMIN_BOT_TOKEN');
  const chatId = Deno.env.get('TELEGRAM_ADMIN_CHAT_ID');
  if (!token || !chatId) {
    return {
      ok: false,
      error: 'Missing TELEGRAM_ADMIN_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID.',
    };
  }

  const title = String(body.title || 'AI Marketing Studio Alert');
  const message = String(body.message || '');
  const source = body.source ? `\nSource: ${body.source}` : '';
  const adminText = `AI Marketing Studio Alert\n${title}\n${message}${source}\nUser: ${userId}`;
  const text = `⚠️ ${title}\n${message}${source}`;
  const result = await callTelegram(token, 'sendMessage', {
    chat_id: chatId,
    text: adminText,
    disable_web_page_preview: true,
  });

  return {
    ok: true,
    action: 'notify_admin',
    message_id: result.message_id,
  };
}

async function trySetTelegramWebhook(token: string, explicitUrl = '') {
  const webhookUrl = explicitUrl || Deno.env.get('TELEGRAM_WEBHOOK_URL') || '';
  const secretToken = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
  if (!webhookUrl || !secretToken) {
    return {
      configured: false,
      reason: 'TELEGRAM_WEBHOOK_URL or TELEGRAM_WEBHOOK_SECRET is not configured.',
    };
  }

  const result = await callTelegram(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: secretToken,
    allowed_updates: ['message', 'channel_post', 'edited_channel_post', 'message_reaction', 'message_reaction_count', 'callback_query'],
  });

  return {
    configured: true,
    result,
  };
}

async function handleCampaignRedirect(client: ReturnType<typeof createClient>, request: Request) {
  const url = new URL(request.url);
  const campaignId = url.searchParams.get('campaign_id') || url.searchParams.get('c');
  if (!campaignId) return jsonResponse({ error: 'Missing campaign_id.' }, 400);

  const { data, error } = await client
    .from('campaign_links')
    .select('id, url, clicks')
    .eq('id', campaignId)
    .single();
  if (error || !data?.url) return jsonResponse({ error: 'Campaign link not found.' }, 404);

  await client
    .from('campaign_links')
    .update({
      clicks: Number(data.clicks || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId);

  return Response.redirect(data.url, 302);
}

async function handleCampaignConversionEvent(client: ReturnType<typeof createClient>, request: Request, body: Record<string, unknown>) {
  const expectedSecret = Deno.env.get('TRACKING_EVENT_SECRET');
  const receivedSecret = request.headers.get('x-tracking-event-secret');
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return { ok: false, error: 'Invalid tracking event secret.' };
  }

  const campaignId = String(body.campaign_id || '').trim();
  if (!campaignId) throw new Error('Missing campaign_id.');

  const { data, error } = await client
    .from('campaign_links')
    .select('*')
    .eq('id', campaignId)
    .single();
  if (error) throw error;

  const clicks = Number(body.clicks || 0);
  const registrations = Number(body.registrations || 0);
  const revenue = Number(body.revenue || 0);

  await client
    .from('campaign_links')
    .update({
      clicks: Number(data.clicks || 0) + clicks,
      registrations: Number(data.registrations || 0) + registrations,
      revenue: Number(data.revenue || 0) + revenue,
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId);

  if (data.content_id) {
    await client.from('content_metrics').insert({
      user_id: data.user_id,
      content_id: data.content_id,
      platform: data.platform,
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      clicks,
      registrations,
      revenue,
      collected_at: new Date().toISOString(),
    });
  }

  return {
    ok: true,
    campaign_id: campaignId,
    clicks,
    registrations,
    revenue,
  };
}

async function handleTelegramWebhook(client: ReturnType<typeof createClient>, request: Request, update: Record<string, any>) {
  const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  const receivedSecret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return { ok: false, error: 'Invalid Telegram webhook secret.' };
  }

  const event = extractTelegramInteraction(update);
  if (!event.messageId) {
    return {
      ok: true,
      ignored: true,
      update_id: update.update_id || null,
      reason: 'No message_id found in Telegram update.',
    };
  }

  const tasks = await findTelegramPublishTasks(client, event.messageId, event.chatId);
  const results = [];
  for (const task of tasks) {
    const metrics = mergeTelegramMetrics(task, event);
    await writeMetricsSnapshot(client, task.user_id, task, metrics, event.message);
    if (task.campaign_id && (metrics.clicks || metrics.registrations || metrics.revenue)) {
      await updateCampaignFromMetrics(client, task.campaign_id, metrics);
    }
    results.push({
      publish_task_id: task.id,
      content_id: task.content_id,
      metrics,
    });
  }

  return {
    ok: true,
    update_id: update.update_id || null,
    event_type: event.type,
    matched_tasks: results.length,
    results,
  };
}

function extractTelegramInteraction(update: Record<string, any>) {
  const message = update.channel_post || update.edited_channel_post || update.message || update.edited_message || {};
  const reactionCount = update.message_reaction_count || {};
  const reaction = update.message_reaction || {};
  const callbackQuery = update.callback_query || {};
  const callbackMessage = callbackQuery.message || {};
  const activeMessage = reactionCount.message_id ? reactionCount : reaction.message_id ? reaction : callbackMessage.message_id ? callbackMessage : message;
  const reactions = reactionCount.reactions || reaction.new_reaction || message.reactions || [];
  const reactionTotal = Array.isArray(reactions)
    ? reactions.reduce((sum: number, item: Record<string, any>) => sum + Number(item.total_count || item.count || 1), 0)
    : 0;

  return {
    type: update.message_reaction_count ? 'message_reaction_count' : update.message_reaction ? 'message_reaction' : update.callback_query ? 'callback_query' : 'message',
    messageId: activeMessage.message_id ? String(activeMessage.message_id) : '',
    chatId: activeMessage.chat?.id ? String(activeMessage.chat.id) : '',
    message: {
      ...activeMessage,
      views: Number(message.views || activeMessage.views || 0),
      forwards: Number(message.forwards || activeMessage.forwards || 0),
      reply_count: Number(message.reply_count || activeMessage.reply_count || 0),
      reactions,
      callback_data: callbackQuery.data || null,
    },
    metrics: {
      views: Number(message.views || activeMessage.views || 0),
      likes: reactionTotal,
      comments: Number(message.reply_count || activeMessage.reply_count || 0),
      shares: Number(message.forwards || activeMessage.forwards || 0),
      clicks: callbackQuery.id ? 1 : 0,
      registrations: 0,
      revenue: 0,
      engagement: reactionTotal + Number(message.reply_count || activeMessage.reply_count || 0) + Number(message.forwards || activeMessage.forwards || 0),
    },
  };
}

async function findTelegramPublishTasks(client: ReturnType<typeof createClient>, messageId: string, chatId: string) {
  const { data, error } = await client
    .from('publish_tasks')
    .select('*, campaign_links(id, clicks, registrations, revenue)')
    .eq('platform', 'Telegram')
    .eq('external_id', messageId);
  if (error) throw error;

  return (data || []).filter((task: Record<string, any>) => {
    if (!chatId) return true;
    const storedChatId = task.result?.telegram_message?.chat?.id;
    return !storedChatId || String(storedChatId) === String(chatId);
  });
}

function mergeTelegramMetrics(task: Record<string, any>, event: Record<string, any>) {
  const existing = task.result?.metrics || task.result?.safe_result?.metrics || {};
  return {
    views: Math.max(Number(existing.views || 0), Number(event.metrics.views || 0)),
    likes: Math.max(Number(existing.likes || 0), Number(event.metrics.likes || 0)),
    comments: Math.max(Number(existing.comments || 0), Number(event.metrics.comments || 0)),
    shares: Math.max(Number(existing.shares || 0), Number(event.metrics.shares || 0)),
    clicks: Number(existing.clicks || 0) + Number(event.metrics.clicks || 0),
    registrations: Number(existing.registrations || 0) + Number(event.metrics.registrations || 0),
    revenue: Number(existing.revenue || 0) + Number(event.metrics.revenue || 0),
    engagement: Math.max(Number(existing.engagement || 0), Number(event.metrics.engagement || 0)),
  };
}

async function updateCampaignFromMetrics(client: ReturnType<typeof createClient>, campaignId: string, metrics: Record<string, number>) {
  const { data, error } = await client
    .from('campaign_links')
    .select('clicks, registrations, revenue')
    .eq('id', campaignId)
    .single();
  if (error) throw error;

  await client
    .from('campaign_links')
    .update({
      clicks: Number(data.clicks || 0) + Number(metrics.clicks || 0),
      registrations: Number(data.registrations || 0) + Number(metrics.registrations || 0),
      revenue: Number(data.revenue || 0) + Number(metrics.revenue || 0),
      updated_at: new Date().toISOString(),
    })
    .eq('id', campaignId);
}

async function writeMetricsSnapshot(
  client: ReturnType<typeof createClient>,
  userId: string,
  task: Record<string, any>,
  metrics: Record<string, number>,
  telegramMessage: Record<string, unknown>,
) {
  await client.from('publish_metrics').upsert({
    user_id: userId,
    publish_task_id: task.id,
    metrics_json: {
      provider: 'telegram',
      external_id: task.external_id || telegramMessage.message_id || null,
      message: sanitizeTelegramMessage(telegramMessage),
      metrics,
    },
    last_sync: new Date().toISOString(),
  });

  if (task.content_id) {
    await client.from('content_metrics').insert({
      user_id: userId,
      content_id: task.content_id,
      platform: 'Telegram',
      views: metrics.views,
      likes: metrics.likes,
      comments: metrics.comments,
      shares: metrics.shares,
      clicks: metrics.clicks,
      registrations: metrics.registrations,
      revenue: metrics.revenue,
      collected_at: new Date().toISOString(),
    });
  }
}

function normalizeTelegramMetrics(message: Record<string, any>) {
  const reactionCount = Array.isArray(message.reactions)
    ? message.reactions.reduce((sum: number, reaction: Record<string, number>) => sum + Number(reaction.total_count || reaction.count || 0), 0)
    : 0;

  return {
    views: Number(message.views || 0),
    likes: reactionCount,
    comments: Number(message.reply_count || 0),
    shares: Number(message.forwards || 0),
    clicks: 0,
    registrations: 0,
    revenue: 0,
    engagement: reactionCount + Number(message.reply_count || 0) + Number(message.forwards || 0),
  };
}

function appendCampaignLink(text: string, url: string) {
  if (!url) return text;
  if (text.includes(url)) return text;
  return `${text}\n\n${url}`;
}

function buildCampaignPublishUrl(task: Record<string, any>) {
  const campaignId = task.campaign_id || task.campaign_links?.id;
  const trackingBaseUrl = Deno.env.get('TELEGRAM_TRACKING_BASE_URL') || Deno.env.get('PLATFORM_FUNCTION_URL') || '';
  if (campaignId && trackingBaseUrl) {
    const separator = trackingBaseUrl.includes('?') ? '&' : '?';
    return `${trackingBaseUrl}${separator}campaign_id=${campaignId}`;
  }
  return String(task.campaign_links?.url || '').trim();
}

function sanitizeTelegramMessage(message: Record<string, any>) {
  return {
    message_id: message.message_id || null,
    date: message.date || null,
    chat: message.chat ? { id: message.chat.id, title: message.chat.title, username: message.chat.username, type: message.chat.type } : null,
    views: message.views || 0,
    forwards: message.forwards || 0,
    reactions: message.reactions || null,
  };
}

function normalizeTelegramChatId(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('@') || raw.startsWith('-')) return raw;
  const match = raw.match(/t\.me\/([^/?#]+)/i);
  if (match?.[1]) return `@${match[1]}`;
  return raw;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token, x-tracking-event-secret',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  });
}
