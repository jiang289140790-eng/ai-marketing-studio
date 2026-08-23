import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient, newHarnessRequestId, normalizeHarnessIntent, readHarnessActiveProject } from '../services/harness-client.js';
import { resolvePresentationBlocks } from '../services/harness-presentation.js';
import { PresentationPanel } from '../components/harness-presentation/PresentationPanel.jsx';
import { parseHarnessContextParams } from '../utils/app-route.js';
import {
  buildSourceChain,
  isCapabilityIntent,
  isTaskTerminal,
  normalizeTaskSnapshot,
  resultHeadline,
  stateLabel,
  stepStateLabel,
} from '../services/harness-task-model.js';
import './AIWorkspacePage.css';

// Every visible preset must be a valid authoritative plan request exactly as
// displayed: the server planner must accept the preset text without a hidden
// identifier or a missing bounded slot. Presets that need a specific post
// link, an exact Evidence/Analysis identity or a bounded keyword either carry
// that bounded input in the text or are not advertised.
const suggestions = [
  '生成待审核 Brief（汇总当前项目知识卡）',
  '搜索 X 和 Reddit 上本周最热门的 "AI 营销" 话题，选 5 条保存为证据',
  '比较当前项目中表现最好的帖子，提炼可复用的内容规律',
  '分析下近期展现量最高的 X 帖子，比较后提炼可复用的内容规律',
  '创建交接包（基于当前项目最新待审核 Brief）',
];

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 128 * 1024;
const MAX_TEXT_ATTACHMENT_CHARS = 4_000;
const TEXT_ATTACHMENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

// The exact metric slot values are fixed server-side (compare_project);
// these labels mirror them so the page always shows the requested metric
// exactly as the plan will rank by.
const compareMetricLabels = {
  views: '展现量（views，涵盖浏览量/播放量/曝光量）',
  engagement: '互动（engagement）',
};

function taskFromResponse(value) {
  return normalizeTaskSnapshot(value?.task) || null;
}

export function AIWorkspacePage({ onNavigate, routeParams, harnessClient: providedHarnessClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [intent, setIntent] = useState('');
  const [allowPaid, setAllowPaid] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowHandoff, setAllowHandoff] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const pollGeneration = useRef(0);
  const pollInFlight = useRef(false);
  const pendingSubmission = useRef(null);
  const attachmentInput = useRef(null);
  const routeContext = useMemo(() => parseHarnessContextParams(routeParams), [routeParams]);
  const routeContextKey = JSON.stringify(routeContext);

  useEffect(() => {
    setIntent(routeContext.intent || '');
  }, [routeContext.intent, routeContextKey]);

  useEffect(() => {
    if (!routeParams?.new) return;
    setIntent('');
    setAttachments([]);
    setActiveTask(null);
    setError('');
  }, [routeParams?.new]);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await harnessClient.list(30);
      // 历史记录同样走统一快照归一化：所有页面使用同一状态映射。
      setHistory(Array.isArray(response.tasks) ? response.tasks.map((entry) => normalizeTaskSnapshot(entry)).filter(Boolean) : []);
    } catch (caught) {
      if (caught?.code !== 'AUTH_REQUIRED') setError(caught?.message || '无法读取任务记录。');
    }
  }, [harnessClient]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  useEffect(() => {
    if (!activeTask || !['queued', 'running'].includes(activeTask.state)) return undefined;
    const timer = globalThis.setInterval(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      const generation = pollGeneration.current;
      try {
        const response = await harnessClient.read(activeTask.id);
        if (generation !== pollGeneration.current) return;
        const next = taskFromResponse(response);
        if (next) {
          setActiveTask(next);
          if (!['queued', 'running'].includes(next.state)) refreshHistory();
        }
      } catch (caught) {
        if (generation !== pollGeneration.current) return;
        setError(caught?.message || '无法更新任务状态。');
      } finally {
        if (generation === pollGeneration.current) pollInFlight.current = false;
      }
    }, 1500);
    return () => {
      pollGeneration.current += 1;
      pollInFlight.current = false;
      globalThis.clearInterval(timer);
    };
  }, [activeTask, harnessClient, refreshHistory]);

  const presentationBlocks = useMemo(() => resolvePresentationBlocks(activeTask), [activeTask]);
  const historySummary = useMemo(() => ({
    running: history.filter((task) => ['queued', 'running'].includes(task.state)).length,
    completed: history.filter((task) => ['succeeded', 'reused'].includes(task.state)).length,
    attention: history.filter((task) => ['partial', 'failed', 'blocked'].includes(task.state)).length,
  }), [history]);
  const visibleHistory = useMemo(() => (showAllHistory ? history : history.slice(0, 6)), [history, showAllHistory]);
  const artifactRefs = Array.isArray(activeTask?.result?.artifact_refs)
    ? activeTask.result.artifact_refs
    : [];
  const evidenceCount = buildSourceChain(activeTask).evidence.length;
  const terminalTask = activeTask && isTaskTerminal(activeTask.state);
  // 结果摘要与详情页共用同一派生函数（同一 snapshot → 同一文案），
  // 不存在“静态 completed 覆盖 running”的独立标题。
  const resultHeadlineText = resultHeadline(activeTask);
  const authoritativePlan = activeTask?.plan || null;
  const requiredApprovals = authoritativePlan?.approvals || {};
  const approvalsReady = (!requiredApprovals.paid_external_calls || allowPaid)
    && (!requiredApprovals.online_writes || allowWrites)
    && (!requiredApprovals.handoff_creation || allowHandoff);

  function activateTask(task) {
    // Approval is scoped to one exact authoritative plan. Switching history
    // entries or creating another task must never inherit a prior plan's paid,
    // write, or handoff consent.
    setAllowPaid(false);
    setAllowWrites(false);
    setAllowHandoff(false);
    setShowFullResult(false);
    setActiveTask(task);
  }

  async function createPlan(event) {
    event.preventDefault();
    if (!intent.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const attachmentContext = attachments.length > 0
        ? `\n\n附件上下文（由用户本地选择）：\n${attachments.map((attachment, index) => {
          const identity = `${index + 1}. ${attachment.name} · ${attachment.type || '未知类型'} · ${formatBytes(attachment.size)}`;
          return attachment.text ? `${identity}\n文本摘录：${attachment.text}` : identity;
        }).join('\n')}`
        : '';
      const normalizedIntent = normalizeHarnessIntent(`${intent}${attachmentContext}`);
      if (normalizedIntent.length > 12_000) throw new Error('任务目标与附件文本合计不能超过 12000 个字符。');
      const projectId = readHarnessActiveProject();
      const submissionKey = JSON.stringify([projectId, normalizedIntent]);
      if (pendingSubmission.current?.key !== submissionKey) {
        pendingSubmission.current = { key: submissionKey, requestId: newHarnessRequestId() };
      }
      const response = await harnessClient.plan({
        requestId: pendingSubmission.current.requestId,
        projectId,
        intent: normalizedIntent,
      });
      const task = taskFromResponse(response);
      if (!task) throw new Error('计划入口没有返回任务记录。');
      pendingSubmission.current = null;
      if (isCapabilityIntent(task.request?.intent)) {
        // “能力：…”只读能力查询：仅作为历史任务存在，绝不设为当前任务；
        // 直接进入该任务的只读执行详情。
        refreshHistory();
        onNavigate?.('ai-execution', task.id);
        return;
      }
      activateTask(task);
      refreshHistory();
    } catch (caught) {
      setError(caught?.message || '生成执行计划失败。');
    } finally {
      setSubmitting(false);
    }
  }

  async function selectAttachments(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const available = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (available === 0) {
      setError(`每个任务最多添加 ${MAX_ATTACHMENTS} 个附件。`);
      return;
    }
    const accepted = [];
    for (const file of files.slice(0, available)) {
      if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
        setError(`附件“${file.name}”必须小于 ${formatBytes(MAX_ATTACHMENT_BYTES)}。`);
        continue;
      }
      let text = '';
      if (TEXT_ATTACHMENT_TYPES.has(file.type) && file.size <= MAX_TEXT_ATTACHMENT_BYTES) {
        text = (await file.text()).slice(0, MAX_TEXT_ATTACHMENT_CHARS).trim();
      }
      accepted.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${globalThis.crypto?.randomUUID?.() || Date.now()}`,
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        text,
      });
    }
    setAttachments((current) => [...current, ...accepted].slice(0, MAX_ATTACHMENTS));
    if (files.length > available) setError(`每个任务最多添加 ${MAX_ATTACHMENTS} 个附件，其余文件未加入。`);
    else if (accepted.length > 0) setError('');
  }

  function removeAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  async function confirmPlan() {
    if (!authoritativePlan || !approvalsReady || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.confirm({
        taskId: activeTask.id,
        planFingerprint: authoritativePlan.fingerprint,
        approval: {
          paid_external_calls: requiredApprovals.paid_external_calls === true,
          online_writes: requiredApprovals.online_writes === true,
          handoff_creation: requiredApprovals.handoff_creation === true,
        },
      });
      const task = taskFromResponse(response);
      if (!task) throw new Error('确认入口没有返回任务记录。');
      setActiveTask(task);
    } catch (caught) {
      setError(caught?.message || '确认执行计划失败。');
    } finally {
      setSubmitting(false);
    }
  }

  async function retryFailedStep(stepId) {
    if (!activeTask?.plan || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.retryFailedStep({
        taskId: activeTask.id,
        planFingerprint: activeTask.plan.fingerprint,
        stepId,
        approval: activeTask.confirmation?.approval || activeTask.plan.approvals,
      });
      const task = taskFromResponse(response);
      if (!task) throw new Error('重试入口没有返回任务记录。');
      setActiveTask(task);
    } catch (caught) {
      setError(caught?.message || '重试失败步骤未被接受。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="ai-workspace" data-testid="harness-ai-workspace">
      <div className="ai-harness-shell">
        <div className="ai-harness-main">
      <section className="ai-hero" data-testid="ai-workspace-hero">
        <div className="ai-hero-copy">
          <span className="ai-kicker">AMS × DeepSeek Harness</span>
          <h1>今天想完成什么？</h1>
          <p>研究、知识沉淀、内容策划与生成都可以从这里开始；结果会直接出现在会话中。</p>
        </div>
        <div className="ai-hero-status">
          <span className="ai-live-dot" />
          <div><strong>Harness 已连接</strong><small>安全模式 · Staging</small></div>
          <button className="secondary-button" type="button" onClick={() => onNavigate?.('research')}>高级研究模式</button>
        </div>
      </section>

      <nav className="ai-task-flow" aria-label="三页任务流程" data-testid="ai-task-flow">
        {[
          ['新任务', '创建或进入任务', ['ai', '']],
          ['执行详情', '计划、进度与失败', activeTask ? ['ai-execution', activeTask.id] : null],
          ['结果与审核', '结果、产物与来源链', activeTask ? ['ai-results', activeTask.id] : null],
        ].map(([label, description, target], index) => (
          <button
            key={label}
            type="button"
            data-testid={`ai-task-flow-${['home', 'execution', 'results'][index]}`}
            className={index === 0 ? 'active' : ''}
            disabled={!target}
            onClick={() => target && onNavigate?.(target[0], target[1])}
          >
            <b>{index + 1}</b>
            <span><strong>{label}</strong><small>{description}</small></span>
            <i>›</i>
          </button>
        ))}
      </nav>

      {!activeTask && (
        <div className="ai-task-empty" data-testid="ai-no-current-task">
          还没有当前任务。输入任务目标创建一条新任务，或从下方最近任务记录打开一条任务；执行与结果页会跟随同一任务编号。
        </div>
      )}

      <details className="ai-overview-disclosure">
        <summary><span>任务概览</span><b>{historySummary.running} 个执行中 · {historySummary.completed} 个已完成 · {historySummary.attention} 个待处理</b><i>展开</i></summary>
        <section className="ai-overview" aria-label="工作台概览">
          <div><span>正在执行</span><strong>{historySummary.running}</strong><small>可随时回来查看进度</small></div>
          <div><span>已完成</span><strong>{historySummary.completed}</strong><small>成果已保留在工作区</small></div>
          <div><span>需要处理</span><strong>{historySummary.attention}</strong><small>失败或部分完成的任务</small></div>
          <div className="ai-overview-promise"><span>安全边界</span><strong>计划 → 确认 → 执行</strong><small>不会绕过你的批准</small></div>
        </section>
      </details>

      <section className="ai-command-card" data-testid="ai-command-center">
        {routeContext.source && (
          <div className="ai-route-context" data-testid="harness-route-context">
            <div>
              <strong>已带入业务上下文</strong>
              <span>{routeContext.source} · {routeContext.entity}</span>
            </div>
            {routeContext.entity_id && <code>{routeContext.entity_id}</code>}
            {routeContext.campaign_id && <code>{routeContext.campaign_id}</code>}
          </div>
        )}
        <div className="ai-command-layout">
          <form onSubmit={createPlan}>
            <div className="ai-command-title"><span>任务目标</span><h2 className="sr-only">创建 AI 任务</h2></div>
            <label className="sr-only" htmlFor="ai-intent">任务目标</label>
            <textarea id="ai-intent" data-testid="harness-intent" value={intent} onChange={(event) => setIntent(event.target.value)} placeholder="直接描述目标，例如：分析这个 X 帖子，保存证据和多模态分析，然后生成待审核 Brief…" maxLength={12000} rows={4} />
            {attachments.length > 0 && (
              <div className="ai-attachment-list" data-testid="harness-attachments" aria-label="已选择附件">
                {attachments.map((attachment) => (
                  <div className="ai-attachment-chip" key={attachment.id}>
                    <span aria-hidden="true">{attachment.type.startsWith('image/') ? '▧' : attachment.type.startsWith('video/') ? '▶' : '▤'}</span>
                    <div><b title={attachment.name}>{attachment.name}</b><small>{formatBytes(attachment.size)} · {attachment.text ? '文本已读取' : attachment.type}</small></div>
                    <button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => removeAttachment(attachment.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="ai-submit-row">
              <input
                ref={attachmentInput}
                className="sr-only"
                data-testid="harness-attachment-input"
                type="file"
                multiple
                accept="image/*,video/*,application/pdf,text/plain,text/markdown,text/csv,application/json"
                onChange={selectAttachments}
              />
              <button className="ai-attachment-button" type="button" onClick={() => attachmentInput.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}>
                <span aria-hidden="true">＋</span> 附件
              </button>
              <span>此步骤只生成计划，不调用付费工具，也不写入数据。</span>
              <button className="primary-button ai-send-button" data-testid="harness-submit" type="submit" disabled={!intent.trim() || submitting}>{submitting ? '生成中…' : '生成计划'} <span aria-hidden="true">→</span></button>
            </div>
          </form>
          <details className="ai-capability-panel">
            <summary>
              <span className="ai-capability-icon">+</span>
              <span><b>快捷能力</b><small>按需展开 5 个常用模板</small></span>
              <i>展开</i>
            </summary>
            <div className="ai-suggestions" aria-label="常用任务">
              {suggestions.map((text, index) => <button key={text} type="button" onClick={() => setIntent(text)}><b>{['研究', '洞察', '比较', '分析', '交接'][index]}</b><span>{text}</span></button>)}
            </div>
          </details>
        </div>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      {activeTask && (
        <section className="ai-active-task ai-conversation" data-testid="harness-active-task">
          <div className="ai-message ai-message-user"><span>你</span><p>{activeTask.request?.intent}</p></div>
          <article className="ai-message ai-message-assistant">
          <div className="ai-section-heading">
            <div><span>AI 营销工作台</span><h2>{stateLabel(activeTask.state)}</h2></div>
            <div className="ai-active-task-actions">
              <button type="button" className="secondary-button" data-testid={`ai-task-open-execution-${activeTask.id}`} onClick={() => onNavigate?.('ai-execution', activeTask.id)}>执行详情</button>
              <button type="button" className="secondary-button" data-testid={`ai-task-open-results-${activeTask.id}`} onClick={() => onNavigate?.('ai-results', activeTask.id)}>结果与审核</button>
              {['planned', 'queued', 'running'].includes(activeTask.state) && <button type="button" className="secondary-button" onClick={() => harnessClient.cancel(activeTask.id).then((value) => setActiveTask(taskFromResponse(value) || activeTask)).catch((caught) => setError(caught.message))}>取消任务</button>}
            </div>
          </div>
          <div className="ai-progress" aria-label="任务进度"><span className={activeTask.state} /></div>

          {authoritativePlan && (
            <div className="ai-plan" data-testid="harness-authoritative-plan">
              <div className="ai-plan-title">
                <div><strong>{authoritativePlan.workflow_title}</strong><span>权威执行计划 · 不可编辑</span></div>
                <code title={authoritativePlan.fingerprint}>{authoritativePlan.fingerprint.slice(0, 12)}…</code>
              </div>
              {authoritativePlan.slots?.metric && (
                <div className="ai-metric" data-testid="harness-metric-slot">
                  比较指标：{compareMetricLabels[authoritativePlan.slots.metric] || authoritativePlan.slots.metric}
                </div>
              )}
              <ol className="ai-plan-steps">
                {authoritativePlan.steps.map((step) => {
                  const snapshot = activeTask.step_states?.[step.step];
                  const stepState = snapshot?.state || 'planned';
                  const canRetry = snapshot?.state === 'failed' && snapshot?.error?.retry_unsafe !== true && ['partial', 'failed'].includes(activeTask.state);
                  return (
                    <li key={step.step} data-testid={`harness-step-${step.step}`} data-state={stepState}>
                      <span className={`ai-step-state ${stepState}`}>{stepStateLabel(stepState)}</span>
                      <div><strong>{step.label}</strong><small>{step.operation} · 前置：{step.depends_on.length ? step.depends_on.join('、') : '无'}</small></div>
                      <div className="ai-step-badges">
                        {step.reuse && <span>可精确复用</span>}
                        {step.cost && <span className="cost">可能付费</span>}
                        {step.write && <span className="write">写入 staging</span>}
                      </div>
                      {snapshot?.error && <p className="ai-step-error">{snapshot.error.code} · {snapshot.error.message}</p>}
                      {canRetry && <button type="button" className="secondary-button" data-testid={`harness-retry-${step.step}`} disabled={submitting} onClick={() => retryFailedStep(step.step)}>仅重试此失败步骤</button>}
                    </li>
                  );
                })}
              </ol>
              {activeTask.state === 'planned' && (
                <div className="ai-confirm-panel" data-testid="harness-confirm-panel">
                  <strong>确认计划后才会执行</strong>
                  <div className="ai-approvals">
                    {requiredApprovals.paid_external_calls && <label><input data-testid="harness-paid-approval" type="checkbox" checked={allowPaid} onChange={(event) => setAllowPaid(event.target.checked)} />允许本计划中的付费采集或模型分析</label>}
                    {requiredApprovals.online_writes && <label><input data-testid="harness-write-approval" type="checkbox" checked={allowWrites} onChange={(event) => setAllowWrites(event.target.checked)} />允许把本计划产物保存到 staging</label>}
                    {requiredApprovals.handoff_creation && <label><input data-testid="harness-handoff-approval" type="checkbox" checked={allowHandoff} onChange={(event) => setAllowHandoff(event.target.checked)} />允许本计划创建交接包</label>}
                  </div>
                  <button type="button" className="primary-button" data-testid="harness-confirm" disabled={!approvalsReady || submitting} onClick={confirmPlan}>{submitting ? '正在确认…' : '确认并开始执行'}</button>
                </div>
              )}
            </div>
          )}

          {terminalTask && (
            <section className={`ai-result-summary ${activeTask.state}`} data-testid="harness-result-summary">
              <div className="ai-result-summary-copy">
                <span>任务结果</span>
                <h3>{resultHeadlineText}</h3>
                <p>{evidenceCount > 0 ? '内容已经进入当前研究项目，可继续分析、生成知识卡或整理 Brief。' : '成果已保留在当前工作区，可随时回来查看。'}</p>
              </div>
              <div className="ai-result-actions">
                {evidenceCount > 0 && <button className="primary-button" type="button" onClick={() => onNavigate?.('research')}>查看 {evidenceCount} 条证据</button>}
                {activeTask.result?.final_response && <button className="secondary-button" type="button" aria-expanded={showFullResult} onClick={() => setShowFullResult((value) => !value)}>{showFullResult ? '收起执行报告' : '查看执行报告'}</button>}
              </div>
              {showFullResult && activeTask.result?.final_response && <div className="ai-result-copy" data-testid="harness-readable-result">{activeTask.result.final_response}</div>}
            </section>
          )}

          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}
          {!terminalTask && activeTask.result?.final_response && (presentationBlocks.length > 0 ? <details className="ai-raw-response"><summary>查看原始回复</summary><div className="ai-result-copy">{activeTask.result.final_response}</div></details> : <div className="ai-result-copy">{activeTask.result.final_response}</div>)}
          {activeTask.error && <div className="notice error" data-testid="harness-task-error">{activeTask.error.operation ? `${activeTask.error.operation} · ` : ''}{activeTask.error.tool_code || activeTask.error.message || activeTask.error.summary || activeTask.error.code}</div>}
          <details className="ai-technical-details" data-testid="ai-task-technical-details"><summary>技术详情</summary>
            <dl className="ai-task-technical"><div><dt>task_id</dt><dd><code>{activeTask.id}</code></dd></div><div><dt>project_id</dt><dd><code>{activeTask.request?.project_id || '未绑定'}</code></dd></div><div><dt>updated_at</dt><dd>{activeTask.updated_at || '—'}</dd></div><div><dt>内部状态</dt><dd>{activeTask.state}</dd></div></dl>
            {activeTask.result?.result_data && <pre className="ai-result-copy">{JSON.stringify(activeTask.result.result_data, null, 2)}</pre>}
            {artifactRefs.length > 0 && <div className="ai-artifacts"><strong>产物身份</strong>{artifactRefs.map((ref) => <code key={ref}>{ref}</code>)}</div>}
          </details>
          </article>
        </section>
      )}

      <details className="ai-history">
        <summary className="ai-history-summary">
          <span><b>最近任务与成果</b><small>{history.length > 0 ? `${history.length} 条记录 · 默认收起` : '暂无记录'}</small></span>
          <i>查看</i>
        </summary>
        <div className="ai-history-body">
          <div className="ai-section-heading"><div><span>任务与成果</span><h2>最近记录</h2><p>展开后先显示最近 6 条，需要时再查看全部。</p></div><button type="button" className="secondary-button" onClick={refreshHistory}>刷新</button></div>
          {history.length === 0 ? <div className="ai-empty">还没有 Harness 任务。你可以从上方的一句话开始。</div> : <><div className="ai-task-list">{visibleHistory.map((task) => <div className="ai-task-row" key={task.id}><button className="ai-task-row-main" type="button" onClick={async () => { try { const response = await harnessClient.read(task.id); const next = taskFromResponse(response) || task; if (isCapabilityIntent(next.request?.intent)) { onNavigate?.('ai-execution', next.id); return; } activateTask(next); } catch (caught) { setError(caught?.message || '无法读取完整任务记录。'); } }}><span className={`ai-task-state ${task.state}`}>{stateLabel(task.state)}</span><strong>{task.request?.intent || '未命名任务'}</strong><time>{task.updated_at ? new Date(task.updated_at).toLocaleString('zh-CN') : ''}</time></button><div className="ai-task-row-links"><button type="button" data-testid={`ai-task-open-execution-${task.id}`} onClick={() => onNavigate?.('ai-execution', task.id)}>执行详情</button><button type="button" data-testid={`ai-task-open-results-${task.id}`} onClick={() => onNavigate?.('ai-results', task.id)}>结果与审核</button></div></div>)}</div>{history.length > 6 && <button className="ai-history-toggle" type="button" onClick={() => setShowAllHistory((value) => !value)}>{showAllHistory ? '收起历史记录' : `查看全部 ${history.length} 条记录`}</button>}</>}
        </div>
      </details>
        </div>
      </div>
    </main>
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
