import { requireSupabase } from './supabase-client';

const COMMAND_CENTER_TABLES = {
  campaigns: 'campaigns',
  strategies: 'strategy_plans',
  contentPackages: 'content_packages',
  contentLibrary: 'content_library',
  publishTasks: 'publish_tasks',
  contentMetrics: 'content_metrics',
  knowledgeEntries: 'knowledge_entries',
  contentMemory: 'content_memory',
  strategyMemory: 'strategy_memory',
  assets: 'assets',
  assetLibrary: 'asset_library',
  characters: 'characters',
  accounts: 'social_accounts',
  platformConnections: 'platform_connections',
  accountReports: 'account_intelligence_reports',
  accountProfiles: 'account_profiles',
  agentRuns: 'agent_runs',
  workflowRuns: 'workflow_runs',
  viralContents: 'viral_contents',
  contentAnalysis: 'content_analysis',
};

export async function readOpsTable(table, options = {}) {
  const client = requireSupabase();
  const limit = options.limit || 80;
  const orderBy = options.orderBy || 'created_at';
  const ascending = Boolean(options.ascending);

  let query = client.from(table).select('*').limit(limit);

  if (options.eq) {
    query = query.eq(options.eq[0], options.eq[1]);
  }

  if (orderBy) {
    query = query.order(orderBy, { ascending });
  }

  const { data, error } = await query;

  if (error) {
    return [];
  }

  return data || [];
}

export async function loadCommandCenterData() {
  const entries = await Promise.all(
    Object.entries(COMMAND_CENTER_TABLES).map(async ([key, table]) => {
      const data = await readOpsTable(table);
      return [key, data];
    }),
  );

  return Object.fromEntries(entries);
}

export function getContentRows(data) {
  return [...(data.contentPackages || []), ...(data.contentLibrary || [])];
}

export function getAssetRows(data) {
  return [...(data.assets || []), ...(data.assetLibrary || [])];
}

export function getKnowledgeRows(data) {
  return [
    ...(data.knowledgeEntries || []),
    ...(data.contentMemory || []),
    ...(data.strategyMemory || []),
    ...(data.accountReports || []),
    ...(data.accountProfiles || []),
  ];
}

export function latestRows(rows, count = 5) {
  return [...(rows || [])]
    .sort((a, b) => new Date(b.created_at || b.updated_at || 0) - new Date(a.created_at || a.updated_at || 0))
    .slice(0, count);
}

export function countBy(rows, predicate) {
  return (rows || []).filter(predicate).length;
}
