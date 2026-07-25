import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { buildUserActionQueue } from '../services/action-queue-service';
import { getExecutionStatus } from '../services/execution-gateway';
import { displayText, getLatest, loadCommandCenterData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { getContentPackageDay, normalizeCampaignDailyPlan } from '../utils/campaign-daily-plan';
import { formatDate } from '../utils/formatters';

const EMPTY_DATA = {
  accounts: [],
  accountProfiles: [],
  accountReports: [],
  campaigns: [],
  strategies: [],
  contentPackages: [],
  legacyContent: [],
  assets: [],
  legacyAssets: [],
  characters: [],
  publishTasks: [],
  publishMetrics: [],
  contentMetrics: [],
  knowledge: [],
  insights: [],
  contentMemory: [],
  strategyMemory: [],
  agentRuns: [],
  workflowRuns: [],
  platformConnections: [],
  __errors: [],
};

const PRIORITY_LABELS = {
  urgent: '紧急',
  high: '高优先级',
  medium: '普通',
  low: '低优先级',
};

export function CommandCenter({ userId, onNavigate, activeCampaignId, campaignContext }) {
  const [data, setData] = useState(EMPTY_DATA);
  const [loading, setLoading] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState({ loading: true, connected: false });

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      loadCommandCenterData(),
      getExecutionStatus({ force: true }).catch(() => ({ connected: false })),
    ]).then(([nextData, nextGatewayStatus]) => {
      if (cancelled) return;
      setData({ ...EMPTY_DATA, ...nextData });
      setGatewayStatus({ loading: false, ...nextGatewayStatus });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const actionQueue = useMemo(() => buildUserActionQueue(data), [data]);
  const currentActions = useMemo(
    () => actionQueue.filter((item) => !activeCampaignId || String(item.campaign_id || '') === String(activeCampaignId)),
    [actionQueue, activeCampaignId],
  );
  const timeline = useMemo(
    () => buildSevenDayTimeline(campaignContext, data),
    [campaignContext, data],
  );
  const exceptions = useMemo(
    () => buildBusinessExceptions(data, actionQueue, gatewayStatus),
    [actionQueue, data, gatewayStatus],
  );
  const recommendations = useMemo(() => buildRecommendations(data), [data]);

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待数据服务配置" description="配置完成后，AI 运营指挥中心会读取真实运营数据。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel command-hero command-hero-simple">
          <p className="eyebrow">AI 运营指挥中心</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>登录后，这里只展示今天需要处理的事项、当前活动进度和真正影响业务的异常。</p>
        </div>
      </section>
    );
  }

  if (!loading && data.campaigns.length === 0) {
    return <FirstUseGuide onNavigate={onNavigate} />;
  }

  const primaryAction = currentActions[0] || actionQueue[0];

  return (
    <section className="page-stack command-center-v2">
      <header className="command-focus-header">
        <div>
          <p className="eyebrow">AI 运营指挥中心</p>
          <h2>{actionQueue.length ? `今天有 ${actionQueue.length} 项需要你处理` : '今天没有阻塞中的人工任务'}</h2>
          <p>
            {primaryAction
              ? `${primaryAction.campaign_name}：${primaryAction.summary}`
              : '当前流程运行正常，可以查看即将发布的内容或继续推进当前活动。'}
          </p>
        </div>
        {primaryAction && (
          <button className="primary-button" type="button" onClick={() => navigateToAction(primaryAction, onNavigate)}>
            {primaryAction.recommended_action}
          </button>
        )}
      </header>

      <section className="command-section action-queue-section">
        <div className="section-head compact-head">
          <div>
            <p className="eyebrow">待我处理</p>
            <h3>按业务优先级排列</h3>
          </div>
          <span className="command-count">{actionQueue.length} 项</span>
        </div>
        {actionQueue.length ? (
          <div className="action-queue-list">
            {actionQueue.slice(0, 8).map((item) => (
              <ActionQueueRow key={`${item.action_type}-${item.entity_id}`} item={item} onNavigate={onNavigate} />
            ))}
          </div>
        ) : (
          <div className="command-clear-state">
            <span>✓</span>
            <div>
              <strong>暂时没有需要人工处理的任务</strong>
              <p>系统不会把正常连接状态或无意义的 0 填满首页。</p>
            </div>
          </div>
        )}
      </section>

      <div className="command-main-grid">
        <CurrentCampaignPanel
          context={campaignContext}
          actions={currentActions}
          onNavigate={onNavigate}
        />
        <SevenDaySchedule timeline={timeline} onNavigate={onNavigate} />
      </div>

      <div className="command-secondary-grid">
        <BusinessExceptions exceptions={exceptions} onNavigate={onNavigate} />
        <AiRecommendations items={recommendations} onNavigate={onNavigate} />
      </div>
    </section>
  );
}

function ActionQueueRow({ item, onNavigate }) {
  return (
    <article className={`action-queue-row priority-${item.priority}`}>
      <div className="action-priority">
        <span>{PRIORITY_LABELS[item.priority] || '普通'}</span>
        <small>{actionTypeLabel(item.action_type)}</small>
      </div>
      <div className="action-copy">
        <strong>{item.title}</strong>
        <p>{truncate(item.summary, 120)}</p>
        <small>
          {item.campaign_name} · {item.account_name}{item.day ? ` · Day ${item.day}` : ''}
        </small>
      </div>
      <button className="ghost-button" type="button" onClick={() => navigateToAction(item, onNavigate)}>
        {item.recommended_action}
      </button>
    </article>
  );
}

function CurrentCampaignPanel({ context, actions, onNavigate }) {
  if (!context?.campaign) {
    return (
      <section className="command-section current-campaign-panel">
        <div className="section-head compact-head">
          <div><p className="eyebrow">当前运营活动</p><h3>请选择一个运营活动</h3></div>
        </div>
        <p>选择活动后，这里会显示目标、主账号、Day 1 进度和当前阻塞。</p>
        <button className="ghost-button" type="button" onClick={() => onNavigate('campaigns')}>选择运营活动</button>
      </section>
    );
  }

  const { campaign, primaryAccount, progress, blockingItems = [], dailyPlan = [], contentPackages = [] } = context;
  const dayOne = contentPackages.find((item) => getContentPackageDay(item) === 1);
  const nextAction = actions[0];
  const planProgress = Math.min(contentPackages.length, dailyPlan.length || 7);

  return (
    <section className="command-section current-campaign-panel">
      <div className="section-head compact-head">
        <div>
          <p className="eyebrow">当前运营活动</p>
          <h3>{campaign.name || campaign.title || '未命名运营活动'}</h3>
        </div>
        <StatusBadge status={campaign.status || 'active'} />
      </div>
      <p className="campaign-goal">{campaign.goal || campaign.objective || campaign.description || '尚未填写活动目标'}</p>
      <dl className="campaign-summary-grid">
        <div><dt>主账号</dt><dd>{accountLabel(primaryAccount)}</dd></div>
        <div><dt>当前阶段</dt><dd>{progress?.currentStage || '等待流程数据'}</dd></div>
        <div><dt>7 天计划</dt><dd>{planProgress} / {dailyPlan.length || 7}</dd></div>
        <div><dt>Day 1 状态</dt><dd>{dayOne ? packageStatusLabel(dayOne) : '尚未创建'}</dd></div>
      </dl>
      <div className="campaign-progress-track" aria-label="运营活动进度">
        <span style={{ width: `${progress?.percent || 0}%` }} />
      </div>
      <div className="campaign-blocker">
        <span>当前阻塞</span>
        <strong>{nextAction?.title || blockingItems[0]?.label || '暂无阻塞'}</strong>
      </div>
      <div className="button-row">
        <button className="ghost-button" type="button" onClick={() => onNavigate('campaigns', campaign.id, { campaign_id: campaign.id })}>
          查看活动
        </button>
        {nextAction && (
          <button className="primary-button" type="button" onClick={() => navigateToAction(nextAction, onNavigate)}>
            下一步：{nextAction.recommended_action}
          </button>
        )}
      </div>
    </section>
  );
}

function SevenDaySchedule({ timeline, onNavigate }) {
  return (
    <section className="command-section seven-day-schedule">
      <div className="section-head compact-head">
        <div><p className="eyebrow">未来 7 天发布计划</p><h3>内容与发布时间</h3></div>
        <button className="ghost-button" type="button" onClick={() => onNavigate('campaigns')}>查看完整计划</button>
      </div>
      {timeline.length ? (
        <div className="schedule-list">
          {timeline.map((item) => (
            <article key={item.day}>
              <div className="schedule-day"><strong>Day {item.day}</strong><span>{item.date || '待排期'}</span></div>
              <div><strong>{item.topic || '待确定主题'}</strong><small>{item.platform || '待选平台'} · {item.format || '待选形式'}</small></div>
              <StatusBadge status={item.status} />
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-card-inline">策略批准并生成 7 天计划后，会在这里显示简洁日程。</div>
      )}
    </section>
  );
}

function BusinessExceptions({ exceptions, onNavigate }) {
  return (
    <section className="command-section exception-panel">
      <div className="section-head compact-head">
        <div><p className="eyebrow">异常</p><h3>仅显示影响业务的问题</h3></div>
        <button className="ghost-button" type="button" onClick={() => onNavigate('health')}>系统状态</button>
      </div>
      {exceptions.length ? (
        <div className="exception-list">
          {exceptions.slice(0, 5).map((item) => (
            <article key={item.id}>
              <span>!</span>
              <div><strong>{item.title}</strong><p>{truncate(item.summary, 120)}</p></div>
              <button className="ghost-button" type="button" onClick={() => onNavigate(item.page, item.entityId || '')}>处理</button>
            </article>
          ))}
        </div>
      ) : (
        <div className="command-clear-state compact">
          <span>✓</span>
          <div><strong>没有影响当前业务的异常</strong><p>连接正常等技术状态已移至“系统状态”页面。</p></div>
        </div>
      )}
    </section>
  );
}

function AiRecommendations({ items, onNavigate }) {
  return (
    <section className="command-section recommendation-panel-v2">
      <div className="section-head compact-head">
        <div><p className="eyebrow">AI 建议</p><h3>有依据、可执行</h3></div>
        <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>知识库</button>
      </div>
      {items.length ? (
        <div className="recommendation-list-v2">
          {items.slice(0, 3).map((item) => (
            <article key={item.id}>
              <span>{item.index}</span>
              <div><strong>{item.title}</strong><p>{truncate(item.text, 130)}</p><small>依据：{item.evidence}</small></div>
              <button className="ghost-button" type="button" onClick={() => onNavigate(item.page)}>查看</button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-card-inline">完成账号分析、发布回收或策略复盘后，这里最多显示 3 条有数据依据的建议。</div>
      )}
    </section>
  );
}

function FirstUseGuide({ onNavigate }) {
  const steps = [
    ['1', '添加运营账号', '先确定要经营的主账号。', 'accounts'],
    ['2', '添加对标账号', '从账号矩阵标记竞品或灵感账号。', 'accounts'],
    ['3', '创建运营活动', '填写目标、平台和主账号。', 'campaigns'],
    ['4', '生成并批准策略', '确认定位、内容支柱和风险边界。', 'campaigns'],
    ['5', '生成 7 天计划', '先批准计划，再进入具体生产。', 'campaigns'],
    ['6', '开始 Day 1', '在内容工作台完成文案、素材和审核。', 'workspace'],
  ];
  return (
    <section className="page-stack command-center-v2">
      <header className="command-focus-header onboarding">
        <div>
          <p className="eyebrow">首次使用</p>
          <h2>从第一个运营活动开始</h2>
          <p>按下面顺序建立最小闭环，首页不会用大量无意义的 0 干扰你。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => onNavigate('accounts')}>添加运营账号</button>
      </header>
      <section className="command-section">
        <div className="onboarding-step-list">
          {steps.map(([number, title, description, page]) => (
            <button type="button" key={number} onClick={() => onNavigate(page)}>
              <span>{number}</span>
              <div><strong>{title}</strong><p>{description}</p></div>
              <em>进入 →</em>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function buildSevenDayTimeline(context, data) {
  if (!context?.currentStrategy) return [];
  const plan = normalizeCampaignDailyPlan(context.currentStrategy.daily_plan).slice(0, 7);
  return plan.map((item) => {
    const contentPackage = context.contentPackages?.find((row) => getContentPackageDay(row) === item.day);
    const publishTask = data.publishTasks.find((task) => String(task.content_package_id || '') === String(contentPackage?.id || ''));
    return {
      day: item.day,
      date: formatDate(item.planned_date || publishTask?.scheduled_at),
      topic: item.topic || item.content_pillar,
      platform: item.platform,
      format: item.format,
      status: publishTask?.status || contentPackage?.status || (item.day === 1 ? 'pending' : 'draft'),
    };
  });
}

function buildBusinessExceptions(data, queue, gatewayStatus) {
  const items = [];
  for (const error of data.__errors || []) {
    items.push({
      id: `read-${error.key}`,
      title: '关键数据读取失败',
      summary: error.message,
      page: 'health',
    });
  }
  for (const action of queue.filter((item) => ['resolve_publish_failure', 'resolve_metrics_failure'].includes(item.action_type))) {
    items.push({
      id: `${action.action_type}-${action.entity_id}`,
      title: action.title,
      summary: action.summary,
      page: action.target_page,
      entityId: action.entity_id,
    });
  }
  const requiresExecution = queue.some((item) => ['generate_day1_content', 'generate_asset', 'resolve_metrics_failure'].includes(item.action_type));
  if (!gatewayStatus.loading && !gatewayStatus.connected && requiresExecution) {
    items.push({
      id: 'execution-gateway',
      title: '执行服务阻塞当前任务',
      summary: gatewayStatus.reason || '当前待办需要调用执行服务，但执行网关尚未连接。',
      page: 'health',
    });
  }
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function buildRecommendations(data) {
  const candidates = [];
  const report = getLatest([...data.accountReports, ...data.accountProfiles], 1)[0];
  const strategyMemory = getLatest(data.strategyMemory, 1)[0];
  const contentMemory = [...data.contentMemory]
    .sort((left, right) => Number(right.success_rate || right.score || 0) - Number(left.success_rate || left.score || 0))[0];

  if (report) {
    candidates.push({
      id: `account-${report.id || 'latest'}`,
      title: '应用最新账号洞察',
      text: firstDisplayText(report, ['key_findings', 'summary', 'analysis', 'report', 'description']),
      evidence: `最新账号分析 · ${formatDate(report.updated_at || report.created_at)}`,
      page: 'intelligence',
    });
  }
  if (strategyMemory) {
    candidates.push({
      id: `strategy-${strategyMemory.id || 'latest'}`,
      title: '把复盘结论用于下一步',
      text: firstDisplayText(strategyMemory, ['lessons_learned', 'learning', 'recommendation', 'summary', 'description']),
      evidence: `策略记忆 · ${formatDate(strategyMemory.updated_at || strategyMemory.created_at)}`,
      page: 'analytics',
    });
  }
  if (contentMemory) {
    candidates.push({
      id: `content-${contentMemory.id || 'best'}`,
      title: '复用已验证的内容模式',
      text: firstDisplayText(contentMemory, ['pattern', 'winning_pattern', 'recommendation', 'summary', 'description']),
      evidence: `内容记忆 · 成功率 ${Number(contentMemory.success_rate || contentMemory.score || 0)}%`,
      page: 'knowledge',
    });
  }
  return candidates.filter((item) => item.text).slice(0, 3).map((item, index) => ({ ...item, index: index + 1 }));
}

function navigateToAction(item, onNavigate) {
  onNavigate(item.target_page, item.target_id, item.target_params);
}

function actionTypeLabel(type) {
  return {
    approve_strategy: '策略审批',
    approve_7_day_plan: '计划审批',
    generate_day1_content: '内容生成',
    review_copy: '文案审核',
    generate_asset: '素材生成',
    confirm_asset: '素材确认',
    approve_publish: '发布审批',
    resolve_publish_failure: '发布异常',
    resolve_metrics_failure: '数据异常',
  }[type] || '运营任务';
}

function accountLabel(account) {
  if (!account) return '未关联账号';
  const name = account.display_name || account.username || account.handle || account.account_name || '未命名账号';
  return `${account.platform || '平台待定'} · ${name}`;
}

function packageStatusLabel(item) {
  const workbench = item.source_insights?.content_workbench || {};
  if (item.status === 'published') return '已发布';
  if (item.status === 'scheduled') return '已排期';
  if (workbench.copy_approved) return '文案已批准';
  if (workbench.selected_version_id) return '文案待审核';
  return '待生成';
}

function firstDisplayText(row, fields) {
  for (const field of fields) {
    if (row?.[field] != null && row[field] !== '') return displayText(row[field], '');
  }
  return '';
}

function truncate(value, length) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
}
