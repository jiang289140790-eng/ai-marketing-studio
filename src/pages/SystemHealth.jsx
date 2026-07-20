import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { executeAgentTask, listAgentTasks } from '../services/agent-service';
import { getJobHistory, listJobs, runJob } from '../services/automation-service';
import { listCollectionRuns, listCollectionTasks, runCollection } from '../services/collector-service';
import { executePublishTask, getPublishHistory } from '../services/publish-service';
import {
  listAuditLogs,
  listCostRecords,
  listNotifications,
  markNotificationRead,
  recordCost,
  summarizeCosts,
  summarizeSystemHealth,
} from '../services/stability-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { createWorkflowRun, updateWorkflowStatus, listWorkflowRuns } from '../services/workflow-service';
import { formatDate, statusLabel } from '../utils/formatters';

const initialCost = {
  category: 'ai',
  source: '',
  amount: 0,
  revenue: 0,
};

export function SystemHealth({ userId }) {
  const [collectorRuns, setCollectorRuns] = useState([]);
  const [collectorTasks, setCollectorTasks] = useState([]);
  const [agentTasks, setAgentTasks] = useState([]);
  const [workflowRuns, setWorkflowRuns] = useState([]);
  const [publishTasks, setPublishTasks] = useState([]);
  const [automationJobs, setAutomationJobs] = useState([]);
  const [automationRuns, setAutomationRuns] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [costRecords, setCostRecords] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [costForm, setCostForm] = useState(initialCost);
  const [selectedError, setSelectedError] = useState(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextCollectorRuns, nextCollectorTasks, nextAgentTasks, nextWorkflowRuns, nextPublishTasks, nextAutomationJobs, nextAutomationRuns, nextNotifications, nextCostRecords, nextAuditLogs] = await Promise.all([
      listCollectionRuns(userId),
      listCollectionTasks(userId),
      listAgentTasks(userId),
      listWorkflowRuns(userId),
      getPublishHistory(userId),
      listJobs(userId),
      getJobHistory(userId),
      listNotifications(userId),
      listCostRecords(userId),
      listAuditLogs(userId),
    ]);
    setCollectorRuns(nextCollectorRuns);
    setCollectorTasks(nextCollectorTasks);
    setAgentTasks(nextAgentTasks);
    setWorkflowRuns(nextWorkflowRuns);
    setPublishTasks(nextPublishTasks);
    setAutomationJobs(nextAutomationJobs);
    setAutomationRuns(nextAutomationRuns);
    setNotifications(nextNotifications);
    setCostRecords(nextCostRecords);
    setAuditLogs(nextAuditLogs);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const health = useMemo(() => summarizeSystemHealth({
    collectorRuns,
    agentTasks,
    workflowRuns,
    publishTasks,
    automationRuns,
    notifications,
  }), [collectorRuns, agentTasks, workflowRuns, publishTasks, automationRuns, notifications]);
  const costs = useMemo(() => summarizeCosts(costRecords), [costRecords]);
  const failedTasks = useMemo(() => buildFailedTasks({ collectorRuns, agentTasks, workflowRuns, publishTasks, automationRuns, automationJobs }), [
    collectorRuns,
    agentTasks,
    workflowRuns,
    publishTasks,
    automationRuns,
    automationJobs,
  ]);

  async function handleRecordCost(event) {
    event.preventDefault();
    try {
      await recordCost(userId, costForm);
      setCostForm(initialCost);
      setMessage('成本记录已保存。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleRead(notification) {
    try {
      await markNotificationRead(notification.id);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleRetry(task) {
    try {
      if (task.kind === 'Publish') {
        await executePublishTask(userId, task.raw);
        setMessage('发布任务已重新执行。');
      } else if (task.kind === 'Collector') {
        const collectionTask = collectorTasks.find((item) => item.id === task.raw.task_id);
        if (!collectionTask) throw new Error('找不到对应的采集任务。');
        await runCollection(userId, collectionTask);
        setMessage('采集任务已重新执行。');
      } else if (task.kind === 'Agent') {
        if (!task.raw.agents) throw new Error('找不到对应的 Agent 配置。');
        await executeAgentTask(userId, task.raw.agents, {
          ...(task.raw.input_data || {}),
          workflow_id: task.raw.workflow_id || task.raw.input_data?.workflow_id || null,
        });
        setMessage('Agent 任务已重新执行。');
      } else if (task.kind === 'Workflow') {
        const nextRun = await createWorkflowRun(userId, {
          workflow_id: task.raw.workflow_id,
          tool_id: task.raw.tool_id,
          character_id: task.raw.character_id,
          prompt_id: task.raw.prompt_id,
          asset_ids: task.raw.asset_ids || [],
          input_data: task.raw.input_data || {},
          cost: task.raw.cost || 0,
          status: 'running',
        });
        await updateWorkflowStatus(nextRun.id, 'success', {
          output_data: {
            copied_from_failed_run_id: task.raw.id,
            note: 'Manual retry created a new workflow run placeholder. Connect the real generator to save final assets.',
          },
        });
        setMessage('Workflow 已重新创建一条运行记录。');
      } else if (task.kind === 'Automation') {
        const job = automationJobs.find((item) => item.id === task.raw.job_id);
        if (!job) throw new Error('找不到对应的 Automation Job。');
        await runJob(userId, job);
        setMessage('Automation Job 已重新执行。');
      } else {
        setSelectedError(task);
        setMessage('该任务类型暂未接入一键重试，请查看错误详情后在对应模块手动处理。');
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Production Health</p>
          <h2>System Health</h2>
          <p>集中查看任务成功率、失败率、队列状态、API 状态、失败通知、成本趋势和审计记录。</p>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后会读取任务、通知、成本和审计日志。" />
      ) : (
        <>
          <div className="stat-grid compact">
            <StatCard label="任务总数" value={loading ? '—' : health.totalTasks} hint="Collector / Agent / Workflow / Publish / Automation" />
            <StatCard label="成功率" value={loading ? '—' : `${health.successRate}%`} hint="success + published / total" />
            <StatCard label="失败率" value={loading ? '—' : `${health.failureRate}%`} hint="failed + error / total" />
            <StatCard label="队列状态" value={loading ? '—' : health.queueCount} hint="queued / running / pending" />
            <StatCard label="API状态" value={loading ? '—' : statusLabel(health.apiStatus)} hint="失败任务存在时需关注" />
            <StatCard label="未读通知" value={loading ? '—' : health.unreadNotifications} hint="notifications unread" />
          </div>

          <div className="stat-grid compact">
            <StatCard label="今日成本" value={loading ? '—' : costs.todayCost.toFixed(2)} hint="今日 cost_records" />
            <StatCard label="今日利润" value={loading ? '—' : costs.todayProfit.toFixed(2)} hint="revenue - cost" />
            <StatCard label="AI成本" value={loading ? '—' : costs.aiCost.toFixed(2)} hint="category=ai" />
            <StatCard label="Workflow成本" value={loading ? '—' : costs.workflowCost.toFixed(2)} hint="category=workflow" />
            <StatCard label="API成本" value={loading ? '—' : costs.apiCost.toFixed(2)} hint="category=api" />
            <StatCard label="累计利润" value={loading ? '—' : costs.profit.toFixed(2)} hint="total revenue - total cost" />
          </div>

          <form className="form-card" onSubmit={handleRecordCost}>
            <p className="eyebrow">Cost Monitoring</p>
            <h3>补录成本 / 收入</h3>
            <div className="form-grid">
              <label>
                类型
                <select value={costForm.category} onChange={(event) => setCostForm({ ...costForm, category: event.target.value })}>
                  <option value="ai">AI成本</option>
                  <option value="workflow">Workflow成本</option>
                  <option value="api">API成本</option>
                </select>
              </label>
              <label>
                来源
                <input value={costForm.source} onChange={(event) => setCostForm({ ...costForm, source: event.target.value })} placeholder="例如 Telegram Bot / ComfyUI / Qwen" />
              </label>
              <label>
                成本
                <input type="number" min="0" step="0.0001" value={costForm.amount} onChange={(event) => setCostForm({ ...costForm, amount: event.target.value })} />
              </label>
              <label>
                收入
                <input type="number" min="0" step="0.0001" value={costForm.revenue} onChange={(event) => setCostForm({ ...costForm, revenue: event.target.value })} />
              </label>
            </div>
            <button className="primary-button" type="submit">保存成本记录</button>
          </form>

          {message && <div className="notice">{message}</div>}

          <div className="content-grid">
            {health.groups.map((group) => (
              <article className="analysis-card" key={group.name}>
                <p className="eyebrow">{group.name}</p>
                <div className="metric-row"><span>总数</span><strong>{group.total}</strong></div>
                <div className="metric-row"><span>成功率</span><strong>{group.successRate}%</strong></div>
                <div className="metric-row"><span>失败</span><strong>{group.failed}</strong></div>
                <div className="metric-row"><span>队列/运行</span><strong>{group.queued}</strong></div>
              </article>
            ))}
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>失败任务</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th>重试</th>
                  <th>错误</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {failedTasks.map((task) => (
                  <tr key={task.id}>
                    <td>{task.title}</td>
                    <td>{task.kind}</td>
                    <td><StatusBadge status={task.status} /></td>
                    <td>{task.retry_count}/{task.max_retry}</td>
                    <td>{task.error || '—'}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" onClick={() => handleRetry(task)}>重试</button>
                        <button type="button" onClick={() => setSelectedError(task)}>详情</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {failedTasks.length === 0 && <tr><td colSpan="6">暂无失败任务</td></tr>}
              </tbody>
            </table>
          </div>

          {selectedError && (
            <aside className="detail-panel">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Error Detail</p>
                  <h2>{selectedError.title}</h2>
                </div>
                <button className="ghost-button" type="button" onClick={() => setSelectedError(null)}>关闭</button>
              </div>
              <pre className="code-preview">{JSON.stringify(selectedError.raw, null, 2)}</pre>
            </aside>
          )}

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>成本</th>
                  <th>收入</th>
                  <th>利润</th>
                </tr>
              </thead>
              <tbody>
                {costs.trend.map((item) => (
                  <tr key={item.date}>
                    <td>{item.date}</td>
                    <td>{item.cost.toFixed(2)}</td>
                    <td>{item.revenue.toFixed(2)}</td>
                    <td>{item.profit.toFixed(2)}</td>
                  </tr>
                ))}
                {costs.trend.length === 0 && <tr><td colSpan="4">暂无成本趋势</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>通知</th>
                  <th>类型</th>
                  <th>渠道</th>
                  <th>状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {notifications.slice(0, 10).map((notification) => (
                  <tr key={notification.id}>
                    <td>{notification.title}<br /><small>{notification.message}</small></td>
                    <td>{statusLabel(notification.type)}</td>
                    <td>{notification.channel}</td>
                    <td><StatusBadge status={notification.status} /></td>
                    <td>{formatDate(notification.created_at)}</td>
                    <td>{notification.status === 'unread' && <button type="button" onClick={() => handleRead(notification)}>标记已读</button>}</td>
                  </tr>
                ))}
                {notifications.length === 0 && <tr><td colSpan="6">暂无通知</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>审计对象</th>
                  <th>动作</th>
                  <th>时间</th>
                  <th>摘要</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.slice(0, 12).map((log) => (
                  <tr key={log.id}>
                    <td>{log.entity_type}</td>
                    <td>{log.action}</td>
                    <td>{formatDate(log.created_at)}</td>
                    <td>{log.after_data?.title || log.after_data?.name || log.after_data?.url || log.before_data?.title || log.before_data?.name || '—'}</td>
                  </tr>
                ))}
                {auditLogs.length === 0 && <tr><td colSpan="4">暂无审计记录</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function buildFailedTasks({ collectorRuns, agentTasks, workflowRuns, publishTasks, automationRuns, automationJobs }) {
  const automationJobNames = new Map(automationJobs.map((job) => [job.id, job.name]));
  return [
    ...collectorRuns.filter(isFailed).map((row) => toFailedTask('Collector', row.id, row.collection_tasks?.content_sources?.name || 'Collector Run', row)),
    ...agentTasks.filter(isFailed).map((row) => toFailedTask('Agent', row.id, row.agents?.name || row.task_type || 'Agent Task', row)),
    ...workflowRuns.filter(isFailed).map((row) => toFailedTask('Workflow', row.id, row.workflow?.name || row.tool_id || 'Workflow Run', row)),
    ...publishTasks.filter(isFailed).map((row) => toFailedTask('Publish', row.id, row.content_library?.title || row.platform || 'Publish Task', row)),
    ...automationRuns.filter(isFailed).map((row) => toFailedTask('Automation', row.id, automationJobNames.get(row.job_id) || row.automation_jobs?.name || 'Automation Run', row)),
  ].slice(0, 30);
}

function isFailed(row) {
  return ['failed', 'error'].includes(row.status);
}

function toFailedTask(kind, id, title, row) {
  return {
    kind,
    id: `${kind}-${id}`,
    title,
    status: row.status,
    retry_count: Number(row.retry_count || 0),
    max_retry: Number(row.max_retry || 3),
    error: row.last_error || row.error_message || row.error || row.result?.error || '',
    raw: row,
  };
}
