import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountForm } from '../components/AccountForm';
import { EmptyState } from '../components/EmptyState';
import { MoreActionsMenu } from '../components/MoreActionsMenu';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import {
  createSocialAccount,
  deleteSocialAccount,
  listSocialAccounts,
  updateSocialAccount,
} from '../services/account-service';
import { loadAccountMatrixData } from '../services/ops-service';
import { listPlatformConnections } from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import {
  buildAccountMatrixRows,
  getAccountRole,
  isReferenceAccount,
  safeBusinessText,
} from '../utils/account-matrix';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate, statusLabel } from '../utils/formatters';

const ACCOUNT_TABS = [
  { id: 'owned', label: '自有账号' },
  { id: 'reference', label: '对标与灵感' },
  { id: 'all', label: '全部账号' },
];

const DETAIL_TABS = [
  ['overview', '概览'],
  ['brain', '账号大脑'],
  ['samples', '内容样本'],
  ['campaigns', '运营活动关联'],
  ['character', '角色绑定'],
  ['capabilities', '平台能力'],
  ['history', '分析历史'],
  ['quality', '数据质量'],
];

function isErrorMessage(message) {
  return /失败|错误|缺少|error|failed/i.test(String(message || ''));
}

function TextValue({ value, fallback = '—' }) {
  const safe = safeBusinessText(value, fallback);
  return <span className={safe.damaged ? 'damaged-text' : ''}>{safe.text}</span>;
}

export function AccountsPage({
  activeCampaignId,
  auxiliaryMode = 'business',
  campaignContext,
  dataScope = 'campaign',
  userId,
  detailId,
  onNavigate,
}) {
  const { confirm } = useConfirmation();
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState('owned');
  const [view, setView] = useState('table');
  const [detailTab, setDetailTab] = useState('overview');
  const [selectedId, setSelectedId] = useState(detailId || '');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [accounts, connections, related] = await Promise.all([
        listSocialAccounts(userId),
        listPlatformConnections(userId),
        loadAccountMatrixData(),
      ]);
      const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId };
      const scopedAccounts = filterRecordsForAuxiliaryScope(accounts, scopeOptions);
      const scopedConnections = filterRecordsForAuxiliaryScope(connections, scopeOptions);
      setRows(buildAccountMatrixRows({
        accounts: scopedAccounts,
        connections: scopedConnections,
        accountReports: related.accountReports,
        viralContents: related.viralContents,
        contentAnalysis: related.contentAnalysis,
        characters: related.characters,
        campaigns: related.campaigns,
        publishTasks: related.publishTasks,
      }));
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }, [activeCampaignId, campaignContext, dataScope, userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (detailId) setSelectedId(detailId);
  }, [detailId]);

  const visibleRows = useMemo(() => rows.filter((row) => {
    if (tab === 'owned') return getAccountRole(row) === 'owned';
    if (tab === 'reference') return isReferenceAccount(row);
    return true;
  }), [rows, tab]);

  const selected = rows.find((row) => String(row.id) === String(selectedId)) || null;

  async function saveAccount(payload) {
    try {
      if (editing) {
        await updateSocialAccount(editing.id, payload);
        setMessage('账号已更新。');
      } else {
        await createSocialAccount(userId, payload);
        setMessage('账号已创建。');
      }
      setEditing(null);
      setCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function removeAccount(account) {
    const accepted = await confirm({
      title: '删除账号？',
      message: `将删除“${account.account_name || account.username || '未命名账号'}”。关联的情报、账号大脑和发布配置可能不再可用。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteSocialAccount(account.id);
      if (String(selectedId) === String(account.id)) setSelectedId('');
      setMessage('账号已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function openDetail(row) {
    setSelectedId(row.id);
    setDetailTab('overview');
    onNavigate?.('accounts', row.id);
  }

  function runNextAction(row) {
    if (row.nextAction === '连接平台') onNavigate?.('connections');
    else if (['抓取内容样本', '分析账号'].includes(row.nextAction)) onNavigate?.('intelligence');
    else openDetail(row);
  }

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="完成数据服务连接后，这里会显示账号身份、账号大脑和运营用途。" />;
  }
  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能读取和管理你的账号矩阵。" />;
  }

  return (
    <section className="page-stack account-matrix-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">账号业务中心</p>
          <h2>账号矩阵</h2>
          <p>管理账号身份、账号大脑和运营用途。OAuth、权限和发布能力统一到“平台连接”管理。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreating(true)}>添加账号</button>
      </div>

      {(creating || editing) && (
        <AccountForm
          initialValue={editing}
          onSubmit={saveAccount}
          onCancel={() => { setCreating(false); setEditing(null); }}
        />
      )}
      {message && <div className={isErrorMessage(message) ? 'notice error' : 'notice'}>{message}</div>}

      <div className="account-matrix-toolbar">
        <div className="segmented-tabs" role="tablist" aria-label="账号分类">
          {ACCOUNT_TABS.map((item) => (
            <button
              className={tab === item.id ? 'active' : ''}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              key={item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
              <strong>{rows.filter((row) => (
                item.id === 'all'
                  || (item.id === 'owned' ? getAccountRole(row) === 'owned' : isReferenceAccount(row))
              )).length}</strong>
            </button>
          ))}
        </div>
        <div className="view-switch" aria-label="视图切换">
          <button className={view === 'table' ? 'active' : ''} type="button" onClick={() => setView('table')}>表格</button>
          <button className={view === 'cards' ? 'active' : ''} type="button" onClick={() => setView('cards')}>卡片</button>
        </div>
      </div>

      {loading ? (
        <div className="skeleton skeleton-card" aria-label="账号矩阵加载中" />
      ) : visibleRows.length === 0 ? (
        <EmptyState
          title={tab === 'owned' ? '当前范围没有自有账号' : '当前范围没有对标或灵感账号'}
          description={tab === 'owned'
            ? '先添加一个运营账号，再到平台连接完成授权。'
            : '先在账号矩阵添加竞争或灵感账号，内容情报会复用同一账号实体。'}
          action={<button className="primary-button" type="button" onClick={() => setCreating(true)}>添加账号</button>}
        />
      ) : view === 'table' ? (
        tab === 'reference'
          ? <ReferenceAccountTable rows={visibleRows} onDetail={openDetail} onNext={runNextAction} />
          : <OwnedAccountTable rows={visibleRows} includeReference={tab === 'all'} onDetail={openDetail} onNext={runNextAction} />
      ) : (
        <div className="account-compact-grid">
          {visibleRows.map((row) => (
            <AccountCard row={row} key={row.id} onDetail={openDetail} onNext={runNextAction} />
          ))}
        </div>
      )}

      {selected && (
        <AccountDetailDrawer
          account={selected}
          activeTab={detailTab}
          mode={auxiliaryMode}
          onTab={setDetailTab}
          onClose={() => { setSelectedId(''); onNavigate?.('accounts'); }}
          onEdit={() => setEditing(selected)}
          onDelete={() => removeAccount(selected)}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}

function OwnedAccountTable({ rows, includeReference, onDetail, onNext }) {
  return (
    <div className="business-table-wrap">
      <table className="business-table account-matrix-table">
        <thead>
          <tr>
            <th>账号</th><th>平台</th>{includeReference && <th>用途</th>}<th>连接</th>
            <th>发布</th><th>指标回收</th><th>绑定角色</th><th>当前运营活动</th>
            <th>最近发布</th><th>最近分析</th><th>账号大脑</th><th>下一步</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><AccountIdentity row={row} /></td>
              <td>{row.platform || '—'}</td>
              {includeReference && <td>{row.role === 'competitor' ? '竞争' : row.role === 'inspiration' ? '灵感' : '自有'}</td>}
              <td>
                <div className="row-action-stack">
                  <Capability {...row.connectionState.registration} />
                  <Capability {...row.connectionState.oauth} />
                </div>
              </td>
              <td><Capability {...row.publishCapability} /></td>
              <td><Capability {...row.metricsCapability} /></td>
              <td>{row.character?.name || row.character?.character_name || '未绑定'}</td>
              <td>{row.campaigns[0]?.name || row.campaigns[0]?.title || '未关联'}</td>
              <td>{formatDate(row.lastPublish?.published_at || row.lastPublish?.updated_at)}</td>
              <td>{formatDate(row.lastAnalysis?.last_analyzed_at || row.lastAnalysis?.created_at)}</td>
              <td><StatusBadge status={row.brain.state} /></td>
              <td><RowActions row={row} onDetail={onDetail} onNext={onNext} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReferenceAccountTable({ rows, onDetail, onNext }) {
  return (
    <div className="business-table-wrap">
      <table className="business-table account-matrix-table reference-table">
        <thead>
          <tr>
            <th>账号</th><th>平台</th><th>类型</th><th>最近抓取</th><th>有效样本</th>
            <th>数据来源</th><th>分析可信度</th><th>账号大脑</th><th>可复制模式</th>
            <th>数据质量</th><th>下一步</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td><AccountIdentity row={row} /></td>
              <td>{row.platform || '—'}</td>
              <td>{row.role === 'competitor' ? '竞争' : '灵感'}</td>
              <td>{formatDate(row.samples[0]?.created_at)}</td>
              <td>{row.samples.length}</td>
              <td>{row.sourceLabel}</td>
              <td>{row.confidence ? `${Math.round(row.confidence * (row.confidence <= 1 ? 100 : 1))}%` : '样本不足'}</td>
              <td><StatusBadge status={row.brain.state} /></td>
              <td><span className="line-clamp-2">{row.patterns.slice(0, 2).join('；') || '等待分析'}</span></td>
              <td>{row.dataWarnings.length ? <span className="quality-warning">{row.dataWarnings[0]}</span> : '正常'}</td>
              <td><RowActions row={row} onDetail={onDetail} onNext={onNext} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountIdentity({ row }) {
  return (
    <div className="account-identity-cell">
      {row.avatar
        ? <img src={row.avatar} alt="" loading="lazy" />
        : <span>{String(row.account_name || row.username || '?').slice(0, 1).toUpperCase()}</span>}
      <div>
        <strong><TextValue value={row.account_name || row.username} fallback="未命名账号" /></strong>
        <small>{row.username ? `@${String(row.username).replace(/^@/, '')}` : '未填写账号名'}</small>
      </div>
    </div>
  );
}

function Capability({ state, label }) {
  return <span className={`capability-pill capability-${state || 'not_connected'}`}>{label || '未知'}</span>;
}

function RowActions({ row, onDetail, onNext }) {
  return (
    <div className="row-action-stack">
      <button type="button" className="text-button" onClick={() => onNext(row)}>{row.nextAction}</button>
      <button type="button" className="text-button subtle" onClick={() => onDetail(row)}>详情</button>
    </div>
  );
}

function AccountCard({ row, onDetail, onNext }) {
  return (
    <article className="account-compact-card">
      <div className="account-card-header"><AccountIdentity row={row} /><StatusBadge status={row.brain.state} /></div>
      <div className="account-card-facts">
        <span>平台<strong>{row.platform || '—'}</strong></span>
        <span>用途<strong>{row.role === 'owned' ? '自有' : row.role === 'competitor' ? '竞争' : '灵感'}</strong></span>
        <span>{row.role === 'owned' ? '连接' : '样本'}<strong>{row.role === 'owned' ? row.connectionState.oauth.label : row.samples.length}</strong></span>
      </div>
      {row.dataWarnings.length > 0 && <p className="quality-warning">{row.dataWarnings[0]}</p>}
      <div className="account-card-footer">
        <button className="primary-button compact" type="button" onClick={() => onNext(row)}>{row.nextAction}</button>
        <button className="ghost-button compact" type="button" onClick={() => onDetail(row)}>查看详情</button>
      </div>
    </article>
  );
}

function AccountDetailDrawer({ account, activeTab, mode, onTab, onClose, onEdit, onDelete, onNavigate }) {
  const reference = isReferenceAccount(account);
  return (
    <aside className="detail-drawer account-detail-drawer" aria-label="账号详情">
      <div className="detail-drawer-header">
        <div>
          <p className="eyebrow">{reference ? '对标与灵感账号' : '自有运营账号'}</p>
          <h3><TextValue value={account.account_name || account.username} fallback="未命名账号" /></h3>
          <p>{account.platform || '未知平台'} · {reference ? (account.role === 'competitor' ? '竞争账号' : '灵感账号') : '自有账号'}</p>
        </div>
        <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="drawer-tabs" role="tablist">
        {DETAIL_TABS.map(([id, label]) => (
          <button className={activeTab === id ? 'active' : ''} key={id} type="button" onClick={() => onTab(id)}>{label}</button>
        ))}
      </div>
      <div className="drawer-body">
        {activeTab === 'overview' && (reference
          ? <ReferenceOverview account={account} onNavigate={onNavigate} />
          : <OwnedOverview account={account} onNavigate={onNavigate} />)}
        {activeTab === 'brain' && <BrainTab account={account} mode={mode} />}
        {activeTab === 'samples' && <SamplesTab account={account} />}
        {activeTab === 'campaigns' && <SimpleList rows={account.campaigns} empty="尚未关联运营活动" getTitle={(row) => row.name || row.title} getMeta={(row) => statusLabel(row.status)} />}
        {activeTab === 'character' && <CharacterTab account={account} onNavigate={onNavigate} />}
        {activeTab === 'capabilities' && <CapabilitiesTab account={account} onNavigate={onNavigate} />}
        {activeTab === 'history' && <SimpleList rows={[...account.reports, ...account.analyses]} empty="暂无分析历史" getTitle={(row) => row.title || row.depth || row.analysis_type || '账号分析'} getMeta={(row) => formatDate(row.created_at)} />}
        {activeTab === 'quality' && <QualityTab account={account} />}
      </div>
      <div className="detail-drawer-footer">
        <button className="primary-button" type="button" onClick={onEdit}>编辑账号</button>
        <MoreActionsMenu><button className="danger-action" type="button" onClick={onDelete}>删除账号</button></MoreActionsMenu>
      </div>
    </aside>
  );
}

function OwnedOverview({ account, onNavigate }) {
  return (
    <div className="drawer-section-grid">
      <DetailCard title="运营用途"><TextValue value={account.content_strategy || account.strategy_summary} fallback="尚未填写运营用途" /></DetailCard>
      <DetailCard title="目标受众"><TextValue value={account.profile?.target_audience || account.target_audience} fallback="等待账号大脑分析" /></DetailCard>
      <DetailCard title="当前运营活动">{account.campaigns[0]?.name || '未关联'}</DetailCard>
      <DetailCard title="绑定角色">{account.character?.name || account.character?.character_name || '未绑定'}</DetailCard>
      <button className="primary-button" type="button" onClick={() => onNavigate?.('campaigns')}>进入运营活动</button>
    </div>
  );
}

function ReferenceOverview({ account, onNavigate }) {
  return (
    <div className="drawer-section-grid">
      <DetailCard title="账号类型">{account.role === 'competitor' ? '竞争账号' : '灵感账号'}</DetailCard>
      <DetailCard title="有效内容样本">{account.samples.length} 条</DetailCard>
      <DetailCard title="分析可信度">{account.confidence ? `${Math.round(account.confidence * (account.confidence <= 1 ? 100 : 1))}%` : '样本不足'}</DetailCard>
      <DetailCard title="可复制模式">{account.patterns.join('；') || '等待分析'}</DetailCard>
      <button className="primary-button" type="button" onClick={() => onNavigate?.('intelligence')}>进入内容情报</button>
    </div>
  );
}

function BrainTab({ account, mode }) {
  const brain = account.latestReport?.account_brain || account.brain_data || account.profile;
  if (!brain) return <DrawerEmpty title="账号大脑尚未生成" action="请先运行账号分析，再回到这里查看结论。" />;
  const summary = typeof brain === 'string' ? brain : brain.summary || brain.positioning || account.strategy_summary;
  return (
    <div className="drawer-section-grid">
      <DetailCard title="状态"><StatusBadge status={account.brain.state} /></DetailCard>
      <DetailCard title="核心结论"><TextValue value={summary} fallback="已有结构化结果，请切换高级模式查看。" /></DetailCard>
      <DetailCard title="内容方向"><TextValue value={account.profile?.content_direction || account.content_strategy} fallback="等待补充" /></DetailCard>
      {mode === 'advanced' && <pre data-technical-detail>{JSON.stringify(brain, null, 2)}</pre>}
    </div>
  );
}

function SamplesTab({ account }) {
  return <SimpleList rows={account.samples} empty="暂无内容样本，请先到内容情报抓取或导入。" getTitle={(row) => safeBusinessText(row.title || row.content, '未命名样本').text} getMeta={(row) => `${formatDate(row.published_at || row.created_at)} · 互动分 ${row.engagement_score || 0}`} />;
}

function CharacterTab({ account, onNavigate }) {
  if (!account.character) return <DrawerEmpty title="尚未绑定角色" action={<button className="primary-button" type="button" onClick={() => onNavigate?.('characters')}>去角色库绑定</button>} />;
  return <DetailCard title="当前角色">{account.character.name || account.character.character_name}<br /><small>LoRA 配置在角色库维护，账号矩阵只显示绑定结果。</small></DetailCard>;
}

function CapabilitiesTab({ account, onNavigate }) {
  return (
    <div className="drawer-section-grid">
      <DetailCard title="读取能力"><Capability {...account.readCapability} /></DetailCard>
      <DetailCard title="发布能力"><Capability {...account.publishCapability} /></DetailCard>
      <DetailCard title="指标回收"><Capability {...account.metricsCapability} /></DetailCard>
      <DetailCard title="连接记录">{account.connections.length} 条</DetailCard>
      <button className="primary-button" type="button" onClick={() => onNavigate?.('connections')}>管理平台连接</button>
    </div>
  );
}

function QualityTab({ account }) {
  return account.dataWarnings.length
    ? <div className="quality-warning-list">{account.dataWarnings.map((warning) => <div key={warning}><strong>需要处理</strong><p>{warning}</p><small>系统仅标记，不会自动覆盖或删除原始记录。</small></div>)}</div>
    : <DrawerEmpty title="数据质量正常" action="未检测到明显乱码、重复身份或样本缺失。" />;
}

function DetailCard({ title, children }) {
  return <section className="detail-card"><span>{title}</span><div>{children}</div></section>;
}

function SimpleList({ rows, empty, getTitle, getMeta }) {
  if (!rows?.length) return <DrawerEmpty title={empty} />;
  return <div className="drawer-list">{rows.slice(0, 30).map((row, index) => <article key={row.id || index}><strong>{getTitle(row)}</strong><small>{getMeta(row)}</small></article>)}</div>;
}

function DrawerEmpty({ title, action }) {
  return <div className="drawer-empty"><strong>{title}</strong>{typeof action === 'string' ? <p>{action}</p> : action}</div>;
}
