import { listAssets } from './asset-service';
import { listContent } from './content-service';
import { listViralContents } from './intelligence-service';
import {
  listCampaignLinks,
  listContentMetrics,
  listContentStrategies,
  summarizeConversions,
  summarizePerformance,
} from './performance-service';
import { listCostRecords, listNotifications, listToolUsage, summarizeCosts, summarizeToolUsage } from './stability-service';
import { getPublishHistory } from './publish-service';
import { listWorkflowRuns } from './workflow-service';
import { listAgentRuns } from './agent-service';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';

export async function buildDataExport(userId, scopeOptions = {}) {
  const [contents, assets, workflows, campaigns, metrics, strategies, toolUsage] = await Promise.all([
    listContent(userId),
    listAssets(userId),
    listWorkflowRuns(userId),
    listCampaignLinks(userId),
    listContentMetrics(userId),
    listContentStrategies(userId),
    listToolUsage(userId),
  ]);

  return {
    exported_at: new Date().toISOString(),
    data_scope: scopeOptions.scope || 'campaign',
    contents: filterRecordsForAuxiliaryScope(contents, scopeOptions),
    assets: filterRecordsForAuxiliaryScope(assets, scopeOptions),
    workflows: filterRecordsForAuxiliaryScope(workflows, scopeOptions),
    campaigns: filterRecordsForAuxiliaryScope(campaigns, scopeOptions),
    metrics: filterRecordsForAuxiliaryScope(metrics, scopeOptions),
    strategies: filterRecordsForAuxiliaryScope(strategies, scopeOptions),
    tool_usage: filterRecordsForAuxiliaryScope(toolUsage, scopeOptions),
  };
}

export async function buildDailyReport(userId, scopeOptions = {}) {
  const rawRows = await Promise.all([
    listContent(userId),
    listWorkflowRuns(userId),
    listAgentRuns(userId),
    listViralContents(userId),
    getPublishHistory(userId),
    listCampaignLinks(userId),
    listContentMetrics(userId),
    listCostRecords(userId),
    listToolUsage(userId),
    listNotifications(userId),
    listContentStrategies(userId),
  ]);
  const [contents, workflows, agentRuns, viralContents, publishTasks, campaigns, metrics, costs, toolUsage, notifications, strategies] = rawRows
    .map((rows) => filterRecordsForAuxiliaryScope(rows, scopeOptions));

  const yesterday = getRelativeDate(-1);
  const today = getRelativeDate(0);
  const yesterdayWorkflows = byDate(workflows, 'created_at', yesterday);
  const yesterdayAgentRuns = byDate(agentRuns, 'created_at', yesterday);
  const yesterdayContents = byDate(contents, 'created_at', yesterday);
  const yesterdayDiscovered = byDate(viralContents, 'created_at', yesterday);
  const yesterdayPublished = publishTasks.filter((item) => String(item.published_at || item.created_at || '').slice(0, 10) === yesterday && item.status === 'published');
  const yesterdayMetrics = byDate(metrics, 'collected_at', yesterday);
  const yesterdayFailures = notifications.filter((item) => {
    const isYesterday = String(item.created_at || '').slice(0, 10) === yesterday;
    return isYesterday && ['unread', 'failed'].includes(item.status);
  });

  const performance = summarizePerformance(metrics);
  const conversions = summarizeConversions(campaigns);
  const costSummary = summarizeCosts(costs);
  const toolSummary = summarizeToolUsage(toolUsage, contents);
  const latestStrategy = strategies[0]?.optimization_strategy;
  const yesterdayToolCost = toolUsage
    .filter((item) => String(item.created_at || '').slice(0, 10) === yesterday)
    .reduce((sum, item) => sum + Number(item.total_cost || 0), 0);
  const campaignContext = scopeOptions.campaignContext || {};
  const blockers = [
    ...(campaignContext.blockingItems || []).map((item) => item.label || item.message || item.code),
    ...yesterdayFailures.map((item) => item.title || item.message),
  ].filter(Boolean);
  const todayActions = buildTodayActions(campaignContext, blockers);
  const yesterdayCompleted = [
    yesterdayContents.length ? `完成 ${yesterdayContents.length} 条内容处理` : '',
    yesterdayWorkflows.length ? `完成 ${yesterdayWorkflows.length} 个工作流任务` : '',
    yesterdayPublished.length ? `发布 ${yesterdayPublished.length} 条内容` : '',
    yesterdayMetrics.length ? `回收 ${yesterdayMetrics.length} 条指标` : '',
  ].filter(Boolean);
  const hasActivity = Boolean(
    yesterdayContents.length
    || yesterdayWorkflows.length
    || yesterdayAgentRuns.length
    || yesterdayDiscovered.length
    || yesterdayPublished.length
    || yesterdayMetrics.length
    || yesterdayFailures.length,
  );

  return {
    date: today,
    report_for: yesterday,
    discovered_content: yesterdayDiscovered.length,
    generated_content: yesterdayWorkflows.length + yesterdayContents.filter((item) => ['draft', 'generating', 'review'].includes(item.pipeline_stage || item.status)).length,
    published_content: yesterdayPublished.length,
    metrics_collected: yesterdayMetrics.length,
    has_activity: hasActivity,
    yesterday_completed: yesterdayCompleted,
    today_actions: todayActions,
    publish_performance: {
      published: yesterdayPublished.length,
      metrics_collected: yesterdayMetrics.length,
      best_content: performance.topContentTitle || null,
      unavailable_reason: yesterdayMetrics.length ? null : '尚无真实回传指标',
    },
    blockers,
    agent_summary: {
      total: yesterdayAgentRuns.length,
      completed: yesterdayAgentRuns.filter((item) => ['completed', 'success'].includes(String(item.status).toLowerCase())).length,
      failed: yesterdayAgentRuns.filter((item) => ['failed', 'error'].includes(String(item.status).toLowerCase())).length,
    },
    workflow_summary: {
      total: yesterdayWorkflows.length,
      completed: yesterdayWorkflows.filter((item) => ['completed', 'success'].includes(String(item.status).toLowerCase())).length,
      failed: yesterdayWorkflows.filter((item) => ['failed', 'error'].includes(String(item.status).toLowerCase())).length,
      running: yesterdayWorkflows.filter((item) => ['running', 'queued', 'pending'].includes(String(item.status).toLowerCase())).length,
    },
    best_content: performance.topContentTitle,
    best_account: performance.topAccount,
    cost: yesterdayToolCost || costSummary.todayCost,
    month_cost: toolSummary.monthCost || costSummary.totalCost,
    average_content_cost: toolSummary.averageContentCost,
    effect_value: conversions.revenue || performance.totals?.revenue || 0,
    failed_tasks: yesterdayFailures.map((item) => ({
      title: item.title,
      type: item.type,
      message: item.message,
    })),
    recommendations: hasActivity
      ? latestStrategy?.recommendations || [
        '优先处理昨日发布、采集或工作流中的真实异常。',
        '将有证据支持的表现信号带入 AI 复盘。',
        '把经人工确认的结论沉淀到知识库。',
      ]
      : todayActions,
  };
}

export function downloadJson(filename, payload) {
  const blob = new globalThis.Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = globalThis.URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  globalThis.URL.revokeObjectURL(url);
}

function byDate(items, field, date) {
  return items.filter((item) => String(item[field] || '').slice(0, 10) === date);
}

function getRelativeDate(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function buildTodayActions(context, blockers) {
  const progress = context?.progress || {};
  const actions = [];
  if (blockers.length) actions.push(`优先解除阻塞：${blockers[0]}`);
  if (!context?.currentStrategy) actions.push('生成并批准当前 Campaign 策略');
  else if ((context?.dailyPlan || []).length < 7) actions.push('生成并批准 7 天计划');
  else if (!(context?.contentPackages || []).length) actions.push('创建并开始 Day 1 内容包');
  else if (!(context?.publishTasks || []).length) actions.push('完成 Day 1 终审并创建安全预演发布任务');
  else if (!progress?.metrics) actions.push('回收 Day 1 真实发布指标');
  return actions.length ? actions : ['检查当前 Campaign 待办并推进下一步'];
}
