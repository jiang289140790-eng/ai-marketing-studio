import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

type GenerateBody = {
  action?: string;
  agent_name?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  parameters?: Record<string, unknown>;
  agent_run_id?: string | null;
  usage_type?: string;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return jsonResponse({ ok: true });
  }

  try {
    if (request.method !== 'POST') {
      return jsonResponse({ error: { code: 'method_not_allowed', message: 'Use POST.' }, status: 'failed' }, 405);
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return jsonResponse({ error: { code: 'unauthorized', message: 'Missing Authorization header.' }, status: 'failed' }, 401);
    }

    const { client, user } = await createAuthorizedClient(authHeader);
    const body = await request.json().catch(() => ({})) as GenerateBody;
    if (body.action && body.action !== 'generate') {
      return jsonResponse({ error: { code: 'unsupported_action', message: 'Only generate is supported.' }, status: 'failed' }, 400);
    }

    const result = await generate(client, user.id, body);
    return jsonResponse(result);
  } catch (error) {
    const normalizedError = normalizeGatewayError(error);
    return jsonResponse({
      status: 'failed',
      error: normalizedError,
    }, normalizedError.status);
  }
});

async function generate(client: ReturnType<typeof createClient>, userId: string, body: GenerateBody) {
  const startedAt = Date.now();
  const prompt = String(body.prompt || '').trim();
  const agentName = String(body.agent_name || 'Analysis Agent').trim();
  const model = String(body.model || Deno.env.get('AI_GATEWAY_DEFAULT_MODEL') || 'gpt-4.1-mini').trim();
  const provider = normalizeProvider(body.provider || inferProvider(model));
  const parameters = body.parameters || {};

  if (!prompt) throw new Error('Missing prompt.');
  if (!model) throw new Error('Missing model.');

  const providerResult = await callProvider(provider, { prompt, model, parameters });

  const duration = Math.max(0, Date.now() - startedAt);
  const cost = estimateCost(provider, model, providerResult.usage);
  const status = 'success';

  await recordUsage(client, userId, {
    agentName,
    provider,
    model,
    usage: providerResult.usage,
    cost,
    duration,
    agentRunId: body.agent_run_id || null,
    usageType: String(body.usage_type || 'analysis'),
  });

  return {
    status,
    agent_name: agentName,
    provider,
    model,
    content: providerResult.content,
    usage: providerResult.usage,
    cost,
    duration,
  };
}

async function callProvider(
  provider: string,
  payload: { prompt: string; model: string; parameters: Record<string, unknown> },
) {
  if (provider === 'anthropic') return callAnthropic(payload);
  if (provider === 'deepseek') return callDeepSeek(payload);
  return callOpenAI(payload);
}

async function callOpenAI({ prompt, model, parameters }: { prompt: string; model: string; parameters: Record<string, unknown> }) {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured in Supabase Edge Function Secrets.');

  const response = await fetchWithTimeout(`${Deno.env.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1'}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: Number(parameters.temperature ?? 0.4),
      max_output_tokens: Number(parameters.max_output_tokens ?? 1200),
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `OpenAI request failed with ${response.status}.`);
  }

  return {
    content: extractOpenAIText(json),
    usage: normalizeUsage(json?.usage),
    raw_provider_id: json?.id || null,
  };
}

async function callAnthropic({ prompt, model, parameters }: { prompt: string; model: string; parameters: Record<string, unknown> }) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured in Supabase Edge Function Secrets.');

  const response = await fetchWithTimeout(`${Deno.env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': String(Deno.env.get('ANTHROPIC_VERSION') || '2023-06-01'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: Number(parameters.max_tokens ?? parameters.max_output_tokens ?? 1200),
      temperature: Number(parameters.temperature ?? 0.4),
      system: String(parameters.system || 'You are an AI content operations analyst. Return practical, concise analysis.'),
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `Anthropic request failed with ${response.status}.`);
  }

  return {
    content: extractAnthropicText(json),
    usage: normalizeUsage(json?.usage),
    raw_provider_id: json?.id || null,
  };
}

async function callDeepSeek({ prompt, model, parameters }: { prompt: string; model: string; parameters: Record<string, unknown> }) {
  const apiKey = Deno.env.get('DEEPSEEK_API_KEY');
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured in Supabase Edge Function Secrets.');

  const response = await fetchWithTimeout(`${Deno.env.get('DEEPSEEK_BASE_URL') || 'https://api.deepseek.com'}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: String(parameters.system || 'You are an AI content operations analyst. Return practical, concise analysis.'),
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: Number(parameters.temperature ?? 0.4),
      max_tokens: Number(parameters.max_tokens ?? parameters.max_output_tokens ?? 1200),
      response_format: parameters.response_format || undefined,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message || `DeepSeek request failed with ${response.status}.`);
  }

  return {
    content: extractChatCompletionText(json),
    usage: normalizeUsage(json?.usage),
    raw_provider_id: json?.id || null,
  };
}

async function createAuthorizedClient(authHeader: string) {
  const { client } = createServiceClient();
  const jwt = authHeader.replace('Bearer ', '');
  const { data, error } = await client.auth.getUser(jwt);
  if (error || !data.user) throw new Error('Invalid user session.');
  return { client, user: data.user };
}

function createServiceClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Edge Function environment.');
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return { client };
}

async function recordUsage(client: ReturnType<typeof createClient>, userId: string, payload: Record<string, any>) {
  const totalTokens = Number(payload.usage?.total_tokens || 0);
  const totalCost = Number(payload.cost?.amount || 0);
  const metadata = {
    provider: payload.provider,
    model: payload.model,
    usage: payload.usage,
    duration_ms: payload.duration,
    agent_name: payload.agentName,
    estimated_cost: payload.cost?.estimated ?? true,
  };

  await client.from('tool_usage').insert({
    user_id: userId,
    tool_name: 'ai-gateway',
    provider: payload.provider,
    usage_type: payload.usageType,
    units: totalTokens || 1,
    unit_cost: totalTokens ? totalCost / totalTokens : 0,
    total_cost: totalCost,
    related_agent_run_id: payload.agentRunId || null,
    metadata,
  });

  await client.from('cost_records').insert({
    user_id: userId,
    category: 'ai',
    source: `${payload.provider}:${payload.model}`,
    amount: totalCost,
    metadata,
  });
}

function inferProvider(model: string) {
  const normalized = model.toLowerCase();
  if (normalized.startsWith('claude') || normalized.includes('anthropic')) return 'anthropic';
  if (normalized.startsWith('deepseek') || normalized.includes('deepseek')) return 'deepseek';
  return 'openai';
}

function normalizeProvider(provider: unknown) {
  const normalized = String(provider || '').toLowerCase().trim();
  if (['anthropic', 'claude'].includes(normalized)) return 'anthropic';
  if (['deepseek', 'deepseek-ai'].includes(normalized)) return 'deepseek';
  if (['openai', 'gpt'].includes(normalized)) return 'openai';
  throw new Error(`Unsupported AI provider: ${provider}`);
}

function normalizeUsage(usage: Record<string, unknown> = {}) {
  const inputTokens = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens || 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    raw: usage || {},
  };
}

function estimateCost(provider: string, model: string, usage: Record<string, number>) {
  const keyPrefix = `${provider}_${model}`.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const inputRate = Number(Deno.env.get(`${keyPrefix}_INPUT_COST_PER_1K`) || Deno.env.get(`${provider.toUpperCase()}_INPUT_COST_PER_1K`) || 0);
  const outputRate = Number(Deno.env.get(`${keyPrefix}_OUTPUT_COST_PER_1K`) || Deno.env.get(`${provider.toUpperCase()}_OUTPUT_COST_PER_1K`) || 0);
  const amount = (Number(usage.input_tokens || 0) / 1000) * inputRate + (Number(usage.output_tokens || 0) / 1000) * outputRate;
  return {
    currency: 'USD',
    amount: Number(amount.toFixed(6)),
    estimated: true,
    rate_source: inputRate || outputRate ? 'edge_function_secret_rates' : 'not_configured',
  };
}

function extractOpenAIText(json: Record<string, any>) {
  if (typeof json.output_text === 'string') return json.output_text;
  const parts = [];
  for (const item of json.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function extractAnthropicText(json: Record<string, any>) {
  return (json.content || [])
    .map((item: Record<string, unknown>) => item.type === 'text' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractChatCompletionText(json: Record<string, any>) {
  return String(json?.choices?.[0]?.message?.content || '').trim();
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const timeoutMs = Number(Deno.env.get('AI_GATEWAY_TIMEOUT_MS') || 60000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`provider_timeout: AI provider request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGatewayError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown AI Gateway error.';
  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return { code: 'provider_timeout', message, status: 504 };
  }
  if (lower.includes('insufficient') || lower.includes('quota') || lower.includes('balance') || lower.includes('billing')) {
    return { code: 'provider_quota_or_billing_error', message, status: 402 };
  }
  if (lower.includes('model') && (lower.includes('not') || lower.includes('unsupported') || lower.includes('invalid'))) {
    return { code: 'model_error', message, status: 400 };
  }
  if (lower.includes('api_key') || lower.includes('key is not configured') || lower.includes('unauthorized')) {
    return { code: 'provider_auth_error', message, status: 401 };
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return { code: 'provider_rate_limited', message, status: 429 };
  }
  return { code: 'ai_gateway_error', message, status: 500 };
}
