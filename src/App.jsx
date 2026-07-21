import { useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './contexts/auth-context';
import { AccountsPage } from './pages/AccountsPage';
import { AssetLibrary } from './pages/AssetLibrary';
import { CharacterLibrary } from './pages/CharacterLibrary';
import { Dashboard } from './pages/Dashboard';

const pageTitles = {
  dashboard: 'AI 运营控制台',
  accounts: '账号矩阵',
  assets: '素材库',
  characters: '角色库',
  content: '内容工厂',
  intelligence: '情报中心',
  publish: '发布中心',
  analytics: '数据分析',
  settings: '设置',
};

function PlaceholderPage({ title, description }) {
  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">等待迁移</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </section>
  );
}

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const { error: authError, loading: authLoading, session, userId } = useAuth();

  const page = useMemo(() => {
    const props = { userId, onNavigate: setActivePage };

    switch (activePage) {
      case 'accounts':
        return <AccountsPage {...props} />;
      case 'assets':
        return <AssetLibrary {...props} />;
      case 'characters':
        return <CharacterLibrary {...props} />;
      case 'content':
        return <PlaceholderPage title="内容工厂" description="后续会把本地 Command Center 的内容生成、审核、发布准备流程迁移到这里。" />;
      case 'intelligence':
        return <PlaceholderPage title="情报中心" description="后续会把 Research Intelligence、竞品账号分析和内容机会发现迁移到这里。" />;
      case 'publish':
        return <PlaceholderPage title="发布中心" description="后续会把 Telegram / X 等平台发布链路迁移到这里。" />;
      case 'analytics':
        return <PlaceholderPage title="数据分析" description="后续会把内容表现、成本、转化和策略优化闭环迁移到这里。" />;
      case 'settings':
        return <PlaceholderPage title="设置" description="这里用于后续集中管理 Supabase、平台连接和个人运营参数。" />;
      default:
        return <Dashboard {...props} onNavigate={setActivePage} />;
    }
  }, [activePage, userId]);

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <div className="main-shell">
        <Header title={pageTitles[activePage] || pageTitles.dashboard} />
        {authLoading && <div className="notice">正在恢复登录状态...</div>}
        {authError && !session && <div className="notice error">{authError}</div>}
        {page}
      </div>
    </div>
  );
}
