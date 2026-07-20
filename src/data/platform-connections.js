const PLATFORM_FUNCTION_BASE = 'https://qtrlymiqohbjvklwegsw.supabase.co/functions/v1/platform';

function callback(platform) {
  return `${PLATFORM_FUNCTION_BASE}?platform=${encodeURIComponent(platform)}`;
}

export const platformConnectionCards = [
  {
    platform: 'X',
    title: 'X / Twitter',
    description: '通过 OAuth 连接自己的 X 账号。支持重复连接多个 X 账号，成功后自动写入账号矩阵。',
    priority: '已接入',
    authType: 'oauth2_pkce',
    connectMode: 'oauth',
    implemented: true,
    requiredSecrets: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REDIRECT_URI'],
    callbackUrl: callback('X'),
  },
  {
    platform: 'Telegram',
    title: 'Telegram',
    description: '使用 Bot / Channel 连接。每个 Channel 会保存为一条独立连接。',
    priority: '已接入',
    authType: 'bot',
    connectMode: 'settings',
    implemented: true,
    requiredSecrets: ['TELEGRAM_ADMIN_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
    callbackUrl: `${PLATFORM_FUNCTION_BASE}/telegram/webhook`,
  },
  {
    platform: 'Instagram',
    title: 'Instagram',
    description: '连接入口已建立，后续迁移旧系统成熟 OAuth 流程、发布和数据同步。',
    priority: '配置已预留',
    authType: 'oauth2',
    connectMode: 'prepared',
    implemented: false,
    requiredSecrets: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'INSTAGRAM_REDIRECT_URI'],
    callbackUrl: callback('Instagram'),
  },
  {
    platform: 'YouTube',
    title: 'YouTube',
    description: '连接入口已建立，后续接入频道授权、视频发布和表现数据同步。',
    priority: '配置已预留',
    authType: 'oauth2',
    connectMode: 'prepared',
    implemented: false,
    requiredSecrets: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'],
    callbackUrl: callback('YouTube'),
  },
  {
    platform: 'TikTok',
    title: 'TikTok',
    description: '连接入口已建立，后续接入 OAuth、发布接口和表现数据。',
    priority: '配置已预留',
    authType: 'oauth2',
    connectMode: 'prepared',
    implemented: false,
    requiredSecrets: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
    callbackUrl: callback('TikTok'),
  },
  {
    platform: 'Discord',
    title: 'Discord',
    description: '新增平台入口。后续可接入 Bot / OAuth，用于频道发布和社区运营。',
    priority: '配置已预留',
    authType: 'bot / oauth2',
    connectMode: 'prepared',
    implemented: false,
    requiredSecrets: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_REDIRECT_URI'],
    callbackUrl: callback('Discord'),
  },
];

export function getPlatformConnectionCard(platform) {
  return platformConnectionCards.find((card) => card.platform === platform);
}
