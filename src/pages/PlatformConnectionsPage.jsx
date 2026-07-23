import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { platformConnectionCards } from '../data/platform-connections';
import { displayText, loadPlatformConnectionData, normalizeList } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function PlatformConnectionsPage({ userId }) {
  const [data, setData] = useState({ platformConnections: [], accounts: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) {
      setIsLoading(false);
      return undefined;
    }
    setIsLoading(true);
    loadPlatformConnectionData()
      .then((nextData) => setData({ platformConnections: [], accounts: [], ...nextData }))
      .catch((error) => setMessage(error.message))
      .finally(() => setIsLoading(false));
    return undefined;
  }, [userId]);

  const byPlatform = useMemo(() => {
    const map = new Map();
    data.platformConnections.forEach((connection) => {
      const key = String(connection.platform || '').toLowerCase();
      map.set(key, [...(map.get(key) || []), connection]);
    });
    return map;
  }, [data.platformConnections]);

  if (!isSupabaseConfigured) {
    return <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会显示平台连接状态。" />;
  }

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看平台连接。" />;
  }

  return (
    <section className="page-stack platform-connections-page">
      <div className="hero-panel">
        <p className="eyebrow">CONNECTION HEALTH</p>
        <h2>平台连接、账号与能力状态</h2>
        <p>这里只展示数据库中的真实连接记录。未完成 OAuth、API 权限或服务端适配的平台统一标记为“准备中”，不会显示成可用。</p>
      </div>

      {message && <div className="notice error">{message}</div>}

      {!isLoading && <PlatformCapabilityMatrix byPlatform={byPlatform} />}

      {isLoading ? (
        <div className="skeleton-grid" aria-label="平台连接加载中">
          {Array.from({ length: 6 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
        </div>
      ) : <div className="platform-connection-grid multi">
        {platformConnectionCards.map((card) => {
          const rows = byPlatform.get(String(card.platform).toLowerCase()) || [];
          const connected = rows.filter(isConnected);
          const latest = [...rows].sort(byLatestSync)[0];
          const relatedAccounts = accountsForPlatform(data.accounts, card.platform, rows);
          const permissions = collectPermissions(rows);
          const capabilities = getCapabilities(card, connected, permissions);
          const state = !card.implemented ? 'preparing' : connected.length ? 'connected' : 'not_connected';

          return (
            <article className={`platform-connection-card ${state}`} key={card.platform}>
              <div className="platform-card-top">
                <div>
                  <span className="platform-icon">{card.platform.slice(0, 1)}</span>
                  <h3>{card.title}</h3>
                </div>
                {state === 'preparing' ? <span className="preparing-badge">准备中</span> : <StatusBadge status={state} />}
              </div>
              <p>{card.description}</p>

              <div className="connection-meta-grid">
                <span>真实连接</span><strong>{connected.length}/{rows.length}</strong>
                <span>已识别账号</span><strong>{relatedAccounts.length}</strong>
                <span>最后同步</span><strong>{formatDate(latest?.last_sync || latest?.last_synced_at || latest?.connected_at)}</strong>
                <span>授权范围</span><strong>{permissions.length ? permissions.join('、') : '未上报'}</strong>
                <span>需要的权限</span><strong>{card.requiredPermissions.join('、')}</strong>
                <span>当前阻塞原因</span><strong>{getBlockingReason(card, connected, permissions)}</strong>
              </div>

              {relatedAccounts.length > 0 && (
                <div className="connected-account-list">
                  <h4>已连接账号</h4>
                  {relatedAccounts.map((account) => (
                    <div key={account.id || account.account_id || account.username}>
                      <strong>{account.account_name || account.display_name || account.username || account.handle || '未命名账号'}</strong>
                      <span>{displayText(account.status || 'active')} · {formatDate(account.last_sync || account.updated_at || account.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="platform-capability-grid" aria-label={`${card.title} 能力状态`}>
                {capabilities.map(({ label, state: capabilityState, detail }) => (
                  <div className={`capability-${capabilityState}`} key={label}>
                    <span>{capabilityIcon(capabilityState)} {label}</span>
                    <small>{detail}</small>
                  </div>
                ))}
              </div>

              {state === 'preparing' && <p className="platform-readiness-note">准备中：等待 OAuth / API 权限配置与服务端适配。</p>}
              {state === 'not_connected' && <p className="platform-readiness-note">尚未发现有效连接记录，请先在服务端完成授权。</p>}
            </article>
          );
        })}
      </div>}
    </section>
  );
}

function PlatformCapabilityMatrix({ byPlatform }) {
  return (
    <section className="platform-capability-matrix-panel">
      <div className="section-head">
        <div><p className="eyebrow">CAPABILITY MATRIX</p><h3>平台能力矩阵</h3></div>
        <span>连接状态来自 Supabase，能力状态来自当前服务端实现与验证结果。</span>
      </div>
      <div className="platform-capability-table-wrap">
        <table className="platform-capability-table">
          <thead><tr><th>平台</th><th>连接</th><th>采集</th><th>发布</th><th>数据回收</th><th>Webhook</th></tr></thead>
          <tbody>
            {platformConnectionCards.map((card) => {
              const connected = (byPlatform.get(String(card.platform).toLowerCase()) || []).filter(isConnected);
              const connectionLabel = card.implemented ? connected.length ? `已接 · ${connected.length}` : '未连接' : '准备中';
              return (
                <tr key={card.platform}>
                  <th>{card.title}</th>
                  <td>{connectionLabel}</td>
                  <CapabilityCell value={card.capabilities.collect} />
                  <CapabilityCell value={card.capabilities.publish} />
                  <CapabilityCell value={card.capabilities.analytics} />
                  <CapabilityCell value={card.capabilities.webhook} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CapabilityCell({ value }) {
  const [state, label] = value;
  return <td><span className={`capability-pill capability-${state}`}>{capabilityIcon(state)} {label}</span></td>;
}

function isConnected(connection) {
  return connection?.status === 'connected' || connection?.is_connected === true;
}

function byLatestSync(a, b) {
  const left = new Date(a.last_sync || a.last_synced_at || a.connected_at || a.updated_at || 0).getTime();
  const right = new Date(b.last_sync || b.last_synced_at || b.connected_at || b.updated_at || 0).getTime();
  return right - left;
}

function accountsForPlatform(accounts, platform, connections) {
  const connectionAccountIds = new Set(connections.map((row) => row.account_id).filter(Boolean).map(String));
  return (accounts || []).filter((account) => (
    String(account.platform || '').toLowerCase() === String(platform).toLowerCase()
    || connectionAccountIds.has(String(account.id || account.account_id || ''))
  ));
}

function collectPermissions(rows) {
  return [...new Set(rows.flatMap((row) => normalizeList(
    row.permissions || row.scopes || row.scope || row.metadata?.permissions || row.metadata?.scopes,
  )).map((value) => String(value)).filter(Boolean))];
}

function getCapabilities(card, connected, _permissions) {
  const hasConnection = connected.length > 0;
  const rows = [
    ['连接状态', hasConnection ? 'available' : card.implemented ? 'not_connected' : 'preparing', hasConnection ? `已连接 ${connected.length} 个账号` : card.implemented ? '尚未发现有效连接' : '准备中'],
    ['内容采集', ...card.capabilities.collect],
    ['内容发布', ...card.capabilities.publish],
    ['数据回收', ...card.capabilities.analytics],
    ['Webhook', ...card.capabilities.webhook],
  ];
  return rows.map(([label, state, detail]) => ({
    label,
    state: !hasConnection && card.implemented && state === 'available' ? 'not_connected' : state,
    detail: !hasConnection && card.implemented && state === 'available' ? '请先连接账号' : detail,
  }));
}

function getBlockingReason(card, connected, permissions) {
  if (!card.implemented) return card.blockingReason;
  if (!connected.length) return '请先完成平台账号授权连接。';
  if (!permissions.length) return `${card.blockingReason} 当前连接尚未上报权限范围。`;
  return card.blockingReason;
}

function capabilityIcon(state) {
  if (state === 'available') return '✓';
  if (state === 'partial') return '◐';
  if (state === 'needs_bridge' || state === 'needs_validation') return '!';
  return '—';
}
