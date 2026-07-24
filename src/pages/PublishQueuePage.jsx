import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { countWhere, displayText, findById, getAssets, getContentPackages, loadPublishQueueData, normalizeList } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = {
  publishTasks: [], publishMetrics: [], platformConnections: [], accounts: [],
  legacyContent: [], contentPackages: [], assets: [], legacyAssets: [],
};

const PUBLISH_FLOW = [
  ['draft', '草稿'], ['ready_for_review', '待审核'], ['approved', '已批准'],
  ['scheduled', '已排期'], ['publishing', '发布中'], ['published', '已发布'], ['failed', '失败'],
];

export function PublishQueuePage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    setLoading(true);
    loadPublishQueueData().then((nextData) => setData({ ...EMPTY, ...nextData })).finally(() => setLoading(false));
    return undefined;
  }, [userId]);

  const contentPackages = useMemo(() => getContentPackages(data), [data]);
  const assets = useMemo(() => getAssets(data), [data]);

  if (!isSupabaseConfigured) return <EmptyState title="等待数据服务配置" description="配置完成后，发布队列会读取真实发布任务。" />;
  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看发布队列。" />;

  return (
    <section className="page-stack publish-queue-page">
      <div className="hero-panel">
        <p className="eyebrow">发布队列</p>
        <h2>先检查，再批准，最后人工二次确认发布</h2>
        <p>发布动作只能通过安全执行网关完成。内容、账号连接、发布权限、格式和人工确认缺少任何一项，都不能执行真实发布。</p>
        <div className="publish-status-flow" aria-label="发布状态流">
          {PUBLISH_FLOW.map(([id, label], index) => <span key={id}>{label}{index < PUBLISH_FLOW.length - 1 && <b>→</b>}</span>)}
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="发布任务" value={loading ? '-' : data.publishTasks.length} hint="等待人工检查" />
        <StatCard label="待批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => ['pending', 'draft', 'ready_for_review', 'scheduled'].includes(item.approval_status || item.status))} hint="不会自动发布" />
        <StatCard label="已批准" value={loading ? '-' : countWhere(data.publishTasks, (item) => item.approval_status === 'approved')} hint="仍需二次确认" />
        <StatCard label="失败" value={loading ? '-' : countWhere(data.publishTasks, (item) => item.status === 'failed')} hint="保留错误信息并允许重试" />
      </div>

      <div className="stack-list">
        {data.publishTasks.length ? data.publishTasks.map((task) => (
          <PublishTaskCard key={task.id} task={task} contentPackages={contentPackages} connections={data.platformConnections} accounts={data.accounts} assets={assets} onNavigate={onNavigate} />
        )) : <EmptyState title="暂无发布任务" description="内容工作台终审通过后，发布任务会进入这里等待人工批准。" />}
      </div>
    </section>
  );
}

function PublishTaskCard({ task, contentPackages, connections, accounts, assets, onNavigate }) {
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const content = findById(contentPackages, task.content_id || task.content_package_id);
  const connection = findConnection(task, connections, content);
  const account = findById(accounts, task.account_id || connection?.account_id || content?.accountId);
  const asset = findById(assets, task.asset_id || task.final_asset_id || content?.assetId);
  const currentStatus = String(task.status || task.approval_status || 'draft').toLowerCase();
  const checks = buildPreflightChecks(task, content, connection, account);
  const baseFailure = checks.find((check) => !check.ok)?.detail;
  const executionReason = baseFailure || (!humanConfirmed ? '请先勾选人工二次确认。' : undefined);

  return (
    <article className="strategy-card publish-task-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">发布任务 · {task.id}</p>
          <h3>{content?.title || task.title || '未命名发布任务'}</h3>
          <p>{displayText(task.final_text || task.content_text || content?.body, '等待内容终审结果')}</p>
        </div>
        <StatusBadge status={currentStatus} />
      </div>

      <div className="business-grid">
        <Info label="平台" value={task.platform || connection?.platform || content?.platform} />
        <Info label="发布账号" value={account?.account_name || account?.username || connection?.account_name} />
        <Info label="平台连接" value={connection?.status || '未绑定'} />
        <Info label="排期时间" value={formatDate(task.scheduled_time || task.publish_time || content?.scheduledAt)} />
        <Info label="内容状态" value={content?.reviewStatus || content?.status || task.status} />
        <Info label="发布结果" value={task.external_id || (currentStatus === 'published' ? '发布成功' : '尚未发布')} />
      </div>

      <div className="publish-preflight-panel">
        <div className="section-head"><h4>发布前检查</h4><span>{checks.filter((item) => item.ok).length}/{checks.length} 通过</span></div>
        <div className="publish-check-list">
          {checks.map((check) => (
            <div className={check.ok ? 'passed' : 'blocked'} key={check.label}>
              <strong>{check.ok ? '✓' : '×'} {check.label}</strong><span>{check.detail}</span>
            </div>
          ))}
        </div>
        <label className="human-confirmation-row">
          <input type="checkbox" checked={humanConfirmed} onChange={(event) => setHumanConfirmed(event.target.checked)} />
          我已人工检查正文、素材、账号和排期，并确认允许执行发布
        </label>
      </div>

      {asset?.url && <div className="asset-preview-large">{String(asset.type).includes('video') ? <video src={asset.url} controls /> : <img src={asset.thumbnail || asset.url} alt="发布素材预览" />}</div>}

      {task.error_message && <div className="notice error"><strong>失败原因：</strong>{task.error_message}</div>}

      <div className="button-row">
        <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>返回内容工作台修改</button>
        <ExecutionButton action="execute_publish" actionName="发布前检查" className="ghost-button" resourceType="publish_task" resourceId={task.id} payload={{ publish_task_id: task.id, dry_run: true, preflight_only: true }} reason={baseFailure} executionUnavailableReason="发布前检查暂不可执行：执行服务暂未连接">发布前检查</ExecutionButton>
        <ExecutionButton action="approve_publish" actionName="批准发布计划" resourceType="publish_task" resourceId={task.id} payload={{ publish_task_id: task.id, action: 'approve' }} reason={baseFailure}>批准发布计划</ExecutionButton>
        <ExecutionButton action="execute_publish" actionName="二次确认并执行发布" resourceType="publish_task" resourceId={task.id} payload={{ publish_task_id: task.id, dry_run: false, human_confirmed: humanConfirmed }} reason={executionReason}>二次确认并执行发布</ExecutionButton>
        {currentStatus === 'failed' && <ExecutionButton action="execute_publish" actionName="失败后重试" className="ghost-button" resourceType="publish_task" resourceId={task.id} payload={{ publish_task_id: task.id, dry_run: false, retry: true, human_confirmed: humanConfirmed }} reason={executionReason}>失败后重试</ExecutionButton>}
      </div>
    </article>
  );
}

function findConnection(task, connections, content) {
  const direct = findById(connections, task.platform_connection_id);
  if (direct) return direct;
  const platform = String(task.platform || content?.platform || '').toLowerCase();
  const accountId = String(task.account_id || content?.accountId || '');
  return (connections || []).find((row) => (
    (!platform || String(row.platform || '').toLowerCase() === platform)
    && (!accountId || String(row.account_id || '') === accountId)
  ));
}

function buildPreflightChecks(task, content, connection, account) {
  const connectionActive = connection?.status === 'connected' || connection?.is_connected === true;
  const permissions = normalizeList(connection?.permissions || connection?.scopes || connection?.scope || connection?.metadata?.permissions || connection?.metadata?.scopes);
  const permissionText = permissions.join(' ').toLowerCase();
  const publishPermission = connectionActive && (permissions.length === 0
    ? connection?.can_publish === true || connection?.metadata?.can_publish === true
    : /(write|publish|tweet\.write|posts\.write|messages)/.test(permissionText));
  const contentApproved = Boolean(content?.approvedForPublishing || content?.reviewStatus === 'approved' || task.content_approved === true);
  const body = String(task.final_text || task.content_text || content?.body || '').trim();
  const platform = String(task.platform || connection?.platform || content?.platform || '').toLowerCase();
  const maxLength = platform === 'x' || platform.includes('twitter') ? 280 : 10000;
  const formatValid = body.length > 0 && body.length <= maxLength;

  return [
    { label: '内容已审核', ok: contentApproved, detail: contentApproved ? '内容终审已通过' : '请先在内容工作台完成终审' },
    { label: '账号已连接', ok: connectionActive && Boolean(account || connection?.account_id), detail: connectionActive ? '有效连接记录已找到' : '请先连接发布账号' },
    { label: '具备发布权限', ok: publishPermission, detail: publishPermission ? '授权范围包含发布能力' : '当前账号缺少发布权限' },
    { label: '内容格式有效', ok: formatValid, detail: formatValid ? `${body.length}/${maxLength} 字符` : body ? `正文超过 ${maxLength} 字符限制` : '正文为空' },
  ];
}

function Info({ label, value }) {
  return <section><span>{label}</span><strong>{displayText(value)}</strong></section>;
}
