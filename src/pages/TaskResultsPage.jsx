import { useCallback, useEffect, useMemo, useState } from 'react';
import { createHarnessClient } from '../services/harness-client.js';
import { resolvePresentationBlocks } from '../services/harness-presentation.js';
import { PresentationPanel } from '../components/harness-presentation/PresentationPanel.jsx';
import {
  APPROVAL_LABELS,
  APPROVAL_REQUIREMENTS,
  buildSourceChain,
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  reviewSummary,
  stateLabel,
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

/**
 * 任务结果与审核页：`#/ai-results/<taskId>`。
 *
 * 只读取真实服务端任务快照（harness read），展示任务结果、产物身份、
 * 来源链与审核状态（人工确认范围 + 当前状态）。绝不静态模拟任务或成功；
 * 无结果即诚实空态，非终态明确提示尚未产生结果。
 */
export function TaskResultsPage({ detailId: taskId = '', onNavigate, harnessClient: providedHarnessClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFullResult, setShowFullResult] = useState(false);

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

  const review = useMemo(() => (task ? reviewSummary(task) : null), [task]);
  const chain = useMemo(() => buildSourceChain(task), [task]);
  const presentationBlocks = useMemo(() => resolvePresentationBlocks(task), [task]);
  const chainCount = chain.evidence.length + chain.knowledge.length + chain.brief.length + chain.generation.length + chain.other.length;
  const taskError = task ? taskErrorText(task) : '';
  const finalResponse = task?.result?.final_response || '';
  const terminal = task && ['succeeded', 'reused', 'partial', 'failed', 'blocked', 'cancelled'].includes(task.state);
  const resultHeadline = chain.evidence.length > 0
    ? `${chain.evidence.length} 条内容已保存为证据`
    : chainCount > 0
      ? `${chainCount} 项成果已生成`
      : task?.state === 'succeeded' || task?.state === 'reused'
        ? '任务已完成'
        : '任务尚未产生结果';

  return (
    <main className="ai-task-page" data-testid="ai-task-results">
      <div className="ai-task-head">
        <div>
          <p className="eyebrow">任务结果与审核</p>
          <h2>{task?.request?.intent ? '结果与审核' : '任务结果与审核'}</h2>
          <p>结果、产物、来源链与人工确认范围均来自真实服务端；刷新页面不会丢失当前任务。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai-execution', taskId)}>返回执行详情</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate?.('ai')}>返回新任务首页</button>
        </div>
      </div>

      {!validTaskId && !loading && (
        <div className="notice error" data-testid="ai-task-invalid-id" role="alert">
          任务编号格式无效，无法读取结果与审核。请从新任务首页选择一条真实任务。
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
              {review?.workflow_title && <span>流程 {review.workflow_title}</span>}
            </div>
          </section>

          <section className="ai-task-panel" data-testid="ai-task-review">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">审核状态</p>
                <h3>{review?.label || '—'}</h3>
              </div>
              {review?.plan_fingerprint && <code title={review.plan_fingerprint}>{review.plan_fingerprint.slice(0, 12)}…</code>}
            </div>
            {review && (
              <div className="ai-review-details" data-testid="ai-review-details">
                <div className="detail-card"><span>任务状态</span><div>{review.label}</div></div>
                <div className="detail-card"><span>计划阶段</span><div>{review.phase === 'planned' ? '等待人工确认' : review.phase === 'active' ? '已确认，执行中' : review.phase === 'attention' ? '需要处理' : '已结束'}</div></div>
                <div className="detail-card"><span>人工确认范围</span><div>{APPROVAL_REQUIREMENTS.some((key) => review.approvals[key]) ? APPROVAL_REQUIREMENTS.filter((key) => review.approvals[key]).map((key) => APPROVAL_LABELS[key]).join('、') : review.phase === 'planned' ? '尚未确认' : '无付费/写入授权'}</div></div>
                <div className="detail-card"><span>需要授权</span><div>{Object.keys(review.requiredApprovals || {}).length ? APPROVAL_REQUIREMENTS.filter((key) => review.requiredApprovals[key]).map((key) => APPROVAL_LABELS[key]).join('、') : '无'}</div></div>
              </div>
            )}
          </section>

          {taskError && (
            <div className="notice error" data-testid="ai-task-error" role="alert">
              {taskError}
            </div>
          )}

          <section className="ai-task-panel" data-testid="ai-task-result">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">任务结果</p>
                <h3>{resultHeadline}</h3>
              </div>
            </div>
            {!terminal ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                任务还在 {stateLabel(task.state)}，尚未产生最终结果。
              </div>
            ) : !finalResponse && chainCount === 0 ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                该任务已结束，但服务端没有记录任何结果或产物。
              </div>
            ) : (
              <>
                {finalResponse && (
                  <div className="ai-result-copy" data-testid="ai-task-final-response">
                    {finalResponse.slice(0, 800)}{finalResponse.length > 800 ? '…' : ''}
                  </div>
                )}
                {finalResponse && (
                  <button className="ghost-button compact" type="button" aria-expanded={showFullResult} onClick={() => setShowFullResult((value) => !value)}>
                    {showFullResult ? '收起完整执行报告' : '查看完整执行报告'}
                  </button>
                )}
                {showFullResult && finalResponse && <div className="ai-result-copy" data-testid="ai-task-full-response">{finalResponse}</div>}
                {task?.result?.result_data != null && (
                  <details className="ai-technical-details">
                    <summary>结构化结果</summary>
                    <pre className="ai-result-copy">{JSON.stringify(task.result.result_data, null, 2)}</pre>
                  </details>
                )}
              </>
            )}
          </section>

          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}

          <section className="ai-task-panel" data-testid="ai-task-chain">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">来源链</p>
                <h3>产物与来源身份</h3>
              </div>
            </div>
            {chainCount === 0 ? (
              <div className="ai-task-empty" data-testid="ai-task-no-chain">
                服务端没有记录产物或来源身份。
              </div>
            ) : (
              <>
                <div className="ai-chain-meta">
                  {chain.project_id && <span>项目绑定 <code>{chain.project_id}</code></span>}
                  {chain.evidence.length > 0 && <span>证据 {chain.evidence.length} 条</span>}
                  {chain.knowledge.length > 0 && <span>知识卡 {chain.knowledge.length} 张</span>}
                  {chain.brief.length > 0 && <span>Brief {chain.brief.length} 份</span>}
                  {chain.generation.length > 0 && <span>生成产物 {chain.generation.length} 项</span>}
                </div>
                <dl className="ai-chain-list" data-testid="ai-task-chain-list">
                  {chain.evidence.map((id) => <div key={`ev-${id}`}><dt>证据</dt><dd><code>{id}</code></dd></div>)}
                  {chain.knowledge.map((id) => <div key={`kc-${id}`}><dt>知识卡</dt><dd><code>{id}</code></dd></div>)}
                  {chain.brief.map((id) => <div key={`brf-${id}`}><dt>Brief</dt><dd><code>{id}</code></dd></div>)}
                  {chain.generation.map((id) => <div key={`g1x-${id}`}><dt>生成产物</dt><dd><code>{id}</code></dd></div>)}
                  {chain.other.map((id) => <div key={`other-${id}`}><dt>身份引用</dt><dd><code>{id}</code></dd></div>)}
                </dl>
              </>
            )}
          </section>

          {task?.result?.artifact_refs?.length > 0 && (
            <details className="ai-technical-details" data-testid="ai-task-artifact-refs">
              <summary>原始产物身份</summary>
              <div className="ai-artifacts">{task.result.artifact_refs.map((ref) => <code key={ref}>{ref}</code>)}</div>
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
