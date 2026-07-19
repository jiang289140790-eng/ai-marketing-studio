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

export async function buildDataExport(userId) {
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
    contents,
    assets,
    workflows,
    campaigns,
    metrics,
    strategies,
    tool_usage: toolUsage,
  };
}

export async function buildDailyReport(userId) {
  const [contents, workflows, viralContents, publishTasks, campaigns, metrics, costs, toolUsage, notifications, strategies] = await Promise.all([
    listContent(userId),
    listWorkflowRuns(userId),
    listViralContents(userId),
    getPublishHistory(userId),
    listCampaignLinks(userId),
    listContentMetrics(userId),
    listCostRecords(userId),
    listToolUsage(userId),
    listNotifications(userId),
    listContentStrategies(userId),
  ]);

  const yesterday = getRelativeDate(-1);
  const today = getRelativeDate(0);
  const yesterdayWorkflows = byDate(workflows, 'created_at', yesterday);
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

  return {
    date: today,
    report_for: yesterday,
    discovered_content: yesterdayDiscovered.length,
    generated_content: yesterdayWorkflows.length + yesterdayContents.filter((item) => ['draft', 'generating', 'review'].includes(item.pipeline_stage || item.status)).length,
    published_content: yesterdayPublished.length,
    metrics_collected: yesterdayMetrics.length,
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
    recommendations: latestStrategy?.recommendations || [
      '把昨日互动最高的内容拆成 Hook、结构、视觉和 CTA，沉淀为 Prompt 模板。',
      '将适合度高的爆款内容转为 Content Idea，交给内容生成 Agent 做 3 个变体。',
      '优先处理 System Health 中的失败发布、失败采集和失败 Workflow。',
      '记录每次 GPT、图片、视频、API 调用成本，观察单条内容成本是否下降。',
    ],
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
