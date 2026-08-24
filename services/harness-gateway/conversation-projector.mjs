/* global AbortSignal, URL, clearTimeout, fetch, setTimeout, structuredClone */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { signRequest } from './gateway-core.mjs';

const CALLBACK_PATH = '/functions/v1/harness-command/internal/generation-events';

export function createConversationProjector({ callbackBase, secret, ackFile, fetchImpl = fetch, retryMs = 2_000 } = {}) {
  const pending = new Map();
  const acknowledged = new Set(existsSync(ackFile || '') ? readFileSync(ackFile, 'utf8').split(/\r?\n/).filter(Boolean) : []);
  let timer = null;
  let draining = false;
  const schedule = (delay = 0) => {
    if (timer || draining || pending.size === 0) return;
    timer = setTimeout(() => { timer = null; void drain(); }, delay); timer.unref?.();
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const [key, event] of pending) {
        const rawBody = JSON.stringify({ schema_version: 1, event });
        const timestamp = String(Date.now());
        const signature = signRequest(secret, { method: 'POST', path: CALLBACK_PATH, userId: event.user_id, timestamp, rawBody });
        try {
          const response = await fetchImpl(new URL(CALLBACK_PATH, `${callbackBase.replace(/\/$/, '')}/`), {
            method: 'POST', redirect: 'error', body: rawBody,
            headers: { 'content-type': 'application/json', 'x-ams-user-id': event.user_id, 'x-ams-timestamp': timestamp, 'x-ams-signature': signature },
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) break;
          pending.delete(key); acknowledged.add(key);
          if (ackFile) appendFileSync(ackFile, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
        } catch { break; }
      }
    } finally { draining = false; schedule(retryMs); }
  };
  const enqueue = (event) => {
    if (!event?.event_id || !event?.user_id || !event?.thread_id || !event?.generation_id || !event?.request_id) return false;
    if (acknowledged.has(event.event_id) || pending.has(event.event_id)) return false;
    pending.set(event.event_id, structuredClone(event)); schedule(); return true;
  };
  return Object.freeze({ enqueue, drain, close: () => { if (timer) clearTimeout(timer); timer = null; }, pendingCount: () => pending.size });
}
