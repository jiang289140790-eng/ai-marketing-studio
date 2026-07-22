import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
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
};

export function CampaignStrategyPage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    setLoading(true);
    loadCampaignData()
      .then((nextData) => setData({ ...EMPTY, ...nextData }))
      .finally(() => setLoading(false));
    return undefined;
  }, [userId]);

  const strategiesByCampaign = useMemo(() => {
    const map = new Map();
    data.strategies.forEach((strategy) => {
      const key = strategy.campaign_id || 'no-campaign';
      map.set(key, [...(map.get(key) || []), strategy]);
    });
    return map;
  }, [data.strategies]);

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会读取 Campaign 和 Agent 策略。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看和审批你的运营策略。" />;
  }

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">Campaign 与策略</p>
        <h2>只填写运营目标，Strategy Agent 负责把目标变成可执行计划</h2>
        <p>
          Campaign 只保留真正需要你判断的内容：目标、平台、自有账号、参考账号、主题、成功指标和时间范围。
          策略生成后先等待你审批；审批通过后，才会创建内容包并进入内容工作台。
        </p>
        <div className="button-row">
          <ExecutionButton actionName="创建 Campaign">新建 Campaign</ExecutionButton>
          <ExecutionButton actionName="让 Strategy Agent 生成策略" className="ghost-button">生成策略</ExecutionButton>
          <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>选择账号矩阵</button>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="Campaign" value={loading ? '-' : data.campaigns.length} hint="当前运营目标" />
        <StatCard label="待审批策略" value={loading ? '-' : countWhere(data.strategies, (item) => ['review', 'pending', 'draft'].includes(item.status))} hint="等待你批准或驳回" />
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
              />
            ))}
            {(strategiesByCampaign.get('no-campaign') || []).map((strategy) => (
              <StrategyCard key={strategy.id} strategy={strategy} accounts={data.accounts} onNavigate={onNavigate} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function CampaignCard({ campaign, strategies, accounts, onNavigate }) {
  return (
    <article className="strategy-card">
      <div className="section-head">
        <div>
          <p className="eyebrow">Campaign</p>
          <h3>{campaign.name || campaign.title || '未命名 Campaign'}</h3>
          <p>{campaign.goal || campaign.description || '暂无目标说明'}</p>
        </div>
        <StatusBadge status={campaign.status || 'active'} />
      </div>
      <div className="business-grid">
        <Info label="目标平台" value={campaign.target_platforms || campaign.platforms || campaign.platform} />
        <Info label="内容主题" value={campaign.content_themes || campaign.theme || campaign.topics} />
        <Info label="成功指标" value={campaign.success_metrics || campaign.kpi || campaign.metrics} />
        <Info label="时间范围" value={campaign.date_range || campaign.duration || campaign.time_range} />
      </div>
      <div className="nested-list">
        {strategies.length ? strategies.map((strategy) => (
          <StrategyCard key={strategy.id} strategy={strategy} accounts={accounts} compact onNavigate={onNavigate} />
        )) : <div className="empty-card-inline">还没有 Agent 策略。连接执行服务后，可以由 Strategy Agent 自动生成。</div>}
      </div>
    </article>
  );
}

function StrategyCard({ strategy, accounts, compact = false, onNavigate }) {
  const account = findById(accounts, strategy.account_id || strategy.target_account_id);
  const plan = strategy.plan || strategy.strategy || strategy.output || {};

  return (
    <article className={`strategy-card ${compact ? 'compact-card' : ''}`}>
      <div className="section-head">
        <div>
          <p className="eyebrow">Strategy Agent</p>
          <h3>{strategy.name || strategy.title || plan.title || '待审批策略'}</h3>
          <p>{strategy.goal || strategy.description || plan.goal || 'Agent 生成的策略会在这里转成可读业务内容。'}</p>
        </div>
        <StatusBadge status={strategy.status || 'review'} />
      </div>

      <div className="business-grid">
        <Info label="目标账号" value={account?.account_name || account?.username || strategy.target_account || plan.target_account} />
        <Info label="内容定位" value={strategy.content_positioning || plan.content_positioning || plan.positioning} />
        <Info label="Hook 规则" value={strategy.hook_rules || plan.hook_rules || plan.hooks} />
        <Info label="文案风格" value={strategy.copy_style || plan.copy_style || plan.tone} />
        <Info label="CTA 规则" value={strategy.cta_rules || plan.cta_rules || plan.cta} />
        <Info label="视觉方向" value={strategy.visual_direction || plan.visual_direction || plan.visual} />
        <Info label="发布频率" value={strategy.posting_frequency || plan.posting_frequency || plan.frequency} />
        <Info label="风险提示" value={strategy.risks || plan.risks || plan.risk_notes} />
      </div>

      <div className="button-row">
        <ExecutionButton actionName="批准策略并创建内容包">批准策略</ExecutionButton>
        <ExecutionButton actionName="驳回并重新生成策略" className="ghost-button">驳回并重生成</ExecutionButton>
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
