import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient, HARNESS_ACTIVE_PROJECT_KEY, HARNESS_APPROVAL_SCOPES, newHarnessRequestId, readHarnessActiveProject } from '../services/harness-client.js';
import { createP20OnlineStore } from '../services/p20-online-store.js';
import { HARNESS_CAPABILITY_MAP } from '../services/harness-capability-map.js';
import { parseHarnessContextParams } from '../utils/app-route.js';
import './AIWorkspacePage.css';

const ACTIVE_THREAD_KEY = 'ams_active_harness_thread_v1';
const ACTIVE_AGENT_THREAD_KEY = 'ams_active_harness_agent_thread_v1';
const WORKSPACE_ID = String(import.meta.env.VITE_AMS_WORKSPACE_ID || 'ai-marketing-studio-staging');
const ACCEPT = 'image/*,video/mp4,application/pdf,text/plain,text/markdown,text/csv,application/json';
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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

function readableLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// 计划步骤只向用户展示能力级说法（“搜索 X 热门主题”），原始操作标识
// 属于执行器术语，保留在 title 提示里，不占默认正文。
function capabilityLabelFor(operation) {
  const id = String(operation || '').split('.').pop();
  const match = HARNESS_CAPABILITY_MAP.find((capability) => capability.id === id);
  return match ? match.label : '自动执行步骤';
}

function summarizeValue(value) {
  if (value == null || value === '') return '未提供';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === 'object') return `${Object.keys(value).length} 个字段`;
  return String(value);
}

const VISIBLE_PAYLOAD_FIELDS = Object.freeze({
  tool_call: ['tool', 'name', 'operation', 'summary', 'status'],
  tool_result: ['tool', 'name', 'operation', 'status', 'count', 'duration_ms', 'summary'],
  evidence: ['title', 'source', 'source_name', 'count', 'status', 'summary'],
  analysis: ['title', 'count', 'status', 'summary', 'version'],
  knowledge: ['title', 'count', 'status', 'summary', 'version'],
  brief: ['title', 'review_status', 'status', 'version', 'summary'],
  artifact: ['title', 'name', 'type', 'status', 'count', 'version'],
  progress: ['completed_steps', 'total_steps', 'status', 'summary'],
});

const APPROVAL_LABELS = Object.freeze({
  paid_external_calls: '允许本计划中的付费外部调用',
  online_writes: '允许本计划写入 staging',
  handoff_creation: '允许创建交接包',
});

function StructuredSummary({ payload, kind, limit = 6 }) {
  const allowed = new Set(VISIBLE_PAYLOAD_FIELDS[kind] || []);
  const entries = Object.entries(payload || {})
    .filter(([key, value]) => allowed.has(key) && value != null && value !== '')
    .slice(0, limit);
  if (!entries.length) return <p className="conversation-empty-result">暂时没有可展示的数据。</p>;
  return <dl className="conversation-summary-grid">{entries.map(([key, value]) => <div key={key}><dt>{readableLabel(key)}</dt><dd>{summarizeValue(value)}</dd></div>)}</dl>;
}

function isSerializedPayload(value) {
  const text = String(value || '').trim();
  if (!text || !['{', '['].includes(text[0])) return false;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function MessageIcon({ role, kind }) {
  if (role === 'user') return <span className="message-avatar user" aria-hidden="true">你</span>;
  const glyphs = { plan: '☷', tool_call: '⌘', tool_result: '✓', approval: '!', progress: '↻', evidence: 'E', analysis: 'A', knowledge: 'K', brief: 'B', artifact: '◆', error: '!' };
  return <span className={`message-avatar assistant kind-${kind}`} aria-hidden="true">{glyphs[kind] || 'AI'}</span>;
}

function MessageCard({ message, onNavigate, onConfirm, canConfirm, currentTaskId, confirming }) {
  const payload = messagePayload(message);
  const kind = message.kind || 'text';
  const messageTaskId = message.task_id || message.taskId;
  const taskId = messageTaskId && messageTaskId === currentTaskId ? currentTaskId : null;
  const safeContent = !isSerializedPayload(message.content) ? message.content : '';
  const requiredApprovals = HARNESS_APPROVAL_SCOPES.filter((scope) => payload.approvals?.[scope] === true);
  const [approval, setApproval] = useState(() => Object.fromEntries(HARNESS_APPROVAL_SCOPES.map((scope) => [scope, false])));
  const exactApprovalReady = requiredApprovals.every((scope) => approval[scope] === true);
  if (kind === 'text') {
    const content = messageText(message);
    const displayText = message.role === 'user' || !isSerializedPayload(content) ? content : '结构化响应已由安全视图收起。';
    return <article className={`conversation-message ${message.role === 'user' ? 'user' : 'assistant'}`} data-kind={kind} data-testid="conversation-message"><MessageIcon role={message.role} kind={kind} /><div className="message-body"><span className="message-author">{message.role === 'user' ? '你' : 'DeepSeek Harness'}</span><div>{displayText}</div></div></article>;
  }
  const labels = {
    plan: '执行计划', tool_call: '准备执行', tool_result: '执行结果', approval: '等待确认',
    progress: '执行进度', evidence: 'Evidence', analysis: 'Analysis', knowledge: 'Knowledge', brief: 'Brief',
    artifact: 'Artifact', error: '错误',
  };
  return (
    <article className={`conversation-card kind-${kind}`} data-kind={kind}>
      <MessageIcon role={message.role} kind={kind} />
      <div className="conversation-card-body">
      <header><strong>{labels[kind] || readableLabel(kind)}</strong><span className={`message-status status-${message.status || 'ready'}`}>{message.status || 'ready'}</span></header>
      {safeContent && <p>{safeContent}</p>}
      {kind === 'plan' && Array.isArray(payload.steps) && <ol className="conversation-plan-steps">{payload.steps.map((step, index) => <li key={step.step || index}><span>{index + 1}</span><div><b>{step.label || step.title || `步骤 ${index + 1}`}</b><small title={step.operation || ''}>{capabilityLabelFor(step.operation)}</small></div></li>)}</ol>}
      {kind === 'plan' && <div className="conversation-plan-risk"><span>费用风险：{payload.cost_indicators?.paid_calls > 0 ? `${payload.cost_indicators.paid_calls} 次付费调用` : '无付费调用'}</span><span>在线写入：{payload.cost_indicators?.online_writes > 0 ? `${payload.cost_indicators.online_writes} 步` : '无'}</span></div>}
      {kind === 'plan' && canConfirm && <fieldset className="conversation-approval-scopes"><legend>逐项确认本计划</legend>{HARNESS_APPROVAL_SCOPES.map((scope) => <label key={scope}><input type="checkbox" checked={approval[scope]} disabled={!requiredApprovals.includes(scope) || confirming} onChange={(event) => setApproval((current) => ({ ...current, [scope]: event.target.checked }))} />{APPROVAL_LABELS[scope]}{!requiredApprovals.includes(scope) && <small>（本计划不需要）</small>}</label>)}</fieldset>}
      {kind === 'plan' && Array.isArray(payload.steps) && payload.steps.some((step) => String(step.operation || '').startsWith('generation.')) && <p className="conversation-generation-gate">生成任务必须先取得精确报价；请在生成工作台确认金额后提交，不在通用对话中盲批费用。</p>}
      {kind === 'tool_call' && <details className="conversation-tool-details"><summary>查看工具与参数摘要</summary><StructuredSummary payload={payload} kind={kind} /></details>}
      {kind === 'tool_result' && <details className="conversation-tool-details"><summary>查看执行结果摘要</summary><StructuredSummary payload={payload} kind={kind} /></details>}
      {['evidence', 'analysis', 'knowledge', 'brief', 'artifact'].includes(kind) && <StructuredSummary payload={payload} kind={kind} />}
      {messageTaskId && !taskId && <p className="conversation-historical-note">历史任务记录，仅供查看。</p>}
      {taskId && <footer>{kind === 'plan' && canConfirm && <button type="button" className="primary" disabled={!exactApprovalReady || confirming || !/^[0-9a-f]{64}$/.test(String(payload.fingerprint || ''))} onClick={() => onConfirm?.({ taskId, planFingerprint: payload.fingerprint, approval })}>{confirming ? '正在确认…' : '确认并开始执行'}</button>}<button type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>查看进度</button><button type="button" onClick={() => onNavigate?.('ai-results', taskId)}>查看结果</button></footer>}
      </div>
    </article>
  );
}

export function AIWorkspacePage({ onNavigate, routeParams, harnessClient: providedHarnessClient, projectStore: providedProjectStore }) {
  const client = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const projectStore = useMemo(() => providedProjectStore || (!providedHarnessClient ? createP20OnlineStore() : null), [providedHarnessClient, providedProjectStore]);
  const routeContext = useMemo(() => parseHarnessContextParams(routeParams), [routeParams]);
  // H9: new user tasks are Harness-native by default. The old deterministic
  // planner is kept only as an explicit legacy recovery path.
  const agentFirst = routeParams?.legacy === '1' ? false : true;
  const activeThreadKey = agentFirst ? ACTIVE_AGENT_THREAD_KEY : ACTIVE_THREAD_KEY;
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
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(() => readHarnessActiveProject());
  const [confirming, setConfirming] = useState(false);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const transcriptRef = useRef(null);
  const fileInputRef = useRef(null);
  const cursorRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const terminalRef = useRef(false);

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
    if (!projectStore) return undefined;
    projectStore.listProjects().then((items) => {
      if (!active) return;
      setProjects(Array.isArray(items) ? items : []);
      if (!activeProjectId && items?.[0]?.id) {
        globalThis.localStorage.setItem(HARNESS_ACTIVE_PROJECT_KEY, items[0].id);
        setActiveProjectId(items[0].id);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [activeProjectId, projectStore]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (routeParams?.new) globalThis.localStorage.removeItem(activeThreadKey);
      const threadId = routeParams?.new ? '' : globalThis.localStorage.getItem(activeThreadKey) || '';
      if (!threadId) return;
      setConnection('connecting');
      try {
        const response = await client.getThread(threadId);
        if (!active) return;
        const restored = { ...response.thread, actions: response.actions || {}, currentTaskId: response.currentTaskId, eventCursor: response.eventCursor };
        const restoredProject = restored.projectId || restored.project_id || null;
        if (activeProjectId && restoredProject && restoredProject !== activeProjectId) {
          globalThis.localStorage.removeItem(activeThreadKey);
          return;
        }
        setThread(restored);
        cursorRef.current = Number(response.eventCursor || 0);
        setEventCursor(cursorRef.current);
        await loadHistory(threadId);
        if (active) setConnection(response.thread?.status === 'failed' ? 'failed' : response.thread?.status === 'blocked' ? 'blocked' : 'connected');
      } catch (caught) {
        globalThis.localStorage.removeItem(activeThreadKey);
        if (active && caught?.code !== 'THREAD_NOT_FOUND') setError(caught?.message || '无法恢复会话。');
      }
    };
    restore();
    return () => { active = false; };
  }, [activeProjectId, activeThreadKey, client, loadHistory, routeParams?.new]);

  useEffect(() => {
    if (!thread?.id) return undefined;
    const controller = new globalThis.AbortController();
    terminalRef.current = false;
    const scheduleReconnect = (caught = null) => {
      if (controller.signal.aborted || terminalRef.current) return;
      const attempt = reconnectAttemptRef.current + 1;
      reconnectAttemptRef.current = attempt;
      setConnection('disconnected');
      if (attempt > 5) {
        setError(caught?.message || '事件连接多次中断，请手动重新连接。');
        return;
      }
      const delay = Math.min(8_000, 750 * (2 ** (attempt - 1)));
      reconnectTimerRef.current = globalThis.setTimeout(() => setStreamEpoch((value) => value + 1), delay);
    };
    client.streamThreadEvents({
      threadId: thread.id, cursor: cursorRef.current, signal: controller.signal,
      onStatus: setConnection,
      onEvent: ({ type, event, cursor }) => {
        reconnectAttemptRef.current = 0;
        cursorRef.current = cursor;
        setEventCursor(cursor);
        const payload = event.payload || {};
        if (type === 'assistant_text_delta') setLiveText((current) => `${current}${payload.delta || ''}`);
        if (type === 'assistant_text_completed') { setLiveText(''); loadHistory(thread.id); refreshThread(thread.id); }
        if (type === 'plan_created') { setThread((current) => current && { ...current, status: 'waiting_confirmation', currentTaskId: event.task_id || current.currentTaskId }); refreshThread(thread.id); }
        if (type === 'task_progress') {
          const nextStatus = ['waiting_confirmation', 'executing', 'completed', 'failed', 'blocked', 'stopped'].includes(payload.state)
            ? payload.state
            : ['queued', 'running'].includes(payload.state) ? 'executing' : null;
          if (nextStatus) setThread((current) => current && { ...current, status: nextStatus, currentTaskId: event.task_id || current.currentTaskId });
          refreshThread(thread.id);
        }
        if (type === 'generation_stopped') { setLiveText(''); setConnection('connected'); refreshThread(thread.id); loadHistory(thread.id); }
        if (type === 'error' || type === 'task_failed') { setLiveText(''); setConnection('failed'); setError(payload.message || 'AI 回复失败，请重试失败步骤。'); refreshThread(thread.id); }
        if (type === 'task_blocked') { setLiveText(''); setConnection('blocked'); refreshThread(thread.id); }
        if (['task_completed', 'task_partial', 'task_failed', 'task_blocked', 'task_cancelled'].includes(type)) terminalRef.current = true;
        if (['task_completed', 'task_partial', 'task_cancelled'].includes(type)) refreshThread(thread.id);
        if (['plan_created', 'tool_call_started', 'tool_call_completed', 'approval_requested', 'task_progress', 'task_completed', 'task_partial', 'task_failed', 'task_blocked', 'task_cancelled', 'evidence_result', 'analysis_result', 'knowledge_result', 'brief_result', 'artifact_result', 'error'].includes(type)) loadHistory(thread.id);
      },
    }).then(() => scheduleReconnect()).catch(scheduleReconnect);
    return () => {
      controller.abort();
      if (reconnectTimerRef.current) globalThis.clearTimeout(reconnectTimerRef.current);
    };
  }, [client, loadHistory, refreshThread, streamEpoch, thread?.id]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (node && userNearBottom) node.scrollTop = node.scrollHeight;
  }, [messages, liveText, sending, userNearBottom]);

  useEffect(() => {
    globalThis.document?.querySelector('.main-shell')?.scrollTo?.({ top: 0 });
  }, []);

  async function ensureThread(requestId) {
    if (thread?.id) return thread;
    const response = await client.createThread({ workspaceId: WORKSPACE_ID, projectId: activeProjectId, requestId: `${requestId}:thread`, title: draft.slice(0, 80) || null });
    const next = { id: response.threadId, actions: { sendMessage: true, stopGeneration: false }, currentTaskId: response.currentTaskId, eventCursor: response.eventCursor, status: 'active' };
    globalThis.localStorage.setItem(activeThreadKey, next.id);
    setThread(next);
    return next;
  }

  async function confirmPlan({ taskId, planFingerprint, approval }) {
    if (confirming) return;
    setConfirming(true);
    setError('');
    try {
      await client.confirmThreadPlan({ taskId, planFingerprint, approval });
      setThread((current) => current && { ...current, status: 'executing', currentTaskId: taskId });
      if (thread?.id) await Promise.all([loadHistory(thread.id), refreshThread(thread.id)]);
    } catch (caught) {
      setError(caught?.message || '计划确认失败。');
    } finally {
      setConfirming(false);
    }
  }

  function switchProject(projectId) {
    if (projectId === activeProjectId) return;
    globalThis.localStorage.setItem(HARNESS_ACTIVE_PROJECT_KEY, projectId);
    globalThis.localStorage.removeItem(activeThreadKey);
    cursorRef.current = 0;
    reconnectAttemptRef.current = 0;
    setEventCursor(0);
    setMessages([]);
    setThread(null);
    setLiveText('');
    setError('');
    setActiveProjectId(projectId);
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
      const sendMessage = agentFirst && typeof client.sendAgentMessage === 'function'
        ? client.sendAgentMessage.bind(client)
        : client.sendMessage.bind(client);
      await sendMessage({ threadId: currentThread.id, requestId, content, attachments: uploaded, clientMessageId });
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
  const isEmptyThread = messages.length === 0 && !liveText;
  const connectionLabel = {
    connected: generationActive ? '正在思考' : '已连接', connecting: '正在连接', disconnected: '正在重连',
    failed: '执行失败', blocked: '任务被阻断', idle: '等待开始', stopping: '正在停止',
  }[connection] || '等待开始';
  return (
    <main className="ai-workspace conversation-page" data-testid="harness-ai-workspace">
      {!isEmptyThread && <section className="conversation-heading">
        <div><span>AMS × DeepSeek Harness</span><h1>{messages.length ? 'AI 工作台' : '今天想完成什么？'}</h1><p>直接说目标。Harness 会自己选择插件工具，结果沉淀到研究、知识、Brief 或成品页。</p></div>
        <div className="conversation-heading-actions">
          {projects.length > 0 && <label className="conversation-project-compact" data-testid="harness-active-project">当前项目<select value={activeProjectId || ''} onChange={(event) => switchProject(event.target.value)} disabled={!projects.length}>{projects.map((project) => <option key={project.id} value={project.id}>{project.topic || project.title || project.id}</option>)}</select></label>}
          <div className={`conversation-connection ${connection}`}><i />{connectionLabel}</div>
        </div>
      </section>}

      {currentTaskId && <nav className="ai-task-flow" aria-label="任务流程" data-testid="ai-task-flow">
        <button className="active" type="button" data-testid="ai-task-flow-home"><b>1</b><span><strong>对话工作区</strong><small>问答、计划和摘要</small></span></button>
        <button type="button" data-testid="ai-task-flow-execution" disabled={!currentTaskId} onClick={() => onNavigate?.('ai-execution', currentTaskId)}><b>2</b><span><strong>执行详情</strong><small>步骤、工具与错误</small></span></button>
        <button type="button" data-testid="ai-task-flow-results" disabled={!currentTaskId} onClick={() => onNavigate?.('ai-results', currentTaskId)}><b>3</b><span><strong>结果与审核</strong><small>Evidence、Brief 与成品</small></span></button>
      </nav>}

      <section className={`conversation-workspace ${isEmptyThread ? 'is-empty' : 'has-conversation'}`} data-testid="conversation-workspace">
        {messages.length > 0 && <header className="conversation-toolbar"><div><span className="harness-mark">H</span><div><strong>DeepSeek Harness</strong><small>{currentTaskId ? '已关联当前任务' : '对话会话'}</small></div></div><div>{currentTaskId && <><button type="button" onClick={() => onNavigate?.('ai-execution', currentTaskId)}>执行详情</button><button type="button" onClick={() => onNavigate?.('ai-results', currentTaskId)}>结果与审核</button></>}</div></header>}
        {!isEmptyThread && <div className="conversation-transcript" ref={transcriptRef} aria-live="polite" data-testid="conversation-transcript" onScroll={(event) => { const node = event.currentTarget; setUserNearBottom(node.scrollHeight - node.scrollTop - node.clientHeight < 96); }}>
          {messages.map((message) => <MessageCard key={message.id} message={message} currentTaskId={currentTaskId} onNavigate={onNavigate} onConfirm={confirmPlan} confirming={confirming} canConfirm={thread?.status === 'waiting_confirmation' && (message.task_id || message.taskId) === currentTaskId} />)}
          {liveText && <article className="conversation-message assistant streaming"><MessageIcon role="assistant" kind="text" /><div className="message-body"><span className="message-author">DeepSeek Harness</span><div>{liveText}<span className="stream-caret" /></div></div></article>}
          {sending && !liveText && <div className="conversation-thinking"><i /><span>正在思考…</span></div>}
        </div>}

        {attachments.length > 0 && <div className="conversation-attachments">{attachments.map((attachment) => <span key={attachment.id}>{attachment.file.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button></span>)}</div>}
        <div className="conversation-composer">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="直接说你要完成什么；Enter 发送，Shift+Enter 换行" rows={2} data-testid="harness-intent" />
          <div>
            <input ref={fileInputRef} className="sr-only" type="file" multiple accept={ACCEPT} onChange={selectFiles} />
            <button type="button" className="composer-attach" onClick={() => fileInputRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}>＋ 附件</button>
            <span>消息和事件由服务端保存，刷新后自动恢复。</span>
            {generationActive ? <button type="button" className="composer-stop" onClick={async () => { setConnection('stopping'); setError(''); try { await client.stopGeneration(thread.id); await loadHistory(thread.id); await refreshThread(thread.id); setLiveText(''); setConnection('connected'); } catch (caught) { await refreshThread(thread.id).catch(() => {}); setConnection('failed'); setError(caught?.message || '停止请求失败，请重新连接后重试。'); } }}>停止</button> : <button type="button" className="composer-send" onClick={() => send()} disabled={!draft.trim() || sending || thread?.actions?.sendMessage === false} data-testid="harness-submit">发送</button>}
          </div>
        </div>
      </section>
      {error && <div className="notice error" role="alert">{error}<button type="button" onClick={() => { reconnectAttemptRef.current = 0; setError(''); if (thread?.id) { loadHistory(thread.id); refreshThread(thread.id); setStreamEpoch((value) => value + 1); } }}>重新连接</button></div>}
      {thread?.id && <details className="ai-technical-details"><summary>技术诊断（默认隐藏）</summary><dl><div><dt>thread_id</dt><dd><code>{thread.id}</code></dd></div>{currentTaskId && <div><dt>task_id</dt><dd><code>{currentTaskId}</code></dd></div>}<div><dt>event_cursor</dt><dd>{eventCursor}</dd></div></dl></details>}
    </main>
  );
}
