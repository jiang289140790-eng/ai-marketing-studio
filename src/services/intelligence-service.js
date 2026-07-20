import { generateAI } from './ai-gateway-service';
import { upsertAccountProfile } from './account-service';
import { requireSupabase } from './supabase-client';

const viralContentSelect = '*, social_accounts:social_account_id(id,account_name,username,platform,account_role,target_audience,content_strategy,posting_frequency)';
const analysisSelect = '*, viral_contents(title,platform,url,views,likes,comments,content_text,published_at,viral_reason,ai_recommendation,social_accounts:social_account_id(account_name,username,platform,account_role))';
const defaultAnalysisModel = 'deepseek-chat';
const defaultContentGenerationModel = 'deepseek-chat';

async function getOrCreateAnalysisAgent(client, userId) {
  const { data: existing, error: existingError } = await client
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .eq('type', 'analysis')
    .order('created_at', { ascending: true })
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.[0]) {
    const agent = existing[0];
    if (!String(agent.model || '').toLowerCase().startsWith('deepseek')) {
      const { data, error } = await client
        .from('agents')
        .update({ model: defaultAnalysisModel })
        .eq('id', agent.id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    }
    return agent;
  }

  const { data, error } = await client
    .from('agents')
    .insert({
      user_id: userId,
      name: 'Analysis Agent',
      description: '分析爆款内容，提炼爆点、复刻策略和账号适配建议。',
      type: 'analysis',
      model: defaultAnalysisModel,
      system_prompt: 'You are a practical AI content operations analyst.',
      status: 'active',
      schedule: { mode: 'manual' },
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function createAnalysisAgentTask(client, userId, agent, viralContent, prompt) {
  const { data, error } = await client
    .from('agent_tasks')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      task_type: 'analysis',
      input_data: {
        viral_content_id: viralContent.id,
        title: viralContent.title,
        platform: viralContent.platform,
        prompt,
      },
      status: 'running',
      retry_count: 0,
      max_retry: 3,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateAnalysisAgentTask(client, taskId, status, payload = {}) {
  const update = { status };
  if (payload.result !== undefined) update.result = payload.result;
  if (payload.last_error !== undefined) update.last_error = payload.last_error;
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();
  const { error } = await client.from('agent_tasks').update(update).eq('id', taskId);
  if (error) throw error;
}

async function createAnalysisAgentRun(client, userId, agent, task, viralContent, prompt) {
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      agent_task_id: task.id,
      agent_name: agent.name,
      input: {
        viral_content_id: viralContent.id,
        title: viralContent.title,
        platform: viralContent.platform,
        prompt,
        model: agent.model,
      },
      status: 'running',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateAnalysisAgentRun(client, runId, status, payload = {}) {
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

async function getOrCreateContentGenerationAgent(client, userId) {
  const { data: existing, error: existingError } = await client
    .from('agents')
    .select('*')
    .eq('user_id', userId)
    .eq('type', 'content_generator')
    .order('created_at', { ascending: true })
    .limit(1);
  if (existingError) throw existingError;
  if (existing?.[0]) {
    const agent = existing[0];
    if (!String(agent.model || '').toLowerCase().startsWith('deepseek')) {
      const { data, error } = await client
        .from('agents')
        .update({ model: defaultContentGenerationModel })
        .eq('id', agent.id)
        .select('*')
        .single();
      if (error) throw error;
      return data;
    }
    return agent;
  }

  const { data, error } = await client
    .from('agents')
    .insert({
      user_id: userId,
      name: 'Content Generation Agent',
      description: 'Generate reusable social content drafts from saved AI analysis.',
      type: 'content_generator',
      model: defaultContentGenerationModel,
      system_prompt: 'You are a practical AI content operations writer.',
      status: 'active',
      schedule: { mode: 'manual' },
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function getOrCreateContentGenerationPrompt(client, userId, platform) {
  const preferredCategories = ['caption', 'general'];
  const { data: prompts, error } = await client
    .from('prompts')
    .select('*')
    .eq('user_id', userId)
    .in('category', preferredCategories)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const matched = (prompts || []).find((prompt) => !prompt.platform || prompt.platform === platform);
  if (matched) return matched;

  const { data, error: insertError } = await client
    .from('prompts')
    .insert({
      user_id: userId,
      title: 'Content Generation Prompt',
      category: 'caption',
      platform: platform || null,
      content: [
        '你是我的个人 AI 内容运营写作助手。',
        '请基于内容分析、账号策略和平台语境，生成一条可以进入内容库审核的社媒内容草稿。',
        '要求：不要复制原文；保留爆款结构；语气自然、有清晰 CTA；适合个人 AI 内容运营账号。',
      ].join('\n'),
    })
    .select('*')
    .single();
  if (insertError) throw insertError;
  return data;
}

async function getPrimaryAccountStrategy(client, userId, platform) {
  let query = client
    .from('social_accounts')
    .select('platform,account_name,account_type,target_audience,content_strategy,posting_frequency,status')
    .eq('user_id', userId)
    .in('account_role', ['owned', 'brand', 'personal'])
    .order('created_at', { ascending: true })
    .limit(1);
  if (platform) query = query.eq('platform', platform);
  const { data, error } = await query;
  if (error) throw error;
  return data?.[0] || null;
}

async function createContentGenerationAgentTask(client, userId, agent, analysis, prompt, accountStrategy) {
  const { data, error } = await client
    .from('agent_tasks')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      task_type: 'content_generation',
      input_data: {
        content_analysis_id: analysis.id,
        viral_content_id: analysis.viral_content_id || analysis.content_id || null,
        prompt_id: prompt.id,
        platform: analysis.source_platform || analysis.viral_contents?.platform || null,
        account_strategy: accountStrategy || {},
      },
      status: 'running',
      retry_count: 0,
      max_retry: 3,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function createContentGenerationAgentRun(client, userId, agent, task, analysis, prompt, accountStrategy) {
  const { data, error } = await client
    .from('agent_runs')
    .insert({
      user_id: userId,
      agent_id: agent.id,
      agent_task_id: task.id,
      agent_name: agent.name,
      input: {
        content_analysis_id: analysis.id,
        viral_content_id: analysis.viral_content_id || analysis.content_id || null,
        prompt_id: prompt.id,
        platform: analysis.source_platform || analysis.viral_contents?.platform || null,
        account_strategy: accountStrategy || {},
        model: agent.model,
      },
      status: 'running',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function updateContentGenerationTask(client, taskId, status, payload = {}) {
  const update = { status };
  if (payload.result !== undefined) update.result = payload.result;
  if (payload.last_error !== undefined) update.last_error = payload.last_error;
  if (['success', 'failed'].includes(status)) update.completed_at = new Date().toISOString();
  const { error } = await client.from('agent_tasks').update(update).eq('id', taskId);
  if (error) throw error;
}

async function updateContentGenerationRun(client, runId, status, payload = {}) {
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

function buildContentGenerationPrompt({ analysis, promptTemplate, accountStrategy }) {
  const result = analysis.analysis_result || {};
  const viralContent = analysis.viral_contents || {};
  const account = accountStrategy || {};
  return [
    promptTemplate.content,
    '',
    '请输出严格 JSON，不要输出 Markdown。JSON 字段必须包含：',
    '{',
    '  "title": "内容标题",',
    '  "body": "正文",',
    '  "hashtags": ["标签1", "标签2"],',
    '  "cta": "行动引导",',
    '  "content_type": "text|image|video|carousel|ad|thread|short_video"',
    '}',
    '',
    '内容分析上下文：',
    `平台：${analysis.source_platform || viralContent.platform || promptTemplate.platform || ''}`,
    `原始标题：${viralContent.title || ''}`,
    `爆款原因：${result.viral_reason || analysis.viral_reason || ''}`,
    `内容结构：${result.structure || analysis.structure || ''}`,
    `用户心理：${result.user_psychology || ''}`,
    `复刻建议：${result.replication_notes || analysis.replication_notes || analysis.recommendation || analysis.ai_recommendation || ''}`,
    `AI评分：${result.ai_score || analysis.fit_score || ''}`,
    '',
    '账号策略：',
    `账号：${account.account_name || ''}`,
    `账号类型：${account.account_type || ''}`,
    `目标受众：${account.target_audience || ''}`,
    `内容方向：${account.content_strategy || ''}`,
    `发布频率：${account.posting_frequency || ''}`,
  ].join('\n');
}

function parseGeneratedContent(content) {
  const text = String(content || '').trim();
  const jsonText = extractJson(text);
  let parsed = {};
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = { body: text };
  }

  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((tag) => String(tag).trim()).filter(Boolean)
    : String(parsed.hashtags || '')
      .split(/[\s,，#]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);

  const allowedTypes = new Set(['text', 'image', 'video', 'carousel', 'ad', 'thread', 'short_video']);
  const contentType = String(parsed.content_type || parsed.type || 'text');

  return {
    title: String(parsed.title || parsed.headline || 'AI 内容草稿'),
    body: String(parsed.body || parsed.content_text || parsed.content || text || ''),
    hashtags,
    cta: String(parsed.cta || parsed.CTA || ''),
    content_type: allowedTypes.has(contentType) ? contentType : 'text',
    raw_content: text,
  };
}

function buildAIAnalysisPrompt(viralContent) {
  const metrics = [
    `views=${Number(viralContent.views || 0)}`,
    `likes=${Number(viralContent.likes || 0)}`,
    `comments=${Number(viralContent.comments || 0)}`,
    `engagement_score=${Number(viralContent.engagement_score || calculateEngagementScore(viralContent))}`,
  ].join(', ');

  return [
    '你是我的个人 AI 内容运营分析 Agent。',
    '请分析下面这条爆款/参考内容，输出严格 JSON，不要输出 Markdown。',
    '',
    'JSON 字段必须包含：',
    '{',
    '除了已有字段，还必须包含 "user_psychology" 和 "ai_score"。',
    '  "analysis": "完整分析摘要",',
    '  "viral_reason": "为什么爆",',
    '  "recommendation": "是否适合我的账号，以及下一步建议",',
    '  "hook": "开头钩子",',
    '  "structure": "内容结构拆解",',
    '  "strategy": "复刻策略",',
    '  "replication_notes": "具体改写/复刻注意事项",',
    '  "target_audience": "这类账号吸引的人群",',
    '  "content_direction": "账号内容方向",',
    '  "content_style": "账号内容风格",',
    '  "posting_frequency": "建议发布频率",',
    '  "brand_positioning": "账号定位",',
    '  "ai_strategy": "AI运营策略",',
    '  "fit_score": 0',
    '}',
    '',
    `平台：${viralContent.platform}`,
    `标题：${viralContent.title}`,
    `正文：${viralContent.content_text || ''}`,
    `内容类型：${viralContent.content_type || inferContentType(viralContent)}`,
    `数据：${metrics}`,
    `链接：${viralContent.url || ''}`,
    '',
    '分析重点：标题、开头、结构、视觉/素材、标签/话题、发布时间、为什么爆、我该如何复刻。',
  ].join('\n');
}

function parseAIAnalysis(content) {
  const text = String(content || '').trim();
  const jsonText = extractJson(text);
  let parsed = {};
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = { analysis: text };
  }

  return {
    analysis: String(parsed.analysis || text || 'AI 分析已生成。'),
    viral_reason: String(parsed.viral_reason || parsed.viralReason || parsed.why || '模型未返回明确爆点。'),
    recommendation: String(parsed.recommendation || parsed.ai_recommendation || parsed.suggestion || '模型未返回明确建议。'),
    hook: String(parsed.hook || ''),
    structure: String(parsed.structure || ''),
    user_psychology: String(parsed.user_psychology || parsed.userPsychology || parsed.psychology || ''),
    strategy: String(parsed.strategy || parsed.replication_strategy || ''),
    replication_notes: String(parsed.replication_notes || parsed.replicationNotes || parsed.strategy || ''),
    target_audience: String(parsed.target_audience || parsed.targetAudience || parsed.audience || ''),
    content_direction: String(parsed.content_direction || parsed.contentDirection || parsed.direction || ''),
    content_style: String(parsed.content_style || parsed.contentStyle || parsed.style || ''),
    posting_frequency: String(parsed.posting_frequency || parsed.postingFrequency || parsed.frequency || ''),
    brand_positioning: String(parsed.brand_positioning || parsed.brandPositioning || parsed.positioning || ''),
    ai_strategy: String(parsed.ai_strategy || parsed.aiStrategy || parsed.strategy || ''),
    fit_score: Number(parsed.fit_score || parsed.fitScore || 70),
    ai_score: Number(parsed.ai_score || parsed.aiScore || parsed.fit_score || parsed.fitScore || 70),
    raw_content: text,
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}

function inferProviderFromModel(model) {
  const normalized = String(model || '').toLowerCase();
  if (normalized.startsWith('deepseek') || normalized.includes('deepseek')) return 'deepseek';
  if (normalized.startsWith('claude') || normalized.includes('anthropic')) return 'anthropic';
  return 'openai';
}

export async function listCompetitorAccounts(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('social_accounts')
    .select('*, account_profiles(*)')
    .eq('user_id', userId)
    .in('account_role', ['competitor', 'inspiration'])
    .order('created_at', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.category) query = query.eq('account_role', filters.category);
  if (filters.search) query = query.or(`username.ilike.%${filters.search}%,account_name.ilike.%${filters.search}%,target_audience.ilike.%${filters.search}%,content_strategy.ilike.%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeSocialAccountForIntelligence);
}

export async function createCompetitorAccount(userId, payload) {
  const client = requireSupabase();
  const accountRole = payload.account_role || payload.account_type || 'competitor';
  const { data, error } = await client
    .from('social_accounts')
    .insert({
      user_id: userId,
      platform: payload.platform,
      account_name: payload.account_name || payload.username,
      username: payload.username,
      account_url: payload.url || payload.account_url || null,
      account_role: accountRole,
      account_type: accountRole,
      account_category: accountRole,
      target_audience: payload.target_audience || payload.audience || null,
      content_strategy: payload.content_strategy || null,
      posting_frequency: payload.posting_frequency || null,
      ops_notes: payload.notes || null,
      status: payload.status || 'active',
      api_status: payload.api_status || 'not_connected',
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function deleteCompetitorAccount(id) {
  const client = requireSupabase();
  const { error } = await client.from('social_accounts').delete().eq('id', id);
  if (error) throw error;
}

export async function listViralContents(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('viral_contents')
    .select(viralContentSelect)
    .eq('user_id', userId)
    .order('engagement_score', { ascending: false });

  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.accountId) query = query.eq('social_account_id', filters.accountId);
  if (filters.search) query = query.or(`title.ilike.%${filters.search}%,content_text.ilike.%${filters.search}%,viral_reason.ilike.%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createViralContent(userId, payload) {
  const score = calculateEngagementScore(payload);
  const client = requireSupabase();
  const { data, error } = await client
    .from('viral_contents')
    .insert({
      user_id: userId,
      social_account_id: payload.social_account_id || payload.account_id || null,
      platform: payload.platform,
      source_platform: payload.source_platform || payload.platform,
      url: payload.url || null,
      title: payload.title,
      content_text: payload.content_text || null,
      media_url: payload.media_url || null,
      views: Number(payload.views || 0),
      likes: Number(payload.likes || 0),
      comments: Number(payload.comments || 0),
      content_type: payload.content_type || inferContentType(payload),
      engagement_score: Number(payload.engagement_score || score),
      viral_reason: payload.viral_reason || null,
      ai_recommendation: payload.ai_recommendation || null,
      published_at: payload.published_at || null,
    })
    .select(viralContentSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function deleteViralContent(id) {
  const client = requireSupabase();
  const { error } = await client.from('viral_contents').delete().eq('id', id);
  if (error) throw error;
}

export async function listContentAnalysis(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('content_analysis')
    .select(analysisSelect)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.viralContentId) query = query.eq('viral_content_id', filters.viralContentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createContentAnalysis(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_analysis')
    .insert({
      user_id: userId,
      content_id: payload.content_id || payload.viral_content_id || null,
      viral_content_id: payload.viral_content_id || null,
      analysis: payload.analysis || null,
      hook: payload.hook || null,
      structure: payload.structure || null,
      strategy: payload.strategy || null,
      source_platform: payload.source_platform || null,
      engagement_score: Number(payload.engagement_score || 0),
      viral_reason: payload.viral_reason || null,
      content_type: payload.content_type || null,
      ai_recommendation: payload.ai_recommendation || null,
      analysis_result: payload.analysis_result || {},
      recommendation: payload.recommendation || null,
      social_account_id: payload.social_account_id || null,
      provider: payload.provider || null,
      model: payload.model || null,
      usage: payload.usage || {},
      cost: Number(payload.cost || 0),
      duration_ms: Number(payload.duration_ms || 0),
      replication_notes: payload.replication_notes || null,
      fit_score: Number(payload.fit_score || 0),
    })
    .select(analysisSelect)
    .single();

  if (error) throw error;
  return data;
}

export async function analyzeViralContentWithAI(userId, viralContent) {
  const client = requireSupabase();
  const agent = await getOrCreateAnalysisAgent(client, userId);
  const prompt = buildAIAnalysisPrompt(viralContent);
  const task = await createAnalysisAgentTask(client, userId, agent, viralContent, prompt);
  const run = await createAnalysisAgentRun(client, userId, agent, task, viralContent, prompt);

  try {
    const gateway = await generateAI({
      agent_name: agent.name,
      prompt,
      model: agent.model || defaultAnalysisModel,
      provider: inferProviderFromModel(agent.model || defaultAnalysisModel),
      parameters: {
        temperature: 0.35,
        max_output_tokens: 1200,
        response_format: { type: 'json_object' },
      },
      agent_run_id: run.id,
      usage_type: 'analysis',
    });

    const parsed = parseAIAnalysis(gateway.content);
    const savedAnalysis = await createContentAnalysis(userId, {
      content_id: viralContent.id,
      viral_content_id: viralContent.id,
      social_account_id: viralContent.social_account_id || null,
      hook: parsed.hook,
      structure: parsed.structure,
      strategy: parsed.strategy,
      source_platform: viralContent.source_platform || viralContent.platform,
      engagement_score: Number(viralContent.engagement_score || calculateEngagementScore(viralContent)),
      viral_reason: parsed.viral_reason,
      content_type: viralContent.content_type || inferContentType(viralContent),
      ai_recommendation: parsed.recommendation,
      recommendation: parsed.recommendation,
      replication_notes: parsed.replication_notes,
      fit_score: Number(parsed.fit_score || calculateFitScore(viralContent)),
      analysis: parsed.analysis,
      analysis_result: parsed,
      provider: gateway.provider,
      model: gateway.model,
      usage: gateway.usage || {},
      cost: Number(gateway.cost?.amount || gateway.cost || 0),
      duration_ms: Number(gateway.duration || 0),
    });

    await client
      .from('viral_contents')
      .update({
        viral_reason: parsed.viral_reason,
        ai_recommendation: parsed.recommendation,
      })
      .eq('id', viralContent.id)
      .eq('user_id', userId);

    if (viralContent.social_account_id) {
      await upsertAccountProfile(
        userId,
        viralContent.social_account_id,
        buildAccountProfilePayload({ viralContent, parsed, gateway }),
      );
    }

    await updateAnalysisAgentRun(client, run.id, 'success', {
      output: {
        kind: 'content_analysis',
        content_analysis_id: savedAnalysis.id,
        provider: gateway.provider,
        model: gateway.model,
        usage: gateway.usage,
        cost: gateway.cost,
      },
      cost: Number(gateway.cost?.amount || gateway.cost || 0),
      duration: Number(gateway.duration || 0),
    });
    await updateAnalysisAgentTask(client, task.id, 'success', {
      result: {
        kind: 'content_analysis',
        content_analysis_id: savedAnalysis.id,
        viral_content_id: viralContent.id,
      },
    });

    return savedAnalysis;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI Analysis failed.';
    await updateAnalysisAgentRun(client, run.id, 'failed', {
      output: { error: message },
      error_message: message,
    });
    await updateAnalysisAgentTask(client, task.id, 'failed', {
      result: { error: message },
      last_error: message,
    });
    throw error;
  }
}

export async function generateContentFromAnalysis(userId, analysis) {
  const client = requireSupabase();
  const agent = await getOrCreateContentGenerationAgent(client, userId);
  const platform = analysis.source_platform || analysis.viral_contents?.platform || null;
  const [promptTemplate, accountStrategy] = await Promise.all([
    getOrCreateContentGenerationPrompt(client, userId, platform),
    getPrimaryAccountStrategy(client, userId, platform),
  ]);
  const prompt = buildContentGenerationPrompt({ analysis, promptTemplate, accountStrategy });
  const task = await createContentGenerationAgentTask(client, userId, agent, analysis, promptTemplate, accountStrategy);
  const run = await createContentGenerationAgentRun(client, userId, agent, task, analysis, promptTemplate, accountStrategy);

  try {
    const gateway = await generateAI({
      agent_name: agent.name,
      prompt,
      model: agent.model || defaultContentGenerationModel,
      provider: inferProviderFromModel(agent.model || defaultContentGenerationModel),
      parameters: {
        temperature: 0.7,
        max_output_tokens: 1200,
        response_format: { type: 'json_object' },
      },
      agent_run_id: run.id,
      usage_type: 'text_generation',
    });

    const parsed = parseGeneratedContent(gateway.content);
    const sourceViralId = analysis.viral_content_id || analysis.content_id || null;
    const cost = Number(gateway.cost?.amount || gateway.cost || 0);
    const duration = Number(gateway.duration || 0);
    const contentText = [
      parsed.body,
      parsed.hashtags.length ? parsed.hashtags.map((tag) => `#${tag.replace(/^#/, '')}`).join(' ') : '',
      parsed.cta ? `CTA: ${parsed.cta}` : '',
    ].filter(Boolean).join('\n\n');

    const { data: contentItem, error: contentError } = await client
      .from('content_library')
      .insert({
        user_id: userId,
        title: parsed.title,
        content_text: contentText,
        content_type: parsed.content_type,
        platform,
        account_category: accountStrategy?.account_type || 'brand',
        prompt_id: promptTemplate.id,
        status: 'draft',
        pipeline_stage: 'draft',
        source_intelligence_id: sourceViralId,
        source_analysis_id: analysis.id,
        idea_notes: analysis.recommendation || analysis.ai_recommendation || analysis.viral_reason || '',
        generation_brief: {
          source: 'content_generation_agent',
          content_analysis_id: analysis.id,
          prompt_id: promptTemplate.id,
          account_strategy: accountStrategy || {},
          generated: parsed,
          provider: gateway.provider,
          model: gateway.model,
          usage: gateway.usage || {},
          cost: gateway.cost || {},
          duration_ms: duration,
        },
        model: gateway.model,
        cost,
        duration_ms: duration,
        hashtags: parsed.hashtags,
        cta: parsed.cta || null,
      })
      .select('*, prompts(title)')
      .single();
    if (contentError) throw contentError;

    await updateContentGenerationRun(client, run.id, 'success', {
      output: {
        kind: 'content_draft',
        content_id: contentItem.id,
        title: contentItem.title,
        provider: gateway.provider,
        model: gateway.model,
        usage: gateway.usage,
        cost: gateway.cost,
      },
      cost,
      duration,
    });
    await updateContentGenerationTask(client, task.id, 'success', {
      result: {
        kind: 'content_draft',
        content_id: contentItem.id,
        content_analysis_id: analysis.id,
      },
    });

    return {
      content: contentItem,
      generated: parsed,
      provider: gateway.provider,
      model: gateway.model,
      cost,
      duration,
      prompt: promptTemplate,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Content generation failed.';
    await updateContentGenerationRun(client, run.id, 'failed', {
      output: { error: message },
      error_message: message,
    });
    await updateContentGenerationTask(client, task.id, 'failed', {
      result: { error: message },
      last_error: message,
    });
    throw error;
  }
}

export async function analyzeViralContent(userId, viralContent) {
  const hook = extractHook(viralContent);
  const structure = buildStructure(viralContent);
  const viralReason = viralContent.viral_reason || buildViralReason(viralContent);
  const replicationNotes = buildReplicationStrategy(viralContent);
  const fitScore = calculateFitScore(viralContent);
  const recommendation = viralContent.ai_recommendation || buildRecommendation(viralContent, fitScore);

  return createContentAnalysis(userId, {
    viral_content_id: viralContent.id,
    social_account_id: viralContent.social_account_id || null,
    hook,
    structure,
    strategy: replicationNotes,
    source_platform: viralContent.source_platform || viralContent.platform,
    engagement_score: Number(viralContent.engagement_score || calculateEngagementScore(viralContent)),
    viral_reason: viralReason,
    content_type: viralContent.content_type || inferContentType(viralContent),
    ai_recommendation: recommendation,
    replication_notes: replicationNotes,
    fit_score: fitScore,
    analysis: [
      `为什么爆：${viralReason}`,
      `如何复刻：${replicationNotes}`,
      `是否适合我的账号：${recommendation}`,
      `参考指标：${Number(viralContent.views || 0)} views / ${Number(viralContent.likes || 0)} likes / ${Number(viralContent.comments || 0)} comments`,
    ].join('\n\n'),
  });
}

export async function getIntelligenceStats(userId) {
  const [accounts, viralContents, analyses] = await Promise.all([
    listCompetitorAccounts(userId),
    listViralContents(userId),
    listContentAnalysis(userId),
  ]);

  const platformCounts = new Map();
  const accountCounts = new Map();

  for (const item of viralContents) {
    platformCounts.set(item.platform, (platformCounts.get(item.platform) || 0) + 1);
    const username = item.social_accounts?.username || item.social_accounts?.account_name;
    if (username) accountCounts.set(username, (accountCounts.get(username) || 0) + 1);
  }

  return {
    competitorAccounts: accounts.length,
    viralContents: viralContents.length,
    analyses: analyses.length,
    topPlatform: [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
    topAccount: [...accountCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
  };
}

function normalizeSocialAccountForIntelligence(account) {
  const profile = account.account_profiles?.[0] || {};
  return {
    ...account,
    username: account.username || account.account_name,
    url: account.account_url,
    category: account.account_role || account.account_type || account.account_category,
    audience: profile.target_audience || account.target_audience,
    followers: Number(account.followers || 0),
    content_strategy: profile.content_direction || account.content_strategy,
    posting_frequency: profile.posting_frequency || account.posting_frequency,
    notes: account.ops_notes,
  };
}

function buildAccountProfilePayload({ viralContent, parsed, gateway }) {
  const fallbackDirection = parsed.strategy || parsed.replication_notes || parsed.recommendation || '';
  return {
    target_audience: parsed.target_audience || inferAudienceFromContent(viralContent),
    content_direction: parsed.content_direction || fallbackDirection,
    content_style: parsed.content_style || parsed.structure || '',
    posting_frequency: parsed.posting_frequency || inferPostingFrequency(viralContent),
    brand_positioning: parsed.brand_positioning || parsed.recommendation || '',
    ai_strategy: parsed.ai_strategy || parsed.strategy || parsed.replication_notes || '',
    analysis_summary: parsed.analysis || parsed.viral_reason || '',
    analysis_result: {
      source: 'analysis_agent',
      viral_content_id: viralContent.id,
      platform: viralContent.platform,
      parsed,
      provider: gateway.provider,
      model: gateway.model,
      usage: gateway.usage || {},
    },
    source_content_ids: [viralContent.id],
    model: gateway.model || null,
    confidence_score: Number(parsed.ai_score || parsed.fit_score || calculateFitScore(viralContent)),
    last_analyzed_at: new Date().toISOString(),
  };
}

function inferAudienceFromContent(viralContent) {
  if (viralContent.platform === 'Telegram') return 'Telegram频道用户，偏好高密度信息、工具推荐和可转发内容。';
  return '关注该账号所在平台和主题的潜在受众。';
}

function inferPostingFrequency(viralContent) {
  if (viralContent.platform === 'Telegram') return 'daily';
  if (viralContent.platform === 'X') return 'daily';
  return 'weekly';
}

export function buildIntelligenceStrategy(viralContents) {
  const topItems = viralContents.slice(0, 5);
  const hooks = topItems.map((item) => extractHook(item)).filter(Boolean);

  return {
    kind: 'content_intelligence_strategy',
    source_count: viralContents.length,
    top_platform: topItems[0]?.platform || '—',
    hooks,
    suggestions: [
      '优先复用高互动内容的开头结构，但替换为自己的账号语气和角色设定。',
      '把爆款原因拆成 Hook、视觉、情绪、CTA 四部分，再进入内容生成。',
      '只复刻结构，不复制素材和原文。',
      '把适合度高的内容直接转为 Content Idea，进入内容库 idea 状态。',
    ],
  };
}

function calculateEngagementScore(item) {
  return Number(item.views || 0) + Number(item.likes || 0) * 10 + Number(item.comments || 0) * 20;
}

function calculateFitScore(item) {
  const score = calculateEngagementScore(item);
  if (score >= 100000) return 95;
  if (score >= 30000) return 85;
  if (score >= 10000) return 75;
  if (score >= 3000) return 65;
  return 50;
}

function inferContentType(item) {
  if (item.content_type) return item.content_type;
  if (item.media_url?.match(/\.(mp4|mov|webm)$/i)) return 'video';
  if (item.media_url) return 'image';
  return 'text';
}

function extractHook(viralContent) {
  const text = viralContent.content_text || viralContent.title || '';
  const firstLine = text.split(/\n|。|！|!|\?/).find(Boolean);
  return firstLine || viralContent.title || '未提取到开头钩子';
}

function buildViralReason(viralContent) {
  const signals = [];
  if (Number(viralContent.views || 0) > 10000) signals.push('曝光高');
  if (Number(viralContent.likes || 0) > 500) signals.push('点赞强');
  if (Number(viralContent.comments || 0) > 100) signals.push('评论讨论多');
  if (!signals.length) signals.push('具备可学习结构');
  return `${signals.join('、')}；核心 Hook 是“${extractHook(viralContent)}”。`;
}

function buildStructure(viralContent) {
  return [
    '1. 开头：用问题、反差、结果或痛点抓注意力。',
    '2. 中段：展示过程、证据、案例或对比，压缩信息密度。',
    '3. 结尾：给出行动建议，引导保存、评论、点击或注册。',
    `参考指标：views=${viralContent.views || 0}, likes=${viralContent.likes || 0}, comments=${viralContent.comments || 0}`,
  ].join('\n');
}

function buildReplicationStrategy(viralContent) {
  return [
    `复刻对象：${viralContent.title}`,
    `平台：${viralContent.platform}`,
    '标题策略：保留强结果或强痛点，替换成你的产品/角色语境。',
    '视觉策略：复用节奏和镜头关系，不直接复制素材。',
    '标签策略：拆成品牌词、场景词、痛点词。',
    '发布时间策略：记录发布时间，后续与互动数据做对比。',
  ].join('\n');
}

function buildRecommendation(viralContent, fitScore) {
  if (fitScore >= 80) return '适合进入你的内容库，建议转成 idea 并交给内容生成 Agent。';
  if (viralContent.platform === 'Telegram') return '适合 Telegram 频道做深度拆解，可先做短文版本测试。';
  return '可以作为灵感参考，建议先改写 Hook，不要直接进入发布。';
}
