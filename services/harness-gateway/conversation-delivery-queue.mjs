/* global queueMicrotask, structuredClone */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sanitizeConversationData } from './conversation-sanitize.mjs';

function stableId(request) {
  return `gdl_${createHash('sha256').update(`${request.user_id}:${request.thread_id}:${request.request_id}`).digest('hex').slice(0, 32)}`;
}

function appendDurable(file, record) {
  if (!file) return;
  const fd = openSync(file, 'a', 0o600);
  try { appendFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
}

export function createConversationDeliveryQueue({ journalFile, runner, onEvent } = {}) {
  const records = new Map();
  const active = new Set();
  if (journalFile && existsSync(journalFile)) {
    for (const line of readFileSync(journalFile, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try { const row = JSON.parse(line); if (row?.delivery_id) records.set(row.delivery_id, row); } catch { /* torn tail */ }
    }
  }
  const emit = (record, type, payload = {}) => onEvent?.({
    event_id: `${record.delivery_id}:${type}:${payload.nativeSeq ?? 'terminal'}`,
    user_id: record.user_id, thread_id: record.request.thread_id,
    generation_id: record.request.generation_id, request_id: record.request.request_id,
    event_type: type, payload,
  });
  const persist = (record) => { records.set(record.delivery_id, structuredClone(record)); appendDurable(journalFile, record); };
  const process = async (record) => {
    record = records.get(record.delivery_id) || record;
    if (active.has(record.delivery_id) || record.state !== 'accepted') return;
    active.add(record.delivery_id);
    record = { ...record, state: 'running', updated_at: new Date().toISOString() }; persist(record);
    emit(record, 'generation_started');
    let assistantText = '';
    let assistantNativeSeq = null;
    let stopped = false;
    const result = await runner.run(record.request, record.user_id, { onFrame: (frame) => {
      if (frame.type === 'conversation_completed' && frame.reason?.kind === 'aborted') stopped = true;
      if (frame.type !== 'session_event') return;
      const event = frame.event;
      if (event?.type === 'assistant/chunk' && event.data?.chunk?.type === 'text-delta') {
        const delta = String(event.data.chunk.text || '');
        if (delta) { assistantText += delta; emit(record, 'assistant_text_delta', { delta, nativeSeq: event.seq }); }
      } else if (event?.type === 'assistant/message') {
        const content = (event.data?.message?.content || []).filter((x) => x?.type === 'text').map((x) => x.text).join('');
        if (content) assistantText = content;
        assistantNativeSeq = event.seq;
      } else if (event?.type === 'tool/call') emit(record, 'tool_call_started', { call: sanitizeConversationData(event.data, 0, 4_000), nativeSeq: event.seq });
      else if (event?.type === 'tool/result') emit(record, 'tool_call_completed', { result: sanitizeConversationData(event.data, 0, 4_000), nativeSeq: event.seq });
    } }).catch(() => ({ ok: false, code: 'HARNESS_CONVERSATION_FAILED' }));
    if (assistantText) emit(record, 'assistant_text_completed', { content: assistantText, nativeSeq: assistantNativeSeq });
    const terminal = stopped || result.code === 'GENERATION_STOPPED' ? 'generation_stopped' : result.ok ? 'generation_completed' : 'generation_failed';
    persist({ ...record, state: terminal === 'generation_completed' ? 'completed' : terminal === 'generation_stopped' ? 'stopped' : 'failed', result, updated_at: new Date().toISOString() });
    emit(record, terminal, result.ok ? {} : { code: result.code || 'GENERATION_FAILED' });
    active.delete(record.delivery_id);
  };
  const enqueue = (request, userId) => {
    const deliveryId = stableId({ ...request, user_id: userId });
    const existing = records.get(deliveryId);
    if (existing) return { ok: true, accepted: true, replayed: true, deliveryId, state: existing.state };
    const record = { delivery_id: deliveryId, user_id: userId, state: 'accepted', request: structuredClone(request), created_at: new Date().toISOString() };
    persist(record); queueMicrotask(() => void process(record));
    return { ok: true, accepted: true, replayed: false, deliveryId, state: 'accepted' };
  };
  for (const record of records.values()) {
    if (record.state === 'accepted') queueMicrotask(() => void process(record));
    else if (record.state === 'running') {
      emit(record, 'generation_failed', { code: 'GENERATION_RECOVERY_REQUIRED' });
      persist({ ...record, state: 'failed', result: { ok: false, code: 'GENERATION_RECOVERY_REQUIRED' }, updated_at: new Date().toISOString() });
    } else if (record.state === 'completed') emit(record, 'generation_completed', {});
    else if (record.state === 'stopped') emit(record, 'generation_stopped', { code: 'GENERATION_STOPPED' });
    else if (record.state === 'failed') emit(record, 'generation_failed', { code: record.result?.code || 'GENERATION_FAILED' });
  }
  const stop = (userId, threadId) => {
    const candidates = [...records.values()].filter((record) => record.user_id === userId && record.request.thread_id === threadId
      && ['accepted', 'running'].includes(record.state));
    const record = candidates.at(-1);
    if (!record) return { ok: false, code: 'NO_ACTIVE_GENERATION' };
    if (record.state === 'accepted') {
      persist({ ...record, state: 'stopped', result: { ok: false, code: 'GENERATION_STOPPED' }, updated_at: new Date().toISOString() });
      emit(record, 'generation_stopped', { code: 'GENERATION_STOPPED' });
      return { ok: true, deliveryId: record.delivery_id };
    }
    return runner.stop(userId, threadId);
  };
  return Object.freeze({ enqueue, stop, close: () => {}, status: () => ({ active: active.size, deliveries: records.size }) });
}
