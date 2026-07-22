import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function verifyGatewaySignature({ body, signature, secret }) {
  if (!secret) return false;
  if (!signature?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message
    .replace(/(sk|hf|gho|ghp|xoxb|xoxp|Bearer)\S+/gi, '$1_REDACTED')
    .replace(/[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/g, 'TELEGRAM_TOKEN_REDACTED')
    .slice(0, 1000);
}
