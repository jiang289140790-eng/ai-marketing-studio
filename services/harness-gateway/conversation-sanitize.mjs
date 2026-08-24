import { redactSensitive } from './harness-runner.mjs';

export function sanitizeConversationData(value, depth = 0, maxString = 32_000) {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSensitive(value).slice(0, maxString);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeConversationData(item, depth + 1, maxString));
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    clean[key] = /authorization|cookie|secret|token|api[-_]?key|credential/i.test(key)
      ? '[REDACTED]'
      : sanitizeConversationData(item, depth + 1, maxString);
  }
  return clean;
}
