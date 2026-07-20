import { instagramAdapter } from './instagram-adapter';
import { telegramAdapter } from './telegram-adapter';
import { tiktokAdapter } from './tiktok-adapter';
import { xAdapter } from './x-adapter';
import { youtubeAdapter } from './youtube-adapter';

export const platformAdapterMethods = [
  'connect',
  'disconnect',
  'reconnect',
  'status',
  'getAccount',
  'fetchContent',
  'publish',
  'getMetrics',
];

export const platformAdapters = {
  Telegram: telegramAdapter,
  X: xAdapter,
  Instagram: instagramAdapter,
  TikTok: tiktokAdapter,
  YouTube: youtubeAdapter,
};

export function getPlatformAdapter(platform) {
  const adapter = platformAdapters[platform];
  if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
  return adapter;
}
