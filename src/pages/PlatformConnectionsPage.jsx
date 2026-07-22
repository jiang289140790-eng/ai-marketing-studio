import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import { platformConnectionCards } from '../data/platform-connections';
import { displayText, loadPlatformConnectionData } from '../services/ops-service';
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
    <section className="page-stack">
      <div className="hero-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Connection Health</p>
            <h2>平台连接健康总览</h2>
          </div>
          <ExecutionButton actionName="检查全部连接" className="primary-button" reason="全平台健康检查需要执行网关接入各平台适配器后开启。">
            检查全部连接
          </ExecutionButton>
        </div>
        <p>
          这里只汇总各平台的连接数量、同步时间和限流健康，不重复展示账号明细。具体账号及其连接灯请在“账号矩阵”中查看。
        </p>
      </div>

      {message && <div className="notice error">{message}</div>}

      {isLoading ? (
        <div className="skeleton-grid" aria-label="平台连接加载中">
          {Array.from({ length: 6 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
        </div>
      ) : <div className="platform-connection-grid multi">
        {platformConnectionCards.map((card) => {
          const rows = byPlatform.get(String(card.platform).toLowerCase()) || [];
          const connected = rows.filter((row) => row.status === 'connected' || row.is_connected === true);
          const latest = rows[0];
          const rateLimit = latest?.rate_limit_status || latest?.metadata?.rate_limit_status || '未上报';
          return (
            <article className={`platform-connection-card ${connected.length ? 'connected' : ''}`} key={card.platform}>
              <div className="platform-card-top">
                <div>
                  <span className="platform-icon">{card.platform.slice(0, 1)}</span>
                  <h3>{card.title}</h3>
                </div>
                <StatusBadge status={connected.length ? 'connected' : 'not_connected'} />
              </div>
              <p>{card.description}</p>
              <div className="connection-meta-grid">
                <span>连接数</span>
                <strong>{connected.length}/{rows.length}</strong>
                <span>最后同步</span>
                <strong>{formatDate(latest?.last_sync || latest?.connected_at)}</strong>
                <span>API 限流</span>
                <strong>{displayText(rateLimit)}</strong>
              </div>
              <div className="button-row">
                <ExecutionButton actionName={`检查 ${card.title} 状态`} className="ghost-button" reason="平台状态检查需要对应平台适配器完成后开启。">检查状态</ExecutionButton>
              </div>
            </article>
          );
        })}
      </div>}
    </section>
  );
}
