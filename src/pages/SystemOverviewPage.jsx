import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { countWhere, getLatest, loadSystemStatusData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function SystemOverviewPage({ userId }) {
  const [data, setData] = useState({ agentRuns: [], workflowRuns: [], publishTasks: [], publishMetrics: [], contentMetrics: [] });

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    loadSystemStatusData().then((nextData) => setData({ agentRuns: [], workflowRuns: [], publishTasks: [], publishMetrics: [], contentMetrics: [], ...nextData }));
    return undefined;
  }, [userId]);

  const allRuns = useMemo(() => [...data.agentRuns, ...data.workflowRuns, ...data.publishTasks], [data]);
  const failed = allRuns.filter((row) => ['failed', 'error'].includes(row.status));

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="配置完成后，这里会显示系统健康情况。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看系统状态。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">系统状态</p>
        <h2>只看运营是否稳定，不把底层数据库细节暴露到页面里</h2>
        <p>这里汇总智能体、工作流、发布任务和指标回收状态，帮助你发现失败任务、未连接执行服务和需要重试的环节。</p>
      </div>

      <div className="stat-grid compact">
        <StatCard label="智能体运行" value={data.agentRuns.length} hint="最近执行记录" />
        <StatCard label="工作流运行" value={data.workflowRuns.length} hint="素材与模型任务" />
        <StatCard label="发布任务" value={data.publishTasks.length} hint="队列状态" />
        <StatCard label="失败任务" value={failed.length} hint="需要检查" />
        <StatCard label="成功率" value={successRate(allRuns)} hint="按最近记录估算" />
      </div>

      <section className="table-card mini-panel">
        <div className="panel-title">
          <h3>最近异常</h3>
          <StatusBadge status={failed.length ? 'failed' : 'success'} />
        </div>
        <div className="record-list">
          {getLatest(failed, 8).length ? getLatest(failed, 8).map((row) => (
            <article className="record-row" key={row.id || row.created_at}>
              <div>
                <strong>{row.name || row.title || row.agent_name || row.platform || '异常任务'}</strong>
                <small>{row.error_message || row.last_error || row.status || '保留错误信息，等待人工处理'}</small>
              </div>
              <span>{formatDate(row.created_at || row.updated_at || row.completed_at)}</span>
            </article>
          )) : <div className="empty-card-inline">当前没有异常任务。</div>}
        </div>
      </section>
    </section>
  );
}

function successRate(rows) {
  if (!rows.length) return '—';
  const success = countWhere(rows, (row) => ['success', 'completed', 'published'].includes(row.status));
  return `${Math.round((success / rows.length) * 100)}%`;
}
