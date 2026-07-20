import { useCallback, useEffect, useMemo, useState } from 'react';
import { AccountForm } from '../components/AccountForm';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { accountCategories } from '../data/navigation';
import {
  analyzeAccountWithAI,
  createSocialAccount,
  deleteSocialAccount,
  generateDailyStrategy,
  listSocialAccounts,
  updateSocialAccount,
} from '../services/account-service';
import {
  connectXPlatform,
  disconnectXPlatform,
  getXPlatformStatus,
  listPlatformConnections,
  reconnectXPlatform,
} from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

const platformConnectionCards = [
  {
    platform: 'X',
    title: 'X / Twitter',
    description: '通过 OAuth 连接自己的 X 账号，成功后自动写入账号矩阵。支持重复连接多个 X 账号。',
    priority: '已接入',
    implemented: true,
    authType: 'oauth',
  },
  {
    platform: 'Telegram',
    title: 'Telegram',
    description: '使用 Bot / Channel 连接。每个 Channel 会保存为一条独立连接。',
    priority: '已接入',
    implemented: true,
    settingsOnly: true,
    authType: 'bot',
  },
  {
    platform: 'Instagram',
    title: 'Instagram',
    description: '连接入口已建立，等待迁移旧系统成熟 OAuth 流程与平台密钥。',
    priority: '待迁移',
    implemented: false,
    authType: 'oauth',
  },
  {
    platform: 'YouTube',
    title: 'YouTube',
    description: '连接入口已建立，后续接入频道授权、发布和数据同步。',
    priority: '待迁移',
    implemented: false,
    authType: 'oauth',
  },
  {
    platform: 'TikTok',
    title: 'TikTok',
    description: '连接入口已建立，后续接入 OAuth、发布和表现数据。',
    priority: '待迁移',
    implemented: false,
    authType: 'oauth',
  },
  {
    platform: 'Discord',
    title: 'Discord',
    description: '新增平台入口。后续可接入 Bot / OAuth，用于频道发布和社区运营。',
    priority: '待迁移',
    implemented: false,
    authType: 'bot / oauth',
  },
];

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

function getPrimaryConnection(account, allConnections = []) {
  const connections = getConnectionsForAccount(account, allConnections);
  return connections.find((connection) => connection.status === 'connected') || connections[0] || null;
}

function getPlatformConnections(connections, platform) {
  return connections
    .filter((connection) => connection.platform === platform)
    .sort((a, b) => {
      if (a.status === 'connected' && b.status !== 'connected') return -1;
      if (a.status !== 'connected' && b.status === 'connected') return 1;
      return new Date(b.connected_at || b.created_at || 0) - new Date(a.connected_at || a.created_at || 0);
    });
}

function getConnectionAccountName(connection) {
  return (
    connection?.social_accounts?.account_name ||
    connection?.metadata?.x?.username ||
    connection?.metadata?.username ||
    connection?.metadata?.screen_name ||
    connection?.metadata?.telegram?.chat_id ||
    connection?.metadata?.chat_id ||
    '等待授权'
  );
}

function getPermissionsLabel(connection) {
  const permissions = connection?.permissions;
  if (!permissions) return '—';
  if (Array.isArray(permissions)) return permissions.length ? permissions.join(', ') : '—';
  if (typeof permissions === 'string') return permissions || '—';
  return Object.values(permissions).flat().filter(Boolean).join(', ') || '—';
}

function formatList(value) {
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  return value || '—';
}

export function AccountsPage({ userId, onNavigate }) {
  const [accounts, setAccounts] = useState([]);
  const [connections, setConnections] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [busyKey, setBusyKey] = useState(null);
  const [strategyResult, setStrategyResult] = useState(null);

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
      apiConnected: connectedConnections.length,
      intelligenceAccounts: accounts.filter((account) => ['competitor', 'inspiration'].includes(getAccountRole(account))).length,
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
        setMessage('账号已创建。自有账号建议优先使用上方平台连接；竞品和灵感账号可以手动维护。');
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
      setMessage(`已删除账号：${account.account_name || account.username}`);
      if (selectedAccount?.id === account.id) setSelectedAccount(null);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleAnalyzeAccount(account) {
    setBusyKey(`account:${account.id}`);
    setMessage('');
    try {
      const result = await analyzeAccountWithAI(userId, account.id);
      setMessage(`AI账号画像已生成：${result.profile?.target_audience || account.account_name || account.username}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleGenerateStrategy(account = null) {
    setBusyKey(account?.id ? `account:${account.id}` : 'strategy');
    setMessage('');
    setStrategyResult(null);
    try {
      const result = await generateDailyStrategy(userId, account?.id || null);
      setStrategyResult(result);
      setMessage('今日运营策略已生成，并写入 content_strategies。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleConnectPlatform(card) {
    if (card.platform !== 'X') {
      if (card.settingsOnly && onNavigate) {
        setMessage('已切换到设置页，请在那里填写 Telegram Channel / Chat ID。每次填写一个新 Channel，就会新增一条连接。');
        onNavigate('settings');
        return;
      }
      setMessage(`${card.title} 已加入连接中心，但真实 ${card.authType} 流程还需要迁移旧系统实现和配置平台密钥。`);
      return;
    }

    setBusyKey(`platform:${card.platform}`);
    setMessage('');
    try {
      const result = await connectXPlatform({ account_role: 'owned' });
      if (result?.auth_url) {
        setMessage('正在进入 X 授权页。授权成功返回后，账号会自动出现在账号矩阵。');
        window.location.assign(result.auth_url);
      } else {
        setMessage('X OAuth 初始化完成，但没有返回授权地址。请检查 Edge Function 配置。');
        await refresh();
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleConnectXForAccount(account) {
    setBusyKey(`account:${account.id}`);
    setMessage('');
    try {
      const result = await connectXPlatform({ account_id: account.id });
      if (result?.auth_url) {
        setMessage('正在进入 X 授权页。授权成功返回后，请刷新账号状态。');
        window.location.assign(result.auth_url);
      } else {
        setMessage('X 连接已创建，请刷新状态查看结果。');
        await refresh();
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleReconnectX(connection) {
    if (!connection) return;
    setBusyKey(`connection:${connection.id}`);
    setMessage('');
    try {
      const result = await reconnectXPlatform(connection.id);
      if (result?.auth_url) {
        setMessage('正在进入 X 重新授权页。授权成功后会自动回到系统。');
        window.location.assign(result.auth_url);
      } else {
        setMessage('X 重新连接已提交。');
        await refresh();
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDisconnectX(connection) {
    if (!connection) return;
    setBusyKey(`connection:${connection.id}`);
    setMessage('');
    try {
      await disconnectXPlatform(connection.id);
      setMessage('X 连接已断开。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRefreshXStatus(connection) {
    if (!connection) {
      setMessage('这个 X 账号还没有连接记录，请先点击“连接 X”。');
      return;
    }
    setBusyKey(`connection:${connection.id}`);
    setMessage('');
    try {
      const result = await getXPlatformStatus(connection.id);
      const status = result?.connection?.status || result?.connections?.[0]?.status || result?.status || 'unknown';
      setMessage(`X 状态已刷新：${statusLabel(status)}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyKey(null);
    }
  }

  function renderConnectionActions(card, platformConnections) {
    const busy = busyKey === `platform:${card.platform}`;
    const hasConnection = platformConnections.length > 0;

    if (card.platform === 'X') {
      return (
        <button
          type="button"
          className="primary-button"
          disabled={busy || !isSupabaseConfigured || !userId}
          onClick={() => handleConnectPlatform(card)}
        >
          {hasConnection ? '连接另一个 X 账号' : '连接 X'}
        </button>
      );
    }

    if (card.settingsOnly) {
      return (
        <button type="button" className="ghost-button" onClick={() => handleConnectPlatform(card)}>
          {hasConnection ? '添加另一个 Telegram' : '到设置页连接'}
        </button>
      );
    }

    return (
      <button type="button" className="ghost-button" disabled={!card.implemented} onClick={() => handleConnectPlatform(card)}>
        {card.implemented ? `连接 ${card.platform}` : '准备接入'}
      </button>
    );
  }

  function renderConnectionRecord(connection) {
    const busy = busyKey === `connection:${connection.id}`;
    return (
      <div className="connection-record" key={connection.id}>
        <div>
          <strong>{getConnectionAccountName(connection)}</strong>
          <small>{formatDate(connection.connected_at || connection.created_at)}</small>
        </div>
        <StatusBadge status={connection.status || 'pending'} />
        {connection.platform === 'X' && (
          <div className="mini-actions">
            <button type="button" disabled={busy} onClick={() => handleRefreshXStatus(connection)}>状态</button>
            <button type="button" disabled={busy} onClick={() => handleReconnectX(connection)}>重连</button>
            <button type="button" disabled={busy} onClick={() => handleDisconnectX(connection)}>断开</button>
          </div>
        )}
      </div>
    );
  }

  function renderPlatformConnectionCenter() {
    return (
      <section className="connection-center">
        <div className="section-head">
          <div>
            <p className="eyebrow">Platform Connection Center</p>
            <h2>连接自己的运营账号</h2>
            <p>每个平台都可以保存多个连接账号。连接成功后系统会自动创建或绑定到 social_accounts，Token 只在后端安全层处理。</p>
          </div>
        </div>

        <div className="platform-connection-grid multi">
          {platformConnectionCards.map((card) => {
            const platformConnections = getPlatformConnections(connections, card.platform);
            const connectedCount = platformConnections.filter((connection) => connection.status === 'connected').length;
            const status = connectedCount ? 'connected' : platformConnections[0]?.status || 'not_connected';
            const firstConnection = platformConnections[0];
            return (
              <article className={`platform-connection-card ${connectedCount ? 'connected' : ''}`} key={card.platform}>
                <div className="platform-card-top">
                  <div>
                    <span className="platform-icon">{card.platform.slice(0, 1)}</span>
                    <h3>{card.title}</h3>
                  </div>
                  <StatusBadge status={status} />
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
                  {platformConnections.length ? platformConnections.map(renderConnectionRecord) : (
                    <div className="connection-empty">暂无连接账号</div>
                  )}
                </div>

                <div className="card-actions">
                  {renderConnectionActions(card, platformConnections)}
                </div>
                <small>{card.priority} · {card.authType}</small>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  function renderConnectionCell(account) {
    const accountConnections = getConnectionsForAccount(account, connections);
    const connection = getPrimaryConnection(account, connections);
    const isBusy = busyKey === `account:${account.id}` || busyKey === `connection:${connection?.id}`;
    const connected = connection?.status === 'connected';

    return (
      <div className="connection-cell">
        <div className="connection-status-row">
          <StatusBadge status={connected ? 'connected' : (connection?.status || account.api_status || 'not_connected')} />
          {connected && <span className="success-pill">API已连接</span>}
        </div>
        <small>连接记录：{accountConnections.length}</small>
        <small>权限：{getPermissionsLabel(connection)}</small>
        <small>最后同步：{formatDate(connection?.last_sync || connection?.connected_at)}</small>
        {account.platform === 'X' && (
          <div className="table-actions">
            {!connected ? (
              <button type="button" disabled={isBusy} onClick={() => handleConnectXForAccount(account)}>
                {connection ? '继续连接 X' : '连接 X'}
              </button>
            ) : (
              <>
                <button type="button" disabled={isBusy} onClick={() => handleRefreshXStatus(connection)}>刷新状态</button>
                <button type="button" disabled={isBusy} onClick={() => handleReconnectX(connection)}>重新连接</button>
                <button type="button" disabled={isBusy} onClick={() => handleDisconnectX(connection)}>断开</button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderAccountDetail(account) {
    if (!account) return null;
    const profile = account.account_profiles?.[0];
    const connection = getPrimaryConnection(account, connections);
    return (
      <article className="detail-panel account-detail-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Account Detail</p>
            <h3>{account.account_name || account.username}</h3>
            <p>{account.platform} · {statusLabel(getAccountRole(account))} · {account.account_url || '暂无 URL'}</p>
          </div>
          <div className="button-row">
            <button className="primary-button" type="button" disabled={busyKey === `account:${account.id}`} onClick={() => handleAnalyzeAccount(account)}>
              AI分析账号
            </button>
            <button className="ghost-button" type="button" disabled={busyKey === `account:${account.id}`} onClick={() => handleGenerateStrategy(account)}>
              生成今日策略
            </button>
          </div>
        </div>

        <dl>
          <div><dt>平台</dt><dd>{account.platform}</dd></div>
          <div><dt>用户名</dt><dd>{account.username || '—'}</dd></div>
          <div><dt>账号类型</dt><dd>{statusLabel(getAccountRole(account))}</dd></div>
          <div><dt>连接状态</dt><dd>{statusLabel(connection?.status || account.api_status || 'not_connected')}</dd></div>
        </dl>

        <div className="profile-grid">
          <section><h4>目标用户</h4><p>{profile?.target_audience || account.target_audience || '等待 AI 分析'}</p></section>
          <section><h4>内容方向</h4><p>{profile?.content_direction || account.content_strategy || '等待 AI 分析'}</p></section>
          <section><h4>视觉风格</h4><p>{profile?.visual_style || profile?.content_style || '等待 AI 分析'}</p></section>
          <section><h4>文案风格</h4><p>{profile?.copywriting_style || profile?.content_style || '等待 AI 分析'}</p></section>
          <section><h4>发布时间规律</h4><p>{formatList(profile?.best_posting_windows) || profile?.posting_frequency || account.posting_frequency || '等待 AI 分析'}</p></section>
          <section><h4>爆款规律</h4><p>{formatList(profile?.viral_patterns)}</p></section>
          <section><h4>品牌定位</h4><p>{profile?.brand_positioning || '等待 AI 分析'}</p></section>
          <section><h4>运营建议</h4><p>{profile?.operation_advice || profile?.ai_strategy || '等待 AI 分析'}</p></section>
        </div>
      </article>
    );
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Account Intelligence Core</p>
          <h2>账号管理</h2>
          <p>social_accounts 是唯一账号实体；platform_connections 保存每个平台的多个授权连接，敏感 Token 不进入前端。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" disabled={!accounts.length || busyKey === 'strategy'} onClick={() => handleGenerateStrategy()}>
            生成全局今日策略
          </button>
          <button className="ghost-button" type="button" onClick={() => setIsCreating(true)}>
            手动添加竞品/灵感账号
          </button>
        </div>
      </div>

      {renderPlatformConnectionCenter()}

      {(isCreating || editing) && (
        <AccountForm initialValue={editing} onSubmit={handleSave} onCancel={() => { setIsCreating(false); setEditing(null); }} />
      )}

      {message && <div className={message.toLowerCase().includes('missing') || message.toLowerCase().includes('error') || message.includes('失败') ? 'notice error' : 'notice'}>{message}</div>}

      {strategyResult && (
        <article className="analysis-card">
          <div className="card-meta">
            <span className="tag">Strategy Agent</span>
            <span>{strategyResult.model || 'deepseek-chat'}</span>
            <span>成本 {Number(strategyResult.cost || 0).toFixed(6)}</span>
            <span>耗时 {Number(strategyResult.duration || 0)}ms</span>
          </div>
          <h3>{strategyResult.daily_strategy?.summary || '今日运营策略'}</h3>
          <p>内容任务：{formatList(strategyResult.daily_strategy?.content_tasks)}</p>
          <p>素材任务：{formatList(strategyResult.daily_strategy?.asset_tasks)}</p>
          <p>发布计划：{formatList(strategyResult.daily_strategy?.publish_plan)}</p>
        </article>
      )}

      <div className="stat-grid">
        <StatCard label="账号总数" value={stats.total} hint="social_accounts" />
        <StatCard label="自有账号" value={stats.owned} hint="owned" />
        <StatCard label="平台已连接" value={stats.apiConnected} hint="connected platform_connections" />
        <StatCard label="情报账号" value={stats.intelligenceAccounts} hint="competitor / inspiration" />
        <StatCard label="已有AI画像" value={stats.profiled} hint="account_profiles" />
      </div>

      {renderAccountDetail(selectedAccount)}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会从 social_accounts、account_profiles 和 platform_connections 读取数据。" />
      ) : accounts.length === 0 ? (
        <EmptyState title="还没有账号" description="自有账号请先使用上方平台连接；竞品和灵感账号可以手动添加，用于内容情报和AI分析。" />
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
                <th>平台连接</th>
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
                    <td>{renderConnectionCell(account)}</td>
                    <td><StatusBadge status={account.status} /></td>
                    <td>
                      <div className="table-actions">
                        <button type="button" onClick={() => setSelectedAccount(account)}>详情</button>
                        <button type="button" disabled={busyKey === `account:${account.id}`} onClick={() => handleAnalyzeAccount(account)}>AI分析</button>
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
