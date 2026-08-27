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

const QUICK_PROMPTS = [
  '读取当前项目状态，并告诉我下一步可以做什么',
  '搜索 X 和 Reddit 上本周热门的 AI 营销话题，选 3 条保存为 Evidence，并生成分析、Knowledge Card 和 pending-review Brief。允许本次付费采集和模型分析，允许结果写入 staging。',
  '分析我上传的图片或视频，保存 Evidence，执行一次多模态分析，并生成 Knowledge Card 和 pending-review Brief。',
  '根据当前项目最新 Brief，生成一张测试图片并保存成品。',
];

const BUSINESS_LINKS = [
  { id: 'research', label: '研究与 Brief' },
  { id: 'knowledge', label: '知识库' },
  { id: 'generation', label: '生成结果' },
  { id: 'assets', label: '素材库' },
  { id: 'characters', label: '角色库' },
  { id: 'publish', label: '发布中心' },
];

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
  const currentTaskId = thread?.currentTaskId || thread?.current_task_id || '';
  const busy = sending || ['executing', 'running', 'queued'].includes(String(thread?.status || '').toLowerCase());

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
      <section className="conversation-workspace">
        <header className="conversation-hero">
          <div>
            <p>AMS × DeepSeek Harness</p>
            <h1>今天想完成什么？</h1>
            <span>直接说目标。Harness 会选择已接入的 AMS 插件工具，结果沉淀到研究、知识、Brief 或成品页。</span>
          </div>
          <div className="conversation-status">
            <span className={`dot dot-${connection}`} />
            {activeProjectId ? `当前项目 ${activeProjectId.slice(0, 10)}…` : '未绑定项目'}
          </div>
        </header>

        <div className="quick-prompts" aria-label="常用任务">
          {QUICK_PROMPTS.map((prompt) => (
            <button type="button" key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>
          ))}
        </div>

        {error && <div className="conversation-error" role="alert">{error}</div>}

        <section className="conversation-transcript" data-testid="conversation-transcript" ref={transcriptRef}>
          {messages.length === 0 && !liveText ? (
            <div className="conversation-empty">
              <h2>只管说你想完成什么</h2>
              <p>不需要先选“研究 / 生成 / Brief”。Harness 会调用 AMS 插件，涉及付费或写入时再确认。</p>
            </div>
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
            placeholder="输入问题或任务；Enter 发送，Shift+Enter 换行"
            disabled={busy}
          />
          <div className="composer-actions">
            <input ref={fileInputRef} type="file" accept={ACCEPT} multiple hidden onChange={onFilesSelected} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>+ 附件</button>
            {busy && activeThreadId ? (
              <button type="button" className="composer-stop" onClick={stop}>停止</button>
            ) : (
              <button type="button" className="primary" data-testid="harness-submit" onClick={send} disabled={!draft.trim() || busy}>{sending ? '发送中…' : '发送'}</button>
            )}
          </div>
        </footer>
      </section>

      <aside className="official-business-dock" aria-label="AMS 业务结果入口">
        <strong>AMS 结果页</strong>
        <p>Harness 负责执行，AMS 只沉淀结果。</p>
        <div className="official-business-grid">
          {BUSINESS_LINKS.map((item) => (
            <button type="button" key={item.id} onClick={() => onNavigate?.(item.id)}>{item.label}</button>
          ))}
        </div>
        {currentTaskId && (
          <div className="conversation-toolbar">
            <button type="button" data-testid="ai-task-flow-execution" onClick={() => onNavigate?.('ai-execution', currentTaskId)}>执行详情</button>
            <button type="button" data-testid="ai-task-flow-results" onClick={() => onNavigate?.('ai-results', currentTaskId)}>结果与审核</button>
          </div>
        )}
      </aside>
    </main>
  );
}
