import { useCampaignContext } from '../contexts/campaign-context';

export function CampaignContextBar({ onNavigate }) {
  const {
    campaigns,
    activeCampaign,
    campaignContext,
    progress,
    loading,
    error,
    selectCampaign,
  } = useCampaignContext();

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
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>{campaign.name || '未命名运营活动'}</option>
          ))}
        </select>
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
        <span>当前阶段</span>
        <strong>{progress?.currentStage || '正在判断'}</strong>
      </div>
      {error && <span className="campaign-context-error">{error}</span>}
    </section>
  );
}
