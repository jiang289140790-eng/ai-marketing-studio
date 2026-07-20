import { requireSupabase } from './supabase-client';

export async function generateAI({
  agent_name,
  prompt,
  model,
  provider,
  parameters = {},
  agent_run_id = null,
  usage_type = 'analysis',
}) {
  const client = requireSupabase();
  const startedAt = Date.now();
  const { data, error } = await client.functions.invoke('ai-gateway', {
    body: {
      action: 'generate',
      agent_name,
      prompt,
      model,
      provider,
      parameters,
      agent_run_id,
      usage_type,
    },
  });

  if (error) throw error;
  if (data?.status === 'failed' || data?.error) {
    throw new Error(formatGatewayError(data?.error));
  }

  return {
    ...data,
    duration: data?.duration || Math.max(0, Date.now() - startedAt),
  };
}

function formatGatewayError(error) {
  const code = error?.code || 'ai_gateway_error';
  const message = error?.message || error || 'AI Gateway request failed.';
  const labels = {
    provider_timeout: 'AI Provider 请求超时，请稍后重试或降低输出长度。',
    provider_quota_or_billing_error: 'AI Provider 额度不足或计费异常，请检查 DeepSeek 账户余额。',
    model_error: '模型配置错误，请检查 Analysis Agent 的模型名。',
    provider_auth_error: 'AI Provider Key 未配置或无效，请检查 Supabase Secrets。',
    provider_rate_limited: 'AI Provider 限流，请稍后重试。',
  };
  return labels[code] ? `${labels[code]} (${message})` : message;
}
