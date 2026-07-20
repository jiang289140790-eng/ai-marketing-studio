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
import { connectXPlatform, disconnectXPlatform, getXPlatformStatus, reconnectXPlatform } from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

function getAccountRole(account) {
  const role = account.account_role || account.account_type || account.account_category || 'owned';
  if (role === 'brand' || role === 'personal') return 'owned';
  return role;
}

function getPrimaryConnection(account) {
  const connections = account.platform_connections || [];
  return connections.find((connection) => connection.status === 'connected') || connections[0] || null;
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

export function AccountsPage({ userId }) {
  const [accounts, setAccounts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [busyAccountId, setBusyAccountId] = useState(null);
  const [strategyResult, setStrategyResult] = useState(null);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    const nextAccounts = await listSocialAccounts(userId);
    setAccounts(nextAccounts);
    setSelectedAccount((current) => {
      if (!current) return null;
      return nextAccounts.find((account) => account.id === current.id) || null;
    });
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const stats = useMemo(() => {
    const connectedAccounts = accounts.filter((account) => getPrimaryConnection(account)?.status === 'connected');
    return {
      total: accounts.length,
      owned: accounts.filter((account) => getAccountRole(account) === 'owned').length,
      apiConnected: connectedAccounts.length,
      intelligenceAccounts: accounts.filter((account) => ['competitor', 'inspiration'].includes(getAccountRole(account))).length,
      profiled: accounts.filter((account) => account.account_profiles?.length > 0).length,
    };
  }, [accounts]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updateSocialAccount(editing.id, payload);
        setMessage('账号已更新。');
      } else {
        await createSocialAccount(userId, payload);
        setMessage('账号已创建。可以继续连接平台 API，或点击“AI分析账号”生成账号画像。');
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
    setBusyAccountId(account.id);
    setMessage('');
    try {
      const result = await analyzeAccountWithAI(userId, account.id);
      setMessage(`AI账号画像已生成：${result.profile?.target_audience || account.account_name || account.username}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleGenerateStrategy(account = null) {
    setBusyAccountId(account?.id || 'strategy');
    setMessage('');
    setStrategyResult(null);
    try {
      const result = await generateDailyStrategy(userId, account?.id || null);
      setStrategyResult(result);
      setMessage('今日运营策略已生成，并写入 content_strategies。');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleConnectX(account) {
    setBusyAccountId(account.id);
    setMessage('');
    try {
      const result = await connectXPlatform({ account_id: account.id });
      if (result?.auth_url) {
        window.open(result.auth_url, '_blank', 'noopener,noreferrer');
        setMessage('已打开 X 授权页面。授权成功返回后，请刷新账号状态。');
      } else {
        setMessage('X 连接已创建，请刷新状态查看结果。');
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleReconnectX(account) {
    const connection = getPrimaryConnection(account);
    if (!connection) return handleConnectX(account);
    setBusyAccountId(account.id);
    setMessage('');
    try {
      const result = await reconnectXPlatform(connection.id);
      if (result?.auth_url) {
        window.open(result.auth_url, '_blank', 'noopener,noreferrer');
        setMessage('已重新打开 X 授权页面。授权成功后，请刷新账号状态。');
      } else {
        setMessage('X 重新连接已提交。');
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleDisconnectX(account) {
    const connection = getPrimaryConnection(account);
    if (!connection) return;
    setBusyAccountId(account.id);
    setMessage('');
    try {
      await disconnectXPlatform(connection.id);
      setMessage('X 连接已断开。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  async function handleRefreshXStatus(account) {
    const connection = getPrimaryConnection(account);
    if (!connection) {
      setMessage('这个 X 账号还没有连接记录，请先点击“连接 X”。');
      return;
    }
    setBusyAccountId(account.id);
    setMessage('');
    try {
      const result = await getXPlatformStatus(connection.id);
      const status = result?.connection?.status || result?.status || 'unknown';
      setMessage(`X 状态已刷新：${statusLabel(status)}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusyAccountId(null);
    }
  }

  function renderConnectionCell(account) {
    const connection = getPrimaryConnection(account);
    const isBusy = busyAccountId === account.id;
    const connected = connection?.status === 'connected';

    if (account.platform !== 'X') {
      return (
        <div className="connection-cell">
          <StatusBadge status={account.api_status || connection?.status || 'not_connected'} />
          <small>连接中心统一读取 platform_connections。</small>
        </div>
      );
    }

    return (
      <div className="connection-cell">
        <div className="connection-status-row">
          <StatusBadge status={connected ? 'connected' : (connection?.status || 'not_connected')} />
          {connected && <span className="success-pill">API已连接</span>}
        </div>
        <small>权限：{getPermissionsLabel(connection)}</small>
        <small>最后同步：{formatDate(connection?.last_sync || connection?.connected_at)}</small>
        <div className="table-actions">
          {!connected ? (
            <button type="button" disabled={isBusy} onClick={() => handleConnectX(account)}>
              {connection ? '继续连接 X' : '连接 X'}
            </button>
          ) : (
            <>
              <button type="button" disabled={isBusy} onClick={() => handleRefreshXStatus(account)}>刷新状态</button>
              <button type="button" disabled={isBusy} onClick={() => handleReconnectX(account)}>重新连接</button>
              <button type="button" disabled={isBusy} onClick={() => handleDisconnectX(account)}>断开</button>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderAccountDetail(account) {
    if (!account) return null;
    const profile = account.account_profiles?.[0];
    const connection = getPrimaryConnection(account);
    return (
      <article className="detail-panel account-detail-panel">
        <div className="section-head">
          <div>
            <p className="eyebrow">Account Detail</p>
            <h3>{account.account_name || account.username}</h3>
            <p>{account.platform} · {statusLabel(getAccountRole(account))} · {account.account_url || '暂无 URL'}</p>
          </div>
          <div className="button-row">
            <button className="primary-button" type="button" disabled={busyAccountId === account.id} onClick={() => handleAnalyzeAccount(account)}>
              AI分析账号
            </button>
            <button className="ghost-button" type="button" disabled={busyAccountId === account.id} onClick={() => handleGenerateStrategy(account)}>
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
          <section>
            <h4>目标用户</h4>
            <p>{profile?.target_audience || account.target_audience || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>内容方向</h4>
            <p>{profile?.content_direction || account.content_strategy || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>视觉风格</h4>
            <p>{profile?.visual_style || profile?.content_style || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>文案风格</h4>
            <p>{profile?.copywriting_style || profile?.content_style || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>发布时间规律</h4>
            <p>{formatList(profile?.best_posting_windows) || profile?.posting_frequency || account.posting_frequency || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>爆款规律</h4>
            <p>{formatList(profile?.viral_patterns)}</p>
          </section>
          <section>
            <h4>品牌定位</h4>
            <p>{profile?.brand_positioning || '等待 AI 分析'}</p>
          </section>
          <section>
            <h4>运营建议</h4>
            <p>{profile?.operation_advice || profile?.ai_strategy || '等待 AI 分析'}</p>
          </section>
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
          <p>social_accounts 是唯一账号实体。内容情报和采集中心只选择这里的账号，不再重复创建。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" disabled={!accounts.length || busyAccountId === 'strategy'} onClick={() => handleGenerateStrategy()}>
            生成全局今日策略
          </button>
          <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
            添加账号
          </button>
        </div>
      </div>

      {(isCreating || editing) && (
        <AccountForm initialValue={editing} onSubmit={handleSave} onCancel={() => { setIsCreating(false); setEditing(null); }} />
      )}

      {message && <div className="notice">{message}</div>}

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
        <StatCard label="API已连接" value={stats.apiConnected} hint="platform_connections" />
        <StatCard label="情报账号" value={stats.intelligenceAccounts} hint="competitor / inspiration" />
        <StatCard label="已有AI画像" value={stats.profiled} hint="account_profiles" />
      </div>

      {renderAccountDetail(selectedAccount)}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会从 social_accounts、account_profiles 和 platform_connections 读取数据。" />
      ) : accounts.length === 0 ? (
        <EmptyState title="还没有账号" description="先添加 X、Instagram、TikTok、YouTube 或 Telegram 账号。后续采集、分析、发布都会围绕这些账号运行。" />
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
                        <button type="button" disabled={busyAccountId === account.id} onClick={() => handleAnalyzeAccount(account)}>AI分析</button>
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
