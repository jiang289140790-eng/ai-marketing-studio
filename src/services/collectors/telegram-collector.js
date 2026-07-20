import { fetchWithSafeHeaders } from '../supabase-client';

const TELEGRAM_PUBLIC_BASE = 'https://t.me/s';

export function connect(source) {
  const channel = normalizeChannel(source.channel || source.username || source.account || source.url || source.name);
  if (!channel) {
    throw new Error('缺少 Telegram channel 或 username。');
  }

  return {
    channel,
    username: channel,
    url: `${TELEGRAM_PUBLIC_BASE}/${channel}`,
  };
}

export async function fetchMessages(source, options = {}) {
  const connection = connect(source);
  const limit = Number(options.limit || 20);
  const response = await fetchWithSafeHeaders(connection.url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Telegram 公开频道读取失败：HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseTelegramMessages(html, connection).slice(0, limit);
}

export function normalizeContent(messages, source) {
  return messages.map((message) => ({
    platform: 'Telegram',
    url: message.url,
    title: message.title,
    content_text: message.text,
    media_url: message.media_url,
    views: message.views,
    likes: 0,
    comments: 0,
    published_at: message.published_at,
    source_message_id: message.message_id,
    source_channel: source.channel || source.username || source.account || source.name,
  }));
}

function parseTelegramMessages(html, connection) {
  if (typeof globalThis.DOMParser !== 'undefined') {
    return parseWithDomParser(html, connection);
  }

  return parseWithRegex(html, connection);
}

function parseWithDomParser(html, connection) {
  const doc = new globalThis.DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('.tgme_widget_message')].map((node) => {
    const post = node.getAttribute('data-post') || '';
    const messageId = post.split('/').pop() || '';
    const text = cleanText(node.querySelector('.tgme_widget_message_text')?.textContent || '');
    const date = node.querySelector('time')?.getAttribute('datetime') || null;
    const views = parseViewCount(node.querySelector('.tgme_widget_message_views')?.textContent || '0');
    const photo = node.querySelector('.tgme_widget_message_photo_wrap')?.getAttribute('style') || '';

    return {
      message_id: messageId,
      url: `https://t.me/${post}`,
      title: makeTitle(text, connection.channel, messageId),
      text,
      media_url: extractBackgroundImage(photo),
      views,
      published_at: date,
    };
  }).filter((item) => item.message_id && (item.text || item.media_url));
}

function parseWithRegex(html, connection) {
  const blocks = html.split('<div class="tgme_widget_message').slice(1);
  return blocks.map((block) => {
    const post = readMatch(block, /data-post="([^"]+)"/);
    const messageId = post.split('/').pop();
    const textHtml = readMatch(block, /<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
    const date = readMatch(block, /<time[^>]*datetime="([^"]+)"/);
    const views = parseViewCount(readMatch(block, /tgme_widget_message_views[^>]*>([^<]+)</));
    const photo = readMatch(block, /background-image:url\('([^']+)'\)/);
    const text = cleanText(stripTags(textHtml));

    return {
      message_id: messageId,
      url: `https://t.me/${post}`,
      title: makeTitle(text, connection.channel, messageId),
      text,
      media_url: photo || null,
      views,
      published_at: date || null,
    };
  }).filter((item) => item.message_id && (item.text || item.media_url));
}

function normalizeChannel(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const match = raw.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]+)/);
  return (match?.[1] || raw.replace(/^@/, '')).replace(/[^A-Za-z0-9_]/g, '');
}

function makeTitle(text, channel, messageId) {
  const firstLine = text.split('\n').find(Boolean);
  if (firstLine) return firstLine.slice(0, 90);
  return `${channel} #${messageId}`;
}

function parseViewCount(value) {
  const clean = String(value || '0').trim().toUpperCase();
  const number = Number.parseFloat(clean.replace(/[^0-9.]/g, '')) || 0;
  if (clean.includes('K')) return Math.round(number * 1000);
  if (clean.includes('M')) return Math.round(number * 1000000);
  return Math.round(number);
}

function cleanText(value) {
  return decodeHtml(String(value || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
}

function stripTags(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractBackgroundImage(style) {
  return readMatch(style, /url\(['"]?([^'")]+)['"]?\)/) || null;
}

function readMatch(value, regex) {
  return String(value || '').match(regex)?.[1] || '';
}
