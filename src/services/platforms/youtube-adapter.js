import { createPreparedAdapter } from './base-adapter';

export const youtubeAdapter = createPreparedAdapter('YouTube', {
  auth_type: 'oauth2',
  required_config: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REDIRECT_URI'],
  supports_multi_account: true,
});
