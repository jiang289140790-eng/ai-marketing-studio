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

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    loadPlatformConnectionData().then((nextData) => setData({ platformConnections: [], accounts: [], ...nextData }));
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
        <p className="eyebrow">平台连接</p>
        <h2>统一查看 X、Telegram、Instagram、YouTube、TikTok、Discord 的连接状态</h2>
        <p>
          每个平台可以保留多个账号连接。这里不显示、不保存前端 Token；OAuth、Bot Token、Client Secret、发布执行和状态同步必须由 Edge Function、
          可信 API 或本地 MCP Runtime 处理。
        </p>
      </div>

      <div className="platform-connection-grid multi">
        {platformConnectionCards.map((card) => {
          const rows = byPlatform.get(String(card.platform).toLowerCase()) || [];
          const connected = rows.filter((row) => row.status === 'connected');
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
                <span>权限</span>
                <strong>{displayText(rows[0]?.permissions)}</strong>
                <span>最后同步</span>
                <strong>{formatDate(rows[0]?.last_sync || rows[0]?.connected_at)}</strong>
              </div>
              <div className="connection-record-list">
                {rows.length ? rows.map((connection) => (
                  <div className="connection-record" key={connection.id}>
                    <div>
                      <strong>{connection.account_name || connection.metadata?.username || connection.metadata?.chat_id || '已保存连接'}</strong>
                      <small>{formatDate(connection.connected_at || connection.created_at)}</small>
                    </div>
                    <StatusBadge status={connection.status || 'pending'} />
                  </div>
                )) : <div className="connection-empty">暂无连接账号</div>}
              </div>
              <div className="button-row">
                <ExecutionButton actionName={`连接 ${card.title}`} className="ghost-button">连接新账号</ExecutionButton>
                <ExecutionButton actionName={`检查 ${card.title} 状态`} className="ghost-button">检查状态</ExecutionButton>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
