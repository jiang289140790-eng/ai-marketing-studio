import { requireSupabase } from './supabase-client';
import { generateAI } from './ai-gateway-service';

const defaultAccountIntelligenceModel = 'deepseek-chat';
const defaultStrategyModel = 'deepseek-chat';

export async function listSocialAccounts(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('social_accounts')
    .select('*, account_profiles(*), platform_connections(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createSocialAccount(userId, payload) {
  const client = requireSupabase();
  const accountRole = payload.account_role || payload.account_type || payload.account_category || 'owned';
  const { data, error } = await client
    .from('social_accounts')
    .insert({
      ...payload,
      user_id: userId,
      username: payload.username || payload.account_name,
      account_name: payload.account_name || payload.username,
      account_role: accountRole,
      account_type: accountRole,
      account_category: accountRole,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSocialAccount(id, payload) {
  const client = requireSupabase();
  const accountRole = payload.account_role || payload.account_type || payload.account_category;
  const update = {
    ...payload,
    username: payload.username || payload.account_name,
    account_name: payload.account_name || payload.username,
  };
  if (accountRole) {
    update.account_role = accountRole;
    update.account_type = accountRole;
    update.account_category = accountRole;
  }
  const { data, error } = await client.from('social_accounts').update(update).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSocialAccount(id) {
  const client = requireSupabase();
  const { error } = await client.from('social_accounts').delete().eq('id', id);
  if (error) throw error;
}

export async function listAccountProfiles(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('account_profiles')
    .select('*, social_accounts(account_name,username,platform,account_role)')
    .eq('user_id', userId)
    .order('last_analyzed_at', { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data || [];
}

export async function upsertAccountProfile(userId, accountId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('account_profiles')
    .upsert({
      user_id: userId,
      account_id: accountId,
      ...payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,account_id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function analyzeAccountWithAI(userId, accountId) {
  const client = requireSupabase();
  const { data: account, error: accountError } = await client
    .from('social_accounts')
    .select('*, account_profiles(*)')
    .eq('user_id', userId)
    .eq('id', accountId)
    .single();
  if (accountError) throw accountError;

  const { data: viralContents, error: viralError } = await client
    .from('viral_contents')
    .select('id,title,platform,url,content_text,views,likes,comments,engagement_score,viral_reason,ai_recommendation,published_at')
    .eq('user_id', userId)
    .eq('social_account_id', accountId)
    .order('engagement_score', { ascending: false })
    .limit(12);
  if (viralError) throw viralError;

  const agent = await getOrCreateAccountIntelligenceAgent(client, userId);
  const startedAt = Date.now();
  const prompt = buildAccountIntelligencePrompt(account, viralContents || []);
  const run = await createAccountAgentRun(client, userId, agent, {
    account_id: account.id,
    prompt,
    sample_count: viralContents?.length || 0,
  });

  try {
    const gateway = await generateAI({
      agent_name: 'Account Intelligence Agent',
      task: 'account_profile',
      prompt,
      model: agent.model || defaultAccountIntelligenceModel,
      parameters: { temperature: 0.3 },
    });
    const parsed = parseAccountProfile(gateway.content);
    const duration = Number(gateway.duration || Math.max(0, Date.now() - startedAt));
    const profile = await upsertAccountProfile(userId, account.id, {
      ...parsed,
      analysis_result: {
        source: 'account_intelligence_agent',
        account_id: account.id,
        sample_count: viralContents?.length || 0,
        raw_content: gateway.content,
        usage: gateway.usage || {},
      },
      source_content_ids: (viralContents || []).map((item) => item.id),
      model: gateway.model || agent.model || defaultAccountIntelligenceModel,
      cost: Number(gateway.cost || 0),
      duration_ms: duration,
      confidence_score: Number(parsed.confidence_score || 75),
      last_analyzed_at: new Date().toISOString(),
    });

    await updateSocialAccount(account.id, {
      target_audience: profile.target_audience || account.target_audience,
      content_strategy: profile.content_direction || account.content_strategy,
      posting_frequency: profile.posting_frequency || account.posting_frequency,
    });

    await updateAccountAgentRun(client, run.id, 'success', {
      output: { account_profile_id: profile.id, profile },
      cost: Number(gateway.cost || 0),
      duration,
    });

    return { account, profile, model: gateway.model, cost: Number(gateway.cost || 0), duration };
  } catch (error) {
    await updateAccountAgentRun(client, run.id, 'failed', {
      output: {},
      error_message: error.message,
      duration: Math.max(0, Date.now() - startedAt),
    });
    throw error;
  }
}

export async function generateDailyStrategy(userId, accountId = null) {
  const client = requireSupabase();
  const [accountsResult, metricsResult, viralResult] = await Promise.all([
    client
      .from('social_accounts')
      .select('*, account_profiles(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),
    client
      .from('content_metrics')
      .select('*')
      .eq('user_id', userId)
      .order('collected_at', { ascending: false })
      .limit(30),
    client
      .from('viral_contents')
      .select('id,title,platform,content_text,views,likes,comments,engagement_score,viral_reason,ai_recommendation,social_accounts:social_account_id(account_name,username,platform,account_role)')
      .eq('user_id', userId)
      .order('engagement_score', { ascending: false })
      .limit(20),
  ]);
  if (accountsResult.error) throw accountsResult.error;
  if (metricsResult.error) throw metricsResult.error;
  if (viralResult.error) throw viralResult.error;

  const accounts = accountId ? (accountsResult.data || []).filter((account) => account.id === accountId) : (accountsResult.data || []);
  const agent = await getOrCreateStrategyAgent(client, userId);
  const startedAt = Date.now();
  const prompt = buildDailyStrategyPrompt(accounts, metricsResult.data || [], viralResult.data || []);
  const run = await createAccountAgentRun(client, userId, agent, {
    account_id: accountId,
    prompt,
    accounts: accounts.map((account) => account.id),
  });

  try {
    const gateway = await generateAI({
      agent_name: 'Strategy Agent',
      task: 'daily_strategy',
      prompt,
      model: agent.model || defaultStrategyModel,
      parameters: { temperature: 0.35 },
    });
    const dailyStrategy = parseDailyStrategy(gateway.content);
    const duration = Number(gateway.duration || Math.max(0, Date.now() - startedAt));
    const { data, error } = await client
      .from('content_strategies')
      .insert({
        user_id: userId,
        title: `Daily Ops Strategy ${new Date().toISOString().slice(0, 10)}`,
        source: 'strategy-agent',
        strategy_type: 'daily_strategy',
        account_id: accountId,
        strategy_date: new Date().toISOString().slice(0, 10),
        input_data: {
          accounts_count: accounts.length,
          metrics_count: metricsResult.data?.length || 0,
          viral_contents_count: viralResult.data?.length || 0,
          model: gateway.model,
        },
        optimization_strategy: dailyStrategy,
        daily_strategy: dailyStrategy,
      })
      .select()
      .single();
    if (error) throw error;

    await updateAccountAgentRun(client, run.id, 'success', {
      output: { content_strategy_id: data.id, daily_strategy: dailyStrategy },
      cost: Number(gateway.cost || 0),
      duration,
    });

    return { strategy: data, daily_strategy: dailyStrategy, model: gateway.model, cost: Number(gateway.cost || 0), duration };
  } catch (error) {
    await updateAccountAgentRun(client, run.id, 'failed', {
      output: {},
      error_message: error.message,
      duration: Math.max(0, Date.now() - startedAt),
    });
    throw error;
  }
}

async function getOrCreateAccountIntelligenceAgent(client, userId) {
  return getOrCreateAgent(client, userId, {
    name: 'Account Intelligence Agent',
    type: 'analysis',
    description: 'Analyze a social account and generate target audience, content direction, style, positioning, and AI operating strategy.',
    system_prompt: 'You are an AI social account strategist for a personal AI ops workspace.',
    model: defaultAccountIntelligenceModel,
  });
}

async function getOrCreateStrategyAgent(client, userId) {
  return getOrCreateAgent(client, userId, {
    name: 'Strategy Agent',
    type: 'strategy',
    description: 'Generate daily operating strategy from account profiles, viral intelligence, and performance data.',
    system_prompt: 'You are a practical AI operations strategist. Create concrete daily social content plans.',
    model: defaultStrategyModel,
  });
}

async function getOrCreateAgent(client, userId, definition) {
  const { data: existing, error: existingError } = await client
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .eq('name', definition.name)
    .order('created_at', { ascending: true })
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.[0]) return existing[0];

  const { data, error } = await client
    .from('agents')
    .insert({
      user_id: userId,
      name: definition.name,
      description: definition.description,
      type: definition.type,
      model: definition.model,
      system_prompt: definition.system_prompt,
      status: 'active',
      schedule: { mode: 'manual' },
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function createAccountAgentRun(client, userId, agent, input) {
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      agent_name: agent.name,
      input,
      status: 'running',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateAccountAgentRun(client, runId, status, payload = {}) {
  const update = {
    status,
    output: payload.output || {},
    cost: Number(payload.cost || 0),
    duration: Number(payload.duration || 0),
    error_message: payload.error_message || null,
  };
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();
  const { error } = await client.from('agent_runs').update(update).eq('id', runId);
  if (error) throw error;
}

function buildAccountIntelligencePrompt(account, viralContents) {
  const samples = viralContents.map((item, index) => [
    `#${index + 1}`,
    `标题：${item.title || ''}`,
    `正文：${item.content_text || ''}`,
    `数据：views=${item.views || 0}, likes=${item.likes || 0}, comments=${item.comments || 0}, score=${item.engagement_score || 0}`,
    `爆款原因：${item.viral_reason || ''}`,
  ].join('\n')).join('\n\n');

  return [
    '你是我的个人 AI 内容运营账号分析 Agent。',
    '请基于账号基础信息和已采集内容，输出严格 JSON，不要输出 Markdown。',
    '',
    'JSON 字段：',
    '{',
    '  "target_audience": "目标用户",',
    '  "content_direction": "内容方向",',
    '  "content_style": "整体内容风格",',
    '  "visual_style": "视觉风格",',
    '  "copywriting_style": "文案风格",',
    '  "posting_frequency": "建议发布频率",',
    '  "best_posting_windows": ["建议发布时间段"],',
    '  "viral_patterns": ["爆款规律"],',
    '  "brand_positioning": "品牌定位",',
    '  "ai_strategy": "AI运营策略",',
    '  "operation_advice": "运营建议",',
    '  "analysis_summary": "总结",',
    '  "confidence_score": 0',
    '}',
    '',
    `平台：${account.platform}`,
    `账号：${account.username || account.account_name}`,
    `URL：${account.account_url || ''}`,
    `账号角色：${account.account_role || account.account_type || account.account_category}`,
    `用户手动备注：${account.ops_notes || ''}`,
    `已有目标用户：${account.target_audience || ''}`,
    `已有内容方向：${account.content_strategy || ''}`,
    '',
    '已采集内容样本：',
    samples || '暂无采集样本。请基于账号信息生成一个保守的初始画像，并标注信心较低。',
  ].join('\n');
}

function parseAccountProfile(content) {
  const parsed = parseJsonish(content);
  const bestPostingWindows = Array.isArray(parsed.best_posting_windows) ? parsed.best_posting_windows : [];
  const viralPatterns = Array.isArray(parsed.viral_patterns) ? parsed.viral_patterns : [];
  return {
    target_audience: String(parsed.target_audience || ''),
    content_direction: String(parsed.content_direction || ''),
    content_style: String(parsed.content_style || ''),
    visual_style: String(parsed.visual_style || ''),
    copywriting_style: String(parsed.copywriting_style || ''),
    posting_frequency: String(parsed.posting_frequency || ''),
    best_posting_windows: bestPostingWindows.map(String),
    viral_patterns: viralPatterns.map(String),
    brand_positioning: String(parsed.brand_positioning || ''),
    ai_strategy: String(parsed.ai_strategy || ''),
    operation_advice: String(parsed.operation_advice || ''),
    analysis_summary: String(parsed.analysis_summary || parsed.summary || ''),
    confidence_score: Number(parsed.confidence_score || 70),
  };
}

function buildDailyStrategyPrompt(accounts, metrics, viralContents) {
  return [
    '你是我的个人 AI 运营 Strategy Agent。',
    '请根据账号画像、近期内容表现、爆款情报，生成今天的运营策略。输出严格 JSON，不要输出 Markdown。',
    '',
    'JSON 字段：',
    '{',
    '  "date": "YYYY-MM-DD",',
    '  "summary": "今日策略摘要",',
    '  "platform_plan": [{"platform":"X","tasks":["3条AI趋势内容"]}],',
    '  "content_tasks": ["内容任务"],',
    '  "asset_tasks": ["素材任务"],',
    '  "publish_plan": ["发布计划"],',
    '  "analysis_focus": ["今天要观察的数据"],',
    '  "recommendations": ["优化建议"],',
    '  "confidence_score": 0',
    '}',
    '',
    '账号画像：',
    JSON.stringify(accounts.map((account) => ({
      platform: account.platform,
      username: account.username || account.account_name,
      role: account.account_role || account.account_type || account.account_category,
      profile: account.account_profiles?.[0] || {},
    })), null, 2),
    '',
    '近期表现数据：',
    JSON.stringify(metrics.slice(0, 12), null, 2),
    '',
    '爆款情报：',
    JSON.stringify(viralContents.slice(0, 12), null, 2),
  ].join('\n');
}

function parseDailyStrategy(content) {
  const parsed = parseJsonish(content);
  return {
    date: String(parsed.date || new Date().toISOString().slice(0, 10)),
    summary: String(parsed.summary || ''),
    platform_plan: Array.isArray(parsed.platform_plan) ? parsed.platform_plan : [],
    content_tasks: Array.isArray(parsed.content_tasks) ? parsed.content_tasks : [],
    asset_tasks: Array.isArray(parsed.asset_tasks) ? parsed.asset_tasks : [],
    publish_plan: Array.isArray(parsed.publish_plan) ? parsed.publish_plan : [],
    analysis_focus: Array.isArray(parsed.analysis_focus) ? parsed.analysis_focus : [],
    recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
    confidence_score: Number(parsed.confidence_score || 70),
    raw_content: String(content || ''),
  };
}

function parseJsonish(content) {
  const text = String(content || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] || text.slice(Math.max(0, text.indexOf('{')), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch {
    return { analysis_summary: text, summary: text };
  }
}
