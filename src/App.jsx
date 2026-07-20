import { useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './contexts/auth-context';
import { AccountsPage } from './pages/AccountsPage';
import { AgentCenter } from './pages/AgentCenter';
import { AIStudio } from './pages/AIStudio';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AssetLibrary } from './pages/AssetLibrary';
import { AutomationCenter } from './pages/AutomationCenter';
import { CharacterLibrary } from './pages/CharacterLibrary';
import { CollectionCenter } from './pages/CollectionCenter';
import { ContentIntelligence } from './pages/ContentIntelligence';
import { ContentLibrary } from './pages/ContentLibrary';
import { DailyReport } from './pages/DailyReport';
import { Dashboard } from './pages/Dashboard';
import { PerformanceCenter } from './pages/PerformanceCenter';
import { PromptLibrary } from './pages/PromptLibrary';
import { PublishCenter } from './pages/PublishCenter';
import { PublishPlan } from './pages/PublishPlan';
import { SettingsPage } from './pages/SettingsPage';
import { SystemHealth } from './pages/SystemHealth';
import { WorkflowRuns } from './pages/WorkflowRuns';

const pageTitles = {
  dashboard: 'Dashboard',
  accounts: '账号管理',
  content: '内容库',
  'ai-studio': 'AI 生成',
  assets: '素材库',
  characters: '角色库',
  prompts: 'Prompt 库',
  workflows: 'Workflow Runs',
  agents: 'Agent Center',
  intelligence: '内容情报',
  collection: '采集中心',
  automation: '自动化中心',
  publish: '发布中心',
  performance: '效果分析',
  health: '系统健康',
  report: '运营日报',
  planner: '发布计划',
  analytics: '数据分析',
  settings: '设置',
};

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const { error: authError, loading: authLoading, session, userId } = useAuth();

  const page = useMemo(() => {
    const props = { userId };

    switch (activePage) {
      case 'accounts':
        return <AccountsPage {...props} />;
      case 'content':
        return <ContentLibrary {...props} />;
      case 'ai-studio':
        return <AIStudio {...props} />;
      case 'assets':
        return <AssetLibrary {...props} />;
      case 'characters':
        return <CharacterLibrary {...props} />;
      case 'prompts':
        return <PromptLibrary {...props} />;
      case 'workflows':
        return <WorkflowRuns {...props} />;
      case 'agents':
        return <AgentCenter {...props} />;
      case 'intelligence':
        return <ContentIntelligence {...props} />;
      case 'collection':
        return <CollectionCenter {...props} />;
      case 'automation':
        return <AutomationCenter {...props} />;
      case 'publish':
        return <PublishCenter {...props} />;
      case 'performance':
        return <PerformanceCenter {...props} />;
      case 'health':
        return <SystemHealth {...props} />;
      case 'report':
        return <DailyReport {...props} />;
      case 'planner':
        return <PublishPlan {...props} />;
      case 'analytics':
        return <AnalyticsPage {...props} />;
      case 'settings':
        return <SettingsPage {...props} />;
      default:
        return <Dashboard {...props} onNavigate={setActivePage} />;
    }
  }, [activePage, userId]);

  return (
    <div className="app-shell">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <div className="main-shell">
        <Header title={pageTitles[activePage]} />
        {authLoading && <div className="notice">正在恢复登录状态…</div>}
        {authError && !session && <div className="notice error">{authError}</div>}
        {page}
      </div>
    </div>
  );
}
