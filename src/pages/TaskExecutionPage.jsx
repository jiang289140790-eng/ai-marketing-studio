import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient } from '../services/harness-client.js';
import {
  APPROVAL_LABELS,
  APPROVAL_REQUIREMENTS,
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  taskSnapshotView,
} from '../services/harness-task-model.js';
import './ai-task-pages.css';

function boundedMessage(error) {
  return String(error?.message || error || '操作失败。').slice(0, 200);
}

function formatTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('zh-CN', { hour12: false });
}

const POLL_INTERVAL_MS = 1500;

function summarizeSteps(steps) {
  const summary = {
    total: steps.length,
    succeeded: 0,
    running: 0,
    failed: 0,
    blocked: 0,
    planned: 0,
    skipped: 0,
    cost: 0,
    write: 0,
    retryable: 0,
    attentionStep: null,
  };
  for (const step of steps) {
    if (step.state === 'succeeded' || step.state === 'reused') summary.succeeded += 1;
    else if (step.state === 'running') summary.running += 1;
    else if (step.state === 'failed') summary.failed += 1;
    else if (step.state === 'blocked') summary.blocked += 1;
    else if (step.state === 'skipped') summary.skipped += 1;
    else summary.planned += 1;
    if (step.cost) summary.cost += 1;
    if (step.write) summary.write += 1;
    if (step.retryable) summary.retryable += 1;
    if (!summary.attentionStep && (step.state === 'running' || step.state === 'failed' || step.state === 'blocked')) {
      summary.attentionStep = step;
    }
  }
  return summary;
}

function stepSummaryText(step) {
  const parts = [step.operation];
  if (step.cost) parts.push('可能付费');
  if (step.write) parts.push('写入 staging');
  if (step.attempts > 0) parts.push(`尝试 ${step.attempts} 次`);
  return parts.filter(Boolean).join(' · ');
}

/**
 * 任务执行详情页：规范路由 `/tasks/<taskId>`（旧 `#/ai-execution/<taskId>` 兼容重定向）。
 *
 * 只读取真实服务端任务快照（harness read），从同一个 taskId 的同一个
 * snapshot 派生顶部汇总、任务卡片、步骤/工具调用、错误与技术详情（单一
 * snapshot view model）。轮询更新原子替换整个 snapshot，绝不局部拼接。
 * 步骤与 tool calls 只展示服务端存在的数据；缺失即明确空态，绝不从计划
 * 步骤伪造成已调用工具。没有数据时展示诚实错误/空态。
 */
export function TaskExecutionPage({ detailId: taskId = '', onNavigate, harnessClient: providedHarnessClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [allowPaid, setAllowPaid] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowHandoff, setAllowHandoff] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pollGeneration = useRef(0);
  const pollInFlight = useRef(false);

  const validTaskId = isValidHarnessTaskId(taskId);

  const refresh = useCallback(async () => {
    if (!validTaskId) {
      setLoading(false);
      setError('');
      setTask(null);
      return;
    }
    try {
      const response = await harnessClient.read(taskId);
      const next = normalizeTaskSnapshot(response?.task);
      if (!next) throw new Error('服务端没有返回有效的任务记录。');
      setTask(next);
      setError('');
    } catch (caught) {
      setError(boundedMessage(caught));
      setTask(null);
    } finally {
      setLoading(false);
    }
  }, [harnessClient, taskId, validTaskId]);

  useEffect(() => { refresh(); }, [refresh]);

  // 活动任务有界轮询：queued/running 期间每 1.5s 读取真实状态，
  // 每次原子替换整个 snapshot，终态自动停止。
  useEffect(() => {
    if (!task || !['queued', 'running'].includes(task.state)) return undefined;
    const timer = globalThis.setInterval(async () => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      const generation = pollGeneration.current;
      try {
        const response = await harnessClient.read(task.id);
        if (generation !== pollGeneration.current) return;
        const next = normalizeTaskSnapshot(response?.task);
        if (next) setTask(next);
      } catch (caught) {
        if (generation !== pollGeneration.current) return;
        setError(boundedMessage(caught));
      } finally {
        if (generation === pollGeneration.current) pollInFlight.current = false;
      }
    }, POLL_INTERVAL_MS);
    return () => {
      pollGeneration.current += 1;
      pollInFlight.current = false;
      globalThis.clearInterval(timer);
    };
  }, [harnessClient, task]);

  // 授权范围限定到当前任务与当前计划指纹：切换任务/状态变化时清除已勾选批准。
  useEffect(() => {
    setAllowPaid(false);
    setAllowWrites(false);
    setAllowHandoff(false);
  }, [task?.id, task?.state, task?.plan?.fingerprint]);

  const view = useMemo(() => taskSnapshotView(task), [task]);
  const steps = view?.steps || [];
  const stepSummary = useMemo(() => summarizeSteps(steps), [steps]);
  const toolCalls = view?.toolCalls || { present: false, calls: [] };
  const approvals = view?.approvals || {};
  const technical = view?.technical || null;
  const approvalsReady = (!approvals.paid_external_calls || allowPaid)
    && (!approvals.online_writes || allowWrites)
    && (!approvals.handoff_creation || allowHandoff);
  const phase = task?.state === 'planned' ? 'planned'
    : ['queued', 'running'].includes(task?.state) ? 'active'
      : ['partial', 'failed', 'blocked'].includes(task?.state) ? 'attention' : 'terminal';

  async function confirmPlan() {
    if (!task?.plan || submitting || !approvalsReady) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.confirm({
        taskId: task.id,
        planFingerprint: task.plan.fingerprint,
        approval: {
          paid_external_calls: approvals.paid_external_calls === true,
          online_writes: approvals.online_writes === true,
          handoff_creation: approvals.handoff_creation === true,
        },
      });
      const next = normalizeTaskSnapshot(response?.task);
      if (!next) throw new Error('确认入口没有返回任务记录。');
      setTask(next);
      setAllowPaid(false);
      setAllowWrites(false);
      setAllowHandoff(false);
    } catch (caught) {
      setError(boundedMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelTask() {
    if (!task || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.cancel(task.id);
      const next = normalizeTaskSnapshot(response?.task);
      if (next) setTask(next);
      else setError('取消结果未被服务端确认，任务快照未改变。');
    } catch (caught) {
      setError(boundedMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function retryFailedStep(stepId) {
    if (!task?.plan || submitting || !approvalsReady) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.retryFailedStep({
        taskId: task.id,
        planFingerprint: task.plan.fingerprint,
        stepId,
        // 与真实 edge 契约一致：三个批准键必须全部为布尔值。
        approval: {
          paid_external_calls: approvals.paid_external_calls === true,
          online_writes: approvals.online_writes === true,
          handoff_creation: approvals.handoff_creation === true,
        },
      });
      const next = normalizeTaskSnapshot(response?.task);
      if (!next) throw new Error('重试入口没有返回任务记录。');
      setTask(next);
      setAllowPaid(false);
      setAllowWrites(false);
      setAllowHandoff(false);
    } catch (caught) {
      setError(boundedMessage(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="ai-task-page" data-testid="ai-task-execution">
      <div className="ai-task-head">
        <div>
          <p className="eyebrow">任务执行详情</p>
          <h2>{view?.intent ? '执行中的任务' : '任务执行详情'}</h2>
          <p>从真实服务端读取任务、计划与逐步执行状态；直接打开或刷新本页都会恢复到同一任务。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai')}>返回新任务首页</button>
          {validTaskId && <button className="ghost-button" type="button" data-testid="ai-task-open-results" onClick={() => onNavigate?.('ai-results', taskId)}>结果与审核</button>}
        </div>
      </div>

      {!validTaskId && !loading && (
        <div className="notice error" data-testid="ai-task-invalid-id" role="alert">
          任务编号格式无效，无法读取执行详情。请从新任务首页选择一条真实任务。
        </div>
      )}

      {validTaskId && loading && <div className="skeleton skeleton-card" data-testid="ai-task-loading" />}

      {validTaskId && !loading && error && (
        <div className="notice error" data-testid="ai-task-read-error" role="alert">
          {error}
        </div>
      )}

      {validTaskId && !loading && task && !task.invalid && (
        <>
          <section className="ai-task-hero" data-testid="ai-task-hero">
            <div className="ai-task-identity">
              <span className={`status-badge ${task.state}`}>{view.stateLabel}</span>
            </div>
            {view.intent && <p className="ai-task-intent">{view.intent}</p>}
            {view.workflowTitle && <div className="ai-task-meta"><span>流程 {view.workflowTitle}</span></div>}
            {['planned', 'queued', 'running'].includes(task.state) && (
              <div className="ai-task-actions">
                <button className="secondary-button" type="button" disabled={submitting} data-testid="ai-task-cancel" onClick={cancelTask}>取消任务</button>
              </div>
            )}
          </section>

          {phase === 'planned' && task.plan && (
            <div className="notice" data-testid="ai-task-pending-confirm">
              权威计划已生成，等待人工确认。确认授权范围见下方计划。
            </div>
          )}

          {phase === 'planned' && task.plan && (
            <section className="ai-task-panel" data-testid="ai-task-confirm-zone">
              <div className="ai-task-panel-head">
                <div>
                  <p className="eyebrow">人工确认</p>
                  <h3>确认计划后才会执行</h3>
                </div>
              </div>
              {Object.keys(approvals).length > 0 && (
                <div className="ai-approvals ai-confirm-approvals">
                  {approvals.paid_external_calls && <label><input type="checkbox" data-testid="ai-task-paid-approval" checked={allowPaid} onChange={(event) => setAllowPaid(event.target.checked)} />允许本计划中的付费采集或模型分析</label>}
                  {approvals.online_writes && <label><input type="checkbox" data-testid="ai-task-write-approval" checked={allowWrites} onChange={(event) => setAllowWrites(event.target.checked)} />允许把本计划产物保存到 staging</label>}
                  {approvals.handoff_creation && <label><input type="checkbox" data-testid="ai-task-handoff-approval" checked={allowHandoff} onChange={(event) => setAllowHandoff(event.target.checked)} />允许本计划创建交接包</label>}
                </div>
              )}
              <button className="primary-button" type="button" data-testid="ai-task-confirm" disabled={!approvalsReady || submitting} onClick={confirmPlan}>
                {submitting ? '正在确认…' : '确认并开始执行'}
              </button>
            </section>
          )}

          {task.plan && (
            <section className="ai-task-panel" data-testid="ai-task-plan">
              <div className="ai-task-panel-head">
                <div>
                  <p className="eyebrow">权威执行计划 · 不可编辑</p>
                  <h3>{task.plan.workflow_title || '执行计划'}</h3>
                </div>
              </div>
              {Object.keys(approvals).length > 0 && (
                <div className="ai-task-approvals" data-testid="ai-task-approvals">
                  {APPROVAL_REQUIREMENTS.filter((key) => approvals[key]).map((key) => (
                    <span className="approval-chip" key={key}>需要授权：{APPROVAL_LABELS[key]}</span>
                  ))}
                </div>
              )}
              <div className="ai-task-step-summary" data-testid="ai-task-step-summary">
                <div className="detail-card"><span>总进度</span><div>{stepSummary.succeeded}/{stepSummary.total} 已完成</div></div>
                <div className="detail-card"><span>需要处理</span><div>{stepSummary.failed + stepSummary.blocked} 个失败/阻断</div></div>
                <div className="detail-card"><span>付费与写入</span><div>{stepSummary.cost} 个可能付费 · {stepSummary.write} 个写入</div></div>
                <div className="detail-card"><span>当前焦点</span><div>{stepSummary.attentionStep?.label || '暂无异常步骤'}</div></div>
              </div>
              <details className="ai-task-step-details" data-testid="ai-task-step-details">
                <summary>展开执行步骤详情（{stepSummary.total} 步）</summary>
                <ol className="ai-task-steps">
                {steps.map((step) => (
                  <li key={step.step} data-testid={`ai-task-step-${step.step}`} data-state={step.state}>
                    <span className={`ai-step-state ${step.state}`}>{step.stateLabel}</span>
                    <div className="ai-step-copy">
                      <strong>{step.label}</strong>
                      <small>{stepSummaryText(step)}</small>
                      <details className="ai-step-inner-detail" open={step.state === 'failed' || step.state === 'blocked'}>
                        <summary>查看本步骤细节</summary>
                        <small>{step.operation} · 前置：{step.depends_on.length ? step.depends_on.join('、') : '无'}</small>
                      <div className="ai-step-badges">
                        {step.reuse && <span>可精确复用</span>}
                        {step.cost && <span className="cost">可能付费</span>}
                        {step.write && <span className="write">写入 staging</span>}
                        {step.attempts > 0 && <span className="attempts" data-testid={`ai-task-step-attempts-${step.step}`}>已尝试 {step.attempts} 次</span>}
                        {step.started_at && <time title={formatTime(step.started_at)}>开始 {formatTime(step.started_at)}</time>}
                        {step.finished_at && <time title={formatTime(step.finished_at)}>结束 {formatTime(step.finished_at)}</time>}
                      </div>
                      {step.error && <p className="ai-step-error" data-testid={`ai-task-step-error-${step.step}`}>{step.error.code} · {step.error.message}</p>}
                      {step.error && (step.error.field || step.error.reason || step.error.response_shape) && (
                        <details className="ai-step-diagnostics" data-testid={`ai-task-step-diagnostics-${step.step}`}>
                          <summary>技术诊断</summary>
                          {step.error.field && <p><strong>field:</strong> {step.error.field}</p>}
                          {step.error.reason && <p><strong>reason:</strong> {step.error.reason}</p>}
                          {step.error.response_shape && <pre>{JSON.stringify(step.error.response_shape, null, 2)}</pre>}
                        </details>
                      )}
                      {step.retryable && ['partial', 'failed', 'blocked'].includes(task.state) && (
                        <div className="ai-task-retry-zone" data-testid={`ai-task-retry-zone-${step.step}`}>
                          {Object.keys(approvals).length > 0 && (
                            <div className="ai-approvals">
                              {approvals.paid_external_calls && <label><input type="checkbox" data-testid={`ai-task-paid-approval-${step.step}`} checked={allowPaid} onChange={(event) => setAllowPaid(event.target.checked)} />允许本计划中的付费采集或模型分析</label>}
                              {approvals.online_writes && <label><input type="checkbox" data-testid={`ai-task-write-approval-${step.step}`} checked={allowWrites} onChange={(event) => setAllowWrites(event.target.checked)} />允许把本计划产物保存到 staging</label>}
                              {approvals.handoff_creation && <label><input type="checkbox" data-testid={`ai-task-handoff-approval-${step.step}`} checked={allowHandoff} onChange={(event) => setAllowHandoff(event.target.checked)} />允许本计划创建交接包</label>}
                            </div>
                          )}
                          <button className="secondary-button" type="button" disabled={!approvalsReady || submitting} data-testid={`ai-task-retry-${step.step}`} onClick={() => retryFailedStep(step.step)}>
                            {submitting ? '正在重试…' : '仅重试此失败步骤'}
                          </button>
                        </div>
                      )}
                      </details>
                    </div>
                  </li>
                ))}
                </ol>
              </details>
            </section>
          )}

          {task.plan && (
            <section className="ai-task-panel" data-testid="ai-task-tool-calls">
              <div className="ai-task-panel-head">
                <div>
                  <p className="eyebrow">真实执行记录</p>
                  <h3>工具调用</h3>
                </div>
              </div>
              {!toolCalls.present ? (
                <div className="ai-task-empty" data-testid="ai-task-no-tool-calls">
                  服务端没有该任务的工具调用记录；计划步骤不等于已调用的工具。
                </div>
              ) : (
                <ul className="ai-tool-calls" data-testid="ai-task-tool-call-list">
                  {toolCalls.calls.map((call, index) => (
                    <li key={`${call.step || 'task'}-${call.tool || 'tool'}-${index}`} data-testid={`ai-task-tool-call-${index}`}>
                      <div className="ai-tool-call-copy">
                        <strong>{call.tool || call.operation || '工具调用'}</strong>
                        {call.operation && <small>{call.operation}</small>}
                        {call.step && <small>步骤 {call.step}</small>}
                      </div>
                      <div className="ai-step-badges">
                        <span className={`ai-tool-status ${call.status}`}>{call.status}</span>
                        {call.started_at && <time title={formatTime(call.started_at)}>开始 {formatTime(call.started_at)}</time>}
                        {call.finished_at && <time title={formatTime(call.finished_at)}>结束 {formatTime(call.finished_at)}</time>}
                      </div>
                      {call.error && <p className="ai-step-error">{call.error.code} · {call.error.message}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {view?.errorText && (
            <div className="notice error" data-testid="ai-task-error" role="alert">
              {view.errorText}
            </div>
          )}

          {!task.plan && !view?.errorText && (
            <div className="ai-task-empty" data-testid="ai-task-no-plan">
              该任务还没有权威计划，暂时没有可展示的执行信息。
            </div>
          )}

          <div className="ai-task-nav">
            <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai-results', task.id)}>查看结果与审核 →</button>
          </div>

          {technical && (
            <details className="ai-technical-details" data-testid="ai-task-technical-details">
              <summary>技术详情</summary>
              <dl className="ai-task-technical">
                <div><dt>task_id</dt><dd><code>{technical.task_id}</code></dd></div>
                <div><dt>project_id</dt><dd><code>{technical.project_id || '未绑定'}</code></dd></div>
                {technical.request_id && <div><dt>request_id</dt><dd><code>{technical.request_id}</code></dd></div>}
                {technical.plan_fingerprint && <div><dt>计划指纹</dt><dd><code>{technical.plan_fingerprint}</code></dd></div>}
                {technical.request_fingerprint && <div><dt>请求指纹</dt><dd><code>{technical.request_fingerprint}</code></dd></div>}
                <div><dt>内部状态</dt><dd>{technical.state || '—'}</dd></div>
                <div><dt>created_at</dt><dd>{formatTime(technical.created_at)}</dd></div>
                <div><dt>updated_at</dt><dd>{formatTime(technical.updated_at)}</dd></div>
                {technical.retry_target && <div><dt>retry_target</dt><dd><code>{technical.retry_target}</code></dd></div>}
                <div><dt>审批字段</dt><dd><code>{JSON.stringify(technical.confirmation_approvals)}</code></dd></div>
              </dl>
            </details>
          )}
        </>
      )}

      {validTaskId && !loading && !task && !error && (
        <div className="ai-task-empty" data-testid="ai-task-not-found">
          没有找到该任务的服务端记录。
        </div>
      )}
    </main>
  );
}
