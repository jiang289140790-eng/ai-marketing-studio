import { adapterResult, createPreparedAdapter } from './base-adapter';

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
  publish: async ({ content }) => adapterResult({
    success: false,
    platform: 'X',
    error: 'X 发布接口已设计，但尚未配置真实 X Developer App、OAuth token 和写入权限。',
    raw: {
      endpoint: 'POST /2/tweets',
      auth: 'OAuth 2.0 user context',
      required_scopes: ['tweet.write', 'tweet.read', 'users.read', 'offline.access'],
      content_preview: {
        title: content?.title || '',
        text: content?.content_text || '',
        media_url: content?.media_url || '',
      },
      credential_location: 'Supabase Edge Function secrets + platform_credentials; never frontend.',
    },
  }),
};
