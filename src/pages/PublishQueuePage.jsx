import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
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
        <h2>最终安全审批点：终审通过也不会自动发布</h2>
        <p>
          内容工作台送入队列后，仍需要在这里批准发布。点击“批准发布”只改变审批状态；
          真正调用平台接口还需要再次确认，并且必须通过可信服务端执行。
        </p>
      </div>

      <div className="stat-grid compact">
        <StatCard label="发布任务" value={loading ? '-' : data.publishTasks.length} hint="等待人工检查" />
        <StatCard label="待批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => ['pending', 'draft', 'scheduled'].includes(item.approval_status || item.status))} hint="不会自动发布" />
        <StatCard label="已批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => item.approval_status === 'approved')} hint="可进入执行前检查" />
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
        <Info label="创建来源" value={task.source || task.created_by || '内容工作台'} />
        <Info label="关联 Campaign" value={task.campaign_id || content?.campaignId} />
        <Info label="发布结果" value={task.external_id || task.error_message || task.status} />
      </div>

      {asset?.url && (
        <div className="asset-preview-large">
          {asset.type === 'video' ? <video src={asset.url} controls /> : <img src={asset.thumbnail || asset.url} alt="" />}
        </div>
      )}

      <div className="button-row">
        <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>返回内容工作台修改</button>
        <button className="ghost-button" type="button" disabled>发布前检查</button>
        <button className="primary-button" type="button" disabled>批准发布</button>
        <button className="primary-button" type="button" disabled>执行发布（二次确认）</button>
        <button className="ghost-button" type="button" disabled>失败后重试</button>
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
