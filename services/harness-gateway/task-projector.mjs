/* global AbortSignal, URL, clearTimeout, fetch, setTimeout, structuredClone */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { signRequest } from './gateway-core.mjs';

const CALLBACK_PATH = '/functions/v1/harness-command/internal/task-events';

function eventKey(event) {
  if (typeof event.event_id === 'string' && event.event_id.length >= 16) return event.event_id;
  return `legacy:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
}

export function createTaskProjector({ callbackBase, secret, ackFile, fetchImpl = fetch, retryMs = 2_000 } = {}) {
  const pending = new Map();
  const acknowledged = new Set();
  const bindings = new Map();
  let timer = null;
  let draining = false;
  if (ackFile && existsSync(ackFile)) {
    for (const line of readFileSync(ackFile, 'utf8').split(/\r?\n/)) if (line) acknowledged.add(line);
  }

  const schedule = (delay = 0) => {
    if (timer || draining || pending.size === 0) return;
    timer = setTimeout(() => { timer = null; void drain(); }, delay);
    timer.unref?.();
  };

  const acknowledge = (key) => {
    acknowledged.add(key);
    if (ackFile) appendFileSync(ackFile, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const [key, event] of pending) {
        const binding = bindings.get(event.task_id) || null;
        const rawBody = JSON.stringify({ schema_version: 1, binding, event });
        const timestamp = String(Date.now());
        const userId = event.user_id;
        const signature = signRequest(secret, { method: 'POST', path: CALLBACK_PATH, userId, timestamp, rawBody });
        try {
          const response = await fetchImpl(new URL(CALLBACK_PATH, `${callbackBase.replace(/\/$/, '')}/`), {
            method: 'POST', redirect: 'error', body: rawBody,
            headers: { 'content-type': 'application/json', 'x-ams-user-id': userId, 'x-ams-timestamp': timestamp, 'x-ams-signature': signature },
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) {
            const payload = await response.json?.().catch(() => null);
            if (response.status === 409 && ['THREAD_NOT_BOUND', 'PROJECTION_BINDING_INVALID'].includes(payload?.code)) {
              pending.delete(key);
              acknowledge(key);
              continue;
            }
            break;
          }
          pending.delete(key);
          acknowledge(key);
        } catch { break; }
      }
    } finally {
      draining = false;
      schedule(retryMs);
    }
  };

  const enqueue = (event) => {
    if (!event?.task_id || !event?.at || !event?.user_id || !event?.task) return false;
    const key = eventKey(event);
    if (acknowledged.has(key) || pending.has(key)) return false;
    pending.set(key, structuredClone(event));
    schedule();
    return true;
  };

  const bindTask = (taskId, binding) => {
    const normalized = {
      user_id: String(binding?.user_id || ''),
      thread_id: String(binding?.thread_id || ''),
      task_id: String(taskId || ''),
      project_id: binding?.project_id == null ? null : String(binding.project_id),
    };
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    if (!new RegExp(`^ht-${uuid}$`).test(normalized.task_id)
      || !new RegExp(`^${uuid}$`).test(normalized.user_id)
      || !new RegExp(`^thr_${uuid}$`).test(normalized.thread_id)
      || (normalized.project_id !== null && !/^prj-[0-9a-f]{24}$/.test(normalized.project_id))) return false;
    const existing = bindings.get(normalized.task_id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) return false;
    bindings.set(normalized.task_id, Object.freeze(normalized));
    schedule();
    return true;
  };

  const close = () => { if (timer) clearTimeout(timer); timer = null; };
  return Object.freeze({ enqueue, bindTask, drain, close, pendingCount: () => pending.size });
}
