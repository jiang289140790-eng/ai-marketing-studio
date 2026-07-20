import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

type PlatformAction = 'connect' | 'disconnect' | 'reconnect' | 'status' | 'getAccount' | 'fetchContent' | 'publish' | 'getMetrics' | 'setWebhook' | 'notifyAdmin';

const supportedActions: PlatformAction[] = ['connect', 'disconnect', 'reconnect', 'status', 'getAccount', 'fetchContent', 'publish', 'getMetrics', 'setWebhook', 'notifyAdmin'];

const preparedPlatformConfigs: Record<string, {
  label: string;
  authType: string;
  requiredSecrets: string[];
  supportedActions: string[];
  notes: string[];
}> = {
  Instagram: {
    label: 'Instagram',
    authType: 'oauth2',
    requiredSecrets: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'INSTAGRAM_REDIRECT_URI'],
    supportedActions: ['connect', 'disconnect', 'reconnect', 'status', 'publish', 'getMetrics'],
    notes: ['Use Instagram OAuth / Meta Graph permissions from the migrated platform layer.', 'Tokens must be written only to platform_credentials.'],
  },
  YouTube: {
    label: 'YouTube',
    authType: 'oauth2',
    requiredSecrets: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'],
    supportedActions: ['connect', 'disconnect', 'reconnect', 'status', 'publish', 'getMetrics'],
    notes: ['Use Google OAuth with YouTube channel scopes.', 'Channel selection should create one platform_connection per channel.'],
  },
  TikTok: {
    label: 'TikTok',
    authType: 'oauth2',
    requiredSecrets: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
    supportedActions: ['connect', 'disconnect', 'reconnect', 'status', 'publish', 'getMetrics'],
    notes: ['Use TikTok OAuth and content posting scopes.', 'Creator info and publish privacy settings stay in publish task metadata.'],
  },
  Discord: {
    label: 'Discord',
    authType: 'bot / oauth2',
    requiredSecrets: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_REDIRECT_URI'],
    supportedActions: ['connect', 'disconnect', 'reconnect', 'status', 'publish', 'getMetrics'],
    notes: ['Discord can use Bot channel publishing first, then OAuth for server/channel discovery.', 'Each server/channel should become an independent platform_connection.'],
  },
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  try {
    if (request.method === 'GET') {
      const { client } = createServiceClient();
      const url = new URL(request.url);
      if ((url.searchParams.get('platform') || '').toLowerCase() === 'x' || (url.searchParams.get('action') || '').toLowerCase() === 'x-callback' || (url.searchParams.has('code') && url.searchParams.has('state'))) {
        return handleXOAuthCallback(client, request);
      }
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

    if (platform === 'X') {
      const { client, user } = await createAuthorizedClient(authHeader);
      return jsonResponse(await handleXPlatformAction(client, user.id, action, body));
    }

    if (platform !== 'Telegram') {
      const { user } = await createAuthorizedClient(authHeader);
      return jsonResponse(buildPreparedPlatformResponse(String(platform), action, body, user.id));
    }

    const { client, user } = await createAuthorizedClient(authHeader);

    if (action === 'notifyAdmin') {
      return jsonResponse(await sendAdminTelegramNotification(user.id, body));
    }

    if (action === 'connect') {
      return jsonResponse(await connectTelegram(client, user.id, body));
    }

    if (action === 'reconnect') {
      return jsonResponse(await reconnectTelegram(client, user.id, body));
    }

    if (action === 'disconnect') {
      return jsonResponse(await disconnectTelegram(client, user.id, body));
    }

    if (action === 'status' || action === 'getAccount') {
      return jsonResponse(await getTelegramConnectionStatus(client, user.id, body));
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

function buildPreparedPlatformResponse(platformInput: string, action: PlatformAction, body: Record<string, unknown>, userId: string) {
  const platform = normalizePreparedPlatform(platformInput);
  const config = preparedPlatformConfigs[platform];
  if (!config) {
    return {
      ok: false,
      platform: platformInput,
      action,
      mode: 'unsupported_platform',
      error: `Unsupported platform: ${platformInput}`,
      token_exposed: false,
    };
  }

  const configuredSecrets = config.requiredSecrets.filter((secretName) => Boolean(Deno.env.get(secretName)));
  const missingSecrets = config.requiredSecrets.filter((secretName) => !Deno.env.get(secretName));
  const redirectUri = Deno.env.get(`${platform.toUpperCase()}_REDIRECT_URI`) || defaultPreparedRedirectUri(platform);
  const readyForOAuth = missingSecrets.length === 0;

  return {
    ok: true,
    platform,
    action,
    mode: readyForOAuth ? 'adapter_ready_pending_implementation' : 'configuration_required',
    status: readyForOAuth ? 'ready' : 'missing_secrets',
    message: readyForOAuth
      ? `${config.label} credentials are configured. The OAuth handler can be implemented against this prepared adapter boundary.`
      : `${config.label} connection is prepared, but Edge Function secrets are not complete yet.`,
    setup: {
      auth_type: config.authType,
      required_secrets: config.requiredSecrets,
      configured_secrets: configuredSecrets,
      missing_secrets: missingSecrets,
      redirect_uri: redirectUri,
      callback_url: defaultPreparedRedirectUri(platform),
      supported_actions: config.supportedActions,
      multi_account: true,
      token_storage: 'platform_credentials_only',
      frontend_token_access: false,
      notes: config.notes,
    },
    safe_result: {
      user_id: userId,
      platform,
      connection_id: body.connection_id || null,
      token_exposed: false,
    },
  };
}

function normalizePreparedPlatform(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'instagram') return 'Instagram';
  if (normalized === 'youtube') return 'YouTube';
  if (normalized === 'tiktok') return 'TikTok';
  if (normalized === 'discord') return 'Discord';
  return value;
}

function defaultPreparedRedirectUri(platform: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || 'https://qtrlymiqohbjvklwegsw.supabase.co';
  return `${supabaseUrl}/functions/v1/platform?platform=${encodeURIComponent(platform)}`;
}

async function connectTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const botToken = getTelegramBotToken();
  const chatId = normalizeTelegramChatId(String(body.chat_id || body.account_url || '').trim());
  const accountName = String(body.account_name || chatId || 'Telegram Channel');
  if (!chatId) {
    const connectCode = await createTelegramConnectCode(userId);
    const botInfo = await callTelegram(botToken, 'getMe', {});
    return {
      ok: true,
      action: 'connect',
      mode: 'telegram_connect_code',
      platform: 'Telegram',
      connect_code: connectCode.code,
      expires_at: connectCode.expires_at,
      instruction: `/connect ${connectCode.code}`,
      bot: {
        id: botInfo.id,
        username: botInfo.username,
        first_name: botInfo.first_name,
      },
      token_exposed: false,
    };
  }

  const botInfo = await callTelegram(botToken, 'getMe', {});
  const chatInfo = await callTelegram(botToken, 'getChat', { chat_id: chatId });
  const resolvedChatId = normalizeTelegramChatId(chatInfo.id || chatId);
  const username = chatInfo.username ? `@${chatInfo.username}` : '';
  const accountUrl = username || resolvedChatId;

  const account = await upsertTelegramSocialAccount(client, userId, {
    account_name: accountName,
    account_url: accountUrl,
    chat_id: resolvedChatId,
    username,
    chat_info: chatInfo,
  });

  const connection = await upsertTelegramConnection(client, userId, account.id, {
    chat_id: resolvedChatId,
    username,
    chat_info: chatInfo,
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      first_name: botInfo.first_name,
    },
  });

  await saveTelegramCredentialReference(client, connection.id, {
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      first_name: botInfo.first_name,
    },
    chat: sanitizeTelegramChat(chatInfo),
  });

  const webhook = await trySetTelegramWebhook(botToken);

  return {
    ok: true,
    action: 'connect',
    platform: 'Telegram',
    connection_id: connection.id,
    account,
    connection,
    bot: {
      id: botInfo.id,
      username: botInfo.username,
      first_name: botInfo.first_name,
    },
    webhook,
    token_exposed: false,
  };
}

async function upsertTelegramSocialAccount(client: ReturnType<typeof createClient>, userId: string, payload: Record<string, any>) {
  const { data: existing, error: existingError } = await client
    .from('social_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', 'Telegram')
    .eq('account_url', payload.account_url)
    .limit(1);
  if (existingError) throw existingError;

  const accountPayload = {
      user_id: userId,
      platform: 'Telegram',
      account_name: payload.account_name || payload.username || payload.chat_id || 'Telegram Channel',
      account_url: payload.account_url || payload.chat_id,
      avatar: null,
      status: 'active',
      account_type: 'brand',
      api_status: 'connected',
      ops_notes: `Telegram chat: ${payload.chat_id || payload.account_url || ''}`,
    };

  if (existing?.[0]?.id) {
    const { data, error } = await client
      .from('social_accounts')
      .update(accountPayload)
      .eq('id', existing[0].id)
      .select('id, account_name, account_url, status, api_status')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client
    .from('social_accounts')
    .insert(accountPayload)
    .select('id, account_name, account_url, status, api_status')
    .single();
  if (error) throw error;
  return data;
}

async function upsertTelegramConnection(client: ReturnType<typeof createClient>, userId: string, accountId: string, metadata: Record<string, any>) {
  const { data: existing, error: existingError } = await client
    .from('platform_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', 'Telegram')
    .eq('account_id', accountId)
    .limit(1);
  if (existingError) throw existingError;

  const now = new Date().toISOString();
  const payload = {
      user_id: userId,
      platform: 'Telegram',
      account_id: accountId,
      status: 'connected',
      auth_type: 'bot_token',
      permissions: ['publish', 'metrics', 'webhook'],
      connected_at: now,
      last_sync: now,
      last_used_at: now,
      disconnected_at: null,
      error_message: null,
      metadata: {
        telegram: {
          chat_id: metadata.chat_id || null,
          username: metadata.username || null,
          chat: sanitizeTelegramChat(metadata.chat_info || {}),
          bot: metadata.bot || null,
        },
        credential_source: 'edge_function_secret',
      },
    };

  if (existing?.[0]?.id) {
    const { data, error } = await client
      .from('platform_connections')
      .update(payload)
      .eq('id', existing[0].id)
      .select('id, platform, status, connected_at, last_sync, metadata')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client
    .from('platform_connections')
    .insert(payload)
    .select('id, platform, status, connected_at, last_sync, metadata')
    .single();
  if (error) throw error;
  return data;
}

async function saveTelegramCredentialReference(client: ReturnType<typeof createClient>, connectionId: string, metadata: Record<string, any>) {
  const payload = {
      connection_id: connectionId,
      encrypted_token: 'edge-secret:TELEGRAM_BOT_TOKEN_OR_ADMIN',
      refresh_token: null,
      expires_at: null,
      token_type: 'telegram_bot_secret_reference',
      scopes: ['publish', 'metrics', 'webhook'],
      metadata: {
        provider: 'telegram',
        credential_source: 'edge_function_secret',
        ...metadata,
      },
      updated_at: new Date().toISOString(),
    };

  const { data: existing, error: existingError } = await client
    .from('platform_credentials')
    .select('id')
    .eq('connection_id', connectionId)
    .limit(1);
  if (existingError) throw existingError;

  if (existing?.[0]?.id) {
    const { error } = await client.from('platform_credentials').update(payload).eq('id', existing[0].id);
    if (error) throw error;
    return;
  }

  const { error } = await client.from('platform_credentials').insert(payload);
  if (error) throw error;
}

async function reconnectTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  if (!body.chat_id && connectionId) {
    const connection = await loadTelegramConnection(client, userId, connectionId);
    const chatId = connection.metadata?.telegram?.chat_id || connection.social_accounts?.account_url || '';
    return connectTelegram(client, userId, {
      ...body,
      chat_id: chatId,
      account_name: connection.social_accounts?.account_name || 'Telegram Channel',
    });
  }

  return connectTelegram(client, userId, body);
}

async function disconnectTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  if (!connectionId) throw new Error('Missing connection_id.');

  const connection = await loadTelegramConnection(client, userId, connectionId);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('platform_connections')
    .update({
      status: 'disconnected',
      disconnected_at: now,
      last_sync: now,
      error_message: null,
      metadata: {
        ...(connection.metadata || {}),
        disconnected_by: 'user',
        disconnected_at: now,
      },
    })
    .eq('id', connectionId)
    .eq('user_id', userId)
    .select('id, platform, status, disconnected_at, last_sync')
    .single();
  if (error) throw error;

  if (connection.account_id) {
    await client
      .from('social_accounts')
      .update({ api_status: 'not_connected' })
      .eq('id', connection.account_id)
      .eq('user_id', userId);
  }

  return {
    ok: true,
    action: 'disconnect',
    platform: 'Telegram',
    connection: data,
    token_exposed: false,
  };
}

async function getTelegramConnectionStatus(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  let query = client
    .from('platform_connections')
    .select('id, platform, account_id, status, auth_type, permissions, connected_at, disconnected_at, last_sync, last_used_at, expires_at, error_message, metadata, social_accounts(account_name, account_url, avatar, status, api_status)')
    .eq('user_id', userId)
    .eq('platform', 'Telegram');

  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  return {
    ok: true,
    action: 'status',
    platform: 'Telegram',
    connections: (data || []).map((connection: Record<string, any>) => ({
      ...connection,
      token_exposed: false,
      credential_status: connection.status === 'connected' ? 'edge_secret_or_secure_storage' : 'not_active',
    })),
  };
}

async function publishTelegram(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const task = await loadPublishTask(client, userId, body);
  const connectionId = task.platform_connection_id || body.connection_id;
  if (!connectionId) throw new Error('Telegram publish requires platform_connection_id.');

  const connection = await loadTelegramConnection(client, userId, String(connectionId));
  const token = await loadTelegramToken(client, String(connectionId));
  const chatId = normalizeTelegramChatId(connection.metadata?.telegram?.chat_id || connection.social_accounts?.account_url || connection.social_accounts?.account_name || body.chat_id);
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
  const messageUrl = buildTelegramMessageUrl(telegramMessage);

  return {
    ok: true,
    action: 'publish',
    platform: 'Telegram',
    message_id: externalId,
    channel_id: telegramMessage.chat?.id ? String(telegramMessage.chat.id) : null,
    external_id: externalId,
    url: messageUrl,
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
  const secretToken = getTelegramBotToken(false);
  if (secretToken) return secretToken;

  const { data, error } = await client
    .from('platform_credentials')
    .select('encrypted_token, token_type')
    .eq('connection_id', connectionId)
    .single();
  if (error) throw error;
  if (!data?.encrypted_token) throw new Error('Telegram credential is missing.');
  if (String(data.encrypted_token).startsWith('edge-secret:')) {
    throw new Error('Telegram bot token secret is not configured in Edge Function.');
  }
  return data.encrypted_token;
}

function getTelegramBotToken(required = true) {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN') || Deno.env.get('TELEGRAM_ADMIN_BOT_TOKEN') || '';
  if (required && !token) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_BOT_TOKEN in Edge Function secrets.');
  return token;
}

async function handleXPlatformAction(client: ReturnType<typeof createClient>, userId: string, action: PlatformAction, body: Record<string, unknown>) {
  if (action === 'connect') return startXOAuth(client, userId, body);
  if (action === 'reconnect') return startXOAuth(client, userId, { ...body, reconnect: true });
  if (action === 'disconnect') return disconnectX(client, userId, body);
  if (action === 'status' || action === 'getAccount') return getXConnectionStatus(client, userId, body);
  if (action === 'publish') return publishX(client, userId, body);
  if (action === 'getMetrics') return getXMetrics(client, userId, body);

  return {
    ok: true,
    platform: 'X',
    action,
    mode: 'placeholder',
    message: 'X Platform Layer is ready for OAuth/status/publish in this phase.',
    token_exposed: false,
  };
}

async function startXOAuth(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const config = getXConfig();
  const state = crypto.randomUUID();
  const codeVerifier = base64UrlEncode(crypto.randomUUID() + crypto.randomUUID());
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const scopes = ['tweet.read', 'tweet.write', 'media.write', 'users.read', 'offline.access'];
  const now = new Date().toISOString();

  const { data: pending, error } = await client
    .from('platform_connections')
    .insert({
      user_id: userId,
      platform: 'X',
      account_id: body.account_id || null,
      status: 'pending',
      auth_type: 'oauth2_pkce',
      permissions: scopes,
      connected_at: null,
      last_sync: now,
      metadata: {
        x: {
          oauth_state: state,
          code_verifier: codeVerifier,
          redirect_uri: config.redirectUri,
          reconnect: Boolean(body.reconnect),
          started_at: now,
        },
      },
    })
    .select('id, platform, status, auth_type, permissions, metadata')
    .single();
  if (error) throw error;

  const authUrl = new URL(`${config.oauthBaseUrl}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', config.redirectUri);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    ok: true,
    action: 'connect',
    platform: 'X',
    connection_id: pending.id,
    auth_url: authUrl.toString(),
    status: 'pending',
    required_scopes: scopes,
    token_exposed: false,
  };
}

async function handleXOAuthCallback(client: ReturnType<typeof createClient>, request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const error = url.searchParams.get('error') || '';
  if (error) return htmlResponse('X connection failed', `X returned error: ${escapeHtml(error)}`, false);
  if (!code || !state) return htmlResponse('X connection failed', 'Missing OAuth code or state.', false);

  const { data: candidates, error: lookupError } = await client
    .from('platform_connections')
    .select('id, user_id, metadata')
    .eq('platform', 'X')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(25);
  if (lookupError) throw lookupError;

  const connection = (candidates || []).find((item: Record<string, any>) => item.metadata?.x?.oauth_state === state);
  if (!connection) return htmlResponse('X connection failed', 'OAuth state expired or not found.', false);

  const config = getXConfig();
  const codeVerifier = String(connection.metadata?.x?.code_verifier || '');
  const token = await exchangeXCodeForToken(config, code, codeVerifier);
  const profile = await fetchXProfile(token.access_token);
  const expiresAt = token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000).toISOString() : null;

  const account = await upsertXSocialAccount(client, connection.user_id, profile);
  await updateXConnectionConnected(client, connection.id, account.id, profile, token, expiresAt);
  await saveXCredentials(client, connection.id, token, expiresAt);

  return htmlResponse('X connected', `X account @${escapeHtml(profile.username || 'unknown')} is connected. You can close this window.`, true);
}

async function disconnectX(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  if (!connectionId) throw new Error('Missing connection_id.');

  const connection = await loadXConnection(client, userId, connectionId);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('platform_connections')
    .update({
      status: 'disconnected',
      disconnected_at: now,
      last_sync: now,
      error_message: null,
      metadata: {
        ...(connection.metadata || {}),
        disconnected_by: 'user',
        disconnected_at: now,
      },
    })
    .eq('id', connectionId)
    .eq('user_id', userId)
    .select('id, platform, status, disconnected_at, last_sync')
    .single();
  if (error) throw error;

  if (connection.account_id) {
    await client.from('social_accounts').update({ api_status: 'not_connected' }).eq('id', connection.account_id).eq('user_id', userId);
  }

  return { ok: true, action: 'disconnect', platform: 'X', connection: data, token_exposed: false };
}

async function getXConnectionStatus(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const connectionId = String(body.connection_id || '').trim();
  let query = client
    .from('platform_connections')
    .select('id, platform, account_id, status, auth_type, permissions, connected_at, disconnected_at, last_sync, last_used_at, expires_at, error_message, metadata, social_accounts(account_name, account_url, avatar, status, api_status)')
    .eq('user_id', userId)
    .eq('platform', 'X');

  if (connectionId) query = query.eq('id', connectionId);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;

  return {
    ok: true,
    action: 'status',
    platform: 'X',
    connections: (data || []).map((connection: Record<string, any>) => ({
      ...connection,
      token_exposed: false,
      credential_status: connection.status === 'connected' ? 'secure_storage' : 'not_active',
    })),
  };
}

async function publishX(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const task = await loadXPublishTask(client, userId, body);
  const connectionId = task.platform_connection_id || body.connection_id;
  if (!connectionId) throw new Error('X publish requires platform_connection_id.');

  const connection = await loadXConnection(client, userId, String(connectionId));
  const credential = await loadXCredential(client, String(connectionId));
  const accessToken = await ensureFreshXAccessToken(client, String(connectionId), connection, credential);
  const content = task.content_library || body.content || {};
  const text = String(content.content_text || content.title || body.text || '').trim();
  if (!text) throw new Error('X posts require text content in this phase.');
  if (text.length > 280) throw new Error('X text-only posts are limited to 280 characters in this MVP.');

  const result = await callXApi(accessToken, '/tweets', {
    method: 'POST',
    body: { text },
  });

  const tweetId = result.data?.id || result.id || null;
  if (!tweetId) throw new Error('X publish succeeded but no tweet id was returned.');
  const username = connection.metadata?.x?.username || connection.social_accounts?.account_name || '';
  const tweetUrl = username ? `https://x.com/${String(username).replace(/^@/, '')}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`;
  const metrics = { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, registrations: 0, revenue: 0, engagement: 0 };
  await writeXMetricsSnapshot(client, userId, task, metrics, {
    tweet_id: tweetId,
    url: tweetUrl,
    raw: result,
  });

  await client
    .from('platform_connections')
    .update({ last_used_at: new Date().toISOString(), last_sync: new Date().toISOString(), error_message: null })
    .eq('id', String(connectionId));

  return {
    ok: true,
    action: 'publish',
    platform: 'X',
    tweet_id: String(tweetId),
    external_id: String(tweetId),
    url: tweetUrl,
    published_at: new Date().toISOString(),
    metrics,
    token_exposed: false,
  };
}

async function getXMetrics(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const task = await loadXPublishTask(client, userId, body);
  const metrics = task.result?.metrics || { views: 0, likes: 0, comments: 0, shares: 0, clicks: 0, registrations: 0, revenue: 0, engagement: 0 };
  await writeXMetricsSnapshot(client, userId, task, metrics, {
    tweet_id: task.external_id || null,
    url: task.result?.url || null,
  });

  return {
    ok: true,
    action: 'getMetrics',
    platform: 'X',
    publish_task_id: task.id,
    external_id: task.external_id,
    metrics,
    note: 'X metrics pull is prepared; full analytics expansion requires approved X API access.',
    token_exposed: false,
  };
}

function getXConfig() {
  const clientId = Deno.env.get('X_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('X_CLIENT_SECRET') || '';
  const redirectUri = Deno.env.get('X_REDIRECT_URI') || '';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing X_CLIENT_ID, X_CLIENT_SECRET, or X_REDIRECT_URI in Edge Function secrets.');
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    apiBaseUrl: (Deno.env.get('X_API_BASE_URL') || 'https://api.x.com/2').replace(/\/$/, ''),
    oauthBaseUrl: (Deno.env.get('X_OAUTH_BASE_URL') || 'https://twitter.com/i/oauth2').replace(/\/$/, ''),
    tokenUrl: Deno.env.get('X_OAUTH_TOKEN_URL') || 'https://api.x.com/2/oauth2/token',
  };
}

async function exchangeXCodeForToken(config: ReturnType<typeof getXConfig>, code: string, codeVerifier: string) {
  if (!codeVerifier) throw new Error('Missing X OAuth code verifier.');

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error_description || json.error || `X OAuth token exchange failed with ${response.status}.`);
  }
  return json;
}

async function refreshXToken(refreshToken: string) {
  if (!refreshToken) throw new Error('No refresh token available for X account.');
  const config = getXConfig();
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error_description || json.error || `X token refresh failed with ${response.status}.`);
  }
  return json;
}

async function fetchXProfile(accessToken: string) {
  const result = await callXApi(accessToken, '/users/me?user.fields=profile_image_url', { method: 'GET' });
  return result.data || result;
}

async function callXApi(accessToken: string, path: string, options: { method?: string; body?: Record<string, unknown> } = {}) {
  const config = getXConfig();
  const response = await fetch(`${config.apiBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.errors || json.error) {
    const message = json.detail || json.title || json.error_description || json.error || json.errors?.[0]?.message || `X API failed with ${response.status}.`;
    throw new Error(message);
  }
  return json;
}

async function upsertXSocialAccount(client: ReturnType<typeof createClient>, userId: string, profile: Record<string, any>) {
  const platformUserId = String(profile.id || '');
  if (!platformUserId) throw new Error('X profile is missing user id.');
  const username = String(profile.username || '').replace(/^@/, '');
  const accountUrl = username ? `https://x.com/${username}` : `https://x.com/i/user/${platformUserId}`;

  const { data: existing, error: existingError } = await client
    .from('social_accounts')
    .select('id')
    .eq('user_id', userId)
    .eq('platform', 'X')
    .eq('account_url', accountUrl)
    .limit(1);
  if (existingError) throw existingError;

  const payload = {
    user_id: userId,
    platform: 'X',
    account_name: username || profile.name || platformUserId,
    account_url: accountUrl,
    avatar: profile.profile_image_url || null,
    status: 'active',
    account_type: 'brand',
    api_status: 'connected',
    ops_notes: `X user id: ${platformUserId}`,
  };

  if (existing?.[0]?.id) {
    const { data, error } = await client.from('social_accounts').update(payload).eq('id', existing[0].id).select('id, account_name, account_url, avatar, status, api_status').single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await client.from('social_accounts').insert(payload).select('id, account_name, account_url, avatar, status, api_status').single();
  if (error) throw error;
  return data;
}

async function updateXConnectionConnected(client: ReturnType<typeof createClient>, connectionId: string, accountId: string, profile: Record<string, any>, token: Record<string, any>, expiresAt: string | null) {
  const now = new Date().toISOString();
  const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
  const { error } = await client
    .from('platform_connections')
    .update({
      account_id: accountId,
      status: 'connected',
      auth_type: 'oauth2_pkce',
      permissions: scopes.length ? scopes : ['tweet.read', 'tweet.write', 'media.write', 'users.read', 'offline.access'],
      connected_at: now,
      last_sync: now,
      last_used_at: now,
      expires_at: expiresAt,
      disconnected_at: null,
      error_message: null,
      metadata: {
        x: {
          user_id: profile.id || null,
          username: profile.username || null,
          name: profile.name || null,
          profile_image_url: profile.profile_image_url || null,
        },
      },
    })
    .eq('id', connectionId);
  if (error) throw error;
}

async function saveXCredentials(client: ReturnType<typeof createClient>, connectionId: string, token: Record<string, any>, expiresAt: string | null) {
  const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
  const payload = {
    connection_id: connectionId,
    encrypted_token: token.access_token || null,
    refresh_token: token.refresh_token || null,
    expires_at: expiresAt,
    token_type: token.token_type || 'bearer',
    scopes,
    metadata: {
      provider: 'x',
      credential_source: 'oauth2_pkce',
    },
    updated_at: new Date().toISOString(),
  };

  const { data: existing, error: existingError } = await client.from('platform_credentials').select('id').eq('connection_id', connectionId).limit(1);
  if (existingError) throw existingError;

  if (existing?.[0]?.id) {
    const { error } = await client.from('platform_credentials').update(payload).eq('id', existing[0].id);
    if (error) throw error;
    return;
  }

  const { error } = await client.from('platform_credentials').insert(payload);
  if (error) throw error;
}

async function loadXConnection(client: ReturnType<typeof createClient>, userId: string, connectionId: string) {
  const { data, error } = await client
    .from('platform_connections')
    .select('*, social_accounts(account_name, account_url, avatar, status, api_status)')
    .eq('id', connectionId)
    .eq('user_id', userId)
    .eq('platform', 'X')
    .single();
  if (error) throw error;
  return data;
}

async function loadXCredential(client: ReturnType<typeof createClient>, connectionId: string) {
  const { data, error } = await client
    .from('platform_credentials')
    .select('encrypted_token, refresh_token, expires_at, scopes, token_type, metadata')
    .eq('connection_id', connectionId)
    .single();
  if (error) throw error;
  if (!data?.encrypted_token) throw new Error('X access token is missing. Reconnect the X account.');
  return data;
}

async function ensureFreshXAccessToken(client: ReturnType<typeof createClient>, connectionId: string, connection: Record<string, any>, credential: Record<string, any>) {
  const expiresAt = credential.expires_at || connection.expires_at;
  const shouldRefresh = expiresAt ? new Date(expiresAt).getTime() - Date.now() < 5 * 60 * 1000 : false;
  if (!shouldRefresh) return credential.encrypted_token;

  const refreshed = await refreshXToken(credential.refresh_token);
  const nextExpiresAt = refreshed.expires_in ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString() : expiresAt || null;
  await saveXCredentials(client, connectionId, {
    ...refreshed,
    refresh_token: refreshed.refresh_token || credential.refresh_token,
  }, nextExpiresAt);
  await client.from('platform_connections').update({ expires_at: nextExpiresAt, last_sync: new Date().toISOString(), error_message: null }).eq('id', connectionId);

  return refreshed.access_token;
}

async function loadXPublishTask(client: ReturnType<typeof createClient>, userId: string, body: Record<string, unknown>) {
  const taskId = body.publish_task_id || body.task_id || (body.task as Record<string, unknown> | undefined)?.id;
  if (!taskId) throw new Error('Missing publish_task_id.');

  const { data, error } = await client
    .from('publish_tasks')
    .select('*, content_library(title, content_text, media_url, content_type, platform), campaign_links(id, url, clicks, registrations, revenue)')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  if (!data || data.platform !== 'X') throw new Error('Publish task is not an X task.');
  return data;
}

async function writeXMetricsSnapshot(client: ReturnType<typeof createClient>, userId: string, task: Record<string, any>, metrics: Record<string, number>, tweet: Record<string, unknown>) {
  await client.from('publish_metrics').upsert({
    user_id: userId,
    publish_task_id: task.id,
    metrics_json: {
      provider: 'x',
      external_id: task.external_id || tweet.tweet_id || null,
      tweet,
      metrics,
    },
    last_sync: new Date().toISOString(),
  });

  if (task.content_id) {
    await client.from('content_metrics').insert({
      user_id: userId,
      content_id: task.content_id,
      platform: 'X',
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

async function sha256Base64Url(value: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(hash)));
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

  const connectResult = await handleTelegramConnectMessage(client, update);
  if (connectResult) return connectResult;

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

async function handleTelegramConnectMessage(client: ReturnType<typeof createClient>, update: Record<string, any>) {
  const message = update.channel_post || update.message || {};
  const text = String(message.text || '').trim();
  if (!text.toLowerCase().startsWith('/connect ')) return null;

  const code = text.split(/\s+/)[1] || '';
  const decoded = await verifyTelegramConnectCode(code);
  if (!decoded?.user_id) {
    return {
      ok: false,
      action: 'connect',
      platform: 'Telegram',
      error: 'Invalid or expired Telegram connect code.',
      update_id: update.update_id || null,
    };
  }

  const chat = message.chat || {};
  const chatId = normalizeTelegramChatId(chat.id || chat.username || '');
  const accountName = chat.title || chat.username || chatId || 'Telegram Channel';
  if (!chatId) {
    return {
      ok: false,
      action: 'connect',
      platform: 'Telegram',
      error: 'Unable to resolve Telegram chat id from webhook message.',
      update_id: update.update_id || null,
    };
  }

  const result = await connectTelegram(client, decoded.user_id, {
    chat_id: chatId,
    account_name: accountName,
  });

  return {
    ok: true,
    action: 'connect',
    platform: 'Telegram',
    update_id: update.update_id || null,
    connection_id: result.connection_id,
    account: result.account,
    token_exposed: false,
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

function buildTelegramMessageUrl(message: Record<string, any>) {
  const messageId = message.message_id;
  const chat = message.chat || {};
  if (!messageId || !chat) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const chatId = String(chat.id || '');
  if (chatId.startsWith('-100')) return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
  return null;
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

function sanitizeTelegramChat(chat: Record<string, any>) {
  return {
    id: chat.id || null,
    title: chat.title || null,
    username: chat.username || null,
    type: chat.type || null,
  };
}

async function createTelegramConnectCode(userId: string) {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const payload = base64UrlEncode(JSON.stringify({
    user_id: userId,
    nonce: crypto.randomUUID(),
    expires_at: expiresAt,
  }));
  const signature = await hmacSha256(payload, getTelegramConnectSecret());
  return {
    code: `${payload}.${signature}`,
    expires_at: expiresAt,
  };
}

async function verifyTelegramConnectCode(code: string) {
  const [payload, signature] = String(code || '').split('.');
  if (!payload || !signature) return null;
  const expected = await hmacSha256(payload, getTelegramConnectSecret());
  if (signature !== expected) return null;

  const decoded = JSON.parse(base64UrlDecode(payload));
  if (!decoded?.expires_at || new Date(decoded.expires_at).getTime() < Date.now()) return null;
  return decoded;
}

function getTelegramConnectSecret() {
  const secret = Deno.env.get('TELEGRAM_CONNECT_SECRET') || Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
  if (!secret) throw new Error('Missing TELEGRAM_CONNECT_SECRET or TELEGRAM_WEBHOOK_SECRET in Edge Function secrets.');
  return secret;
}

async function hmacSha256(payload: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return atob(padded);
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

function htmlResponse(title: string, message: string, success = false) {
  const accent = success ? '#16a34a' : '#dc2626';
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return new Response(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f3f6fb;
        color: #0f172a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(560px, calc(100vw - 32px));
        border: 1px solid #d8e1ee;
        border-radius: 24px;
        background: white;
        padding: 32px;
        box-shadow: 0 24px 80px rgba(15, 23, 42, 0.12);
        text-align: center;
      }
      .status {
        display: inline-grid;
        width: 52px;
        height: 52px;
        place-items: center;
        border-radius: 18px;
        background: ${success ? '#dcfce7' : '#fee2e2'};
        color: ${accent};
        font-size: 28px;
        font-weight: 900;
      }
      h1 { margin: 18px 0 10px; font-size: 28px; }
      p { margin: 0; color: #475569; line-height: 1.7; word-break: break-word; }
      a, button {
        display: inline-block;
        margin-top: 24px;
        border: 0;
        border-radius: 999px;
        background: #0f172a;
        color: white;
        cursor: pointer;
        font-weight: 800;
        padding: 12px 18px;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="status">${success ? '✓' : '!'}</div>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      <button onclick="window.close()">关闭窗口</button>
      <a href="https://jiang289140790-eng.github.io/ai-marketing-studio/">返回 AI Marketing Studio</a>
    </main>
  </body>
</html>`, {
    status: success ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
