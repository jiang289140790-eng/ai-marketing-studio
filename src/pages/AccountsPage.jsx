import { useCallback, useEffect, useState } from 'react';
import { AccountForm } from '../components/AccountForm';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { accountCategories } from '../data/navigation';
import { createSocialAccount, deleteSocialAccount, listSocialAccounts, updateSocialAccount } from '../services/account-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate, statusLabel } from '../utils/formatters';

export function AccountsPage({ userId }) {
  const [accounts, setAccounts] = useState([]);
  const [editing, setEditing] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [message, setMessage] = useState('');

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setAccounts(await listSocialAccounts(userId));
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function handleSave(payload) {
    try {
      if (editing) {
        await updateSocialAccount(editing.id, payload);
      } else {
        await createSocialAccount(userId, payload);
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
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Account Matrix</p>
          <h2>账号矩阵管理</h2>
          <p>把品牌号、个人号、竞品号和灵感号都沉淀成运营档案，记录受众、内容方向、发布频率和 API 状态。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsCreating(true)}>
          添加账号
        </button>
      </div>

      {(isCreating || editing) && (
        <AccountForm initialValue={editing} onSubmit={handleSave} onCancel={() => { setIsCreating(false); setEditing(null); }} />
      )}

      {message && <div className="notice error">{message}</div>}

      <div className="stat-grid">
        <StatCard label="账号总数" value={accounts.length} hint="social_accounts" />
        <StatCard label="正常运营" value={accounts.filter((account) => account.status === 'active').length} hint="可用于日常运营" />
        <StatCard label="API已连接" value={accounts.filter((account) => account.api_status === 'connected').length} hint="可接发布/数据能力" />
        <StatCard label="竞品/灵感" value={accounts.filter((account) => ['competitor', 'inspiration'].includes(account.account_type || account.account_category)).length} hint="用于内容情报" />
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置完成后，这里会从 social_accounts 表读取和保存账号。" />
      ) : accounts.length === 0 ? (
        <EmptyState title="还没有账号" description="先添加你的 X、Instagram、TikTok、YouTube 或 Telegram 账号，建立个人运营资产池。" />
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>平台</th>
                <th>类型</th>
                <th>账号</th>
                <th>目标受众</th>
                <th>内容方向</th>
                <th>频率</th>
                <th>API</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>{account.platform}</td>
                  <td>{statusLabel(account.account_type || account.account_category)}</td>
                  <td className="account-cell">
                    {account.avatar && <img src={account.avatar} alt="" />}
                    <span>
                      <strong>{account.account_name}</strong>
                      <br />
                      <small>{account.account_url ? <a href={account.account_url} target="_blank" rel="noreferrer">打开账号</a> : formatDate(account.created_at)}</small>
                    </span>
                  </td>
                  <td>{account.target_audience || '—'}</td>
                  <td>{account.content_strategy || '—'}</td>
                  <td>{account.posting_frequency || '—'}</td>
                  <td><StatusBadge status={account.api_status || 'not_connected'} /></td>
                  <td><StatusBadge status={account.status} /></td>
                  <td>
                    <div className="table-actions">
                      <button type="button" onClick={() => setEditing(account)}>编辑</button>
                      <button type="button" onClick={() => handleDelete(account)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isSupabaseConfigured && (
        <div className="tag-panel">
          <strong>账号类型</strong>
          <div className="tag-row">
            {accountCategories.map((category) => (
              <span key={category.value} className="tag">
                {category.label} · {accounts.filter((account) => (account.account_type || account.account_category) === category.value).length}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
