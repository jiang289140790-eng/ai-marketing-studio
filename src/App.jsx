import { useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
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
import { Dashboard } from './pages/Dashboard';
import { DailyReport } from './pages/DailyReport';
import { PromptLibrary } from './pages/PromptLibrary';
import { PerformanceCenter } from './pages/PerformanceCenter';
import { PublishCenter } from './pages/PublishCenter';
import { PublishPlan } from './pages/PublishPlan';
import { SettingsPage } from './pages/SettingsPage';
import { SystemHealth } from './pages/SystemHealth';
import { WorkflowRuns } from './pages/WorkflowRuns';
import { getCurrentSession, onAuthStateChange, upsertProfile } from './services/auth-service';
import { isSupabaseConfigured } from './services/supabase-client';

const pageTitles = {
  dashboard: 'Dashboard',
  accounts: '账号管理',
  content: '内容库',
  'ai-studio': 'AI生成',
  assets: '素材库',
  characters: '角色库',
  prompts: 'Prompt库',
  workflows: 'Workflow Runs',
  agents: 'Agent Center',
  intelligence: '内容情报',
  collection: '采集中心',
  automation: '自动化中心',
  publish: '发布中心',
  performance: '表现分析',
  health: '系统健康',
  report: '运营日报',
  planner: '发布计划',
  analytics: '数据分析',
  settings: '设置',
};

export default function App() {
  const [activePage, setActivePage] = useState('dashboard');
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined;

    getCurrentSession()
      .then(async (currentSession) => {
        setSession(currentSession);
        if (currentSession?.user) {
          setProfile(await upsertProfile(currentSession.user));
        }
      })
      .catch((error) => setAuthError(error.message));

    return onAuthStateChange(async (nextSession) => {
      setSession(nextSession);
      if (nextSession?.user) {
        setProfile(await upsertProfile(nextSession.user));
      } else {
        setProfile(null);
      }
    });
  }, []);

  const userId = session?.user?.id;

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
        <Header session={session} profile={profile} title={pageTitles[activePage]} />
        {authError && <div className="notice error">{authError}</div>}
        {!session && isSupabaseConfigured && (
          <div className="notice">
            请先使用 Google 登录。登录后才会从 Supabase 读取你的账号、内容、素材、角色、Prompt、Workflow 和发布任务。
          </div>
        )}
        {page}
      </div>
    </div>
  );
}
