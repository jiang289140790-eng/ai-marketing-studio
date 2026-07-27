import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import { findById, getAssets, getContentPackages, loadPublishQueueData } from '../services/ops-service';
import {
  buildPublishPreflightChecks,
  CONTENT_APPROVAL,
  EXECUTION_MODE,
  getContentApprovalState,
  getDryRunPresentation,
  getExecutionMode,
  getPublishErrorPresentation,
  getPublishReadiness,
  getPublishTaskState,
  PUBLISH_TASK_STATE,
} from '../services/publish-state-machine';
import { isSupabaseConfigured } from '../services/supabase-client';
import { getContentPackageDay } from '../utils/campaign-daily-plan';
import { formatDate } from '../utils/formatters';
import { connectionIsActive } from '../utils/platform-connection-summary';

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

const VIEWS = [
  ['pending', '待处理'],
  ['calendar', '发布日历'],
  ['scheduled', '已排期'],
  ['publishing', '发布中'],
  ['published', '已发布'],
  ['failed', '失败'],
];

export function PublishQueuePage({ userId, onNavigate, activeCampaignId, campaignContext, detailId }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [activeView, setActiveView] = useState('pending');

  const loadData = useCallback(() => {
    if (!userId || !isSupabaseConfigured) return Promise.resolve();
    setLoading(true);
    setLoadError('');
    return loadPublishQueueData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .catch((error) => {
        setLoadError(error?.message || '发布任务读取失败');
      })
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const allowedPackageIds = useMemo(
    () => new Set((campaignContext?.contentPackages || []).map((item) => String(item.id))),
    [campaignContext?.contentPackages],
  );
  const scopedPublishTasks = useMemo(() => {
    const rows = data.publishTasks.filter((task) => (
      !activeCampaignId
      || String(task.campaign_id || '') === String(activeCampaignId)
      || allowedPackageIds.has(String(task.content_package_id || ''))
    ));
    return rows.sort((left, right) => String(right.updated_at || right.created_at || '').localeCompare(
      String(left.updated_at || left.created_at || ''),
    ));
  }, [activeCampaignId, allowedPackageIds, data.publishTasks]);
  const contentPackages = useMemo(() => getContentPackages({
    ...data,
    contentPackages: data.contentPackages.filter((item) => (
      !activeCampaignId
      || allowedPackageIds.has(String(item.id))
      || String(item.campaign_id || item.campaignId || '') === String(activeCampaignId)
    )),
  }), [activeCampaignId, allowedPackageIds, data]);
  const assets = useMemo(() => getAssets(data), [data]);
  const visibleTasks = useMemo(
    () => filterTasks(scopedPublishTasks, activeView, detailId),
    [activeView, detailId, scopedPublishTasks],
  );
  const counts = useMemo(() => countViews(scopedPublishTasks), [scopedPublishTasks]);

  if (!isSupabaseConfigured) return <EmptyState title="等待数据服务配置" description="配置完成后，发布中心会读取真实发布任务。" />;
  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看和批准发布任务。" />;

  return (
    <section className="page-stack publish-center-v2">
      <header className="publish-center-header">
        <div>
          <p className="eyebrow">发布中心 · X / Telegram 安全发布</p>
          <h2>一个入口完成预检、批准、排期与发布</h2>
          <p>内容审核、发布任务和执行模式分别展示。测试执行通过不会被标记为发布失败，真实发布仍默认要求人工确认。</p>
        </div>
        <div className="publish-safety-note">
          <strong>默认安全模式</strong>
          <span>dry_run · 不执行真实发布</span>
        </div>
      </header>

      {loadError && (
        <div className="notice error" role="alert">
          发布中心数据读取失败：{loadError}
        </div>
      )}

      <nav className="publish-view-tabs" aria-label="发布任务分类">
        {VIEWS.map(([id, label]) => (
          <button type="button" className={activeView === id ? 'active' : ''} key={id} onClick={() => setActiveView(id)}>
            <span>{label}</span>
            {id !== 'calendar' && <strong>{counts[id] || 0}</strong>}
          </button>
        ))}
      </nav>

      {activeView === 'calendar' ? (
        <PublishCalendar tasks={scopedPublishTasks} contentPackages={contentPackages} />
      ) : (
        <div className="publish-task-list">
          {visibleTasks.length ? visibleTasks.map((task) => (
            <PublishTaskCard
              key={task.id}
              task={task}
              contentPackages={contentPackages}
              connections={data.platformConnections}
              accounts={data.accounts}
              assets={assets}
              onNavigate={onNavigate}
              onRefresh={loadData}
            />
          )) : (
            <EmptyState
              title={loading ? '正在读取发布任务' : '当前分类暂无任务'}
              description="内容工作台审核通过并创建发布任务后，会进入这里。"
            />
          )}
        </div>
      )}
    </section>
  );
}

function PublishTaskCard({ task, contentPackages, connections, accounts, assets, onNavigate, onRefresh }) {
  const content = findById(contentPackages, task.content_id || task.content_package_id);
  const connection = findConnection(task, connections, content);
  const account = findById(accounts, task.account_id || connection?.account_id || content?.accountId);
  const asset = findPrimaryAsset(task, assets, content);
  const selectedAssets = findPublishAssets(task, assets, content);
  const contentApproval = getContentApprovalState(task, content);
  const publishState = getPublishTaskState(task);
  const executionMode = getExecutionMode(task);
  const preflightChecks = buildPublishPreflightChecks({ task, content, connection, account, asset });
  const dryRun = getDryRunPresentation(task);
  const error = getPublishErrorPresentation(task);
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [showError, setShowError] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(toLocalDateTime(task.scheduled_at || task.scheduled_time, 60));
  const day = getContentPackageDay(content?.raw || content);
  const preflightPassed = task.publish_result?.preflight?.passed === true;
  const canApprove = preflightChecks.every((item) => item.passed);
  const readiness = getPublishReadiness({
    checks: preflightChecks,
    task,
    humanAuthorized: publishState !== 'pending_approval' || humanConfirmed,
  });

  const returnToWorkspace = () => onNavigate('workspace', content?.id || task.content_package_id, {
    campaign_id: content?.campaignId || task.campaign_id || '',
    day: day || 1,
  });

  return (
    <article className={`publish-task-card-v2 state-${publishState}`}>
      <div className="publish-task-summary">
        <div>
          <p className="eyebrow">{task.platform || content?.platform || 'Telegram'} · {day ? `Day ${day}` : '内容发布'}</p>
          <h3>{content?.title || task.title || '未命名发布任务'}</h3>
          <p>{truncate(task.publish_content?.body || task.final_text || content?.body || '等待最终文案', 180)}</p>
        </div>
        <div className="publish-state-stack">
          <StatusBadge status={CONTENT_APPROVAL[contentApproval].tone} />
          <strong>{CONTENT_APPROVAL[contentApproval].label}</strong>
          <StatusBadge status={publishState} />
          <strong>{PUBLISH_TASK_STATE[publishState].label}</strong>
        </div>
      </div>

      <div className="publish-facts">
        <Fact label="Campaign" value={content?.campaignId || task.campaign_id || '未关联'} />
        <Fact label="发布账号" value={account?.account_name || account?.username || connection?.account_name || '未关联'} />
        <Fact label="执行模式" value={`${EXECUTION_MODE[executionMode]?.label || executionMode} · ${EXECUTION_MODE[executionMode]?.description || ''}`} />
        <Fact label="排期" value={formatDate(task.scheduled_at || task.scheduled_time)} />
        <Fact label="平台返回 ID" value={task.external_id || task.publish_result?.platform_result?.platform_post_id || '尚未发布'} />
        <Fact label="发布素材" value={formatPublishMediaSummary(selectedAssets)} />
      </div>

      <PublishMediaPreview task={task} assets={selectedAssets} />

      {dryRun && !(readiness.businessReady && !dryRun.passed) && (
        <div className={`dry-run-result ${dryRun.passed ? 'passed' : 'blocked'}`}>
          <span>{dryRun.passed ? '✓' : '!'}</span>
          <div>
            <strong>{dryRun.title}</strong>
            <p>{dryRun.summary}</p>
            <small>{formatDate(dryRun.checkedAt)}</small>
          </div>
        </div>
      )}

      <div className={`dry-run-result ${readiness.executionConditionsMet ? 'passed' : 'blocked'}`}>
        <span>{readiness.executionConditionsMet ? '✓' : '!'}</span>
        <div>
          <strong>业务预检：{readiness.businessPassed}/{readiness.businessTotal} 通过</strong>
          <p>执行条件：{readiness.executionConditionsMet ? '已满足' : '未满足'} · 最终状态：{readiness.finalLabel}</p>
        </div>
      </div>

      <details className="publish-preflight-compact" open={!readiness.businessReady && publishState === 'pending_approval'}>
        <summary>
          <span>发布前检查</span>
          <strong>{preflightChecks.filter((item) => item.passed).length}/{preflightChecks.length} 通过</strong>
        </summary>
        <div className="publish-check-grid">
          {preflightChecks.map((check) => (
            <div className={check.passed ? 'passed' : 'blocked'} key={check.code}>
              <span>{check.passed ? '✓' : '×'}</span>
              <div><strong>{check.label}</strong><small>{check.message}</small></div>
            </div>
          ))}
        </div>
      </details>

      {error && (
        <div className="publish-error-summary">
          <div>
            <strong>{error.summary}</strong>
            <span>错误编号：{error.code} · {error.retryable ? '可以重试' : '需要人工处理'}</span>
            <small>建议：{error.recommendedAction}</small>
          </div>
          <button className="ghost-button" type="button" onClick={() => setShowError((value) => !value)}>
            {showError ? '收起原因' : '查看原因'}
          </button>
          {showError && <p>技术细节已写入审计日志，页面仅展示可操作的安全摘要。</p>}
        </div>
      )}

      {(publishState === 'pending_approval' || publishState === 'draft' || publishState === 'scheduled') && (
        <div className="publish-schedule-row">
          <label>
            <span>发布时间</span>
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
          {publishState === 'scheduled' && (
            <ExecutionButton
              action="schedule_publish_task"
              actionName="修改发布时间"
              className="ghost-button"
              resourceType="publish_task"
              resourceId={task.id}
              payload={() => ({ publish_task_id: task.id, scheduled_at: fromLocalDateTime(scheduledAt) })}
              ready={Boolean(scheduledAt)}
              reason={scheduledAt ? undefined : '请选择发布时间'}
              onCompleted={onRefresh}
            >
              修改时间
            </ExecutionButton>
          )}
        </div>
      )}

      {publishState === 'scheduled' && (
        <label className="human-confirmation-row">
          <input type="checkbox" checked={humanConfirmed} onChange={(event) => setHumanConfirmed(event.target.checked)} />
          我已检查最终文案、全部素材、账号和发布时间，并明确批准本次 {task.platform || '平台'} 正式发布
        </label>
      )}

      <div className="publish-dynamic-actions">
        {publishState === 'pending_approval' && !preflightPassed && (
          <ExecutionButton
            action="run_publish_preflight"
            actionName="运行发布预检"
            resourceType="publish_task"
            resourceId={task.id}
            payload={{ publish_task_id: task.id, execution_mode: 'dry_run' }}
            reason={preflightChecks.some((item) => !item.passed) ? '请先处理未通过的发布条件' : undefined}
            onCompleted={onRefresh}
          >
            运行一次测试预检
          </ExecutionButton>
        )}
        {publishState === 'pending_approval' && preflightPassed && (
          <ExecutionButton
            action="approve_publish_task"
            actionName="批准并排期"
            resourceType="publish_task"
            resourceId={task.id}
            payload={() => ({
              publish_task_id: task.id,
              scheduled_at: fromLocalDateTime(scheduledAt),
              human_confirmed: true,
              approved_by: 'human',
            })}
            ready={Boolean(scheduledAt) && canApprove}
            reason={!scheduledAt ? '请先选择发布时间' : !canApprove ? '发布前检查尚未通过' : undefined}
            onCompleted={onRefresh}
          >
            批准并排期
          </ExecutionButton>
        )}
        {(publishState === 'pending_approval' || publishState === 'draft') && (
          <button className="ghost-button" type="button" onClick={returnToWorkspace}>退回内容工作台</button>
        )}
        {publishState === 'draft' && (
          <ExecutionButton
            action="schedule_publish_task"
            actionName="设置排期"
            resourceType="publish_task"
            resourceId={task.id}
            payload={() => ({ publish_task_id: task.id, scheduled_at: fromLocalDateTime(scheduledAt) })}
            ready={Boolean(scheduledAt)}
            reason={scheduledAt ? undefined : '请选择发布时间'}
            onCompleted={onRefresh}
          >
            设置排期
          </ExecutionButton>
        )}
        {publishState === 'scheduled' && (
          <>
            <ExecutionButton
              action="execute_publish_task"
              actionName="立即正式发布"
              resourceType="publish_task"
              resourceId={task.id}
              payload={{ publish_task_id: task.id, execution_mode: 'live', human_confirmed: humanConfirmed }}
              ready={humanConfirmed}
              reason={humanConfirmed ? undefined : '请先明确人工确认'}
              onCompleted={onRefresh}
            >
              立即发布
            </ExecutionButton>
            <ExecutionButton
              action="reject_publish"
              actionName="取消发布"
              className="ghost-button danger"
              resourceType="publish_task"
              resourceId={task.id}
              payload={{ publish_task_id: task.id, feedback: 'Cancelled by human in Publish Center.' }}
              onCompleted={onRefresh}
            >
              取消
            </ExecutionButton>
          </>
        )}
        {publishState === 'failed' && (
          <>
            <ExecutionButton
              action="retry_publish_task"
              actionName="测试重试"
              resourceType="publish_task"
              resourceId={task.id}
              payload={{ publish_task_id: task.id, execution_mode: 'dry_run', human_confirmed: false }}
              ready={error?.retryable}
              reason={error?.retryable ? undefined : '该任务当前不可重试'}
              onCompleted={onRefresh}
            >
              重试
            </ExecutionButton>
            <button className="ghost-button" type="button" onClick={returnToWorkspace}>返回修改</button>
          </>
        )}
        {(publishState === 'publishing' || publishState === 'published') && (
          <ExecutionButton
            action="get_publish_result"
            actionName="刷新平台结果"
            className="ghost-button"
            resourceType="publish_task"
            resourceId={task.id}
            payload={{ publish_task_id: task.id }}
            onCompleted={onRefresh}
          >
            刷新结果
          </ExecutionButton>
        )}
      </div>
    </article>
  );
}

function PublishCalendar({ tasks, contentPackages }) {
  const scheduled = tasks
    .filter((task) => task.scheduled_at || task.scheduled_time)
    .sort((left, right) => new Date(left.scheduled_at || left.scheduled_time) - new Date(right.scheduled_at || right.scheduled_time));
  return (
    <section className="publish-calendar-panel">
      <div className="section-head compact-head">
        <div><p className="eyebrow">发布日历</p><h3>未来排期</h3></div>
        <span>{scheduled.length} 条</span>
      </div>
      {scheduled.length ? scheduled.map((task) => {
        const content = findById(contentPackages, task.content_package_id);
        const state = getPublishTaskState(task);
        return (
          <article key={task.id}>
            <time>{formatDate(task.scheduled_at || task.scheduled_time)}</time>
            <div><strong>{content?.title || '未命名内容'}</strong><small>{task.platform} · {PUBLISH_TASK_STATE[state].label}</small></div>
            <StatusBadge status={state} />
          </article>
        );
      }) : <EmptyState title="未来 7 天暂无排期" description="批准发布任务并设置时间后，会出现在这里。" />}
    </section>
  );
}

function filterTasks(tasks, view, detailId) {
  if (detailId) {
    const selected = tasks.find((task) => String(task.id) === String(detailId));
    if (selected) return [selected];
  }
  return tasks.filter((task) => PUBLISH_TASK_STATE[getPublishTaskState(task)].group === view);
}

function countViews(tasks) {
  return tasks.reduce((counts, task) => {
    const group = PUBLISH_TASK_STATE[getPublishTaskState(task)].group;
    counts[group] = (counts[group] || 0) + 1;
    return counts;
  }, {});
}

function findConnection(task, connections, content) {
  const direct = findById(connections, task.platform_connection_id || task.publish_content?.connection_id);
  if (direct) return direct;
  const platform = String(task.platform || content?.platform || '').toLowerCase();
  const accountId = String(task.platform_account_id || task.account_id || content?.accountId || '');
  return connections.find((row) => (
    (!platform || String(row.platform || '').toLowerCase() === platform)
    && (!accountId || String(row.account_id || '') === accountId)
    && connectionIsActive(row)
  )) || {};
}

function findPrimaryAsset(task, assets, content) {
  const selectedId = task.publish_content?.selected_asset_id || task.asset_id || task.final_asset_id || content?.finalAssetId;
  return findById(assets, selectedId)
    || assets.find((asset) => (
      String(asset.contentId || '') === String(task.content_package_id || content?.id || '')
      && asset.approvedForPublishing
    ))
    || {};
}

function findPublishAssets(task, assets, content) {
  const embedded = Array.isArray(task.publish_content?.assets) ? task.publish_content.assets : [];
  const selectedIds = [
    ...(Array.isArray(task.publish_content?.selected_asset_ids) ? task.publish_content.selected_asset_ids : []),
    task.publish_content?.selected_asset_id,
    task.asset_id,
    task.final_asset_id,
    content?.finalAssetId,
  ].filter(Boolean).map(String);
  const embeddedById = new Map(embedded.filter((item) => item?.id).map((item) => [String(item.id), item]));
  const storedById = new Map(assets.filter((item) => item?.id).map((item) => [String(item.id), item]));
  const selected = selectedIds.length
    ? selectedIds.map((id) => storedById.get(id) || embeddedById.get(id)).filter(Boolean)
    : embedded;
  const fallback = selected.length ? selected : assets.filter((item) => (
    String(item.contentId || item.content_package_id || '') === String(task.content_package_id || content?.id || '')
    && (item.approvedForPublishing || item.approved_for_publishing)
  ));
  return Array.from(new Map(fallback.map((item) => [String(item.id || item.url || item.output_url), item])).values());
}

function PublishMediaPreview({ task, assets }) {
  if (!assets.length) return null;
  const externalUrl = task.publish_result?.url
    || task.publish_result?.platform_result?.url
    || task.publish_result?.platform_result?.tweet_url
    || null;
  return (
    <section className="publish-media-preview">
      <div className="publish-media-heading">
        <div>
          <span>本次发布素材</span>
          <strong>{formatPublishMediaSummary(assets)}</strong>
        </div>
        {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer">查看平台原帖</a>}
      </div>
      <div className={`publish-media-grid count-${Math.min(assets.length, 4)}`}>
        {assets.map((item, index) => {
          const url = item.url || item.output_url || item.raw?.output_url || '';
          const type = String(item.type || item.asset_type || item.raw?.asset_type || '').toLowerCase();
          if (!url) return null;
          return type.includes('video')
            ? <video key={item.id || url} src={url} controls preload="metadata" aria-label={`发布视频 ${index + 1}`} />
            : <img key={item.id || url} src={url} alt={`发布图片 ${index + 1}`} loading="lazy" />;
        })}
      </div>
    </section>
  );
}

function formatPublishMediaSummary(assets) {
  if (!assets.length) return '纯文字';
  const videos = assets.filter((item) => String(item.type || item.asset_type || item.raw?.asset_type || '').toLowerCase().includes('video')).length;
  const images = assets.length - videos;
  if (videos) return `${videos} 个视频`;
  return `${images} 张图片`;
}

function Fact({ label, value }) {
  return <div><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function toLocalDateTime(value, fallbackMinutes = 0) {
  const date = value ? new Date(value) : new Date(Date.now() + fallbackMinutes * 60_000);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalDateTime(value) {
  return value ? new Date(value).toISOString() : null;
}
