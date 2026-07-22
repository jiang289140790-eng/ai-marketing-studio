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
                {capabilities.map(([label, available, detail]) => (
                  <div className={available ? 'available' : 'unavailable'} key={label}>
                    <span>{available ? '✓' : '—'} {label}</span>
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

function getCapabilities(card, connected, permissions) {
  const hasConnection = connected.length > 0;
  const scopes = permissions.join(' ').toLowerCase();
  const canPublish = hasConnection && /(write|publish|tweet\.write|posts\.write|messages)/.test(scopes);
  const canRead = hasConnection && (permissions.length === 0 || /(read|tweet\.read|posts|messages|channel)/.test(scopes));
  const supportsWebhook = hasConnection && String(card.platform).toLowerCase() === 'telegram';

  return [
    ['OAuth / 授权', hasConnection, hasConnection ? '已发现有效连接' : '尚未完成'],
    ['内容采集', canRead, canRead ? '权限记录允许读取' : '等待读取权限'],
    ['内容发布', canPublish, canPublish ? '权限记录允许发布' : '等待发布权限'],
    ['数据回传', canRead, canRead ? '可由服务端同步' : '等待服务端适配'],
    ['Webhook', supportsWebhook, supportsWebhook ? 'Telegram 服务端入口已预留' : '当前未启用'],
  ];
}
