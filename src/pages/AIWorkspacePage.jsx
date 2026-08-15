import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHarnessClient, newHarnessRequestId, readHarnessActiveProject } from '../services/harness-client.js';
import { resolvePresentationBlocks } from '../services/harness-presentation.js';
import { PresentationPanel } from '../components/harness-presentation/PresentationPanel.jsx';
import './AIWorkspacePage.css';

const suggestions = [
  '分析这个 X 帖子，保存证据和分析，并生成待审核 Brief',
  '搜索 X 和 Reddit 上本周最热门的话题，选 5 条保存为证据',
  '比较当前项目中表现最好的帖子，提炼可复用的内容规律',
  '根据已审核知识卡生成一个新的内容策划草案',
];

const stateLabels = {
  queued: '等待执行',
  running: '正在执行',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};

function taskFromResponse(value) {
  return value?.task && typeof value.task === 'object' ? value.task : null;
}

export function AIWorkspacePage({ onNavigate, harnessClient: providedHarnessClient }) {
  const harnessClient = useMemo(() => providedHarnessClient || createHarnessClient(), [providedHarnessClient]);
  const [intent, setIntent] = useState('');
  const [allowPaid, setAllowPaid] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowHandoff, setAllowHandoff] = useState(false);
  const [activeTask, setActiveTask] = useState(null);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pollGeneration = useRef(0);
  const pollInFlight = useRef(false);
  const pendingSubmission = useRef(null);

  const refreshHistory = useCallback(async () => {
    try {
      const response = await harnessClient.list(30);
      setHistory(Array.isArray(response.tasks) ? response.tasks : []);
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

  const plan = useMemo(() => {
    if (!intent.trim()) return [];
    const steps = ['理解目标并读取当前项目状态'];
    if (/搜索|采集|帖子|reddit|\bx\b/i.test(intent)) steps.push('通过已允许的研究工具获取公开来源');
    if (/分析|比较|规律|知识|brief|草案/i.test(intent)) steps.push('分析来源并形成可追溯结果');
    if (allowWrites) steps.push('把确认后的产物保存到当前 staging 工作区');
    else steps.push('仅返回预览，不写入在线工作区');
    return steps;
  }, [allowWrites, intent]);
  const needsHandoff = /交接包|handoff/i.test(intent);

  async function submit(event) {
    event.preventDefault();
    if (!intent.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const normalizedIntent = intent.trim();
      const projectId = readHarnessActiveProject();
      const approval = { paid_external_calls: allowPaid, online_writes: allowWrites, handoff_creation: needsHandoff && allowHandoff };
      const submissionKey = JSON.stringify([projectId, normalizedIntent, approval]);
      if (pendingSubmission.current?.key !== submissionKey) {
        pendingSubmission.current = { key: submissionKey, requestId: newHarnessRequestId() };
      }
      const response = await harnessClient.submit({
        requestId: pendingSubmission.current.requestId,
        projectId,
        intent: normalizedIntent,
        approval,
      });
      const task = taskFromResponse(response);
      if (!task) throw new Error('任务入口没有返回任务记录。');
      pendingSubmission.current = null;
      setActiveTask(task);
      setIntent('');
      setAllowPaid(false);
      setAllowWrites(false);
      setAllowHandoff(false);
    } catch (caught) {
      setError(caught?.message || '任务提交失败。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="ai-workspace" data-testid="harness-ai-workspace">
      <section className="ai-hero">
        <div>
          <span className="ai-kicker">AI 营销工作台</span>
          <h1>告诉我你想完成什么</h1>
          <p>用一句话完成采集、分析、知识沉淀和内容策划。系统会先显示计划，涉及费用和保存时由你明确批准。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => onNavigate?.('research')}>进入高级研究模式</button>
      </section>

      <section className="ai-command-card">
        <form onSubmit={submit}>
          <label htmlFor="ai-intent">任务目标</label>
          <textarea
            id="ai-intent"
            data-testid="harness-intent"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            placeholder="例如：分析这条 X 帖子，保存证据和多模态分析，然后生成待审核 Brief"
            maxLength={12000}
            rows={5}
          />
          <div className="ai-suggestions" aria-label="常用任务">
            {suggestions.map((text) => <button key={text} type="button" onClick={() => setIntent(text)}>{text}</button>)}
          </div>

          {plan.length > 0 && (
            <div className="ai-plan" data-testid="harness-plan">
              <strong>本次执行计划</strong>
              <ol>{plan.map((step) => <li key={step}>{step}</li>)}</ol>
            </div>
          )}

          <div className="ai-approvals">
            <label><input type="checkbox" checked={allowPaid} onChange={(event) => setAllowPaid(event.target.checked)} />允许本次付费采集或模型分析</label>
            <label><input type="checkbox" checked={allowWrites} onChange={(event) => setAllowWrites(event.target.checked)} />允许把本次结果保存到 staging</label>
            {needsHandoff && <label><input data-testid="harness-handoff-approval" type="checkbox" checked={allowHandoff} onChange={(event) => setAllowHandoff(event.target.checked)} />允许本次任务创建交接包</label>}
          </div>
          <div className="ai-submit-row">
            <span>不会删除数据、修改权限、自动发布或访问 production。</span>
            <button className="primary-button" data-testid="harness-submit" type="submit" disabled={!intent.trim() || !allowPaid || (needsHandoff && (!allowWrites || !allowHandoff)) || submitting}>
              {submitting ? '正在提交…' : '确认并开始'}
            </button>
          </div>
        </form>
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      {activeTask && (
        <section className="ai-active-task" data-testid="harness-active-task">
          <div className="ai-section-heading">
            <div><span>当前任务</span><h2>{stateLabels[activeTask.state] || activeTask.state}</h2></div>
            {['queued', 'running'].includes(activeTask.state) && <button type="button" className="secondary-button" onClick={() => harnessClient.cancel(activeTask.id).then((value) => setActiveTask(taskFromResponse(value) || activeTask)).catch((caught) => setError(caught.message))}>取消任务</button>}
          </div>
          <div className="ai-progress" aria-label="任务进度"><span className={activeTask.state} /></div>
          <p>{activeTask.request?.intent}</p>
          {presentationBlocks.length > 0 && <PresentationPanel blocks={presentationBlocks} />}
          {activeTask.result?.final_response && (
            presentationBlocks.length > 0 ? (
              <details className="ai-raw-response">
                <summary>查看原始回复</summary>
                <div className="ai-result-copy">{activeTask.result.final_response}</div>
              </details>
            ) : (
              <div className="ai-result-copy">{activeTask.result.final_response}</div>
            )
          )}
          {activeTask.error && <div className="notice error">{activeTask.error.message || activeTask.error.code}</div>}
          {activeTask.result?.artifact_refs?.length > 0 && (
            <div className="ai-artifacts">
              <strong>本次产物</strong>
              {activeTask.result.artifact_refs.map((ref) => <code key={ref}>{ref}</code>)}
            </div>
          )}
        </section>
      )}

      <section className="ai-history">
        <div className="ai-section-heading"><div><span>任务与成果</span><h2>最近记录</h2></div><button type="button" className="secondary-button" onClick={refreshHistory}>刷新</button></div>
        {history.length === 0 ? <div className="ai-empty">还没有 Harness 任务。你可以从上方的一句话开始。</div> : (
          <div className="ai-task-list">{history.map((task) => (
            <button key={task.id} type="button" onClick={async () => {
              try {
                const response = await harnessClient.read(task.id);
                setActiveTask(taskFromResponse(response) || task);
              } catch (caught) {
                setError(caught?.message || '无法读取完整任务记录。');
              }
            }}>
              <span className={`ai-task-state ${task.state}`}>{stateLabels[task.state] || task.state}</span>
              <strong>{task.request?.intent || '未命名任务'}</strong>
              <time>{task.updated_at ? new Date(task.updated_at).toLocaleString('zh-CN') : ''}</time>
            </button>
          ))}</div>
        )}
      </section>
    </main>
  );
}
