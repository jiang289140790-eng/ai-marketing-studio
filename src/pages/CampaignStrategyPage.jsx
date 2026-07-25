import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { countWhere, displayText, loadCampaignData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  getCampaignDayRows,
  getDailyPlanApprovalStatus,
  isCompleteSevenDayPlan,
  normalizeCampaignDailyPlan,
} from '../utils/campaign-daily-plan';

const EMPTY = {
  campaigns: [],
  strategies: [],
  contentPackages: [],
  accounts: [],
  accountReports: [],
  knowledge: [],
  strategyMemory: [],
  contentMetrics: [],
  __errors: [],
};

const INITIAL_FORM = {
  name: '',
  goal: '',
  platforms: 'x',
  accountIds: [],
  themes: '',
  successMetrics: '曝光、互动、关注、点击',
  needImage: true,
  needVideo: false,
};

export function CampaignStrategyPage({ userId, onNavigate, activeCampaignId, refreshCampaignContext }) {
  const [data, setData] = useState(EMPTY);
  const [form, setForm] = useState(INITIAL_FORM);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    try {
      const nextData = await loadCampaignData();
      setData({ ...EMPTY, ...nextData });
      await refreshCampaignContext?.();
    } finally {
      setLoading(false);
    }
  }, [refreshCampaignContext, userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const strategiesByCampaign = useMemo(() => {
    const map = new Map();
    data.strategies.forEach((strategy) => {
      const key = strategy.campaign_id || 'no-campaign';
      map.set(key, [...(map.get(key) || []), strategy]);
    });
    return map;
  }, [data.strategies]);

  const visibleCampaigns = activeCampaignId
    ? data.campaigns.filter((campaign) => String(campaign.id) === String(activeCampaignId))
    : data.campaigns;
  const ownedAccounts = data.accounts.filter((account) => (
    ['owned', 'brand', 'personal'].includes(account.account_role || account.account_type || account.account_category || 'owned')
  ));
  const campaignPayload = buildCampaignPayload(form, ownedAccounts);
  const canCreate = Boolean(form.name.trim() && form.goal.trim());

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="配置完成后，这里会读取运营活动和策略。" />;
  }
  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能创建、查看和审核运营策略。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">运营活动与策略</p>
        <h2>先批准策略，再批准 7 天计划，最后从 Day 1 开始生产</h2>
        <p>系统继续复用现有运营活动、策略的 daily_plan 和内容包，不会建立另一套内容计划。</p>
      </div>

      <DataReadErrors errors={data.__errors} />

      <details className="campaign-create-disclosure" open={!visibleCampaigns.length}>
        <summary>{visibleCampaigns.length ? '创建其他运营活动' : '创建第一个运营活动'}</summary>
      <form className="campaign-form-card" onSubmit={(event) => event.preventDefault()}>
        <div className="section-head">
          <div>
            <p className="eyebrow">新建运营活动</p>
            <h3>给 AI 营销团队一个明确目标</h3>
          </div>
          <ExecutionButton
            action="create_campaign"
            actionName="创建运营活动"
            payload={campaignPayload}
            ready={canCreate}
            reason={!canCreate ? '请先填写名称和目标' : undefined}
            onCompleted={reload}
          >
            创建运营活动
          </ExecutionButton>
        </div>
        <div className="form-grid">
          <label>
            <span>名称</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：AI 角色账号增长" />
          </label>
          <label>
            <span>平台</span>
            <input value={form.platforms} onChange={(event) => setForm({ ...form, platforms: event.target.value })} placeholder="x" />
          </label>
          <label className="wide">
            <span>运营目标</span>
            <textarea value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder="例如：30 天内提升关注和有效互动" />
          </label>
          <label className="wide">
            <span>内容主题</span>
            <textarea value={form.themes} onChange={(event) => setForm({ ...form, themes: event.target.value })} placeholder="一行一个主题" />
          </label>
          <label>
            <span>成功指标</span>
            <input value={form.successMetrics} onChange={(event) => setForm({ ...form, successMetrics: event.target.value })} />
          </label>
          <label>
            <span>主运营账号</span>
            <select
              multiple
              value={form.accountIds}
              onChange={(event) => setForm({ ...form, accountIds: Array.from(event.target.selectedOptions).map((option) => option.value) })}
            >
              {ownedAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.account_name || account.username || account.account_url}</option>
              ))}
            </select>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.needImage} onChange={(event) => setForm({ ...form, needImage: event.target.checked })} />
            <span>需要图片素材</span>
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.needVideo} onChange={(event) => setForm({ ...form, needVideo: event.target.checked })} />
            <span>需要视频素材</span>
          </label>
        </div>
      </form>
      </details>

      <div className="stat-grid compact">
        <StatCard label="当前运营活动" value={loading ? '-' : visibleCampaigns.length} hint="默认只显示当前活动" />
        <StatCard label="待批准策略" value={loading ? '-' : countWhere(data.strategies, (item) => (
          visibleCampaigns.some((campaign) => String(campaign.id) === String(item.campaign_id))
          && ['review', 'pending', 'draft'].includes(item.status)
        ))} hint="等待人工确认" />
        <StatCard label="已批准策略" value={loading ? '-' : countWhere(data.strategies, (item) => (
          visibleCampaigns.some((campaign) => String(campaign.id) === String(item.campaign_id))
          && item.status === 'approved'
        ))} hint="可查看 7 天计划" />
        <StatCard label="当前内容包" value={loading ? '-' : countWhere(data.contentPackages, (item) => (
          visibleCampaigns.some((campaign) => String(campaign.id) === String(item.campaign_id))
        ))} hint="当前活动数据" />
      </div>

      <div className="stack-list">
        {!visibleCampaigns.length ? (
          <EmptyState title="暂无运营活动" description="创建运营活动后，按策略审批和 7 天计划审批顺序推进。" />
        ) : visibleCampaigns.map((campaign) => (
          <CampaignCard
            key={campaign.id}
            campaign={campaign}
            strategies={strategiesByCampaign.get(campaign.id) || []}
            accounts={data.accounts}
            contentPackages={data.contentPackages}
            onNavigate={onNavigate}
            onRefresh={reload}
          />
        ))}
      </div>
    </section>
  );
}

function CampaignCard({ campaign, strategies, accounts, contentPackages, onNavigate, onRefresh }) {
  const accountIds = extractAccountIds(campaign.target_accounts);
  const platforms = normalizeArray(campaign.target_platforms);
  const topics = normalizeArray(campaign.content_themes);
  const primaryAccount = accounts.find((account) => accountIds.includes(String(account.id)));

  return (
    <article className="strategy-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">运营活动</p>
          <h3>{campaign.name || '未命名运营活动'}</h3>
          <p>{campaign.goal || '暂无目标说明'}</p>
        </div>
        <StatusBadge status={campaign.status || 'active'} />
      </div>
      <div className="business-grid">
        <Info label="主运营账号" value={primaryAccount?.account_name || primaryAccount?.username || accountIds} />
        <Info label="目标平台" value={platforms} />
        <Info label="目标受众" value={campaign.target_audience} />
        <Info label="内容主题" value={topics} />
        <Info label="成功指标" value={campaign.success_metrics} />
        <Info label="素材要求" value={campaign.asset_requirements} />
      </div>
      <div className="button-row">
        <ExecutionButton
          action="generate_campaign_strategy"
          actionName="生成运营策略"
          resourceType="campaign"
          resourceId={campaign.id}
          payload={{
            campaign_id: campaign.id,
            account_ids: accountIds,
            platforms,
            objective: campaign.goal,
            content_topics: topics,
            period_type: 'weekly',
            save_to_db: true,
          }}
          onCompleted={onRefresh}
        >
          生成运营策略
        </ExecutionButton>
        <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>查看账号矩阵</button>
      </div>

      <div className="nested-list">
        {strategies.length ? strategies.map((strategy) => (
          <StrategyCard
            key={strategy.id}
            campaign={campaign}
            strategy={strategy}
            primaryAccount={primaryAccount}
            contentPackages={contentPackages.filter((item) => (
              String(item.strategy_plan_id || '') === String(strategy.id)
              || String(item.campaign_id || '') === String(campaign.id)
            ))}
            onNavigate={onNavigate}
            onRefresh={onRefresh}
          />
        )) : <div className="empty-card-inline">还没有策略。先生成策略，再由你人工批准。</div>}
      </div>
    </article>
  );
}

function StrategyCard({ campaign, strategy, primaryAccount, contentPackages, onNavigate, onRefresh }) {
  const plan = strategy.plan || strategy.strategy || strategy.output || {};
  const dailyPlan = normalizeCampaignDailyPlan(strategy.daily_plan || plan.daily_plan || plan.weekly_plan);
  const dayRows = getCampaignDayRows(dailyPlan, contentPackages);
  const planApproval = getDailyPlanApprovalStatus(strategy);
  const completePlan = isCompleteSevenDayPlan(dailyPlan);
  const isReview = ['review', 'pending', 'draft'].includes(strategy.status || 'review');
  const isApproved = strategy.status === 'approved';
  const dayOne = dayRows.find((item) => item.day === 1);
  const packagesReady = dayRows.filter((item) => item.contentPackage).length === 7;
  const evidence = extractStrategyEvidence(strategy);

  return (
    <article className="strategy-card compact-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">策略方案</p>
          <h3>{strategy.name || strategy.title || plan.title || '待批准策略'}</h3>
          <p className="strategy-summary">{strategy.description || strategy.executive_summary || plan.executive_summary || '等待策略说明'}</p>
        </div>
        <StatusBadge status={strategy.status || 'review'} />
      </div>

      <div className="business-grid strategy-detail-grid">
        <Info label="运营活动" value={campaign.name} />
        <Info label="主账号" value={primaryAccount?.account_name || primaryAccount?.username || strategy.target_accounts} />
        <Info label="运营目标" value={campaign.goal} />
        <Info label="目标受众" value={strategy.target_audience || plan.target_audience || campaign.target_audience} />
        <Info label="账号定位" value={strategy.account_positioning || plan.account_positioning || primaryAccount?.positioning} />
        <Info label="内容支柱" value={strategy.content_themes || plan.content_pillars} />
        <Info label="发布频率" value={plan.posting_frequency || strategy.posting_frequency || '由 7 天计划确认'} />
        <Info label="内容比例" value={plan.content_mix || strategy.content_mix || 'AI 初始建议，待数据验证后调整'} />
        <Info label="视觉方向" value={plan.visual_direction || strategy.visual_direction || campaign.asset_requirements} />
        <Info label="文案风格" value={plan.copy_style || plan.tone || strategy.copy_style} />
        <Info label="互动策略" value={plan.engagement_strategy || strategy.engagement_strategy} />
        <Info label="转化策略" value={plan.conversion_strategy || plan.cta_strategy || strategy.kpi_targets} />
        <Info label="风险边界" value={strategy.risk_notes || plan.risk_notes || plan.guardrails} />
        <Info label="生成依据" value={evidence} />
      </div>

      <div className="strategy-daily-plan">
        <div className="daily-plan-head">
          <strong>7 天内容计划</strong>
          <span>{dailyPlan.length}/7 天 · 计划状态：{planApproval === 'approved' ? '已批准' : '待批准'}</span>
        </div>
        {dayRows.length ? (
          <div className="campaign-day-list">
            {dayRows.map((day) => (
              <details className="campaign-day-item" key={day.day} open={day.day === 1}>
                <summary>
                  <strong>Day {day.day}</strong>
                  <span>{day.topic || day.content_pillar || '待补充主题'}</span>
                  <StatusBadge status={day.status || 'not_started'} />
                </summary>
                <div className="business-grid">
                  <Info label="计划日期" value={day.planned_date} />
                  <Info label="平台" value={day.platform} />
                  <Info label="内容支柱" value={day.content_pillar} />
                  <Info label="内容角色" value={day.content_role} />
                  <Info label="目标" value={day.objective} />
                  <Info label="Hook 类型" value={day.hook_type} />
                  <Info label="内容形式" value={day.format} />
                  <Info label="素材要求" value={day.media_requirement} />
                  <Info label="行动引导" value={day.CTA} />
                  <Info label="备注" value={day.notes} />
                </div>
              </details>
            ))}
          </div>
        ) : <div className="empty-card-inline">策略批准后，点击“生成 7 天计划”。</div>}
      </div>

      <div className="button-row">
        {isReview && (
          <>
            <ExecutionButton
              action="approve_campaign_strategy"
              actionName="批准策略"
              resourceType="strategy"
              resourceId={strategy.id}
              payload={{ campaign_id: campaign.id, strategy_id: strategy.id, action: 'approve' }}
              onCompleted={onRefresh}
            >
              批准策略
            </ExecutionButton>
            <ExecutionButton
              action="approve_campaign_strategy"
              actionName="要求修改策略"
              className="ghost-button"
              resourceType="strategy"
              resourceId={strategy.id}
              payload={() => ({
                campaign_id: campaign.id,
                strategy_id: strategy.id,
                action: 'request_changes',
                feedback: window.prompt('请输入需要修改的内容') || '',
              })}
              onCompleted={onRefresh}
            >
              要求修改
            </ExecutionButton>
          </>
        )}

        {isApproved && (!completePlan || planApproval !== 'approved') && (
          <ExecutionButton
            action="generate_7_day_plan"
            actionName={dailyPlan.length ? '修改 7 天计划' : '生成 7 天计划'}
            resourceType="strategy"
            resourceId={strategy.id}
            payload={{
              campaign_id: campaign.id,
              strategy_id: strategy.id,
              items_per_day: 1,
              max_total_items: 7,
              confirm_overwrite: dailyPlan.length > 0,
            }}
            onCompleted={onRefresh}
          >
            {dailyPlan.length ? '修改 7 天计划' : '生成 7 天计划'}
          </ExecutionButton>
        )}

        {isApproved && completePlan && planApproval !== 'approved' && (
          <ExecutionButton
            action="approve_7_day_plan"
            actionName="批准 7 天计划"
            resourceType="strategy"
            resourceId={strategy.id}
            payload={{ campaign_id: campaign.id, strategy_id: strategy.id }}
            onCompleted={onRefresh}
          >
            批准 7 天计划
          </ExecutionButton>
        )}

        {isApproved && planApproval === 'approved' && !packagesReady && (
          <ExecutionButton
            action="create_content_packages_from_daily_plan"
            actionName="创建 Day 1—Day 7 内容包"
            resourceType="strategy"
            resourceId={strategy.id}
            payload={{ campaign_id: campaign.id, strategy_id: strategy.id }}
            onCompleted={onRefresh}
          >
            创建 7 天内容包
          </ExecutionButton>
        )}

        {dayOne?.contentPackage && (
          <ExecutionButton
            action="start_campaign_day"
            actionName="开始 Day 1"
            resourceType="content_package"
            resourceId={dayOne.contentPackage.id}
            payload={{ campaign_id: campaign.id, strategy_id: strategy.id, day: 1 }}
            onCompleted={async () => {
              await onRefresh?.();
              onNavigate('workspace', dayOne.contentPackage.id, { strategy_id: strategy.id, day: 1 });
            }}
          >
            开始 Day 1
          </ExecutionButton>
        )}
      </div>
      <p className="form-hint">Day 2—Day 7 仅建立计划和内容包，本任务不会自动生产，也不会触发真实发布。</p>
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

function DataReadErrors({ errors = [] }) {
  if (!errors.length) return null;
  return (
    <div className="error-banner">
      <strong>数据读取异常</strong>
      <ul>{errors.slice(0, 5).map((error) => <li key={`${error.key}-${error.message}`}>{error.message}</li>)}</ul>
    </div>
  );
}

function buildCampaignPayload(form, accounts) {
  const targetAccounts = form.accountIds.map((id) => {
    const account = accounts.find((item) => String(item.id) === String(id));
    return { account_id: id, platform: account?.platform, username: account?.username || account?.account_name };
  });
  return {
    name: form.name.trim(),
    goal: form.goal.trim(),
    target_accounts: targetAccounts,
    target_audience: [],
    target_platforms: splitList(form.platforms).map((item) => item.toLowerCase()),
    content_themes: splitList(form.themes),
    success_metrics: { metrics: splitList(form.successMetrics) },
    asset_requirements: { need_image: form.needImage, need_video: form.needVideo },
    status: 'active',
  };
}

function extractStrategyEvidence(strategy) {
  const values = Array.isArray(strategy.source_insights) ? strategy.source_insights : [];
  return values.filter((item) => !['approval_feedback', 'daily_plan_approval', 'daily_plan_generation'].includes(item?.type));
}

function splitList(value) {
  return String(value || '').split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value).flat().filter(Boolean);
  return splitList(value);
}

function extractAccountIds(value) {
  return normalizeArray(value)
    .map((item) => String(typeof item === 'string' ? item : item?.account_id || item?.id || ''))
    .filter(Boolean);
}
