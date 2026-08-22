import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { AuxiliaryPageFrame } from './components/AuxiliaryPageFrame';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { CampaignContextBar } from './components/CampaignContextBar';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { useAuth } from './contexts/auth-context';
import { useCampaignContext } from './contexts/campaign-context';
import { useAppRoute } from './utils/app-route';

const AccountsPage = lazy(() => import('./pages/AccountsPage').then((module) => ({ default: module.AccountsPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })));
const DataAnalyticsPage = lazy(() => import('./pages/DataAnalyticsPage').then((module) => ({ default: module.DataAnalyticsPage })));
const AssetLibrary = lazy(() => import('./pages/AssetLibrary').then((module) => ({ default: module.AssetLibrary })));
const CampaignStrategyPage = lazy(() => import('./pages/CampaignStrategyPage').then((module) => ({ default: module.CampaignStrategyPage })));
const CharacterLibrary = lazy(() => import('./pages/CharacterLibrary').then((module) => ({ default: module.CharacterLibrary })));
const ContentWorkspacePage = lazy(() => import('./pages/ContentWorkspacePage').then((module) => ({ default: module.ContentWorkspacePage })));
const ContentIntelligence = lazy(() => import('./pages/ContentIntelligence').then((module) => ({ default: module.ContentIntelligence })));
const DailyReport = lazy(() => import('./pages/DailyReport').then((module) => ({ default: module.DailyReport })));
const PublishQueuePage = lazy(() => import('./pages/PublishQueuePage').then((module) => ({ default: module.PublishQueuePage })));
const PromptLibrary = lazy(() => import('./pages/PromptLibrary').then((module) => ({ default: module.PromptLibrary })));
const GenerationTasksPage = lazy(() => import('./pages/GenerationTasksPage').then((module) => ({ default: module.GenerationTasksPage })));
const PlatformConnectionsPage = lazy(() => import('./pages/PlatformConnectionsPage').then((module) => ({ default: module.PlatformConnectionsPage })));
const SystemOverviewPage = lazy(() => import('./pages/SystemOverviewPage').then((module) => ({ default: module.SystemOverviewPage })));
const WorkflowModelConfigPage = lazy(() => import('./pages/WorkflowModelConfigPage').then((module) => ({ default: module.WorkflowModelConfigPage })));
const KnowledgeVaultPage = lazy(() => import('./pages/KnowledgeVaultPage').then((module) => ({ default: module.KnowledgeVaultPage })));
const ResearchWorkspacePage = lazy(() => import('./pages/ResearchWorkspacePage').then((module) => ({ default: module.ResearchWorkspacePage })));
const AIWorkspacePage = lazy(() => import('./pages/AIWorkspacePage').then((module) => ({ default: module.AIWorkspacePage })));

const PRIMARY_WORKSPACE_PAGES = new Set(['ai', 'research', 'generation', 'knowledge', 'connections']);

const pageTitles = {
  ai: 'AI 工作台',
  dashboard: 'AI 工作台',
  campaigns: '运营活动',
  plan: '内容计划',
  research: '研究工作台',
  workspace: '内容工作台',
  intelligence: '内容情报',
  publish: '发布队列',
  accounts: '账号矩阵',
  assets: '素材库',
  characters: '角色库',
  generation: '生成工作台',
  'data-analytics': '数据分析',
  analytics: 'AI 复盘',
  dailyreport: '运营日报',
  knowledge: '知识库',
  connections: '平台连接',
  health: '系统状态',
  workflows: '工作流与模型',
};

pageTitles.prompts = '提示词库';

const auxiliaryPageDescriptions = {
  accounts: '维护运营账号、竞品与灵感账号，作为运营活动的统一账号来源。',
  characters: '维护持续生成身份、角色设定与角色模型绑定，供内容生产直接复用。',
  assets: '管理当前运营活动已上传或生成的真实图片、视频、音频与文件成果。',
  prompts: '沉淀可复用的文案与视觉提示词，服务当前账号和内容生产。',
  connections: '查看当前账号的平台授权、执行能力和真实阻塞。',
  workflows: '查看当前运营活动可调用的生成工作流、模型与最近执行记录。',
  health: '只展示真正影响当前运营活动的运行异常和待处理问题。',
  'data-analytics': '展示当前运营活动真实发生的指标，不解释原因。',
  analytics: '解释当前运营活动为什么出现这些结果，并给出待审核建议。',
  dailyreport: '汇总昨天完成、今天待办、执行异常与下一步行动。',
  knowledge: '沉淀当前账号、内容、策略与复盘知识，供后续智能体复用。',
  generation: '用一句话生成图片或视频，确认报价后查看实时进度、成品和版本历史。',
};

export default function App() {
  const { page: activePage, detailId, routeParams, navigate } = useAppRoute();
  const { error: authError, loading: authLoading, session, userId } = useAuth();
  const campaignState = useCampaignContext();
  const contextPages = new Set(['campaigns', 'plan', 'workspace', 'intelligence', 'assets', 'publish', 'data-analytics', 'analytics']);
  const auxiliaryDescription = auxiliaryPageDescriptions[activePage] || '';
  const useAuxiliaryFrame = Boolean(auxiliaryDescription) && !PRIMARY_WORKSPACE_PAGES.has(activePage);
  const [auxiliaryScope, setAuxiliaryScope] = useState('campaign');
  const [auxiliaryMode, setAuxiliaryMode] = useState('normal');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem('ams-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });

  function updateSidebarCollapsed(nextValue) {
    const collapsed = Boolean(nextValue);
    setSidebarCollapsed(collapsed);
    try {
      globalThis.localStorage?.setItem('ams-sidebar-collapsed', String(collapsed));
    } catch {
      // The layout remains usable when browser storage is unavailable.
    }
  }

  useEffect(() => {
    setAuxiliaryScope('campaign');
    setAuxiliaryMode('normal');
  }, [activePage]);

  const page = useMemo(() => {
    const props = {
      userId,
      onNavigate: navigate,
      detailId,
      routeParams,
      activeCampaignId: campaignState.activeCampaignId,
      campaignContext: campaignState.campaignContext,
      refreshCampaignContext: campaignState.refreshCampaignContext,
      dataScope: auxiliaryScope,
      auxiliaryMode,
    };

    switch (activePage) {
      case 'ai':
        return <AIWorkspacePage {...props} />;
      case 'campaigns':
        return <CampaignStrategyPage {...props} />;
      case 'plan':
        return <CampaignStrategyPage {...props} />;
      case 'research':
        return <ResearchWorkspacePage {...props} />;
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
      case 'generation':
        return <GenerationTasksPage {...props} />;
      case 'data-analytics':
        return <DataAnalyticsPage {...props} />;
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
        return <AIWorkspacePage {...props} />;
    }
  }, [activePage, auxiliaryMode, auxiliaryScope, campaignState.activeCampaignId, campaignState.campaignContext, campaignState.refreshCampaignContext, detailId, navigate, routeParams, userId]);

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        activePage={activePage}
        collapsed={sidebarCollapsed}
        onCollapsedChange={updateSidebarCollapsed}
        onNavigate={navigate}
      />
      <div className="main-shell">
        <Header description={auxiliaryDescription} title={pageTitles[activePage] || pageTitles.dashboard} />
        {userId && contextPages.has(activePage) && !auxiliaryDescription && <CampaignContextBar onNavigate={navigate} />}
        {authLoading && <div className="notice">正在恢复登录状态...</div>}
        {authError && !session && <div className="notice error">{authError}</div>}
        <PageErrorBoundary resetKey={`${activePage}:${detailId || ''}`} onNavigate={navigate}>
          <Suspense fallback={<div className="notice">正在加载页面...</div>}>
            {useAuxiliaryFrame ? (
              <AuxiliaryPageFrame
                dataScope={auxiliaryScope}
                description={auxiliaryDescription}
                mode={auxiliaryMode}
                onModeChange={setAuxiliaryMode}
                onNavigate={navigate}
                onScopeChange={setAuxiliaryScope}
              >
                <div key={`${activePage}:${auxiliaryScope}:${campaignState.activeCampaignId}`}>{page}</div>
              </AuxiliaryPageFrame>
            ) : page}
          </Suspense>
        </PageErrorBoundary>
      </div>
    </div>
  );
}
