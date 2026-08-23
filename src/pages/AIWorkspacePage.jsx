import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient, newHarnessRequestId, readHarnessActiveProject } from '../services/harness-client.js';
import { parseHarnessContextParams } from '../utils/app-route.js';
import './AIWorkspacePage.css';

const ACTIVE_THREAD_KEY = 'ams_active_harness_thread_v1';
const WORKSPACE_ID = String(import.meta.env.VITE_AMS_WORKSPACE_ID || 'ai-marketing-studio-staging');
const ACCEPT = 'image/*,video/mp4,application/pdf,text/plain,text/markdown,text/csv,application/json';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const QUICK_PROMPTS = [
  '读取当前项目已有 Evidence 和 Knowledge，并告诉我可以完成什么',
  '总结当前项目最重要的营销洞察',
  '基于已有 Evidence 生成一份 Brief 计划',
  '检查当前任务的进度和阻断项',
  '告诉我下一步最值得执行的营销动作',
];

function messagePayload(message) {
  return message.structured_payload || message.structuredPayload || {};
}

function messageText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

function normalizeMessages(input) {
  const byId = new Map();
  for (const message of Array.isArray(input) ? input : []) {
    if (!message || typeof message.id !== 'string') continue;
    if ((message.kind || 'text') === 'text' && !messageText(message)) continue;
    byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => Number(left.sequence || 0) - Number(right.sequence || 0));
}

function reconcileMessages(current, incoming) {
  const authoritative = normalizeMessages(incoming);
  const acknowledgedClientIds = new Set(authoritative.map((message) => message.client_message_id || message.clientMessageId).filter(Boolean));
  const pending = normalizeMessages(current).filter((message) => message.status === 'accepted'
    && !authoritative.some((serverMessage) => serverMessage.id === message.id)
    && !acknowledgedClientIds.has(message.id));
  return normalizeMessages([...authoritative, ...pending]);
}

function MessageCard({ message, onNavigate, onCommand, canConfirm }) {
  const payload = messagePayload(message);
  const kind = message.kind || 'text';
  const taskId = message.task_id || message.taskId;
  if (kind === 'text') {
    return <article className={`conversation-message ${message.role === 'user' ? 'user' : 'assistant'}`} data-kind={kind} data-testid="conversation-message"><div>{messageText(message)}</div></article>;
  }
  const labels = {
    plan: '执行计划', tool_call: 'Tool Call', tool_result: '工具结果', approval: '等待确认',
    progress: '执行进度', evidence: 'Evidence', analysis: 'Analysis', knowledge: 'Knowledge', brief: 'Brief',
    artifact: 'Artifact', error: '错误',
  };
  return (
    <article className={`conversation-card kind-${kind}`} data-kind={kind}>
      <header><strong>{labels[kind] || kind}</strong><span>{message.status}</span></header>
      {message.content && <p>{message.content}</p>}
      {kind === 'plan' && Array.isArray(payload.steps) && <ol>{payload.steps.map((step, index) => <li key={step.step || index}><b>{step.label || step.title || `步骤 ${index + 1}`}</b><small>{step.operation || step.tool || ''}</small></li>)}</ol>}
      {kind === 'plan' && <div className="conversation-plan-risk"><span>费用风险：{payload.cost_indicators?.paid_calls > 0 ? `${payload.cost_indicators.paid_calls} 次付费调用` : '无付费调用'}</span><span>审批：{Object.values(payload.approvals || {}).some(Boolean) ? '需要确认' : '无需额外审批'}</span></div>}
      {kind === 'tool_call' && <details><summary>查看参数摘要</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>}
      {['tool_result', 'evidence', 'analysis', 'knowledge', 'brief', 'artifact'].includes(kind) && <details><summary>查看结构化结果</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details>}
      {taskId && <footer>{kind === 'plan' && canConfirm && <button type="button" className="primary" onClick={() => onCommand?.('执行')}>确认执行</button>}<button type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>查看执行详情</button><button type="button" onClick={() => onNavigate?.('ai-results', taskId)}>查看完整结果</button></footer>}
    </article>
  );
}

export function AIWorkspacePage({ onNavigate, routeParams, harnessClient: providedHarnessClient }) {
  const client = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const routeContext = useMemo(() => parseHarnessContextParams(routeParams), [routeParams]);
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState(routeContext.intent || '');
  const [attachments, setAttachments] = useState([]);
  const [connection, setConnection] = useState('idle');
  const [sending, setSending] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');
  const [eventCursor, setEventCursor] = useState(0);
  const [userNearBottom, setUserNearBottom] = useState(true);
  const transcriptRef = useRef(null);
  const fileInputRef = useRef(null);
  const cursorRef = useRef(0);

  const loadHistory = useCallback(async (threadId) => {
    const response = await client.listMessages(threadId, 0, 200);
    setMessages((current) => reconcileMessages(current, response.messages));
    return response;
  }, [client]);

  const refreshThread = useCallback(async (threadId) => {
    const response = await client.getThread(threadId);
    setThread({ ...response.thread, actions: response.actions || {}, currentTaskId: response.currentTaskId, eventCursor: response.eventCursor });
    return response;
  }, [client]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (routeParams?.new) globalThis.localStorage.removeItem(ACTIVE_THREAD_KEY);
      const threadId = routeParams?.new ? '' : globalThis.localStorage.getItem(ACTIVE_THREAD_KEY) || '';
      if (!threadId) return;
      setConnection('connecting');
      try {
        const response = await client.getThread(threadId);
        if (!active) return;
        setThread({ ...response.thread, actions: response.actions || {}, currentTaskId: response.currentTaskId, eventCursor: response.eventCursor });
        cursorRef.current = Number(response.eventCursor || 0);
        setEventCursor(cursorRef.current);
        await loadHistory(threadId);
        if (active) setConnection(response.thread?.status === 'failed' ? 'failed' : response.thread?.status === 'blocked' ? 'blocked' : 'connected');
      } catch (caught) {
        globalThis.localStorage.removeItem(ACTIVE_THREAD_KEY);
        if (active && caught?.code !== 'THREAD_NOT_FOUND') setError(caught?.message || '无法恢复会话。');
      }
    };
    restore();
    return () => { active = false; };
  }, [client, loadHistory, refreshThread, routeParams?.new]);

  useEffect(() => {
    if (!thread?.id) return undefined;
    const controller = new globalThis.AbortController();
    client.streamThreadEvents({
      threadId: thread.id, cursor: cursorRef.current, signal: controller.signal,
      onStatus: setConnection,
      onEvent: ({ type, event, cursor }) => {
        cursorRef.current = cursor;
        setEventCursor(cursor);
        const payload = event.payload || {};
        if (type === 'assistant_text_delta') setLiveText((current) => `${current}${payload.delta || ''}`);
        if (type === 'assistant_text_completed') { setLiveText(''); loadHistory(thread.id); refreshThread(thread.id); }
        if (type === 'plan_created') { setThread((current) => current && { ...current, status: 'waiting_confirmation', currentTaskId: event.task_id || current.currentTaskId }); refreshThread(thread.id); }
        if (type === 'task_progress') { setThread((current) => current && { ...current, status: 'executing', currentTaskId: event.task_id || current.currentTaskId }); refreshThread(thread.id); }
        if (type === 'generation_stopped') { setLiveText(''); setConnection('connected'); refreshThread(thread.id); loadHistory(thread.id); }
        if (type === 'error' || type === 'task_failed') { setLiveText(''); setConnection('failed'); setError(payload.message || 'AI 回复失败，请重试失败步骤。'); refreshThread(thread.id); }
        if (type === 'task_blocked') { setLiveText(''); setConnection('blocked'); refreshThread(thread.id); }
        if (['task_completed', 'task_partial', 'task_cancelled'].includes(type)) refreshThread(thread.id);
        if (['plan_created', 'tool_call_started', 'tool_call_completed', 'approval_requested', 'task_progress', 'task_completed', 'task_partial', 'task_failed', 'task_blocked', 'task_cancelled', 'evidence_result', 'analysis_result', 'knowledge_result', 'brief_result', 'artifact_result', 'error'].includes(type)) loadHistory(thread.id);
      },
    }).catch((caught) => {
      if (!controller.signal.aborted) { setConnection('disconnected'); setError(caught?.message || '事件连接已中断，可重新连接。'); }
    });
    return () => controller.abort();
  }, [client, loadHistory, refreshThread, thread?.id]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node && userNearBottom) node.scrollTop = node.scrollHeight;
  }, [messages, liveText, sending, userNearBottom]);

  useEffect(() => {
    globalThis.document?.querySelector('.main-shell')?.scrollTo?.({ top: 0 });
  }, []);

  async function ensureThread(requestId) {
    if (thread?.id) return thread;
    const response = await client.createThread({ workspaceId: WORKSPACE_ID, projectId: readHarnessActiveProject(), requestId: `${requestId}:thread`, title: draft.slice(0, 80) || null });
    const next = { id: response.threadId, actions: { sendMessage: true, stopGeneration: false }, currentTaskId: response.currentTaskId, eventCursor: response.eventCursor, status: 'active' };
    globalThis.localStorage.setItem(ACTIVE_THREAD_KEY, next.id);
    setThread(next);
    return next;
  }

  async function send(overrideContent = '') {
    const content = String(overrideContent || draft).trim();
    if (!content || sending || thread?.actions?.stopGeneration === true || thread?.actions?.sendMessage === false) return;
    const requestId = newHarnessRequestId();
    const clientMessageId = newHarnessRequestId();
    const optimistic = { id: clientMessageId, role: 'user', kind: 'text', status: 'accepted', content, sequence: Number.MAX_SAFE_INTEGER };
    setMessages((current) => [...current, optimistic]);
    setDraft('');
    setSending(true);
    setError('');
    try {
      const currentThread = await ensureThread(requestId);
      const uploaded = [];
      for (const attachment of attachments) uploaded.push(await client.uploadAttachment({ threadId: currentThread.id, requestId, file: attachment.file }));
      await client.sendMessage({ threadId: currentThread.id, requestId, content, attachments: uploaded, clientMessageId });
      await refreshThread(currentThread.id);
      setAttachments([]);
      await loadHistory(currentThread.id);
    } catch (caught) {
      setMessages((current) => current.map((message) => message.id === clientMessageId ? { ...message, status: 'failed' } : message));
      setDraft(content);
      setError(caught?.message || '消息发送失败。');
    } finally { setSending(false); }
  }

  function onComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  }

  function selectFiles(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const accepted = files.filter((file) => file.size > 0 && file.size <= MAX_ATTACHMENT_BYTES).slice(0, MAX_ATTACHMENTS - attachments.length);
    setAttachments((current) => [...current, ...accepted.map((file) => ({ id: `${file.name}-${file.lastModified}-${file.size}`, file }))]);
    if (accepted.length !== files.length) setError(`最多 ${MAX_ATTACHMENTS} 个附件，单个不超过 25 MB。`);
  }

  const currentTaskId = thread?.currentTaskId || messages.findLast((message) => message.task_id)?.task_id || null;
  const generationActive = thread?.actions?.stopGeneration === true;
  const connectionLabel = {
    connected: generationActive ? '正在思考' : '已连接', connecting: '正在连接', disconnected: '正在重连',
    failed: '执行失败', blocked: '任务被阻断', idle: '等待开始', stopping: '正在停止',
  }[connection] || '等待开始';
  return (
    <main className="ai-workspace conversation-page" data-testid="harness-ai-workspace">
      <section className="conversation-heading">
        <div><span>AMS × DeepSeek Harness</span><h1>今天想完成什么？</h1><p>问答、计划、执行进度和结果都保留在同一个会话中。</p></div>
        <div className={`conversation-connection ${connection}`}><i />{connectionLabel}</div>
      </section>

      <nav className="ai-task-flow" aria-label="三页任务流程" data-testid="ai-task-flow">
        <button className="active" type="button" data-testid="ai-task-flow-home"><b>1</b><span><strong>对话工作区</strong><small>问答、计划和摘要</small></span></button>
        <button type="button" data-testid="ai-task-flow-execution" disabled={!currentTaskId} onClick={() => onNavigate?.('ai-execution', currentTaskId)}><b>2</b><span><strong>执行详情</strong><small>步骤、工具与错误</small></span></button>
        <button type="button" data-testid="ai-task-flow-results" disabled={!currentTaskId} onClick={() => onNavigate?.('ai-results', currentTaskId)}><b>3</b><span><strong>结果与审核</strong><small>Evidence、Brief 与成品</small></span></button>
      </nav>

      <section className={`conversation-workspace ${messages.length === 0 && !liveText ? 'is-empty' : 'has-conversation'}`} data-testid="conversation-workspace">
        <div className="conversation-transcript" ref={transcriptRef} aria-live="polite" data-testid="conversation-transcript" onScroll={(event) => { const node = event.currentTarget; setUserNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
          {messages.length === 0 && !liveText ? <div className="conversation-empty"><h2>今天想完成什么？</h2><p>直接提问，或描述一个需要执行的营销任务。</p><div className="conversation-quick-prompts" aria-label="快捷任务">{QUICK_PROMPTS.map((prompt) => <button type="button" key={prompt} onClick={() => setDraft(prompt)}>{prompt}</button>)}</div></div> : messages.map((message) => <MessageCard key={message.id} message={message} onNavigate={onNavigate} onCommand={send} canConfirm={thread?.status === 'waiting_confirmation' && (message.task_id || message.taskId) === currentTaskId} />)}
          {liveText && <article className="conversation-message assistant streaming"><div>{liveText}<span className="stream-caret" /></div></article>}
          {sending && !liveText && <div className="conversation-thinking"><i /><span>正在思考…</span></div>}
        </div>

        {attachments.length > 0 && <div className="conversation-attachments">{attachments.map((attachment) => <span key={attachment.id}>{attachment.file.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button></span>)}</div>}
        <div className="conversation-composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="输入问题或任务；Enter 发送，Shift+Enter 换行" rows={2} data-testid="harness-intent" />
          <div>
            <input ref={fileInputRef} className="sr-only" type="file" multiple accept={ACCEPT} onChange={selectFiles} />
            <button type="button" className="composer-attach" onClick={() => fileInputRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}>＋ 附件</button>
            <span>消息和事件由服务端保存，刷新后自动恢复。</span>
            {generationActive ? <button type="button" className="composer-stop" onClick={async () => { setConnection('stopping'); setError(''); try { await client.stopGeneration(thread.id); await refreshThread(thread.id); } catch (caught) { setConnection('failed'); setError(caught.message); } }}>停止</button> : <button type="button" className="composer-send" onClick={() => send()} disabled={!draft.trim() || sending || thread?.actions?.sendMessage === false} data-testid="harness-submit">发送</button>}
          </div>
        </div>
      </section>
      {error && <div className="notice error" role="alert">{error}<button type="button" onClick={async () => { if (!thread?.id) return; setConnection('connecting'); setError(''); try { await Promise.all([loadHistory(thread.id), refreshThread(thread.id)]); setConnection('connected'); } catch (caught) { setConnection('failed'); setError(caught.message); } }}>重新连接</button></div>}
      {thread?.id && <details className="ai-technical-details"><summary>技术详情</summary><dl><div><dt>thread_id</dt><dd><code>{thread.id}</code></dd></div>{currentTaskId && <div><dt>task_id</dt><dd><code>{currentTaskId}</code></dd></div>}<div><dt>event_cursor</dt><dd>{eventCursor}</dd></div></dl></details>}
    </main>
  );
}
