import { createPreparedAdapter } from './base-adapter';

export const discordAdapter = createPreparedAdapter('Discord', {
  auth_type: 'bot / oauth2',
  required_config: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_REDIRECT_URI'],
  supports_multi_account: true,
});
