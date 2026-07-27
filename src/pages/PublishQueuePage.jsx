import { useCallback, useEffect, useMemo, useState } from 'react';
import { BusinessErrorNotice } from '../components/BusinessErrorNotice';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import { findById, getAssets, getContentPackages, loadPublishQueueData } from '../services/ops-service';
import { createPublishTask } from '../services/publish-service';
import {
  buildPublishPreflightGroups,
  CONTENT_APPROVAL,
  EXECUTION_MODE,
  getContentApprovalState,
  getDryRunPresentation,
  getExecutionMode,
  getPublishErrorPresentation,
  getPublishTaskState,
  PUBLISH_TASK_STATE,
} from '../services/publish-state-machine';
import { isSupabaseConfigured } from '../services/supabase-client';
import { getContentPackageDay } from '../utils/campaign-daily-plan';
import { normalizeBusinessError } from '../utils/business-error';
import { formatDate } from '../utils/formatters';
import {
  buildSevenDayCalendar,
  connectionContextLabel,
  filterPublishCenterTasks,
  getCampaignLink,
  metricsCapabilityForTask,
  PUBLISH_CENTER_TABS,
  summarizePublishCenter,
} from '../utils/publish-center-model';
import { connectionIsActive } from '../utils/platform-connection-summary';

const EMPTY = {
  publishTasks: [],
  publishMetrics: [],
  platformConnections: [],
  accounts: [],
  campaigns: [],
  campaignLinks: [],
  legacyContent: [],
  contentPackages: [],
  assets: [],
  legacyAssets: [],
};

export function PublishQueuePage({ userId, onNavigate, activeCampaignId, campaignContext, detailId }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [activeView, setActiveView] = useState('pending');
  const [manualOpen, setManualOpen] = useState(false);

  const loadData = useCallback(() => {
    if (!userId || !isSupabaseConfigured) return Promise.resolve();
    setLoading(true);
    setLoadError(null);
    return loadPublishQueueData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .catch((error) => setLoadError(normalizeBusinessError(error, {
        title: '发布中心暂时无法读取任务',
        impact: '现有发布任务不会受到影响。',
        recommendation: '可以刷新重试；如果仍失败，请到系统状态查看错误编号。',
      })))
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
    () => filterPublishCenterTasks(scopedPublishTasks, activeView, detailId),
    [activeView, detailId, scopedPublishTasks],
  );
  const stats = useMemo(
    () => summarizePublishCenter(scopedPublishTasks, data.publishMetrics),
    [data.publishMetrics, scopedPublishTasks],
  );
  const contextSnapshot = useMemo(
    () => buildPageContext(campaignContext, data.platformConnections),
    [campaignContext, data.platformConnections],
  );

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="配置完成后，发布中心会读取真实发布任务。" />;
  }
  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看和批准发布任务。" />;

  return (
    <section className="page-stack publish-center-product">
      <header className="publish-product-header">
        <div>
          <p className="eyebrow">发布中心 · 人工审核，AI 执行</p>
          <h2>处理批准、排期、发布和指标回收</h2>
          <p>正式任务默认由内容工作台终审创建。这里不重复编辑内容，也不会绕过人工确认自动发布。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setManualOpen(true)}>
          手动创建发布任务
        </button>
      </header>

      <section className="publish-page-context" aria-label="发布上下文">
        <ContextFact label="当前运营活动" value={contextSnapshot.campaignName} />
        <ContextFact label="当前账号" value={contextSnapshot.accountName} />
        <ContextFact label="当前 Day" value={contextSnapshot.dayLabel} />
        <ContextFact label="当前平台" value={contextSnapshot.platform} />
        <ContextFact label="连接状态" value={contextSnapshot.connectionLabel} tone={contextSnapshot.connectionTone} />
        <ContextFact label="下一步操作" value={contextSnapshot.nextAction} wide />
      </section>

      <BusinessErrorNotice error={loadError} />

      <section className="publish-stat-grid" aria-label="发布任务统计">
        <StatCard label="待我批准" value={stats.awaitingApproval} help="等待人工审核和排期" />
        <StatCard label="今天待发布" value={stats.todayScheduled} help="今天已经排期" />
        <StatCard label="发布中" value={stats.publishing} help="平台正在处理" />
        <StatCard label="失败待处理" value={stats.failed} help="可以检查原因或重试" danger={stats.failed > 0} />
        <StatCard label="指标待同步" value={stats.metricsPending} help="已发布但尚未回收指标" />
      </section>

      <nav className="publish-product-tabs" aria-label="发布中心视图">
        {PUBLISH_CENTER_TABS.map((tab) => (
          <button
            type="button"
            className={activeView === tab.id ? 'active' : ''}
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
          >
            {tab.label}
            {tab.id !== 'calendar' && <strong>{countTab(scopedPublishTasks, tab.id)}</strong>}
          </button>
        ))}
      </nav>

      {activeView === 'calendar' ? (
        <PublishCalendar
          tasks={scopedPublishTasks}
          contentPackages={contentPackages}
          accounts={data.accounts}
        />
      ) : activeView === 'history' ? (
        <PublishHistory
          tasks={visibleTasks}
          contentPackages={contentPackages}
          campaigns={data.campaigns}
          accounts={data.accounts}
          connections={data.platformConnections}
          onNavigate={onNavigate}
          onRefresh={loadData}
        />
      ) : (
        <div className="publish-product-task-list">
          {visibleTasks.length ? visibleTasks.map((task) => (
            <PublishTaskCard
              key={task.id}
              task={task}
              contentPackages={contentPackages}
              campaigns={data.campaigns}
              campaignLinks={data.campaignLinks}
              connections={data.platformConnections}
              accounts={data.accounts}
              assets={assets}
              onNavigate={onNavigate}
              onRefresh={loadData}
            />
          )) : (
            <EmptyState
              title={loading ? '正在读取发布任务' : emptyTitle(activeView)}
              description={emptyDescription(activeView)}
              action={activeView === 'pending' ? (
                <button className="primary-button" type="button" onClick={() => onNavigate('workspace')}>
                  返回内容工作台
                </button>
              ) : undefined}
            />
          )}
        </div>
      )}

      {manualOpen && (
        <ManualPublishDrawer
          userId={userId}
          campaignId={activeCampaignId}
          contentPackages={contentPackages}
          connections={data.platformConnections}
          campaignLinks={data.campaignLinks}
          onClose={() => setManualOpen(false)}
          onCreated={() => {
            setManualOpen(false);
            setActiveView('pending');
            loadData();
          }}
        />
      )}
    </section>
  );
}

function PublishTaskCard({
  task,
  contentPackages,
  campaigns,
  campaignLinks,
  connections,
  accounts,
  assets,
  onNavigate,
  onRefresh,
}) {
  const content = findById(contentPackages, task.content_id || task.content_package_id);
  const campaign = findById(campaigns, task.campaign_id || content?.campaignId);
  const connection = findConnection(task, connections, content);
  const account = findAccount(task, accounts, connection, content);
  const asset = findPrimaryAsset(task, assets, content);
  const selectedAssets = findPublishAssets(task, assets, content);
  const contentApproval = getContentApprovalState(task, content);
  const publishState = getPublishTaskState(task);
  const executionMode = getExecutionMode(task);
  const preflight = buildPublishPreflightGroups({ task, content, connection, account, asset, campaign });
  const dryRun = getDryRunPresentation(task);
  const error = getPublishErrorPresentation(task);
  const trackingLink = getCampaignLink(task, campaignLinks);
  const metricsCapability = metricsCapabilityForTask(task, connection);
  const [humanConfirmed, setHumanConfirmed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(toLocalDateTime(task.scheduled_at || task.scheduled_time, 60));
  const day = getContentPackageDay(content?.raw || content);
  const preflightPassed = task.publish_result?.preflight?.passed === true;
  const externalUrl = getExternalUrl(task);
  const primaryBlocker = preflight.blockers[0];

  const returnToWorkspace = (focus = '') => onNavigate('workspace', content?.id || task.content_package_id, {
    campaign_id: campaign?.id || content?.campaignId || task.campaign_id || '',
    day: day || 1,
    focus,
  });

  return (
    <article className={`publish-product-card state-${publishState}`}>
      <div className="publish-product-card-main">
        <div className="publish-product-copy">
          <div className="publish-product-kicker">
            <span>{task.platform || content?.platform || '未指定平台'}</span>
            <span>{day ? `Day ${day}` : '未关联 Day'}</span>
            <span>{EXECUTION_MODE[executionMode]?.label || executionMode}</span>
          </div>
          <h3>{content?.title || task.title || '未命名发布任务'}</h3>
          <p>{truncate(task.publish_content?.body || task.final_text || content?.body || '等待最终文案', 220)}</p>
          <div className="publish-product-meta">
            <span><small>运营活动</small>{campaign?.name || content?.campaignId || task.campaign_id || '未关联'}</span>
            <span><small>发布账号</small>{account?.account_name || account?.username || connection?.social_accounts?.account_name || '未绑定'}</span>
            <span><small>计划时间</small>{formatDate(task.scheduled_at || task.scheduled_time)}</span>
            <span><small>追踪链接</small>{trackingLink?.url ? truncate(trackingLink.url, 42) : '未设置'}</span>
          </div>
        </div>
        <div className="publish-product-status">
          <StatusBadge status={CONTENT_APPROVAL[contentApproval].tone} />
          <strong>{CONTENT_APPROVAL[contentApproval].label}</strong>
          <StatusBadge status={publishState} />
          <strong>{PUBLISH_TASK_STATE[publishState].label}</strong>
        </div>
      </div>

      <PublishMediaPreview task={task} assets={selectedAssets} />

      {publishState !== 'published' && (
        <section className={`publish-readiness-summary ${preflight.finalState}`}>
          <div>
            <span>内容检查</span>
            <strong>{preflight.contentPassed}/{preflight.contentTotal} 通过</strong>
          </div>
          <div>
            <span>平台检查</span>
            <strong>{preflight.platformPassed}/{preflight.platformTotal} 通过</strong>
          </div>
          <div>
            <span>执行授权</span>
            <strong>{preflight.executionAuthorization.label}</strong>
          </div>
          <div>
            <span>最终状态</span>
            <strong>{preflight.finalLabel}</strong>
          </div>
        </section>
      )}

      {dryRun && publishState !== 'published' && (
        <div className={`publish-safe-run-result ${dryRun.passed ? 'passed' : 'blocked'}`}>
          <span>{dryRun.passed ? '✓' : '!'}</span>
          <div><strong>{dryRun.title}</strong><p>{dryRun.summary}</p></div>
        </div>
      )}

      {publishState !== 'published' && (
        <details className="publish-check-details" open={Boolean(primaryBlocker)}>
          <summary>
            <span>{primaryBlocker ? `当前阻塞：${primaryBlocker.message}` : '全部预检明细'}</span>
            <strong>{preflight.contentPassed + preflight.platformPassed}/{preflight.contentTotal + preflight.platformTotal}</strong>
          </summary>
          <div className="publish-check-columns">
            <CheckGroup title="内容检查" checks={preflight.contentChecks} />
            <CheckGroup title="平台检查" checks={preflight.platformChecks} />
          </div>
        </details>
      )}

      {error && (
        <section className="publish-safe-error" role="alert">
          <div>
            <strong>{error.summary}</strong>
            <span>业务影响：{error.impact}</span>
            <span>推荐操作：{error.recommendedAction}</span>
            <small>错误编号：{error.code} · {error.retryable ? '可以重试' : '需要人工处理'}</small>
          </div>
          <button className="ghost-button" type="button" onClick={() => setAdvancedOpen((value) => !value)}>
            {advancedOpen ? '收起技术详情' : '高级详情'}
          </button>
          {advancedOpen && <code>{error.technicalDetail}</code>}
        </section>
      )}

      {(publishState === 'pending_approval' || publishState === 'draft' || publishState === 'scheduled') && (
        <div className="publish-product-schedule">
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

      {publishState === 'scheduled' && executionMode === 'live' && (
        <label className="human-confirmation-row">
          <input type="checkbox" checked={humanConfirmed} onChange={(event) => setHumanConfirmed(event.target.checked)} />
          我已检查最终文案、素材、账号和发布时间，并明确批准本次正式发布
        </label>
      )}

      <div className="publish-product-actions">
        {publishState === 'pending_approval' && (
          <>
            <ExecutionButton
              action="run_publish_preflight"
              actionName="运行安全预演"
              resourceType="publish_task"
              resourceId={task.id}
              payload={{ publish_task_id: task.id, execution_mode: 'dry_run' }}
              onCompleted={onRefresh}
            >
              运行安全预演
            </ExecutionButton>
            {preflightPassed && preflight.businessReady && (
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
                ready={Boolean(scheduledAt)}
                reason={scheduledAt ? undefined : '请选择发布时间'}
                onCompleted={onRefresh}
              >
                批准并排期
              </ExecutionButton>
            )}
            <button className="ghost-button" type="button" onClick={() => returnToWorkspace()}>
              退回内容工作台
            </button>
          </>
        )}
        {publishState === 'scheduled' && (
          <>
            <ExecutionButton
              action="execute_publish_task"
              actionName={executionMode === 'dry_run' ? '运行安全预演' : '正式发布'}
              resourceType="publish_task"
              resourceId={task.id}
              payload={{
                publish_task_id: task.id,
                execution_mode: executionMode,
                human_confirmed: executionMode === 'dry_run' || humanConfirmed,
              }}
              ready={executionMode === 'dry_run' || humanConfirmed}
              reason={executionMode === 'live' && !humanConfirmed ? '请先明确人工确认' : undefined}
              onCompleted={onRefresh}
            >
              {executionMode === 'dry_run' ? '运行安全预演' : '正式发布'}
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
              actionName="重试发布"
              resourceType="publish_task"
              resourceId={task.id}
              payload={{ publish_task_id: task.id, execution_mode: 'dry_run', human_confirmed: false }}
              ready={error?.retryable}
              reason={error?.retryable ? undefined : '该任务当前不可重试'}
              onCompleted={onRefresh}
            >
              重试发布
            </ExecutionButton>
            <button className="ghost-button" type="button" onClick={() => returnToWorkspace()}>
              返回修改
            </button>
          </>
        )}
        {publishState === 'publishing' && (
          <ExecutionButton
            action="get_publish_result"
            actionName="刷新发布结果"
            className="ghost-button"
            resourceType="publish_task"
            resourceId={task.id}
            payload={{ publish_task_id: task.id }}
            onCompleted={onRefresh}
          >
            刷新发布结果
          </ExecutionButton>
        )}
        {publishState === 'published' && (
          <>
            {metricsCapability.available && (
              <ExecutionButton
                action="collect_content_metrics"
                actionName="同步指标"
                resourceType="publish_task"
                resourceId={task.id}
                payload={{ publish_task_id: task.id, platform: task.platform }}
                onCompleted={onRefresh}
              >
                同步指标
              </ExecutionButton>
            )}
            {externalUrl && <a className="secondary-button" href={externalUrl} target="_blank" rel="noreferrer">查看平台帖子</a>}
          </>
        )}
        {primaryBlocker?.code === 'content_approved' && (
          <button className="ghost-button" type="button" onClick={() => returnToWorkspace('copy')}>修改文案</button>
        )}
        {primaryBlocker?.code === 'asset_approved' && (
          <button className="ghost-button" type="button" onClick={() => returnToWorkspace('asset')}>更换素材</button>
        )}
        {['account_registered', 'oauth_valid', 'publish_capability'].includes(primaryBlocker?.code) && (
          <button className="ghost-button" type="button" onClick={() => onNavigate('connections')}>重新连接账号</button>
        )}
      </div>
    </article>
  );
}

function PublishCalendar({ tasks, contentPackages, accounts }) {
  const [mode, setMode] = useState('week');
  const days = useMemo(() => buildSevenDayCalendar(tasks), [tasks]);
  const scheduled = days.flatMap((day) => day.tasks);
  return (
    <section className="publish-calendar-product">
      <div className="section-head compact-head">
        <div><p className="eyebrow">未来 7 天</p><h3>发布日历</h3></div>
        <div className="publish-calendar-switch">
          <button type="button" className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>周视图</button>
          <button type="button" className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>列表视图</button>
        </div>
      </div>
      {mode === 'week' ? (
        <div className="publish-week-grid">
          {days.map((day) => (
            <article key={day.key}>
              <header><strong>{day.label}</strong><span>{day.key.slice(5)}</span></header>
              {day.tasks.length ? day.tasks.map((task) => {
                const content = findById(contentPackages, task.content_package_id);
                return (
                  <div className="publish-calendar-item" key={task.id}>
                    <time>{formatTime(task.scheduled_at || task.scheduled_time)}</time>
                    <strong>{truncate(content?.title || task.title || '未命名内容', 32)}</strong>
                    <small>{task.platform} · {PUBLISH_TASK_STATE[getPublishTaskState(task)].label}</small>
                  </div>
                );
              }) : <small className="publish-calendar-empty">无排期</small>}
            </article>
          ))}
        </div>
      ) : scheduled.length ? (
        <div className="publish-calendar-list">
          {scheduled.map((task) => {
            const content = findById(contentPackages, task.content_package_id);
            const account = findById(accounts, task.account_id || task.platform_account_id);
            return (
              <article key={task.id}>
                <time>{formatDate(task.scheduled_at || task.scheduled_time)}</time>
                <div><strong>{content?.title || '未命名内容'}</strong><small>{task.platform} · {account?.account_name || '账号待确认'}</small></div>
                <StatusBadge status={getPublishTaskState(task)} />
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState title="未来 7 天暂无排期" description="批准发布任务并设置时间后，会出现在这里。" />
      )}
    </section>
  );
}

function PublishHistory({ tasks, contentPackages, campaigns, accounts, connections, onNavigate, onRefresh }) {
  if (!tasks.length) return <EmptyState title="暂无历史发布记录" description="已发布和已取消的任务会保留在这里。" />;
  return (
    <div className="table-wrap publish-history-table">
      <table>
        <thead><tr><th>内容</th><th>运营活动 / Day</th><th>平台 / 账号</th><th>模式</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
        <tbody>
          {tasks.map((task) => {
            const content = findById(contentPackages, task.content_package_id || task.content_id);
            const campaign = findById(campaigns, task.campaign_id || content?.campaignId);
            const connection = findConnection(task, connections, content);
            const account = findAccount(task, accounts, connection, content);
            const state = getPublishTaskState(task);
            const externalUrl = getExternalUrl(task);
            const metrics = metricsCapabilityForTask(task, connection);
            return (
              <tr key={task.id}>
                <td><strong>{truncate(content?.title || task.title || '未命名内容', 50)}</strong><small>{truncate(task.publish_content?.body || content?.body, 70)}</small></td>
                <td>{campaign?.name || '未关联'}<small>Day {getContentPackageDay(content?.raw || content) || '—'}</small></td>
                <td>{task.platform}<small>{account?.account_name || '账号未绑定'}</small></td>
                <td>{EXECUTION_MODE[getExecutionMode(task)]?.label}</td>
                <td><StatusBadge status={state} /> {PUBLISH_TASK_STATE[state].label}</td>
                <td>{formatDate(task.published_at || task.updated_at || task.created_at)}</td>
                <td>
                  <div className="table-actions">
                    {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer">查看帖子</a>}
                    {state === 'published' && metrics.available && (
                      <ExecutionButton
                        action="collect_content_metrics"
                        actionName="同步指标"
                        className="ghost-button"
                        resourceType="publish_task"
                        resourceId={task.id}
                        payload={{ publish_task_id: task.id, platform: task.platform }}
                        onCompleted={onRefresh}
                      >
                        同步指标
                      </ExecutionButton>
                    )}
                    <button type="button" onClick={() => onNavigate('workspace', content?.id, { campaign_id: campaign?.id || '' })}>查看内容</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManualPublishDrawer({
  userId,
  campaignId,
  contentPackages,
  connections,
  campaignLinks,
  onClose,
  onCreated,
}) {
  const [form, setForm] = useState({
    contentPackageId: contentPackages[0]?.id || '',
    connectionId: '',
    scheduledAt: toLocalDateTime('', 60),
    executionMode: 'dry_run',
    campaignLinkId: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const selectedContent = findById(contentPackages, form.contentPackageId);
  const matchingConnections = connections.filter((connection) => (
    !selectedContent?.platform
    || String(connection.platform || '').toLowerCase() === String(selectedContent.platform).toLowerCase()
  ));
  const selectedConnection = findById(connections, form.connectionId);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await createPublishTask(userId, {
        campaign_id: campaignId || selectedContent?.campaignId || null,
        content_package_id: selectedContent?.sourceKey === 'contentPackages' ? selectedContent.id : null,
        content_id: selectedContent?.sourceKey === 'legacyContent' ? selectedContent.id : null,
        platform_connection_id: selectedConnection?.id || null,
        platform_account_id: selectedConnection?.external_account_id
          || selectedConnection?.metadata?.external_user_id
          || selectedConnection?.metadata?.username
          || null,
        platform: selectedContent?.platform || selectedConnection?.platform,
        scheduled_time: fromLocalDateTime(form.scheduledAt),
        execution_mode: form.executionMode,
        campaign_link_id: form.campaignLinkId || null,
        publish_content: {
          body: selectedContent?.body || '',
          content_approval_status: selectedContent?.reviewStatus || 'pending',
          source: 'manual_publish_center',
        },
      });
      onCreated();
    } catch (caught) {
      setError(normalizeBusinessError(caught, {
        title: '发布任务尚未创建',
        impact: '没有产生新的发布任务，现有内容不会改变。',
        recommendation: '检查内容、平台账号和发布时间后重试。',
      }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop publish-manual-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="detail-drawer publish-manual-drawer" aria-label="手动创建发布任务">
        <div className="detail-drawer-header">
          <div><p className="eyebrow">高级补充操作</p><h3>手动创建发布任务</h3><p>新任务固定进入“待批准”，不能直接指定数据库状态。</p></div>
          <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
        </div>
        <form className="drawer-body publish-manual-form" onSubmit={handleSubmit}>
          <BusinessErrorNotice error={error} advanced />
          <label>
            <span>内容</span>
            <select required value={form.contentPackageId} onChange={(event) => setForm({ ...form, contentPackageId: event.target.value, connectionId: '' })}>
              <option value="">请选择已终审内容</option>
              {contentPackages.map((content) => <option key={`${content.sourceKey}-${content.id}`} value={content.id}>{content.title}</option>)}
            </select>
          </label>
          <label>
            <span>平台账号</span>
            <select required value={form.connectionId} onChange={(event) => setForm({ ...form, connectionId: event.target.value })}>
              <option value="">请选择平台连接</option>
              {matchingConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.platform} · {connection.social_accounts?.account_name || connection.account_name || '未命名账号'}
                  {connectionIsActive(connection) ? '' : '（当前不可发布）'}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>计划时间</span>
            <input type="datetime-local" required value={form.scheduledAt} onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })} />
          </label>
          <label>
            <span>执行模式</span>
            <select value={form.executionMode} onChange={(event) => setForm({ ...form, executionMode: event.target.value })}>
              <option value="dry_run">安全预演（不真实发布）</option>
              <option value="live">正式执行（仍需后续人工批准）</option>
            </select>
          </label>
          <label>
            <span>追踪链接（可选）</span>
            <select value={form.campaignLinkId} onChange={(event) => setForm({ ...form, campaignLinkId: event.target.value })}>
              <option value="">不使用追踪链接</option>
              {campaignLinks.map((link) => <option key={link.id} value={link.id}>{link.utm_campaign || link.url || link.id}</option>)}
            </select>
          </label>
          <div className="publish-manual-summary">
            <strong>创建后的状态</strong>
            <span>待批准 · {EXECUTION_MODE[form.executionMode].label}</span>
            {!selectedConnection && <small>未绑定平台连接时不会允许创建正常发布任务。</small>}
          </div>
          <div className="detail-drawer-footer">
            <button className="ghost-button" type="button" onClick={onClose}>取消</button>
            <button className="primary-button" type="submit" disabled={saving || !selectedContent || !selectedConnection}>
              {saving ? '正在创建…' : '创建待批准任务'}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function buildPageContext(context, connections) {
  const campaign = context?.campaign || {};
  const account = context?.primaryAccount || {};
  const content = (context?.contentPackages || []).find((item) => !['published', 'completed'].includes(
    String(item.status || item.review_status || '').toLowerCase(),
  )) || context?.contentPackages?.[0] || {};
  const connection = connections.find((row) => (
    String(row.account_id || '') === String(account.id || '')
    || String(row.platform || '').toLowerCase() === String(account.platform || '').toLowerCase()
  )) || {};
  const snapshot = buildPublishPreflightGroups({
    task: { platform: account.platform, publish_result: { execution_mode: 'dry_run' } },
    content,
    connection,
    account,
    campaign,
  });
  return {
    campaignName: campaign.name || campaign.title || '未选择运营活动',
    accountName: account.account_name || account.username || '尚未绑定主账号',
    dayLabel: `Day ${getContentPackageDay(content) || 1}`,
    platform: account.platform || content.platform || '未设置',
    connectionLabel: connectionContextLabel(snapshot.connection),
    connectionTone: snapshot.connection.publishCapability ? 'success' : 'warning',
    nextAction: snapshot.connection.publishCapability ? '处理待批准发布任务' : '先修复平台连接',
  };
}

function CheckGroup({ title, checks }) {
  return (
    <section>
      <h4>{title}</h4>
      {checks.map((check) => (
        <div className={check.passed ? 'passed' : 'blocked'} key={check.code}>
          <span>{check.passed ? '✓' : '×'}</span>
          <div><strong>{check.label}</strong><small>{check.message}</small></div>
        </div>
      ))}
    </section>
  );
}

function ContextFact({ label, value, tone = '', wide = false }) {
  return <div className={`${wide ? 'wide ' : ''}${tone ? `tone-${tone}` : ''}`}><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function StatCard({ label, value, help, danger = false }) {
  return <article className={danger ? 'danger' : ''}><span>{label}</span><strong>{value}</strong><small>{help}</small></article>;
}

function countTab(tasks, tab) {
  return filterPublishCenterTasks(tasks, tab).length;
}

function findConnection(task, connections, content) {
  const direct = findById(connections, task.platform_connection_id || task.publish_content?.connection_id);
  if (direct) return direct;
  const platform = String(task.platform || content?.platform || '').toLowerCase();
  const accountId = String(task.platform_account_id || task.account_id || content?.accountId || '');
  return connections.find((row) => (
    (!platform || String(row.platform || '').toLowerCase() === platform)
    && (!accountId || String(row.account_id || '') === accountId)
  )) || {};
}

function findAccount(task, accounts, connection, content) {
  return findById(accounts, connection?.account_id || task.account_id || content?.accountId)
    || accounts.find((row) => (
      String(row.platform || '').toLowerCase() === String(task.platform || content?.platform || '').toLowerCase()
      && String(row.username || row.external_user_id || '') === String(task.platform_account_id || '')
    ))
    || {};
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
  if (!assets.length) return <div className="publish-no-media"><strong>纯文字发布</strong><span>当前任务没有关联图片或视频。</span></div>;
  const externalUrl = getExternalUrl(task);
  return (
    <section className="publish-media-preview">
      <div className="publish-media-heading">
        <div><span>本次发布素材</span><strong>{formatPublishMediaSummary(assets)}</strong></div>
        {externalUrl && <a href={externalUrl} target="_blank" rel="noreferrer">查看平台帖子</a>}
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
  return videos ? `${videos} 个视频` : `${assets.length} 张图片`;
}

function getExternalUrl(task) {
  return task.publish_result?.url
    || task.publish_result?.platform_result?.url
    || task.publish_result?.platform_result?.tweet_url
    || task.publish_result?.platform_result?.post_url
    || null;
}

function emptyTitle(view) {
  if (view === 'publishing') return '当前没有发布中的任务';
  return '当前没有待处理任务';
}

function emptyDescription(view) {
  if (view === 'publishing') return '任务开始执行后会出现在这里，可以随时刷新平台结果。';
  return '内容工作台终审通过后会自动创建待批准任务；失败任务也会在这里等待处理。';
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

function formatTime(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date);
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
