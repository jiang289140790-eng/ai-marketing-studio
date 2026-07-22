import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import {
  countWhere,
  displayText,
  findById,
  getAssets,
  getContentPackages,
  loadPublishQueueData,
} from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = {
  publishTasks: [],
  publishMetrics: [],
  platformConnections: [],
  accounts: [],
  legacyContent: [],
  contentPackages: [],
  assets: [],
  legacyAssets: [],
};

export function PublishQueuePage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    setLoading(true);
    loadPublishQueueData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .finally(() => setLoading(false));
    return undefined;
  }, [userId]);

  const contentPackages = useMemo(() => getContentPackages(data), [data]);
  const assets = useMemo(() => getAssets(data), [data]);

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，发布队列会读取真实发布任务。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看发布队列。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">发布队列</p>
        <h2>最终安全审批：内容终审通过，也不会直接发布到外部平台</h2>
        <p>
          发布队列是最后一道安全门。这里区分“批准发布计划”和“真正执行发布”。执行发布必须二次确认，并且必须通过可信服务端调用平台适配器。
        </p>
      </div>

      <div className="stat-grid compact">
        <StatCard label="发布任务" value={loading ? '-' : data.publishTasks.length} hint="等待人工检查" />
        <StatCard label="待批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => ['pending', 'draft', 'scheduled'].includes(item.approval_status || item.status))} hint="不会自动发布" />
        <StatCard label="已批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => item.approval_status === 'approved')} hint="仍需二次执行确认" />
        <StatCard label="失败" value={loading ? '-' : countWhere(data.publishTasks, (item) => item.status === 'failed')} hint="保留错误信息" />
      </div>

      <div className="stack-list">
        {data.publishTasks.length ? data.publishTasks.map((task) => (
          <PublishTaskCard
            key={task.id}
            task={task}
            contentPackages={contentPackages}
            connections={data.platformConnections}
            accounts={data.accounts}
            assets={assets}
            onNavigate={onNavigate}
          />
        )) : (
          <EmptyState title="暂无发布任务" description="内容工作台终审通过后，发布任务会进入这里等待人工批准。" />
        )}
      </div>
    </section>
  );
}

function PublishTaskCard({ task, contentPackages, connections, accounts, assets, onNavigate }) {
  const content = findById(contentPackages, task.content_id || task.content_package_id);
  const connection = findById(connections, task.platform_connection_id);
  const account = findById(accounts, task.account_id || connection?.account_id);
  const asset = findById(assets, task.asset_id || task.final_asset_id || content?.assetId);
  const platformConnected = connection?.status === 'connected';

  return (
    <article className="strategy-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">Publish Task</p>
          <h3>{content?.title || task.title || '未命名发布任务'}</h3>
          <p>{displayText(task.final_text || task.content_text || content?.body, '等待内容终审结果')}</p>
        </div>
        <StatusBadge status={task.approval_status || task.status || 'pending'} />
      </div>

      <div className="business-grid">
        <Info label="平台" value={task.platform || connection?.platform || content?.platform} />
        <Info label="发布账号" value={account?.account_name || account?.username || connection?.account_name} />
        <Info label="平台连接" value={connection?.status || '未绑定'} />
        <Info label="排期时间" value={formatDate(task.scheduled_time || task.publish_time || content?.scheduledAt)} />
        <Info label="内容状态" value={content?.status || task.status} />
        <Info label="发布结果" value={task.external_id || task.error_message || task.status} />
      </div>

      {asset?.url && (
        <div className="asset-preview-large">
          {asset.type === 'video' ? <video src={asset.url} controls /> : <img src={asset.thumbnail || asset.url} alt="" />}
        </div>
      )}

      <div className="button-row">
        <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>返回内容工作台修改</button>
        <ExecutionButton actionName="发布前安全检查" className="ghost-button" reason="发布前检查会在 execute_publish dry-run 阶段执行。">发布前检查</ExecutionButton>
        <ExecutionButton
          action="approve_publish"
          actionName="批准发布计划"
          resourceType="publish_task"
          resourceId={task.id}
          payload={{ publish_task_id: task.id, action: 'approve' }}
          reason={platformConnected ? undefined : '无法批准：该平台账号未连接或连接状态不可用。'}
        >
          批准发布计划
        </ExecutionButton>
        <ExecutionButton
          action="execute_publish"
          actionName="二次确认并执行发布"
          resourceType="publish_task"
          resourceId={task.id}
          payload={{ publish_task_id: task.id, dry_run: true }}
        >
          二次确认执行发布
        </ExecutionButton>
        <ExecutionButton action="execute_publish" actionName="失败后重试发布" className="ghost-button" resourceType="publish_task" resourceId={task.id} payload={{ publish_task_id: task.id, dry_run: true }}>失败后重试</ExecutionButton>
      </div>
    </article>
  );
}

function Info({ label, value }) {
  return (
    <section>
      <span>{label}</span>
      <strong>{displayText(value)}</strong>
    </section>
  );
}
