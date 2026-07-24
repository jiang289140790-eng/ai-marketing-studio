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
    provider_timeout: 'AI 服务响应超时，请稍后重试或缩短生成要求。',
    provider_quota_or_billing_error: 'AI 服务额度不足或计费状态异常，请检查对应服务商账户。',
    model_error: '模型不可用或模型名称不正确，请检查模型授权与配置。',
    provider_auth_error: 'AI 服务密钥未配置或无效，请检查 Supabase Edge Function Secrets。',
    provider_rate_limited: 'AI 服务请求过于频繁，请稍后重试。',
  };
  return labels[code] ? `${labels[code]} (${message})` : message;
}
