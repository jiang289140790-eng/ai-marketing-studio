import { createPreparedAdapter } from './base-adapter';

export const instagramAdapter = createPreparedAdapter('Instagram', {
  auth_type: 'oauth2',
  required_config: ['INSTAGRAM_CLIENT_ID', 'INSTAGRAM_CLIENT_SECRET', 'INSTAGRAM_REDIRECT_URI'],
  supports_multi_account: true,
});
