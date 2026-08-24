/* global clearTimeout, setTimeout, structuredClone */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolveHarnessLaunch, redactSensitive } from './harness-runner.mjs';
import { sanitizeConversationData } from './conversation-sanitize.mjs';

const MAX_LINE = 256 * 1024;
const MAX_STDERR = 4 * 1024;
const ATTACHMENT_REF = /^harness-thread-attachments:[0-9a-f-]{36}\/thr_[0-9a-f-]{36}\/[A-Za-z0-9._:-]{1,200}\/[A-Za-z0-9._-]{1,120}$/i;
const ATTACHMENT_MIME = /^(?:image\/(?:png|jpeg|webp|gif)|video\/mp4|application\/(?:pdf|json)|text\/(?:plain|markdown|csv))(?:;[A-Za-z0-9=._ -]{1,80})?$/i;

function validAttachment(item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).every((key) => ['ref', 'name', 'size', 'mime_type'].includes(key))
    && ATTACHMENT_REF.test(String(item.ref || ''))
    && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 200
    && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 25 * 1024 * 1024
    && ATTACHMENT_MIME.test(String(item.mime_type || ''));
}

function validateRequest(request) {
  if (!request || request.schema_version !== 1
    || !/^thr_[0-9a-f-]{36}$/.test(String(request.thread_id || ''))
    || !/^session-[0-9a-f-]{36}$/.test(String(request.native_session_id || ''))
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(request.request_id || ''))
    || request.workspace_id !== 'ai-marketing-studio-staging'
    || typeof request.content !== 'string' || !request.content.trim()
    || request.content.length > 32_000
    || !Array.isArray(request.attachments ?? [])
    || (request.attachments ?? []).length > 10
    || (request.attachments ?? []).some((item) => !validAttachment(item))) {
    throw Object.assign(new Error('Invalid conversation request.'), { code: 'CONVERSATION_REQUEST_INVALID' });
  }
}

export function createConversationRunner({ executable, profileArgs, workspace = process.env.HARNESS_WORKSPACE || '/workspace', timeoutMs = 600_000, journalFile = process.env.HARNESS_CONVERSATION_JOURNAL || '', capabilityManifest = null } = {}) {
  const defaults = resolveHarnessLaunch(executable);
  executable = defaults.executable;
  profileArgs ||= defaults.profileArgs;
  const active = new Map();
  const journal = new Map();

  if (journalFile && existsSync(journalFile)) {
    for (const line of readFileSync(journalFile, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (!record?.key || !record?.state) continue;
        const current = journal.get(record.key) || { state: null, frames: [], result: null };
        if (record.state === 'started') current.state = 'started';
        if (record.state === 'frame' && record.frame) current.frames.push(record.frame);
        if (record.state === 'completed') { current.state = 'completed'; current.result = record.result; }
        journal.set(record.key, current);
      } catch { /* ignore a torn final journal line */ }
    }
  }

  const persist = (record) => {
    if (journalFile) appendFileSync(journalFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  };

  function key(userId, threadId) { return `${userId}:${threadId}`; }

  async function run(request, userId, { onFrame } = {}) {
    validateRequest(request);
    const activeKey = key(userId, request.thread_id);
    const requestKey = `${activeKey}:${request.request_id}`;
    const recovered = journal.get(requestKey);
    if (recovered?.state === 'completed') {
      for (const frame of recovered.frames) onFrame?.(structuredClone(frame));
      return { ...structuredClone(recovered.result), replayed: true };
    }
    if (recovered?.state === 'started') return { ok: false, code: 'GENERATION_RECOVERY_REQUIRED', replayed: true };
    if (active.has(activeKey)) return { ok: false, code: 'GENERATION_ALREADY_ACTIVE' };
    const generationId = `gen_${randomUUID()}`;
    const attachmentManifest = (request.attachments || []).map((item) => ({ ref: item.ref, name: item.name, size: item.size, mime_type: item.mime_type }));
    const envelope = JSON.stringify({
      schemaVersion: 1,
      sessionId: request.native_session_id,
      content: attachmentManifest.length
        ? `${request.content.trim()}\n\n[Authenticated private attachment manifest; metadata only, do not claim file-content understanding]\n${JSON.stringify(attachmentManifest)}`
        : request.content.trim(),
    });
    const env = {
      PATH: process.env.PATH || '',
      HOME: process.env.HARNESS_HOME || '/data/harness',
      DSH_HOME: process.env.HARNESS_HOME || '/data/harness',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '',
      AMS_USER_ID: userId,
      AMS_CONVERSATION_MODE: 'qa',
      AMS_CAPABILITY_MANIFEST: JSON.stringify(capabilityManifest || []),
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
    };
    const journalEntry = { state: 'started', frames: [], result: null };
    journal.set(requestKey, journalEntry);
    persist({ key: requestKey, state: 'started' });
    const child = spawn(executable, [...profileArgs, envelope], { cwd: workspace, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const force = { timer: null };
    const terminate = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      try { child.stdin.write(`${JSON.stringify({ action: 'stop' })}\n`); } catch { child.kill('SIGTERM'); return; }
      if (!force.timer) force.timer = setTimeout(() => child.kill('SIGTERM'), 7_000);
    };
    active.set(activeKey, { child, generationId, requestId: request.request_id, terminate });
    onFrame?.({ type: 'generation_started', generationId, requestId: request.request_id });
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    let terminalFrame = null;
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_LINE) {
        child.kill('SIGTERM');
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const frame = sanitizeConversationData(JSON.parse(line));
          if (terminalFrame) continue;
          journalEntry.frames.push(frame);
          persist({ key: requestKey, state: 'frame', frame });
          onFrame?.(frame);
          if (frame.type === 'conversation_completed') {
            terminalFrame = frame;
            // The native completion frame is authoritative. Some Harness
            // profiles keep background handles alive after the turn has been
            // flushed, so waiting for a natural process exit would leave the
            // HTTP stream and generation lease open indefinitely.
            if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
          }
        } catch { child.kill('SIGTERM'); }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR); });

    return await new Promise((resolve) => {
      child.once('error', () => {
        clearTimeout(timer); if (force.timer) clearTimeout(force.timer); active.delete(activeKey);
        const result = { ok: false, code: 'HARNESS_SPAWN_FAILED', generationId };
        journalEntry.state = 'completed'; journalEntry.result = result;
        persist({ key: requestKey, state: 'completed', result });
        resolve(result);
      });
      child.once('exit', (code) => {
        clearTimeout(timer); if (force.timer) clearTimeout(force.timer); active.delete(activeKey);
        const terminalKind = terminalFrame?.reason?.kind;
        const terminalSucceeded = ['completed', 'aborted'].includes(terminalKind);
        const result = terminalSucceeded || (!terminalFrame && code === 0) ? { ok: true, generationId } : {
          ok: false,
          code: timedOut ? 'HARNESS_TIMEOUT' : terminalFrame ? 'HARNESS_CONVERSATION_FAILED' : 'HARNESS_EXIT_FAILED',
          generationId,
          diagnostic: redactSensitive(stderr).slice(0, 240),
        };
        journalEntry.state = 'completed'; journalEntry.result = result;
        persist({ key: requestKey, state: 'completed', result });
        resolve(result);
      });
    });
  }

  function stop(userId, threadId) {
    const current = active.get(key(userId, threadId));
    if (!current) return { ok: false, code: 'NO_ACTIVE_GENERATION' };
    current.terminate();
    return { ok: true, generationId: current.generationId };
  }

  return Object.freeze({ run, stop, hasActive: (userId, threadId) => active.has(key(userId, threadId)) });
}
