import { useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { listSocialAccounts } from '../services/account-service';
import { listAssets } from '../services/asset-service';
import { listCharacters } from '../services/character-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function Dashboard({ userId, onNavigate }) {
  const [stats, setStats] = useState({
    accounts: 0,
    owned: 0,
    intelligence: 0,
    assets: 0,
    characters: 0,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;

    async function loadStats() {
      setLoading(true);
      try {
        const [accounts, assets, characters] = await Promise.all([
          listSocialAccounts(userId),
          listAssets(userId),
          listCharacters(userId),
        ]);

        setStats({
          accounts: accounts.length,
          owned: accounts.filter((account) => ['owned', 'brand', 'personal'].includes(account.account_role || account.account_type || account.account_category)).length,
          intelligence: accounts.filter((account) => ['competitor', 'inspiration'].includes(account.account_role || account.account_type || account.account_category)).length,
          assets: assets.length,
          characters: characters.length,
        });
      } finally {
        setLoading(false);
      }
    }

    loadStats().catch(() => setLoading(false));
    return undefined;
  }, [userId]);

  if (!isSupabaseConfigured) {
    return (
      <section className="page-stack">
        <EmptyState title="等待 Supabase 配置" description="配置 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY 后，线上站会读取真实数据库。" />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel">
          <p className="eyebrow">Personal AI Ops Workspace</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>登录后，这里会显示账号矩阵、素材库和角色库的真实数据。</p>
        </div>
      </section>
    );
  }

  const value = (number) => (loading ? '-' : number);

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">Command Center</p>
        <h2>AI Marketing Studio 线上控制台</h2>
        <p>当前线上站点以 Command Center 为核心，集中展示账号矩阵、素材库、角色库、策略、内容工作台和发布审批。</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('accounts')}>打开账号矩阵</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('assets')}>打开素材库</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('characters')}>打开角色库</button>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="账号总数" value={value(stats.accounts)} hint="social_accounts" />
        <StatCard label="自有账号" value={value(stats.owned)} hint="owned" />
        <StatCard label="情报账号" value={value(stats.intelligence)} hint="competitor / inspiration" />
        <StatCard label="素材数量" value={value(stats.assets)} hint="assets" />
        <StatCard label="角色数量" value={value(stats.characters)} hint="characters" />
      </div>
    </section>
  );
}
