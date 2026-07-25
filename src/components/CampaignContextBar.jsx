import { useMemo, useState } from 'react';
import { useCampaignContext } from '../contexts/campaign-context';
import { isHistoricalOrTestCampaign } from '../services/campaign-context-service';

export function CampaignContextBar({ onNavigate }) {
  const [showHistory, setShowHistory] = useState(false);
  const {
    campaigns,
    activeCampaign,
    campaignContext,
    progress,
    loading,
    error,
    selectCampaign,
  } = useCampaignContext();
  const visibleCampaigns = useMemo(
    () => campaigns.filter((campaign) => showHistory || !isHistoricalOrTestCampaign(campaign)),
    [campaigns, showHistory],
  );
  const hiddenCount = campaigns.length - visibleCampaigns.length;
  const currentDay = resolveCurrentDay(campaignContext);
  const blocker = campaignContext?.blockingItems?.[0]?.label || '暂无阻塞';
  const nextAction = resolveNextAction(campaignContext);
  const platform = campaignContext?.primaryAccount?.platform
    || firstValue(activeCampaign?.target_platforms)
    || '未设置';

  if (loading && !activeCampaign) {
    return <section className="campaign-context-bar"><span>正在读取当前运营活动…</span></section>;
  }

  if (!campaigns.length) {
    return (
      <section className="campaign-context-bar empty">
        <div><strong>当前没有运营活动</strong><span>先创建一个运营活动，再开始策略与内容生产。</span></div>
        <button className="primary-button" type="button" onClick={() => onNavigate('campaigns')}>创建运营活动</button>
      </section>
    );
  }

  return (
    <section className="campaign-context-bar" aria-label="当前运营活动上下文">
      <label className="campaign-context-select">
        <span>当前运营活动</span>
        <select value={activeCampaign?.id || ''} onChange={(event) => selectCampaign(event.target.value)}>
          {visibleCampaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>{campaign.name || '未命名运营活动'}</option>
          ))}
          {!visibleCampaigns.some((campaign) => campaign.id === activeCampaign?.id) && activeCampaign && (
            <option value={activeCampaign.id}>{activeCampaign.name || '当前运营活动'}</option>
          )}
        </select>
        {hiddenCount > 0 && (
          <button className="context-history-toggle" type="button" onClick={() => setShowHistory((value) => !value)}>
            {showHistory ? '隐藏历史/测试数据' : `历史/测试数据（${hiddenCount}）`}
          </button>
        )}
      </label>
      <div className="campaign-context-fact">
        <span>主账号</span>
        <strong>
          {campaignContext?.primaryAccount
            ? `${campaignContext.primaryAccount.platform || '平台未设置'} · ${campaignContext.primaryAccount.account_name || campaignContext.primaryAccount.username || '未命名账号'}`
            : '尚未关联'}
        </strong>
      </div>
      <div className="campaign-context-fact">
        <span>平台</span>
        <strong>{platform}</strong>
      </div>
      <div className="campaign-context-fact">
        <span>当前 Day</span>
        <strong>{currentDay}</strong>
      </div>
      <div className="campaign-context-fact">
        <span>当前步骤</span>
        <strong>{progress?.currentStage || '正在判断'}</strong>
      </div>
      <div className="campaign-context-fact campaign-context-wide">
        <span>阻塞问题</span>
        <strong>{blocker}</strong>
      </div>
      <div className="campaign-context-fact campaign-context-wide">
        <span>下一步操作</span>
        <strong>{nextAction}</strong>
      </div>
      {error && <span className="campaign-context-error">{error}</span>}
    </section>
  );
}

function resolveCurrentDay(context) {
  const packages = context?.contentPackages || [];
  if (!packages.length) return 'Day 1';
  const current = packages.find((item) => !['completed', 'published', 'archived'].includes(
    String(item.review_status || item.status || '').toLowerCase(),
  )) || packages[packages.length - 1];
  const source = current?.source_insights && typeof current.source_insights === 'object'
    ? current.source_insights
    : {};
  const value = source.day_index || source.day || String(current?.title || '').match(/day\s*(\d+)/i)?.[1] || 1;
  return `Day ${Number(String(value).match(/\d+/)?.[0] || 1)}`;
}

function resolveNextAction(context) {
  const code = context?.blockingItems?.[0]?.code;
  const actions = {
    primary_account_missing: '关联主运营账号',
    account_brain_missing: '确认账号分析报告',
    strategy_missing: '生成并批准策略',
    daily_plan_missing: '补全并批准 7 天计划',
    day1_package_missing: '创建 Day 1 内容包',
    day1_copy_missing: '进入 Day 1 生成文案',
    day1_character_missing: '为 Day 1 选择角色 / LoRA',
    day1_asset_missing: '创建安全预演素材任务',
    day1_review_missing: '完成内容终审',
    day1_publish_missing: '创建 dry-run 发布任务',
    day1_metrics_missing: '回收 Day 1 指标',
  };
  return actions[code] || '继续当前 Day';
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  if (value && typeof value === 'object') return Object.values(value).flat()[0];
  return value;
}
