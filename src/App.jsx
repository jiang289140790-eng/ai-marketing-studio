import { lazy, Suspense, useMemo } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './contexts/auth-context';
import { useAppRoute } from './utils/app-route';

const CommandCenter = lazy(() => import('./pages/CommandCenter').then((module) => ({ default: module.CommandCenter })));
const AccountsPage = lazy(() => import('./pages/AccountsPage').then((module) => ({ default: module.AccountsPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })));
const AssetLibrary = lazy(() => import('./pages/AssetLibrary').then((module) => ({ default: module.AssetLibrary })));
const CampaignStrategyPage = lazy(() => import('./pages/CampaignStrategyPage').then((module) => ({ default: module.CampaignStrategyPage })));
const CharacterLibrary = lazy(() => import('./pages/CharacterLibrary').then((module) => ({ default: module.CharacterLibrary })));
const ContentWorkspacePage = lazy(() => import('./pages/ContentWorkspacePage').then((module) => ({ default: module.ContentWorkspacePage })));
const ContentIntelligence = lazy(() => import('./pages/ContentIntelligence').then((module) => ({ default: module.ContentIntelligence })));
const DailyReport = lazy(() => import('./pages/DailyReport').then((module) => ({ default: module.DailyReport })));
const PublishQueuePage = lazy(() => import('./pages/PublishQueuePage').then((module) => ({ default: module.PublishQueuePage })));
const PromptLibrary = lazy(() => import('./pages/PromptLibrary').then((module) => ({ default: module.PromptLibrary })));
const AIWorksPage = lazy(() => import('./pages/AIWorksPage').then((module) => ({ default: module.AIWorksPage })));
const PlatformConnectionsPage = lazy(() => import('./pages/PlatformConnectionsPage').then((module) => ({ default: module.PlatformConnectionsPage })));
const SystemOverviewPage = lazy(() => import('./pages/SystemOverviewPage').then((module) => ({ default: module.SystemOverviewPage })));
const WorkflowModelConfigPage = lazy(() => import('./pages/WorkflowModelConfigPage').then((module) => ({ default: module.WorkflowModelConfigPage })));
const KnowledgeVaultPage = lazy(() => import('./pages/KnowledgeVaultPage').then((module) => ({ default: module.KnowledgeVaultPage })));

const pageTitles = {
  dashboard: 'AI 运营指挥中心',
  campaigns: '运营活动与策略',
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

pageTitles.prompts = '提示词库';

export default function App() {
  const { page: activePage, detailId, navigate } = useAppRoute();
  const { error: authError, loading: authLoading, session, userId } = useAuth();

  const page = useMemo(() => {
    const props = { userId, onNavigate: navigate, detailId };

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
      case 'prompts':
        return <PromptLibrary {...props} />;
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
  }, [activePage, detailId, navigate, userId]);

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={navigate} />
      <div className="main-shell">
        <Header title={pageTitles[activePage] || pageTitles.dashboard} />
        {authLoading && <div className="notice">正在恢复登录状态...</div>}
        {authError && !session && <div className="notice error">{authError}</div>}
        <Suspense fallback={<div className="notice">正在加载页面...</div>}>{page}</Suspense>
      </div>
    </div>
  );
}
