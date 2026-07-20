import { useEffect, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { listSocialAccounts } from '../services/account-service';
import { getAgentStats, listAgents, listAgentTasks } from '../services/agent-service';
import { listAssets } from '../services/asset-service';
import { getAutomationStats, getJobHistory, listJobs } from '../services/automation-service';
import { listCollectionRuns, listCollectionTasks, listSources } from '../services/collector-service';
import { listContent, listPublishTasks } from '../services/content-service';
import { getIntelligenceStats } from '../services/intelligence-service';
import { listCampaignLinks, listContentMetrics, listPublishMetrics, summarizeConversions, summarizePerformance } from '../services/performance-service';
import { listCostRecords, listNotifications, listToolUsage, summarizeCosts, summarizeToolUsage } from '../services/stability-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { getWorkflowStats, listWorkflowRuns } from '../services/workflow-service';

export function Dashboard({ userId, onNavigate }) {
  const [stats, setStats] = useState({
    accounts: 0,
    apiConnected: 0,
    contentIdeas: 0,
    generating: 0,
    review: 0,
    scheduled: 0,
    published: 0,
    analyzing: 0,
    assets: 0,
    todayWorkflowRuns: 0,
    workflowSuccessRate: 0,
    agents: 0,
    runningAgentTasks: 0,
    agentTaskSuccessRate: 0,
    topIntelligencePlatform: '-',
    topCompetitorAccount: '-',
    viralContents: 0,
    contentAnalyses: 0,
    collectorSources: 0,
    collectorRuns: 0,
    automationJobs: 0,
    automationTodayRuns: 0,
    automationFailedRuns: 0,
    pendingPublish: 0,
    topContent: '-',
    topAccount: '-',
    platformRoi: 0,
    metricRows: 0,
    todayCost: 0,
    todayAiCost: 0,
    monthCost: 0,
    averageContentCost: 0,
    unreadNotifications: 0,
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;

    async function loadStats() {
      setLoading(true);
      try {
        const [
          accounts,
          content,
          publishTasks,
          assets,
          workflowRuns,
          agents,
          agentTasks,
          intelligenceStats,
          collectorSources,
          _collectorTasks,
          collectorRuns,
          automationJobs,
          automationRuns,
          contentMetrics,
          publishMetrics,
          campaignLinks,
          costRecords,
          toolUsage,
          notifications,
        ] = await Promise.all([
          listSocialAccounts(userId),
          listContent(userId),
          listPublishTasks(userId),
          listAssets(userId),
          listWorkflowRuns(userId),
          listAgents(userId),
          listAgentTasks(userId),
          getIntelligenceStats(userId),
          listSources(userId),
          listCollectionTasks(userId),
          listCollectionRuns(userId),
          listJobs(userId),
          getJobHistory(userId),
          listContentMetrics(userId),
          listPublishMetrics(userId),
          listCampaignLinks(userId),
          listCostRecords(userId),
          listToolUsage(userId),
          listNotifications(userId),
        ]);

        const workflowStats = getWorkflowStats(workflowRuns);
        const agentStats = getAgentStats(agents, agentTasks);
        const automationStats = getAutomationStats(automationJobs, automationRuns);
        const performanceStats = summarizePerformance(contentMetrics, publishMetrics);
        const conversionStats = summarizeConversions(campaignLinks);
        const costStats = summarizeCosts(costRecords);
        const toolStats = summarizeToolUsage(toolUsage, content);

        setStats({
          accounts: accounts.length,
          apiConnected: accounts.filter((account) => account.api_status === 'connected').length,
          contentIdeas: content.filter((item) => (item.pipeline_stage || item.status) === 'idea').length,
          generating: content.filter((item) => (item.pipeline_stage || item.status) === 'generating').length,
          review: content.filter((item) => (item.pipeline_stage || item.status) === 'review').length,
          scheduled: content.filter((item) => (item.pipeline_stage || item.status) === 'scheduled').length,
          published: content.filter((item) => (item.pipeline_stage || item.status) === 'published').length,
          analyzing: content.filter((item) => (item.pipeline_stage || item.status) === 'analyzing').length,
          assets: assets.length,
          todayWorkflowRuns: workflowStats.todayRuns,
          workflowSuccessRate: workflowStats.successRate,
          agents: agentStats.totalAgents,
          runningAgentTasks: agentStats.runningTasks,
          agentTaskSuccessRate: agentStats.successRate,
          topIntelligencePlatform: intelligenceStats.topPlatform || '-',
          topCompetitorAccount: intelligenceStats.topAccount || '-',
          viralContents: intelligenceStats.viralContents,
          contentAnalyses: intelligenceStats.analyses,
          collectorSources: collectorSources.length,
          collectorRuns: collectorRuns.length,
          automationJobs: automationStats.jobs,
          automationTodayRuns: automationStats.todayRuns,
          automationFailedRuns: automationStats.failedRuns,
          pendingPublish: publishTasks.filter((task) => ['draft', 'scheduled', 'publishing'].includes(task.status)).length,
          topContent: performanceStats.topContentTitle || '-',
          topAccount: performanceStats.topAccount || '-',
          platformRoi: conversionStats.revenuePerClick || performanceStats.platformRoi,
          metricRows: performanceStats.metricsCount,
          todayCost: costStats.todayCost,
          todayAiCost: toolStats.todayAiCost,
          monthCost: toolStats.monthCost || costStats.totalCost,
          averageContentCost: toolStats.averageContentCost,
          unreadNotifications: notifications.filter((item) => item.status === 'unread').length,
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
        <EmptyState
          title="等待 Supabase 配置"
          description="复制 .env.example 为 .env.local，填写 Supabase URL 和 anon/publishable key 后，即可启用真实数据库数据。"
        />
      </section>
    );
  }

  if (!userId) {
    return (
      <section className="page-stack">
        <div className="hero-panel">
          <p className="eyebrow">Personal AI Ops Workspace</p>
          <h2>请先登录你的个人运营工作台</h2>
          <p>
            登录后，Dashboard 会从 Supabase 读取你的账号矩阵、内容库、素材、Agent、发布任务、效果分析和成本数据。
          </p>
        </div>
        <EmptyState
          title="等待 GitHub 登录"
          description="点击右上角 GitHub 登录。授权成功返回后，这里会显示你的真实运营数据。"
        />
      </section>
    );
  }

  const value = (number) => (loading ? '-' : number);
  const money = (number) => (loading ? '-' : Number(number || 0).toFixed(4));

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">Personal AI Ops Workspace</p>
        <h2>你的个人 AI 内容运营控制台</h2>
        <p>
          围绕“情报发现 → AI 分析 → 内容生成 → 素材生成 → 发布 → 数据采集 → 效果分析 → 策略优化”的每日运营闭环。
        </p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('intelligence')}>发现内容机会</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('agents')}>运行 AI Agent</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('content')}>推进内容 Pipeline</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('publish')}>打开发布中心</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('report')}>查看运营日报</button>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="账号矩阵" value={value(stats.accounts)} hint={`${stats.apiConnected} 个账号 API 已连接`} />
        <StatCard label="内容机会" value={value(stats.viralContents)} hint={`AI 分析 ${stats.contentAnalyses} 条`} />
        <StatCard label="待生成" value={value(stats.contentIdeas + stats.generating)} hint="idea + generating" />
        <StatCard label="待审核" value={value(stats.review)} hint="review pipeline" />
        <StatCard label="待发布" value={value(stats.pendingPublish)} hint="Publish Center" />
        <StatCard label="已发布" value={value(stats.published)} hint="published content" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="今日 AI 成本" value={money(stats.todayAiCost)} hint="tool_usage 今日" />
        <StatCard label="今日运营成本" value={money(stats.todayCost)} hint="cost_records 今日" />
        <StatCard label="本月成本" value={money(stats.monthCost)} hint="个人运营成本" />
        <StatCard label="单条内容成本" value={money(stats.averageContentCost)} hint="本月成本 / 内容数" />
        <StatCard label="素材数量" value={value(stats.assets)} hint="assets" />
        <StatCard label="未读提醒" value={value(stats.unreadNotifications)} hint="失败任务和系统提醒" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="今日生成任务" value={value(stats.todayWorkflowRuns)} hint="workflow_runs" />
        <StatCard label="Workflow 成功率" value={loading ? '-' : `${stats.workflowSuccessRate}%`} hint="success / total" />
        <StatCard label="Agent 数量" value={value(stats.agents)} hint="三个核心 Agent" />
        <StatCard label="Agent 运行中" value={value(stats.runningAgentTasks)} hint="agent_tasks running" />
        <StatCard label="Agent 成功率" value={loading ? '-' : `${stats.agentTaskSuccessRate}%`} hint="success / total" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="热门情报平台" value={loading ? '-' : stats.topIntelligencePlatform} hint="爆款内容来源" />
        <StatCard label="热门参考账号" value={loading ? '-' : stats.topCompetitorAccount} hint="内容机会来源" />
        <StatCard label="采集源" value={value(stats.collectorSources)} hint="content_sources" />
        <StatCard label="采集运行" value={value(stats.collectorRuns)} hint="collection_runs" />
        <StatCard label="自动化任务" value={value(stats.automationJobs)} hint="automation_jobs" />
        <StatCard label="失败运行" value={value(stats.automationFailedRuns)} hint="需要处理" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="最佳内容" value={loading ? '-' : stats.topContent} hint="按表现分数" />
        <StatCard label="最佳账号类型" value={loading ? '-' : stats.topAccount} hint="按转化 / 互动" />
        <StatCard label="个人 ROI" value={value(stats.platformRoi)} hint="效果值 / 点击" />
        <StatCard label="表现数据" value={value(stats.metricRows)} hint="content_metrics" />
        <StatCard label="分析中内容" value={value(stats.analyzing)} hint="analyzing pipeline" />
        <StatCard label="今日自动运行" value={value(stats.automationTodayRuns)} hint="automation_runs" />
      </div>
    </section>
  );
}
