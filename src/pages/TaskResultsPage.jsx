import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient } from '../services/harness-client.js';
import { resolvePresentationBlocks } from '../services/harness-presentation.js';
import { PresentationPanel } from '../components/harness-presentation/PresentationPanel.jsx';
import {
  isValidHarnessTaskId,
  normalizeTaskSnapshot,
  stateLabel,
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

// 结果页五分类展示顺序与标签（每类都从同一 snapshot 派生，缺失逐类空态）。
const RESULT_SECTION_ORDER = [
  ['evidence', 'Evidence'],
  ['analysis', 'Analysis'],
  ['knowledge', 'Knowledge'],
  ['brief', 'Brief'],
  ['artifact', 'Artifact'],
];

/**
 * 任务结果与审核页：规范路由 `/tasks/<taskId>/results`（旧 `#/ai-results/<taskId>` 兼容重定向）。
 *
 * 只读取真实服务端任务快照（harness read），结果五分类
 * （Evidence / Analysis / Knowledge / Brief / Artifact）全部从同一 snapshot
 * 的 result / result_data / artifact_refs 派生；各类型缺失时逐类显示明确
 * 空状态，绝不使用 demo/fixture/static success。非终态任务明确提示尚未
 * 产生结果；轮询更新原子替换整个 snapshot。
 */
export function TaskResultsPage({ detailId: taskId = '', onNavigate, harnessClient: providedHarnessClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [task, setTask] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFullResult, setShowFullResult] = useState(false);
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

  // 活动任务有界轮询：queued/running 期间每 1.5s 原子替换整个 snapshot。
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

  const view = useMemo(() => taskSnapshotView(task), [task]);
  const chain = view?.chain || null;
  const sections = view?.sections || null;
  const technical = view?.technical || null;
  const presentationBlocks = useMemo(() => resolvePresentationBlocks(task), [task]);
  const finalResponse = task?.result?.final_response || '';
  const terminal = task && ['succeeded', 'reused', 'partial', 'failed', 'blocked', 'cancelled'].includes(task.state);
  const notTerminalText = task ? `任务还在 ${stateLabel(task.state)}，尚未产生最终结果。` : '';

  return (
    <main className="ai-task-page" data-testid="ai-task-results">
      <div className="ai-task-head">
        <div>
          <p className="eyebrow">任务结果与审核</p>
          <h2>{view?.intent ? '结果与审核' : '任务结果与审核'}</h2>
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
              <span className={`status-badge ${task.state}`}>{view.stateLabel}</span>
            </div>
            {view.intent && <p className="ai-task-intent">{view.intent}</p>}
            {view.workflowTitle && <div className="ai-task-meta"><span>流程 {view.workflowTitle}</span></div>}
          </section>

          <section className="ai-task-panel" data-testid="ai-task-review">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">审核状态</p>
                <h3>{view.stateLabel}</h3>
              </div>
            </div>
            <div className="ai-review-details" data-testid="ai-review-details">
              <div className="detail-card"><span>任务状态</span><div>{view.stateLabel}</div></div>
              <div className="detail-card"><span>计划阶段</span><div>{view.phase === 'planned' ? '等待人工确认' : view.phase === 'active' ? '已确认，执行中' : view.phase === 'attention' ? '需要处理' : '已结束'}</div></div>
            </div>
          </section>

          {view?.errorText && (
            <div className="notice error" data-testid="ai-task-error" role="alert">
              {view.errorText}
            </div>
          )}

          <section className="ai-task-panel" data-testid="ai-task-result">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">任务结果</p>
                <h3>{view.headline}</h3>
              </div>
            </div>
            {!terminal ? (
              <div className="ai-task-empty" data-testid="ai-task-no-result">
                {notTerminalText}
              </div>
            ) : !finalResponse && !chain?.evidence.length && !chain?.analysis.length && !chain?.knowledge.length && !chain?.brief.length && !chain?.generation.length && !task?.result?.result_data ? (
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
              </>
            )}
          </section>

          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}

          <section className="ai-task-panel" data-testid="ai-task-sections">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">结果分类</p>
                <h3>Evidence · Analysis · Knowledge · Brief · Artifact</h3>
              </div>
            </div>
            <div className="ai-result-sections">
              {RESULT_SECTION_ORDER.map(([key, label]) => {
                const section = sections?.[key] || { present: false, items: [] };
                return (
                  <div className="ai-result-section" key={key} data-testid={`ai-task-section-${key}`}>
                    <div className="ai-result-section-head"><strong>{label}</strong>{section.present && <span>{section.items.length} 项</span>}</div>
                    {!terminal ? (
                      <div className="ai-task-empty">{notTerminalText}</div>
                    ) : !section.present ? (
                      <div className="ai-task-empty" data-testid={`ai-task-no-${key}`}>服务端没有记录该任务的 {label} 数据。</div>
                    ) : (
                      <ul className="ai-section-items" data-testid={`ai-task-${key}-items`}>
                        {section.items.map((item) => (
                          <li key={`${item.kind}-${item.id || item.summary || item.name}`}>
                            {item.id && <code>{item.id}</code>}
                            {(item.summary || item.name) && <span>{item.summary || item.name}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="ai-task-panel" data-testid="ai-task-chain">
            <div className="ai-task-panel-head">
              <div>
                <p className="eyebrow">来源链</p>
                <h3>产物与来源身份</h3>
              </div>
            </div>
            {!chain || (!chain.evidence.length && !chain.analysis.length && !chain.knowledge.length && !chain.brief.length && !chain.generation.length && !chain.other.length) ? (
              <div className="ai-task-empty" data-testid="ai-task-no-chain">
                服务端没有记录产物或来源身份。
              </div>
            ) : (
              <>
                <div className="ai-chain-meta">
                  {chain.project_id && <span>项目绑定 <code>{chain.project_id}</code></span>}
                  {chain.evidence.length > 0 && <span>证据 {chain.evidence.length} 条</span>}
                  {chain.analysis.length > 0 && <span>分析 {chain.analysis.length} 项</span>}
                  {chain.knowledge.length > 0 && <span>知识卡 {chain.knowledge.length} 张</span>}
                  {chain.brief.length > 0 && <span>Brief {chain.brief.length} 份</span>}
                  {chain.generation.length > 0 && <span>生成产物 {chain.generation.length} 项</span>}
                </div>
                <dl className="ai-chain-list" data-testid="ai-task-chain-list">
                  {chain.evidence.map((id) => <div key={`ev-${id}`}><dt>证据</dt><dd><code>{id}</code></dd></div>)}
                  {chain.analysis.map((id) => <div key={`an-${id}`}><dt>分析</dt><dd><code>{id}</code></dd></div>)}
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
