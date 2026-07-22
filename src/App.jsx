import { useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './contexts/auth-context';
import { AccountsPage } from './pages/AccountsPage';
import { AssetLibrary } from './pages/AssetLibrary';
import { CharacterLibrary } from './pages/CharacterLibrary';
import { CommandCenter } from './pages/CommandCenter';
import { OpsDataPage } from './pages/OpsDataPage';

const pageTitles = {
  dashboard: 'AI 运营总控台',
  accounts: '账号矩阵',
  campaigns: 'Campaign 与策略',
  content: '内容工厂',
  aiworks: 'AI 成果',
  assets: '素材库',
  characters: '角色库',
  publish: '发布队列',
  analytics: '分析优化',
  knowledge: '知识库',
  settings: '设置',
};

function SettingsPage() {
  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">Settings</p>
        <h2>系统设置</h2>
        <p>
          线上 GitHub Pages 只保留前端可见配置。平台密钥、AI Key、Telegram/X Token 等敏感信息继续放在
          Supabase Edge Function Secrets 或后端环境变量中，不能进入前端。
        </p>
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
      case 'campaigns':
      case 'content':
      case 'aiworks':
      case 'publish':
      case 'analytics':
      case 'knowledge':
        return <OpsDataPage type={activePage} {...props} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <CommandCenter {...props} />;
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
