import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountForm } from '../components/AccountForm';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { accountCategories } from '../data/navigation';
import { platformConnectionCards } from '../data/platform-connections';
import {
  createSocialAccount,
  deleteSocialAccount,
  listSocialAccounts,
  updateSocialAccount,
} from '../services/account-service';
import { listPlatformConnections } from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

function getAccountRole(account) {
  const role = account.account_role || account.account_type || account.account_category || 'owned';
  if (role === 'brand' || role === 'personal') return 'owned';
  return role;
}

function getConnectionsForAccount(account, allConnections = []) {
  const embeddedConnections = account.platform_connections || [];
  const relatedConnections = allConnections.filter((connection) => connection.account_id === account.id);
  const byId = new Map();
  [...embeddedConnections, ...relatedConnections].forEach((connection) => {
    if (connection?.id) byId.set(connection.id, connection);
  });
  return Array.from(byId.values());
}

function getPlatformConnections(connections, platform) {
  return connections
    .filter((connection) => connection.platform === platform)
    .sort((a, b) => new Date(b.connected_at || b.created_at || 0) - new Date(a.connected_at || a.created_at || 0));
}

function getPermissionsLabel(connection) {
  const permissions = connection?.permissions;
  if (!permissions) return '—';
  if (Array.isArray(permissions)) return permissions.length ? permissions.join(', ') : '—';
  if (typeof permissions === 'string') return permissions || '—';
  return Object.values(permissions).flat().filter(Boolean).join(', ') || '—';
}

function getConnectionAccountName(connection) {
  return (
    connection?.social_accounts?.account_name ||
    connection?.metadata?.username ||
    connection?.metadata?.screen_name ||
    connection?.metadata?.chat_id ||
    connection?.account_name ||
    '等待授权'
  );
}

function messageIsError(message) {
  return /error|failed|missing|失败|异常|缺少/i.test(String(message || ''));
}

export function AccountsPage({ userId }) {
  const [accounts, setAccounts] = useState([]);
  const [connections, setConnections] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const [nextAccounts, nextConnections] = await Promise.all([
      listSocialAccounts(userId),
      listPlatformConnections(userId),
    ]);
    setAccounts(nextAccounts);
    setConnections(nextConnections);
    setSelectedAccount((current) => {
      if (!current) return null;
      return nextAccounts.find((account) => account.id === current.id) || null;
    });
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const stats = useMemo(() => {
    const connectedConnections = connections.filter((connection) => connection.status === 'connected');
    return {
      total: accounts.length,
      owned: accounts.filter((account) => getAccountRole(account) === 'owned').length,
      intelligence: accounts.filter((account) => ['competitor', 'inspiration'].includes(getAccountRole(account))).length,
      connected: connectedConnections.length,
      profiled: accounts.filter((account) => account.account_profiles?.length > 0).length,
    };
  }, [accounts, connections]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updateSocialAccount(editing.id, payload);
        setMessage('账号已更新。');
      } else {
        await createSocialAccount(userId, payload);
        setMessage('账号已创建。');
      }
      setEditing(null);
      setIsCreating(false);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(account) {
    try {
      await deleteSocialAccount(account.id);
      if (selectedAccount?.id === account.id) setSelectedAccount(null);
      setMessage(`已删除账号：${account.account_name || account.username}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  function renderPlatformConnectionCenter() {
    return (
      <section className="connection-center">
        <div className="section-head">
          <div>
            <p className="eyebrow">Platform Connection Center</p>
            <h2>平台连接状态</h2>
            <p>这里展示每个平台当前已连接的账号数量。真正 OAuth / Bot 授权由后端 Edge Function 管理，前端不保存 Token。</p>
          </div>
        </div>

        <div className="platform-connection-grid multi">
          {platformConnectionCards.map((card) => {
            const platformConnections = getPlatformConnections(connections, card.platform);
            const connectedCount = platformConnections.filter((connection) => connection.status === 'connected').length;
            const firstConnection = platformConnections[0];
            return (
              <article className={`platform-connection-card ${connectedCount ? 'connected' : ''}`} key={card.platform}>
                <div className="platform-card-top">
                  <div>
                    <span className="platform-icon">{card.platform.slice(0, 1)}</span>
                    <h3>{card.title}</h3>
                  </div>
                  <StatusBadge status={connectedCount ? 'connected' : 'not_connected'} />
                </div>
                <p>{card.description}</p>
                <div className="connection-meta-grid">
                  <span>连接数</span>
                  <strong>{connectedCount}/{platformConnections.length}</strong>
                  <span>权限</span>
                  <strong>{getPermissionsLabel(firstConnection)}</strong>
                  <span>最后同步</span>
                  <strong>{formatDate(firstConnection?.last_sync || firstConnection?.connected_at)}</strong>
                </div>
                <div className="connection-record-list">
                  {platformConnections.length ? platformConnections.map((connection) => (
                    <div className="connection-record" key={connection.id}>
                      <div>
                        <strong>{getConnectionAccountName(connection)}</strong>
                        <small>{formatDate(connection.connected_at || connection.created_at)}</small>
                      </div>
                      <StatusBadge status={connection.status || 'pending'} />
                    </div>
                  )) : <div className="connection-empty">暂无连接账号</div>}
                </div>
                <small>{card.priority} · {card.authType}</small>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  function renderAccountDetail(account) {
    if (!account) return null;
    const profile = account.account_profiles?.[0];
    const accountConnections = getConnectionsForAccount(account, connections);
    return (
      <article className="detail-panel account-detail-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Account Brain</p>
            <h3>{account.account_name || account.username}</h3>
            <p>{account.platform} · {statusLabel(getAccountRole(account))} · {account.account_url || '暂无 URL'}</p>
          </div>
          <button className="ghost-button" type="button" onClick={() => setSelectedAccount(null)}>关闭详情</button>
        </div>

        <dl>
          <div><dt>平台</dt><dd>{account.platform}</dd></div>
          <div><dt>用户名</dt><dd>{account.username || '—'}</dd></div>
          <div><dt>账号类型</dt><dd>{statusLabel(getAccountRole(account))}</dd></div>
          <div><dt>连接记录</dt><dd>{accountConnections.length}</dd></div>
        </dl>

        <div className="profile-grid">
          <section><h4>目标用户</h4><p>{profile?.target_audience || account.target_audience || '等待 AI 画像'}</p></section>
          <section><h4>内容方向</h4><p>{profile?.content_direction || account.content_strategy || '等待 AI 画像'}</p></section>
          <section><h4>内容风格</h4><p>{profile?.content_style || '等待 AI 画像'}</p></section>
          <section><h4>发布频率</h4><p>{profile?.posting_frequency || account.posting_frequency || '等待 AI 画像'}</p></section>
          <section><h4>品牌定位</h4><p>{profile?.brand_positioning || '等待 AI 画像'}</p></section>
          <section><h4>AI 策略</h4><p>{profile?.ai_strategy || '等待 AI 画像'}</p></section>
        </div>
      </article>
    );
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Account Intelligence Core</p>
          <h2>账号矩阵管理</h2>
          <p>social_accounts 是唯一账号实体。自己的账号、竞品账号和灵感账号都统一放在这里，后续供情报、Agent 和发布系统调用。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured || !userId}>
          添加账号
        </button>
      </div>

      {renderPlatformConnectionCenter()}

      {(isCreating || editing) && (
        <AccountForm initialValue={editing} onSubmit={handleSave} onCancel={() => { setIsCreating(false); setEditing(null); }} />
      )}

      {message && <div className={messageIsError(message) ? 'notice error' : 'notice'}>{message}</div>}

      <div className="stat-grid">
        <StatCard label="账号总数" value={stats.total} hint="social_accounts" />
        <StatCard label="自有账号" value={stats.owned} hint="owned" />
        <StatCard label="情报账号" value={stats.intelligence} hint="competitor / inspiration" />
        <StatCard label="平台已连接" value={stats.connected} hint="platform_connections" />
        <StatCard label="已有 AI 画像" value={stats.profiled} hint="account_profiles" />
      </div>

      {renderAccountDetail(selectedAccount)}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会从 social_accounts、account_profiles 和 platform_connections 读取真实数据。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理你的个人账号矩阵。" />
      ) : accounts.length === 0 ? (
        <EmptyState title="还没有账号" description="添加第一个自有账号、竞品账号或灵感账号，后续 AI 会基于这些账号做情报分析。" />
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>角色</th>
                <th>账号</th>
                <th>目标受众</th>
                <th>内容方向</th>
                <th>发布频率</th>
                <th>AI画像</th>
                <th>运营状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const profile = account.account_profiles?.[0];
                return (
                  <tr key={account.id}>
                    <td>{account.platform}</td>
                    <td>{statusLabel(getAccountRole(account))}</td>
                    <td className="account-cell">
                      {account.avatar && <img src={account.avatar} alt="" />}
                      <span>
                        <strong>{account.account_name || account.username}</strong>
                        <br />
                        <small>{account.username || account.account_url || formatDate(account.created_at)}</small>
                      </span>
                    </td>
                    <td>{profile?.target_audience || account.target_audience || '—'}</td>
                    <td>{profile?.content_direction || account.content_strategy || '—'}</td>
                    <td>{profile?.posting_frequency || account.posting_frequency || '—'}</td>
                    <td>{profile ? `已生成 · ${formatDate(profile.last_analyzed_at || profile.updated_at)}` : '等待AI分析'}</td>
                    <td><StatusBadge status={account.status} /></td>
                    <td>
                      <div className="table-actions">
                        <button type="button" onClick={() => setSelectedAccount(account)}>详情</button>
                        <button type="button" onClick={() => setEditing(account)}>编辑</button>
                        {account.account_url && <a className="ghost-button" href={account.account_url} target="_blank" rel="noreferrer">打开</a>}
                        <button type="button" onClick={() => handleDelete(account)}>删除</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isSupabaseConfigured && (
        <div className="tag-panel">
          <strong>账号角色</strong>
          <div className="tag-row">
            {accountCategories.map((category) => (
              <span key={category.value} className="tag">
                {category.label} · {accounts.filter((account) => getAccountRole(account) === category.value).length}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
