import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createHarnessClient,
  newHarnessRequestId,
  readHarnessActiveProject,
} from '../services/harness-client.js';
import './AIWorkspacePage.css';

const WORKSPACE_ID = String(import.meta.env.VITE_AMS_WORKSPACE_ID || 'ai-marketing-studio');
const ACTIVE_THREAD_KEY = 'ams_native_harness_thread_v2';
const ACCEPT = 'image/*,video/mp4,application/pdf,text/plain,text/markdown,text/csv,application/json';
const MAX_ATTACHMENTS = 8;
const TOOL_CALL_KIND = 'tool_call';
const TOOL_RESULT_KIND = 'tool_result';

function normalizeMessages(input) {
  const byId = new Map();
  for (const message of Array.isArray(input) ? input : []) {
    if (!message || typeof message.id !== 'string') continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function mergeMessages(current, incoming) {
  return normalizeMessages([...current, ...incoming]);
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content.trim();
  const payload = message?.structured_payload || message?.structuredPayload;
  if (payload?.summary) return String(payload.summary).trim();
  if (payload?.title) return String(payload.title).trim();
  return '';
}

function safeKind(message) {
  const kind = String(message?.kind || 'text').toLowerCase();
  if (['text', 'plan', TOOL_CALL_KIND, TOOL_RESULT_KIND, 'progress', 'evidence', 'analysis', 'knowledge', 'brief', 'artifact', 'error'].includes(kind)) return kind;
  return 'text';
}

function statusLabel(value) {
  const status = String(value || 'ready');
  return ({
    accepted: '已接收',
    completed: '已完成',
    failed: '失败',
    blocked: '已阻断',
    running: '执行中',
    queued: '排队中',
    ready: '就绪',
  })[status] || status;
}

function extractSummary(payload = {}) {
  const keys = ['title', 'summary', 'status', 'review_status', 'count', 'version', 'artifact_ref', 'source'];
  return keys
    .filter((key) => payload[key] != null && payload[key] !== '')
    .slice(0, 5)
    .map((key) => `${key}: ${typeof payload[key] === 'object' ? JSON.stringify(payload[key]).slice(0, 80) : String(payload[key]).slice(0, 120)}`);
}

function MessageCard({ message, onNavigate }) {
  const kind = safeKind(message);
  const payload = message.structured_payload || message.structuredPayload || {};
  const text = messageText(message);
  const taskId = message.task_id || message.taskId || payload.task_id || '';
  const isUser = message.role === 'user';

  if (kind === 'text') {
    return (
      <article className={`conversation-message ${isUser ? 'user' : 'assistant'}`} data-testid="conversation-message">
        <span className="message-avatar">{isUser ? '你' : 'AI'}</span>
        <div className="message-body">
          <strong>{isUser ? '你' : 'DeepSeek Harness'}</strong>
          <p>{text || '已收到结构化消息。'}</p>
        </div>
      </article>
    );
  }

  return (
    <article className={`conversation-card kind-${kind}`} data-kind={kind}>
      <header>
        <strong>{kind === TOOL_CALL_KIND ? '工具调用' : kind === TOOL_RESULT_KIND ? '工具结果' : kind}</strong>
        <span>{statusLabel(message.status)}</span>
      </header>
      {text && <p>{text}</p>}
      {extractSummary(payload).length > 0 && (
        <ul>
          {extractSummary(payload).map((item) => <li key={item}>{item}</li>)}
        </ul>
      )}
      {taskId && (
        <footer>
          <button type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>查看执行</button>
          <button type="button" onClick={() => onNavigate?.('ai-results', taskId)}>查看结果</button>
        </footer>
      )}
    </article>
  );
}

function localUserMessage({ content, clientMessageId }) {
  return {
    id: clientMessageId,
    sequence: Date.now(),
    role: 'user',
    kind: 'text',
    status: 'accepted',
    content,
  };
}

function threadIdFrom(response) {
  return response?.threadId || response?.thread_id || response?.thread?.id || '';
}

export function AIWorkspacePage({ onNavigate, routeParams, harnessClient: providedHarnessClient }) {
  const client = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState(routeParams?.intent || '');
  const [attachments, setAttachments] = useState([]);
  const [connection, setConnection] = useState('idle');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [liveText, setLiveText] = useState('');
  const activeProjectId = readHarnessActiveProject();
  const fileInputRef = useRef(null);
  const transcriptRef = useRef(null);
  const cursorRef = useRef(0);

  const activeThreadId = thread?.id || thread?.thread_id || '';
  const busy = sending || ['executing', 'running', 'queued'].includes(String(thread?.status || '').toLowerCase());
  const hasConversation = messages.length > 0 || liveText;

  const loadMessages = useCallback(async (threadId) => {
    if (!threadId) return;
    const response = await client.listMessages(threadId, 0, 200);
    setMessages((current) => mergeMessages(current, response.messages || []));
  }, [client]);

  const refreshThread = useCallback(async (threadId) => {
    if (!threadId) return null;
    const response = await client.getThread(threadId);
    const nextThread = {
      ...(response.thread || {}),
      id: response.thread?.id || threadId,
      currentTaskId: response.currentTaskId || response.thread?.currentTaskId || response.thread?.current_task_id || null,
      eventCursor: response.eventCursor || response.thread?.eventCursor || response.thread?.event_cursor || 0,
      actions: response.actions || response.thread?.actions || {},
    };
    setThread(nextThread);
    cursorRef.current = Math.max(cursorRef.current, Number(nextThread.eventCursor || 0));
    return nextThread;
  }, [client]);

  useEffect(() => {
    let alive = true;
    const restore = async () => {
      if (routeParams?.new) {
        globalThis.localStorage?.removeItem?.(ACTIVE_THREAD_KEY);
        return;
      }
      const threadId = globalThis.localStorage?.getItem?.(ACTIVE_THREAD_KEY);
      if (!threadId) return;
      try {
        setConnection('connecting');
        await refreshThread(threadId);
        await loadMessages(threadId);
        if (alive) setConnection('connected');
      } catch (caught) {
        globalThis.localStorage?.removeItem?.(ACTIVE_THREAD_KEY);
        if (alive) setError(caught?.message || '无法恢复会话，请新建一次任务。');
      }
    };
    restore();
    return () => { alive = false; };
  }, [loadMessages, refreshThread, routeParams?.new]);

  useEffect(() => {
    if (!activeThreadId || !client.streamThreadEvents) return undefined;
    const controller = new globalThis.AbortController();
    client.streamThreadEvents({
      threadId: activeThreadId,
      cursor: cursorRef.current,
      signal: controller.signal,
      onStatus: setConnection,
      onEvent: ({ type, event, cursor }) => {
        cursorRef.current = Math.max(cursorRef.current, Number(cursor || 0));
        const payload = event?.payload || {};
        if (type === 'assistant_text_delta') setLiveText((current) => `${current}${payload.delta || ''}`);
        if (type === 'assistant_text_completed') {
          setLiveText('');
          loadMessages(activeThreadId);
          refreshThread(activeThreadId);
        }
        if (['plan_created', 'task_progress', 'task_completed', 'task_failed', 'task_blocked'].includes(type)) {
          refreshThread(activeThreadId);
          loadMessages(activeThreadId);
        }
      },
    }).catch((caught) => {
      if (!controller.signal.aborted) setConnection(caught?.code === 'EVENT_STREAM_UNAVAILABLE' ? 'polling' : 'disconnected');
    });
    return () => controller.abort();
  }, [activeThreadId, client, loadMessages, refreshThread]);

  useEffect(() => {
    transcriptRef.current?.scrollTo?.({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, liveText]);

  async function ensureThread() {
    if (activeThreadId) return activeThreadId;
    const response = await client.createThread({
      workspaceId: WORKSPACE_ID,
      projectId: activeProjectId || null,
      requestId: newHarnessRequestId(),
      title: draft.slice(0, 80) || 'AI Marketing Studio',
    });
    const nextThreadId = threadIdFrom(response);
    if (!nextThreadId) throw new Error('Harness 没有返回会话 ID。');
    globalThis.localStorage?.setItem?.(ACTIVE_THREAD_KEY, nextThreadId);
    setThread({ id: nextThreadId, status: 'active', currentTaskId: response.currentTaskId || null });
    return nextThreadId;
  }

  async function uploadQueuedAttachments(threadId, requestId) {
    const refs = [];
    for (const file of attachments.slice(0, MAX_ATTACHMENTS)) {
      refs.push(await client.uploadAttachment({ threadId, requestId, file }));
    }
    return refs;
  }

  async function send() {
    const content = draft.trim();
    if (!content || busy) return;
    setError('');
    setSending(true);
    const requestId = newHarnessRequestId();
    const clientMessageId = newHarnessRequestId();
    try {
      const threadId = await ensureThread();
      const uploaded = await uploadQueuedAttachments(threadId, requestId);
      setMessages((current) => mergeMessages(current, [localUserMessage({ content, clientMessageId })]));
      setDraft('');
      setAttachments([]);
      const dispatch = client.sendAgentMessage || client.sendMessage;
      await dispatch.call(client, { threadId, requestId, clientMessageId, content, attachments: uploaded });
      await refreshThread(threadId);
      await loadMessages(threadId);
    } catch (caught) {
      setError(caught?.message || 'Harness 暂时无法执行这条任务。');
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!activeThreadId || !client.stopGeneration) return;
    await client.stopGeneration(activeThreadId).catch(() => null);
    await refreshThread(activeThreadId).catch(() => null);
  }

  function onKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  function onFilesSelected(event) {
    const next = Array.from(event.target.files || []).slice(0, MAX_ATTACHMENTS);
    setAttachments((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS));
    event.target.value = '';
  }

  return (
    <main className="ai-workspace harness-native-shell" data-testid="ai-official-harness-page">
      <section className={`conversation-workspace ${hasConversation ? 'has-conversation' : 'is-empty'}`}>
        <div className="native-harness-topbar" aria-label="Harness session controls">
          <button type="button" disabled>AI Marketing Studio</button>
          <button type="button" disabled>标准模式</button>
          <button type="button" disabled>DeepSeek</button>
          <span className={`dot dot-${connection}`} aria-label={connection} />
          <span className="project-chip">{activeProjectId ? `当前项目 ${activeProjectId.slice(0, 10)}…` : '未绑定项目'}</span>
        </div>

        {error && <div className="conversation-error" role="alert">{error}</div>}

        <section className="conversation-transcript" data-testid="conversation-transcript" ref={transcriptRef}>
          {!hasConversation ? (
            <div className="conversation-empty" aria-label="Harness native empty state" />
          ) : (
            messages.map((message) => <MessageCard key={message.id} message={message} onNavigate={onNavigate} />)
          )}
          {liveText && <MessageCard message={{ id: 'live', role: 'assistant', kind: 'text', content: liveText, status: 'running' }} />}
        </section>

        <footer className="conversation-composer">
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((file, index) => (
                <span key={`${file.name}-${index}`}>{file.name}<button type="button" onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>
              ))}
            </div>
          )}
          <textarea
            data-testid="harness-intent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="描述你想要构建的内容"
            disabled={busy}
          />
          <div className="composer-actions">
            <input ref={fileInputRef} type="file" accept={ACCEPT} multiple hidden onChange={onFilesSelected} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>+</button>
            {busy && activeThreadId ? (
              <button type="button" className="composer-stop" onClick={stop}>停止</button>
            ) : (
              <button type="button" className="primary" data-testid="harness-submit" onClick={send} disabled={!draft.trim() || busy}>{sending ? '发送中…' : '发送'}</button>
            )}
          </div>
        </footer>
      </section>
    </main>
  );
}
