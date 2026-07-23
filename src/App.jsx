import { lazy, Suspense, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './contexts/auth-context';
import { AccountsPage } from './pages/AccountsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AssetLibrary } from './pages/AssetLibrary';
import { CampaignStrategyPage } from './pages/CampaignStrategyPage';
import { CharacterLibrary } from './pages/CharacterLibrary';
import { CommandCenter } from './pages/CommandCenter';
import { ContentWorkspacePage } from './pages/ContentWorkspacePage';
import { ContentIntelligence } from './pages/ContentIntelligence';
import { DailyReport } from './pages/DailyReport';
import { PublishQueuePage } from './pages/PublishQueuePage';

const AIWorksPage = lazy(() => import('./pages/AIWorksPage').then((module) => ({ default: module.AIWorksPage })));
const PlatformConnectionsPage = lazy(() => import('./pages/PlatformConnectionsPage').then((module) => ({ default: module.PlatformConnectionsPage })));
const SystemOverviewPage = lazy(() => import('./pages/SystemOverviewPage').then((module) => ({ default: module.SystemOverviewPage })));
const WorkflowModelConfigPage = lazy(() => import('./pages/WorkflowModelConfigPage').then((module) => ({ default: module.WorkflowModelConfigPage })));
const KnowledgeVaultPage = lazy(() => import('./pages/KnowledgeVaultPage').then((module) => ({ default: module.KnowledgeVaultPage })));

const pageTitles = {
  dashboard: 'AI Command Center',
  campaigns: 'Campaign 与策略',
  workspace: '内容工作台',
  intelligence: '内容情报',
  publish: '发布队列',
  accounts: '账号矩阵',
  assets: '素材库',
  characters: '角色库',
  aiworks: 'AI 成果',
  analytics: '分析优化',
  dailyreport: '运营日报',
  knowledge: '知识库',
  connections: '平台连接',
  health: '系统状态',
  workflows: '工作流与模型配置',
};

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const { error: authError, loading: authLoading, session, userId } = useAuth();

  const page = useMemo(() => {
    const props = { userId, onNavigate: setActivePage };

    switch (activePage) {
      case 'campaigns':
        return <CampaignStrategyPage {...props} />;
      case 'workspace':
        return <ContentWorkspacePage {...props} />;
      case 'intelligence':
        return <ContentIntelligence {...props} />;
      case 'publish':
        return <PublishQueuePage {...props} />;
      case 'accounts':
        return <AccountsPage {...props} />;
      case 'assets':
        return <AssetLibrary {...props} />;
      case 'characters':
        return <CharacterLibrary {...props} />;
      case 'aiworks':
        return <AIWorksPage {...props} />;
      case 'analytics':
        return <AnalyticsPage {...props} />;
      case 'dailyreport':
        return <DailyReport {...props} />;
      case 'knowledge':
        return <KnowledgeVaultPage {...props} />;
      case 'connections':
        return <PlatformConnectionsPage {...props} />;
      case 'health':
        return <SystemOverviewPage {...props} />;
      case 'workflows':
        return <WorkflowModelConfigPage {...props} />;
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
        <Suspense fallback={<div className="notice">正在加载页面...</div>}>{page}</Suspense>
      </div>
    </div>
  );
}
