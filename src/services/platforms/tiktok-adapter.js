import { createPreparedAdapter } from './base-adapter';

export const tiktokAdapter = createPreparedAdapter('TikTok', {
  auth_type: 'oauth2',
  required_config: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_REDIRECT_URI'],
  supports_multi_account: true,
});
