import { CampaignContextBar } from './CampaignContextBar';
import { useCampaignContext } from '../contexts/campaign-context';
import {
  AUXILIARY_DATA_SCOPES,
  auxiliaryScopeLabel,
} from '../utils/auxiliary-page-scope';

export function AuxiliaryPageFrame({
  children,
  dataScope,
  description,
  mode,
  onModeChange,
  onNavigate,
  onScopeChange,
}) {
  const { activeCampaign, campaignContext } = useCampaignContext();
  const primaryAccount = campaignContext?.primaryAccount;

  return (
    <div className="auxiliary-page-frame">
      <CampaignContextBar onNavigate={onNavigate} />
      <section className="auxiliary-foundation-toolbar" aria-label="辅助页面数据范围">
        <div className="auxiliary-responsibility">
          <span>页面职责</span>
          <strong>{description}</strong>
        </div>
        <label>
          <span>数据范围</span>
          <select value={dataScope} onChange={(event) => onScopeChange(event.target.value)}>
            {AUXILIARY_DATA_SCOPES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <div className="auxiliary-scope-summary">
          <span>正在查看</span>
          <strong>{auxiliaryScopeLabel(dataScope)}</strong>
          <small>
            {dataScope === 'campaign'
              ? activeCampaign?.name || '尚未选择运营活动'
              : dataScope === 'account'
                ? primaryAccount?.account_name || primaryAccount?.username || '尚未关联主账号'
                : dataScope === 'test' ? '仅显示测试与调试记录' : '不含测试数据的历史记录'}
          </small>
        </div>
        <div className="auxiliary-mode-switch" role="group" aria-label="信息显示模式">
          <button className={mode === 'normal' ? 'active' : ''} type="button" onClick={() => onModeChange('normal')}>普通模式</button>
          <button className={mode === 'advanced' ? 'active' : ''} type="button" onClick={() => onModeChange('advanced')}>高级模式</button>
        </div>
      </section>

      <div className="auxiliary-page-body" data-mode={mode}>{children}</div>

      {mode === 'advanced' && (
        <details className="auxiliary-technical-details">
          <summary>高级技术详情</summary>
          <dl>
            <div><dt>当前数据范围</dt><dd>{auxiliaryScopeLabel(dataScope)}</dd></div>
            <div><dt>运营活动标识</dt><dd>{activeCampaign?.id || '未选择'}</dd></div>
            <div><dt>主账号标识</dt><dd>{primaryAccount?.id || '未关联'}</dd></div>
          </dl>
          <p>原始 JSON、工作流标识、Storage 路径与技术错误仅在此模式显示；Secrets 与 Token 始终不会显示。</p>
        </details>
      )}
    </div>
  );
}
