import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { platformConnectionCards } from '../data/platform-connections';
import { getExecutionStatus } from '../services/execution-gateway';
import { loadPlatformConnectionData } from '../services/ops-service';
import {
  getTelegramPlatformStatus,
  getXPlatformStatus,
} from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { formatDate } from '../utils/formatters';
import { buildPlatformSummaries } from '../utils/platform-connection-summary';

const DRAWER_TABS = [
  ['auth', '认证'],
  ['permissions', '权限'],
  ['accounts', '账号'],
  ['publish', '发布'],
  ['metrics', '指标'],
  ['webhook', 'Webhook'],
  ['quota', '额度'],
  ['errors', '错误记录'],
];

export function PlatformConnectionsPage({
  activeCampaignId,
  auxiliaryMode = 'business',
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
}) {
  const [data, setData] = useState({ platformConnections: [], platformAdapters: [], accounts: [], publishTasks: [] });
  const [gateway, setGateway] = useState({ loading: true, connected: false, status: null, reason: '' });
  const [selectedPlatform, setSelectedPlatform] = useState('');
  const [drawerTab, setDrawerTab] = useState('auth');
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState('');
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const nextData = await loadPlatformConnectionData();
      const scopeOptions = { scope: dataScope, campaignContext, activeCampaignId };
      setData({
        platformConnections: filterRecordsForAuxiliaryScope(nextData.platformConnections, scopeOptions),
        platformAdapters: nextData.platformAdapters || [],
        accounts: filterRecordsForAuxiliaryScope(nextData.accounts, scopeOptions),
        publishTasks: filterRecordsForAuxiliaryScope(nextData.publishTasks, scopeOptions),
      });
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
    if (!userId) return undefined;
    let cancelled = false;
    getExecutionStatus({ force: true }).then((status) => {
      if (!cancelled) setGateway({ loading: false, ...status });
    }).catch((error) => {
      if (!cancelled) setGateway({ loading: false, connected: false, status: null, reason: error.message });
    });
    return () => { cancelled = true; };
  }, [userId]);

  const summaries = useMemo(() => buildPlatformSummaries({
    cards: platformConnectionCards,
    connections: data.platformConnections,
    accounts: data.accounts,
    adapters: data.platformAdapters,
    gateway,
  }), [data, gateway]);
  const selected = summaries.find((summary) => summary.platform === selectedPlatform) || null;

  async function testCapability(summary) {
    const connection = summary.activeRows[0] || summary.rows[0];
    if (!connection) {
      setMessage(`${summary.title} 尚无连接记录，请先完成授权。`);
      return;
    }
    setTesting(summary.platform);
    setMessage('');
    try {
      if (String(summary.platform).toLowerCase() === 'x') await getXPlatformStatus(connection.id);
      else if (String(summary.platform).toLowerCase() === 'telegram') await getTelegramPlatformStatus(connection.id);
      else throw new Error('该平台暂未提供真实能力检测接口。');
      setMessage(`${summary.title} 能力检测已完成，状态已刷新。`);
      await refresh();
    } catch (error) {
      setMessage(`${summary.title} 检测未通过：${error.message}`);
    } finally {
      setTesting('');
    }
  }

  function openDrawer(summary, tab = 'auth') {
    setSelectedPlatform(summary.platform);
    setDrawerTab(tab);
  }

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待数据服务配置" description="完成数据服务连接后，这里会统一管理 OAuth、权限和平台执行能力。" />;
  }
  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看和验证平台连接。" />;
  }

  return (
    <section className="page-stack platform-connections-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">平台能力中心</p>
          <h2>平台连接</h2>
          <p>统一管理 OAuth、权限、发布、指标回收、Webhook 和额度。账号运营资料请前往账号矩阵。</p>
        </div>
      </div>

      {message && <div className={/未通过|失败|错误|尚无/.test(message) ? 'notice error' : 'notice'}>{message}</div>}

      {loading ? (
        <div className="platform-summary-grid">
          {Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
        </div>
      ) : (
        <div className="platform-summary-grid">
          {summaries.map((summary) => (
            <PlatformSummaryCard
              key={summary.platform}
              summary={summary}
              testing={testing === summary.platform}
              onManage={() => openDrawer(summary)}
              onAccounts={() => openDrawer(summary, 'accounts')}
              onTest={() => testCapability(summary)}
            />
          ))}
        </div>
      )}

      {selected && (
        <PlatformDetailDrawer
          summary={selected}
          activeTab={drawerTab}
          mode={auxiliaryMode}
          gateway={gateway}
          publishTasks={data.publishTasks}
          onTab={setDrawerTab}
          onClose={() => setSelectedPlatform('')}
          onNavigate={onNavigate}
          onTest={() => testCapability(selected)}
          testing={testing === selected.platform}
        />
      )}
    </section>
  );
}

function PlatformSummaryCard({ summary, testing, onManage, onAccounts, onTest }) {
  const isX = String(summary.platform).toLowerCase() === 'x';
  const currentError = summary.errors[0];
  const businessImpact = isX && summary.quota.state === 'failed'
    ? 'API 额度已用尽：读取、发布或指标回收会受到影响。'
    : isX && summary.connectionState.state === 'failed'
      ? 'OAuth 已过期：账号仍保留登记，但当前不可发布或回收指标。'
    : currentError || '当前没有影响业务的异常';
  return (
    <article className={`platform-summary-card ${summary.connectionState.state}`}>
      <div className="platform-card-top">
        <div className="platform-title">
          <span className="platform-icon">{summary.platform.slice(0, 1)}</span>
          <div><h3>{summary.title}</h3><small>{summary.description}</small></div>
        </div>
        <StatusBadge status={summary.connectionState.state} />
      </div>

      <div className="platform-summary-facts">
        <Fact label="连接状态" value={summary.connectionState.label} />
        <Fact label="已登记账号" value={`${summary.accountCount} 个`} />
        <Fact label="OAuth 有效账号" value={`${summary.connectedCount} 个`} />
        <Fact label="可发布账号" value={`${summary.publishableCount} 个`} />
        <Fact label="读取能力" value={<Capability {...summary.read} />} />
        <Fact label="发布能力" value={<Capability {...summary.publish} />} />
        <Fact label="指标回收" value={<Capability {...summary.metrics} />} />
        <Fact label="Webhook" value={<Capability {...summary.webhook} />} />
        <Fact label="Token 状态" value={<Capability {...summary.token} />} />
        <Fact label="额度或限制" value={<Capability {...summary.quota} />} />
        <Fact label="最近验证" value={formatDate(summary.lastVerifiedAt)} />
      </div>

      {isX && (
        <div className="x-platform-strip">
          <span>OAuth 账号 <strong>{summary.connectedCount}</strong></span>
          <span>X MCP <Capability {...summary.xMcp} /></span>
          <span>API credits <Capability {...summary.quota} /></span>
        </div>
      )}

      <div className={`platform-impact ${businessImpact.includes('没有') ? 'ok' : 'warning'}`}>
        <span>当前影响</span><strong>{businessImpact}</strong>
      </div>

      <div className="platform-card-actions">
        <button className="primary-button compact" type="button" onClick={onManage}>管理连接</button>
        <button className="ghost-button compact" type="button" onClick={onAccounts}>查看账号</button>
        <button className="ghost-button compact" type="button" onClick={onTest} disabled={testing}>
          {testing ? '检测中…' : '测试能力'}
        </button>
      </div>
    </article>
  );
}

function PlatformDetailDrawer({
  summary,
  activeTab,
  mode,
  gateway,
  publishTasks,
  onTab,
  onClose,
  onNavigate,
  onTest,
  testing,
}) {
  const tasks = publishTasks.filter((task) => String(task.platform || '').toLowerCase() === String(summary.platform).toLowerCase());
  return (
    <aside className="detail-drawer platform-detail-drawer" aria-label="平台连接详情">
      <div className="detail-drawer-header">
        <div><p className="eyebrow">平台详情</p><h3>{summary.title}</h3><p>{summary.connectionState.label} · {summary.accountCount} 个账号</p></div>
        <button className="ghost-button" type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="drawer-tabs" role="tablist">
        {DRAWER_TABS.map(([id, label]) => <button className={activeTab === id ? 'active' : ''} type="button" key={id} onClick={() => onTab(id)}>{label}</button>)}
      </div>
      <div className="drawer-body">
        {activeTab === 'auth' && (
          <div className="drawer-section-grid">
            <DetailCard title="认证方式">{summary.authType || '未配置'}</DetailCard>
            <DetailCard title="连接状态"><Capability {...summary.connectionState} /></DetailCard>
            <DetailCard title="Token 状态"><Capability {...summary.token} /></DetailCard>
            <DetailCard title="最近真实验证">{formatDate(summary.lastVerifiedAt)}</DetailCard>
            <p className="security-note">出于安全原因，Token、Secret 和完整凭据不会在前端显示。</p>
          </div>
        )}
        {activeTab === 'permissions' && (
          <div className="drawer-section-grid">
            <DetailCard title="业务能力">
              读取：{summary.read.label}；发布：{summary.publish.label}；指标：{summary.metrics.label}
            </DetailCard>
            <details className="technical-details">
              <summary>查看技术权限范围</summary>
              {summary.permissions.length ? <ul>{summary.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul> : <p>连接未上报技术权限范围。</p>}
            </details>
          </div>
        )}
        {activeTab === 'accounts' && (
          summary.relatedAccounts.length
            ? <div className="drawer-list">{summary.relatedAccounts.map((account) => <article key={account.id}><strong>{account.account_name || account.username || '未命名账号'}</strong><small>{account.platform} · {account.status || '未知状态'}</small></article>)}</div>
            : <DrawerEmpty title="尚无关联账号" action="请先完成平台授权，成功后账号会同步到账号矩阵。" />
        )}
        {activeTab === 'publish' && (
          <div className="drawer-section-grid">
            <DetailCard title="发布能力"><Capability {...summary.publish} /></DetailCard>
            <DetailCard title="可发布账号">{summary.publishableCount} 个</DetailCard>
            <DetailCard title="相关发布任务">{tasks.length} 条</DetailCard>
            <button className="primary-button" type="button" onClick={() => onNavigate?.('publish')}>进入发布中心</button>
          </div>
        )}
        {activeTab === 'metrics' && <DetailCard title="指标回收能力"><Capability {...summary.metrics} /></DetailCard>}
        {activeTab === 'webhook' && <DetailCard title="Webhook 状态"><Capability {...summary.webhook} /></DetailCard>}
        {activeTab === 'quota' && (
          <div className="drawer-section-grid">
            <DetailCard title="当前额度"><Capability {...summary.quota} /></DetailCard>
            <DetailCard title="业务影响">{summary.quota.detail || '平台未提供额度详情'}</DetailCard>
          </div>
        )}
        {activeTab === 'errors' && (
          summary.errors.length
            ? <div className="drawer-list">{summary.errors.map((error, index) => <article key={`${error}-${index}`}><strong>连接异常</strong><small>{error}</small></article>)}</div>
            : <DrawerEmpty title="没有影响业务的异常" action="正常连接状态已收纳，不占用主页面空间。" />
        )}
        {mode === 'advanced' && activeTab === 'auth' && (
          <details className="technical-details" data-technical-detail>
            <summary>高级运行状态</summary>
            <p>执行网关：{gateway.connected ? '已连接' : '未连接'}</p>
            <p>适配器：{summary.adapter?.status || '未上报'}</p>
          </details>
        )}
      </div>
      <div className="detail-drawer-footer">
        <button className="primary-button" type="button" onClick={onTest} disabled={testing}>{testing ? '检测中…' : '测试当前连接'}</button>
        <button className="ghost-button" type="button" onClick={() => onNavigate?.('accounts')}>打开账号矩阵</button>
      </div>
    </aside>
  );
}

function Fact({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Capability({ state, label }) {
  return <span className={`capability-pill capability-${state || 'unknown'}`}>{label || '未知'}</span>;
}

function DetailCard({ title, children }) {
  return <section className="detail-card"><span>{title}</span><div>{children}</div></section>;
}

function DrawerEmpty({ title, action }) {
  return <div className="drawer-empty"><strong>{title}</strong><p>{action}</p></div>;
}
