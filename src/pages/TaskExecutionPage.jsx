import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient } from '../services/harness-client.js';
import {
  APPROVAL_LABELS,
  APPROVAL_REQUIREMENTS,
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  requiredApprovals,
  stateLabel,
  stepExecutionView,
  taskErrorText,
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

/**
 * 任务执行详情页：`#/ai-execution/<taskId>`。
 *
 * 只读取真实服务端任务快照（harness read），展示权威计划、逐步执行
 * 进度（attempt/event/failure 由 step_states 的真实字段派生）、失败诊断与
 * 重试。确认/重试仍走既有 plan → 人工授权边界；本页任何操作都不静默
 * 触发付费 Provider。没有数据时展示诚实错误/空态。
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

  // 活动任务有界轮询：queued/running 期间每 1.5s 读取真实状态，终态自动停止。
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

  const steps = useMemo(() => (task ? stepExecutionView(task) : []), [task]);
  const approvals = useMemo(() => requiredApprovals(task), [task]);
  const approvalsReady = (!approvals.paid_external_calls || allowPaid)
    && (!approvals.online_writes || allowWrites)
    && (!approvals.handoff_creation || allowHandoff);
  const phase = task?.state === 'planned' ? 'planned'
    : ['queued', 'running'].includes(task?.state) ? 'active'
      : ['partial', 'failed', 'blocked'].includes(task?.state) ? 'attention' : 'terminal';

  async function cancelTask() {
    if (!task || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await harnessClient.cancel(task.id);
      const next = normalizeTaskSnapshot(response?.task);
      if (next) setTask(next);
      else setTask((current) => ({ ...current, state: 'cancelled' }));
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

  const taskError = task ? taskErrorText(task) : '';

  return (
    <main className="ai-task-page" data-testid="ai-task-execution">
      <div className="ai-task-head">
        <div>
          <p className="eyebrow">任务执行详情</p>
          <h2>{task?.request?.intent ? '执行中的任务' : '任务执行详情'}</h2>
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
              <span className={`status-badge ${task.state}`}>{stateLabel(task.state)}</span>
              <code title={task.id}>{task.id}</code>
              <small>更新于 {formatTime(task.updated_at)}</small>
            </div>
            {task.request?.intent && <p className="ai-task-intent">{task.request.intent}</p>}
            <div className="ai-task-meta">
              <span>项目 {task.request?.project_id || '未绑定'}</span>
              {task.plan && <span>计划 {task.plan.fingerprint ? `${task.plan.fingerprint.slice(0, 12)}…` : '—'}</span>}
              {task.plan && <span>流程 {task.plan.workflow_title || '—'}</span>}
            </div>
            {['planned', 'queued', 'running'].includes(task.state) && (
              <div className="ai-task-actions">
                <button className="secondary-button" type="button" disabled={submitting} data-testid="ai-task-cancel" onClick={cancelTask}>取消任务</button>
              </div>
            )}
          </section>

          {phase === 'planned' && task.plan && (
            <div className="notice" data-testid="ai-task-pending-confirm">
              权威计划已生成，等待人工确认。请回到新任务首页完成“确认并开始执行”；确认授权范围见下方计划。
            </div>
          )}

          {task.plan && (
            <section className="ai-task-panel" data-testid="ai-task-plan">
              <div className="ai-task-panel-head">
                <div>
                  <p className="eyebrow">权威执行计划 · 不可编辑</p>
                  <h3>{task.plan.workflow_title || '执行计划'}</h3>
                </div>
                <code title={task.plan.fingerprint}>{task.plan.fingerprint ? `${task.plan.fingerprint.slice(0, 12)}…` : '无指纹'}</code>
              </div>
              {Object.keys(approvals).length > 0 && (
                <div className="ai-task-approvals" data-testid="ai-task-approvals">
                  {APPROVAL_REQUIREMENTS.filter((key) => approvals[key]).map((key) => (
                    <span className="approval-chip" key={key}>需要授权：{APPROVAL_LABELS[key]}</span>
                  ))}
                </div>
              )}
              <ol className="ai-task-steps">
                {steps.map((step) => (
                  <li key={step.step} data-testid={`ai-task-step-${step.step}`} data-state={step.state}>
                    <span className={`ai-step-state ${step.state}`}>{step.stateLabel}</span>
                    <div className="ai-step-copy">
                      <strong>{step.label}</strong>
                      <small>{step.operation} · 前置：{step.depends_on.length ? step.depends_on.join('、') : '无'}</small>
                      <div className="ai-step-badges">
                        {step.reuse && <span>可精确复用</span>}
                        {step.cost && <span className="cost">可能付费</span>}
                        {step.write && <span className="write">写入 staging</span>}
                        {step.attempts > 0 && <span className="attempts">已尝试 {step.attempts + 1} 次</span>}
                        {step.started_at && <time title={formatTime(step.started_at)}>开始 {formatTime(step.started_at)}</time>}
                        {step.finished_at && <time title={formatTime(step.finished_at)}>结束 {formatTime(step.finished_at)}</time>}
                      </div>
                      {step.error && <p className="ai-step-error" data-testid={`ai-task-step-error-${step.step}`}>{step.error.code} · {step.error.message}</p>}
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
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {taskError && (
            <div className="notice error" data-testid="ai-task-error" role="alert">
              {taskError}
            </div>
          )}

          {!task.plan && !taskError && (
            <div className="ai-task-empty" data-testid="ai-task-no-plan">
              该任务还没有权威计划，暂时没有可展示的执行信息。
            </div>
          )}

          <div className="ai-task-nav">
            <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai-results', task.id)}>查看结果与审核 →</button>
          </div>
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
