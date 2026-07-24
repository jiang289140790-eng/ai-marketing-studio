import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatusBadge } from '../components/StatusBadge';
import { platformConnectionCards } from '../data/platform-connections';
import { displayText, loadPlatformConnectionData, normalizeList } from '../services/ops-service';
import { getExecutionStatus } from '../services/execution-gateway';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

export function PlatformConnectionsPage({ userId }) {
  const [data, setData] = useState({ platformConnections: [], accounts: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [gateway, setGateway] = useState({ loading: true, connected: false, status: null, reason: '' });

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

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    getExecutionStatus({ force: true }).then((status) => {
      if (!cancelled) setGateway({ loading: false, ...status });
    });
    return () => { cancelled = true; };
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

      {!isLoading && <ConnectionLayerSummary byPlatform={byPlatform} gateway={gateway} />}
      {!isLoading && <PlatformCapabilityMatrix byPlatform={byPlatform} gateway={gateway} />}

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
          const capabilities = getCapabilities(card, connected, permissions, gateway);
          const runtimeReady = platformRuntimeReady(card.platform, gateway);
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
                <span>执行能力</span><strong>{runtimeReady ? '服务端已就绪' : '尚未完全就绪'}</strong>
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

function ConnectionLayerSummary({ byPlatform, gateway }) {
  const authorized = [...byPlatform.values()].flat().filter(isConnected).length;
  const xReady = platformRuntimeReady('X', gateway);
  return (
    <section className="connection-layer-summary">
      <div><span>账号授权</span><strong>{authorized} 条有效记录</strong><small>来自 Supabase platform_connections</small></div>
      <b>→</b>
      <div><span>安全执行网关</span><strong>{gateway.loading ? '检查中' : gateway.connected ? '已连接' : '未完全连接'}</strong><small>{gateway.reason || 'Edge Function 与 MCP Bridge 状态'}</small></div>
      <b>→</b>
      <div><span>X MCP 工具</span><strong>{gateway.loading ? '检查中' : xReady ? '可调用' : '尚未接入'}</strong><small>读取、分析和同步必须同时具备工具能力</small></div>
    </section>
  );
}

function PlatformCapabilityMatrix({ byPlatform, gateway }) {
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
              const connectionLabel = card.implemented ? connected.length ? `已授权 · ${connected.length}` : '未授权' : '准备中';
              const capabilities = getCapabilities(card, connected, collectPermissions(connected), gateway);
              return (
                <tr key={card.platform}>
                  <th>{card.title}</th>
                  <td>{connectionLabel}</td>
                  {capabilities.slice(1).map((capability) => <CapabilityCell key={capability.label} value={[capability.state, capability.detail]} />)}
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

function getCapabilities(card, connected, _permissions, gateway) {
  const hasConnection = connected.length > 0;
  const runtimeReady = platformRuntimeReady(card.platform, gateway);
  const runtimeCapability = (value) => {
    const [state] = value;
    if (!hasConnection && card.implemented) return ['not_connected', '请先完成账号授权'];
    if (['available', 'partial', 'needs_validation', 'needs_bridge'].includes(state) && !runtimeReady) {
      return ['needs_bridge', '账号已授权，执行工具尚未就绪'];
    }
    return value;
  };
  const rows = [
    ['连接状态', hasConnection ? 'available' : card.implemented ? 'not_connected' : 'preparing', hasConnection ? `已连接 ${connected.length} 个账号` : card.implemented ? '尚未发现有效连接' : '准备中'],
    ['内容采集', ...runtimeCapability(card.capabilities.collect)],
    ['内容发布', ...runtimeCapability(card.capabilities.publish)],
    ['数据回收', ...runtimeCapability(card.capabilities.analytics)],
    ['Webhook', ...runtimeCapability(card.capabilities.webhook)],
  ];
  return rows.map(([label, state, detail]) => ({
    label,
    state: !hasConnection && card.implemented && state === 'available' ? 'not_connected' : state,
    detail: !hasConnection && card.implemented && state === 'available' ? '请先连接账号' : detail,
  }));
}

function platformRuntimeReady(platform, gateway) {
  if (!gateway?.connected) return false;
  if (String(platform).toLowerCase() !== 'x') return true;
  return gateway.status?.x_mcp === 'connected' && gateway.status?.x_tools === true;
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
