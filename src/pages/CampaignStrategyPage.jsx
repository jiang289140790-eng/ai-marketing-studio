import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { getExecutionStatus } from '../services/execution-gateway';
import { countWhere, displayText, findById, loadCampaignData } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';

const EMPTY = {
  campaigns: [],
  strategies: [],
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

export function CampaignStrategyPage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [form, setForm] = useState(INITIAL_FORM);
  const [loading, setLoading] = useState(false);
  const [gateway, setGateway] = useState({ loading: true, connected: false });

  const reload = useCallback(() => {
    if (!userId || !isSupabaseConfigured) return Promise.resolve();
    setLoading(true);
    return loadCampaignData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .finally(() => setLoading(false));
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    let mounted = true;
    getExecutionStatus().then((status) => {
      if (mounted) setGateway({ loading: false, ...status });
    });
    return () => {
      mounted = false;
    };
  }, []);

  const strategiesByCampaign = useMemo(() => {
    const map = new Map();
    data.strategies.forEach((strategy) => {
      const key = strategy.campaign_id || 'no-campaign';
      map.set(key, [...(map.get(key) || []), strategy]);
    });
    return map;
  }, [data.strategies]);

  const ownedAccounts = data.accounts.filter((account) => ['owned', 'brand', 'personal'].includes(account.account_role || account.account_type || account.account_category || 'owned'));
  const campaignPayload = buildCampaignPayload(form, ownedAccounts);
  const canCreate = Boolean(form.name.trim() && form.goal.trim());
  const createHint = !canCreate ? '请先填写名称和目标' : !gateway.connected ? '执行服务暂未连接，请查看上方连接状态' : '';

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会读取 Campaign 和 Agent 策略。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能创建、查看和审核你的运营策略。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">Campaign 与策略</p>
        <h2>先定义运营目标，再让 Strategy Agent 生成可执行策略</h2>
        <p>
          Campaign 是 AI 员工的任务 brief：目标、平台、账号、主题、成功指标、图片/视频需求都会传给执行网关。
          策略生成后会保存到 strategy_plans，必须经过你批准后才进入内容工作台。
        </p>
      </div>

      <DataReadErrors errors={data.__errors} />

      <form className="campaign-form-card" onSubmit={(event) => event.preventDefault()}>
        <div className="section-head">
          <div>
            <p className="eyebrow">新建 Campaign</p>
            <h3>给 AI 营销团队一个明确目标</h3>
          </div>
          <ExecutionButton
            action="create_campaign"
            actionName="创建 Campaign"
            payload={campaignPayload}
            ready={canCreate}
            reason={!canCreate ? '请先填写名称和目标' : undefined}
            showGatewayHint={canCreate}
            onCompleted={reload}
          >
            创建 Campaign
          </ExecutionButton>
        </div>
        {createHint && <div className="form-hint">{createHint}</div>}

        <div className="form-grid">
          <label>
            <span>名称</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：欧美 AI 角色账号增长" />
          </label>
          <label>
            <span>平台</span>
            <input value={form.platforms} onChange={(event) => setForm({ ...form, platforms: event.target.value })} placeholder="x, telegram" />
          </label>
          <label className="wide">
            <span>目标</span>
            <textarea value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} placeholder="例如：30 天内提升 X 账号关注并给 Telegram 引流" />
          </label>
          <label className="wide">
            <span>内容主题</span>
            <textarea value={form.themes} onChange={(event) => setForm({ ...form, themes: event.target.value })} placeholder="一行一个主题，例如：AI角色写真、ComfyUI工作流、角色故事" />
          </label>
          <label>
            <span>成功指标</span>
            <input value={form.successMetrics} onChange={(event) => setForm({ ...form, successMetrics: event.target.value })} />
          </label>
          <label>
            <span>目标账号</span>
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

      <div className="stat-grid compact">
        <StatCard label="Campaign" value={loading ? '-' : data.campaigns.length} hint="当前运营目标" />
        <StatCard label="待审核策略" value={loading ? '-' : countWhere(data.strategies, (item) => ['review', 'pending', 'draft'].includes(item.status))} hint="等待你批准或驳回" />
        <StatCard label="已批准策略" value={loading ? '-' : countWhere(data.strategies, (item) => item.status === 'approved')} hint="可进入内容生产" />
        <StatCard label="可用账号" value={loading ? '-' : data.accounts.length} hint="来自账号矩阵" />
      </div>

      <div className="stack-list">
        {data.campaigns.length === 0 && data.strategies.length === 0 ? (
          <EmptyState title="暂无 Campaign 策略" description="创建 Campaign 后，Agent 生成的策略会以业务卡片方式显示在这里。" />
        ) : (
          <>
            {data.campaigns.map((campaign) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                strategies={strategiesByCampaign.get(campaign.id) || []}
                accounts={data.accounts}
                onNavigate={onNavigate}
                onRefresh={reload}
              />
            ))}
            {(strategiesByCampaign.get('no-campaign') || []).map((strategy) => (
              <StrategyCard key={strategy.id} strategy={strategy} accounts={data.accounts} onNavigate={onNavigate} onRefresh={reload} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function CampaignCard({ campaign, strategies, accounts, onNavigate, onRefresh }) {
  const accountIds = extractAccountIds(campaign.target_accounts);
  const platforms = normalizeArray(campaign.target_platforms);
  const topics = normalizeArray(campaign.content_themes);

  return (
    <article className="strategy-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">Campaign</p>
          <h3>{campaign.name || '未命名 Campaign'}</h3>
          <p>{campaign.goal || '暂无目标说明'}</p>
        </div>
        <StatusBadge status={campaign.status || 'active'} />
      </div>
      <div className="business-grid">
        <Info label="目标平台" value={platforms} />
        <Info label="内容主题" value={topics} />
        <Info label="成功指标" value={campaign.success_metrics} />
        <Info label="素材需求" value={campaign.asset_requirements} />
      </div>
      <div className="button-row">
        <ExecutionButton
          action="generate_strategy"
          actionName="让 Strategy Agent 生成策略"
          resourceType="campaign"
          resourceId={campaign.id}
          payload={{
            campaign_id: campaign.id,
            account_ids: accountIds,
            platforms,
            objective: campaign.goal,
            content_topics: topics,
            period_type: 'weekly',
            content_theme_count: Math.max(3, topics.length || 3),
            save_to_db: true,
          }}
          onCompleted={onRefresh}
        >
          让 AI 生成本周策略
        </ExecutionButton>
        <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>选择账号矩阵</button>
      </div>
      <div className="nested-list">
        {strategies.length ? strategies.map((strategy) => (
          <StrategyCard key={strategy.id} strategy={strategy} accounts={accounts} compact onNavigate={onNavigate} onRefresh={onRefresh} />
        )) : <div className="empty-card-inline">还没有 Agent 策略。点击“生成策略”后会保存到 strategy_plans。</div>}
      </div>
    </article>
  );
}

function StrategyCard({ strategy, accounts, compact = false, onNavigate, onRefresh }) {
  const account = findById(accounts, strategy.account_id || strategy.target_account_id);
  const plan = strategy.plan || strategy.strategy || strategy.output || {};
  const pillars = normalizePillars(strategy.content_themes || strategy.content_pillars || plan.content_pillars || plan.content_themes);
  const dailyPlan = normalizeDailyPlan(strategy.daily_plan || plan.daily_plan || plan.weekly_plan || plan.content_calendar);
  const isReview = ['review', 'pending', 'draft'].includes(strategy.status || 'review');

  return (
    <article className={`strategy-card ${compact ? 'compact-card' : ''}`}>
      <div className="section-head">
        <div>
          <p className="eyebrow">Strategy Agent</p>
          <h3>{strategy.name || strategy.title || plan.title || '待审核策略'}</h3>
          <p className="strategy-summary">{strategy.description || strategy.executive_summary || plan.executive_summary || 'Agent 生成的策略会转成可审核的业务内容。'}</p>
        </div>
        <StatusBadge status={strategy.status || 'review'} />
      </div>

      <div className="business-grid">
        <Info label="目标账号" value={account?.account_name || account?.username || strategy.target_accounts} />
        <Info label="内容支柱" value={strategy.content_themes || plan.content_pillars} />
        <Info label="Hook 规则" value={plan.hook_library || strategy.source_insights} />
        <Info label="CTA 策略" value={plan.cta_strategy || strategy.kpi_targets} />
        <Info label="平台" value={strategy.target_platforms} />
        <Info label="模型" value={strategy.llm_model} />
      </div>

      <div className="strategy-pillars" aria-label="内容支柱">
        {pillars.length ? pillars.map((pillar, index) => (
          <span className="pillar-tag" key={`${pillar.name}-${index}`}>
            {pillar.name}{pillar.weight != null ? ` · ${Math.round(pillar.weight * 100)}%` : ''}
          </span>
        )) : <span className="pillar-tag muted">等待 AI 生成内容支柱</span>}
      </div>

      <div className="strategy-daily-plan">
        <div className="daily-plan-head"><strong>本周执行预览</strong><span>{dailyPlan.length ? `${dailyPlan.length} 天` : '等待生成'}</span></div>
        {dailyPlan.length ? (
          <div className="daily-plan-grid">
            {dailyPlan.slice(0, 7).map((day) => (
              <div className="day-slot" key={day.day}>
                <strong>{day.day}</strong>
                <span>{day.pillar || '待定主题'}</span>
                <small>{day.platform || '待定平台'}</small>
              </div>
            ))}
          </div>
        ) : <div className="empty-card-inline">AI 策略生成后，这里会显示周一到周日的主题与平台安排。</div>}
      </div>

      <div className="button-row">
        {isReview && (
          <>
            <ExecutionButton
              action="approve_strategy"
              actionName="批准策略并创建内容包"
              resourceType="strategy"
              resourceId={strategy.id}
              payload={{ strategy_id: strategy.id, action: 'approve' }}
              onCompleted={onRefresh}
            >
              批准策略
            </ExecutionButton>
            <ExecutionButton
              action="reject_strategy"
              actionName="驳回策略"
              className="ghost-button"
              resourceType="strategy"
              resourceId={strategy.id}
              payload={() => ({ strategy_id: strategy.id, action: 'reject', feedback: window.prompt('驳回原因或修改意见') || '' })}
              onCompleted={onRefresh}
            >
              驳回策略
            </ExecutionButton>
          </>
        )}
        <button className="ghost-button" type="button" onClick={() => onNavigate('workspace')}>查看关联内容</button>
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

function DataReadErrors({ errors = [] }) {
  if (!errors.length) return null;
  return (
    <div className="error-banner">
      <strong>数据读取异常</strong>
      <ul>
        {errors.slice(0, 5).map((error) => (
          <li key={`${error.key}-${error.message}`}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

function buildCampaignPayload(form, accounts) {
  const targetAccounts = form.accountIds.map((id) => {
    const account = accounts.find((item) => item.id === id);
    return {
      account_id: id,
      platform: account?.platform,
      username: account?.username || account?.account_name,
    };
  });

  return {
    name: form.name.trim(),
    goal: form.goal.trim(),
    target_accounts: targetAccounts,
    target_audience: [],
    target_platforms: splitList(form.platforms).map((item) => item.toLowerCase()),
    content_themes: splitList(form.themes),
    success_metrics: {
      metrics: splitList(form.successMetrics),
    },
    asset_requirements: {
      need_image: form.needImage,
      need_video: form.needVideo,
    },
    status: 'active',
  };
}

function splitList(value) {
  return String(value || '')
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value).flat().filter(Boolean);
  return splitList(value);
}

function extractAccountIds(value) {
  return normalizeArray(value)
    .map((item) => (typeof item === 'string' ? item : item?.account_id || item?.id))
    .filter(Boolean);
}

function normalizePillars(value) {
  return normalizeArray(value).map((item, index) => {
    if (typeof item === 'string') return { name: item, weight: null };
    const rawWeight = item?.weight ?? item?.ratio ?? item?.percentage;
    const numericWeight = rawWeight == null ? null : Number(rawWeight);
    return {
      name: item?.pillar || item?.name || item?.title || item?.theme || `内容支柱 ${index + 1}`,
      weight: Number.isFinite(numericWeight) ? (numericWeight > 1 ? numericWeight / 100 : numericWeight) : null,
    };
  });
}

function normalizeDailyPlan(value) {
  if (!value) return [];
  const entries = Array.isArray(value) ? value.map((item, index) => [item.day || item.date || `第 ${index + 1} 天`, item]) : Object.entries(value);
  return entries.map(([day, item]) => {
    const plan = typeof item === 'string' ? { pillar: item } : item || {};
    return {
      day,
      pillar: plan.pillar || plan.theme || plan.topic || plan.title || plan.content,
      platform: normalizeArray(plan.platform || plan.platforms || plan.channel).join(' / '),
    };
  });
}
