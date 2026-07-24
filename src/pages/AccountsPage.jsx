import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountForm } from '../components/AccountForm';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { useConfirmation } from '../contexts/confirmation-context';
import { accountCategories } from '../data/navigation';
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

function connectionIsActive(connection) {
  return connection?.status === 'connected' || connection?.is_connected === true;
}

function messageIsError(message) {
  return /error|failed|missing|失败|异常|缺少/i.test(String(message || ''));
}

export function AccountsPage({ userId, detailId, onNavigate }) {
  const { confirm } = useConfirmation();
  const [accounts, setAccounts] = useState([]);
  const [connections, setConnections] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
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
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  useEffect(() => {
    if (!detailId || !accounts.length) return;
    setSelectedAccount(accounts.find((account) => String(account.id) === String(detailId)) || null);
  }, [accounts, detailId]);

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
    const accepted = await confirm({
      title: '删除账号？',
      message: `将删除“${account.account_name || account.username || '未命名账号'}”。该账号关联的内容情报、画像和发布配置可能不再可用。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteSocialAccount(account.id);
      if (selectedAccount?.id === account.id) {
        setSelectedAccount(null);
        onNavigate('accounts');
      }
      setMessage(`已删除账号：${account.account_name || account.username}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
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
          <button className="ghost-button" type="button" onClick={() => {
            setSelectedAccount(null);
            onNavigate('accounts');
          }}>关闭详情</button>
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
          <p>这里是唯一的账号资产中心。自己的账号、竞品账号和灵感账号都统一放在这里，后续供情报、Agent 和发布系统调用。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)} disabled={!isSupabaseConfigured || !userId}>
          添加账号
        </button>
      </div>

      {(isCreating || editing) && (
        <AccountForm initialValue={editing} onSubmit={handleSave} onCancel={() => { setIsCreating(false); setEditing(null); }} />
      )}

      {message && <div className={messageIsError(message) ? 'notice error' : 'notice'}>{message}</div>}

      <div className="stat-grid">
        <StatCard label="账号总数" value={stats.total} hint="统一账号资产" />
        <StatCard label="自有账号" value={stats.owned} hint="owned" />
        <StatCard label="情报账号" value={stats.intelligence} hint="competitor / inspiration" />
        <StatCard label="平台已连接" value={stats.connected} hint="已授权连接" />
        <StatCard label="已有 AI 画像" value={stats.profiled} hint="账号智能分析" />
      </div>

      {renderAccountDetail(selectedAccount)}

      {isLoading ? (
        <div className="skeleton-grid" aria-label="账号矩阵加载中">
          {Array.from({ length: 4 }, (_, index) => <div className="skeleton skeleton-card" key={index} />)}
        </div>
      ) : !isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会读取你的真实账号、画像和平台连接状态。" />
      ) : !userId ? (
        <EmptyState title="请先登录" description="登录后才能读取和管理你的个人账号矩阵。" />
      ) : accounts.length === 0 ? (
        <EmptyState title="还没有账号" description="添加第一个自有账号、竞品账号或灵感账号，后续 AI 会基于这些账号做情报分析。" />
      ) : (
        <div className="account-card-grid">
          {accounts.map((account) => {
            const profile = account.account_profiles?.[0];
            const accountConnections = getConnectionsForAccount(account, connections);
            const hasBrain = Boolean(profile || account.strategy_summary || account.brain_data);
            return (
              <article className="account-row-card" key={account.id}>
                <div className="account-card-header">
                  {account.avatar ? (
                    <img className="account-avatar-thumb" src={account.avatar} alt="" loading="lazy" />
                  ) : (
                    <span className="account-avatar-fallback" aria-hidden="true">{String(account.account_name || account.username || '?').slice(0, 1).toUpperCase()}</span>
                  )}
                  <div className="account-card-identity">
                    <h3>{account.account_name || account.username}</h3>
                    <small>{account.username ? `@${String(account.username).replace(/^@/, '')}` : formatDate(account.created_at)} · {account.platform} · {statusLabel(getAccountRole(account))}</small>
                  </div>
                  <StatusBadge status={account.status} />
                </div>

                <div className="account-connection-row">
                  <span>平台连接</span>
                  <div className="connection-dots" aria-label="账号平台连接状态">
                    {['x', 'telegram', 'youtube'].map((platform) => {
                      const connection = accountConnections.find((item) => String(item.platform || '').toLowerCase() === platform);
                      return (
                        <span
                          className={`connection-dot ${connectionIsActive(connection) ? 'connected' : ''}`}
                          key={platform}
                          title={`${platform.toUpperCase()}：${connectionIsActive(connection) ? '已连接' : '未连接'}`}
                        >
                          {platform.slice(0, 1).toUpperCase()}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className="account-card-fields">
                  <div><span>目标受众</span><p>{profile?.target_audience || account.target_audience || '—'}</p></div>
                  <div><span>内容方向</span><p>{profile?.content_direction || account.content_strategy || '—'}</p></div>
                  <div><span>发布频率</span><p>{profile?.posting_frequency || account.posting_frequency || '—'}</p></div>
                </div>

                <div className="account-card-footer">
                  <span className={`account-brain-state ${hasBrain ? 'ready' : ''}`}>
                    {hasBrain ? `AI 已画像 · ${formatDate(profile?.last_analyzed_at || profile?.updated_at)}` : '等待 AI 分析'}
                  </span>
                  <div className="table-actions">
                    <button type="button" onClick={() => {
                      setSelectedAccount(account);
                      onNavigate('accounts', account.id);
                    }}>详情</button>
                    <button type="button" onClick={() => setEditing(account)}>编辑</button>
                    {account.account_url && <a className="ghost-button" href={account.account_url} target="_blank" rel="noreferrer">打开</a>}
                    <button type="button" onClick={() => handleDelete(account)}>删除</button>
                  </div>
                </div>
              </article>
            );
          })}
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
