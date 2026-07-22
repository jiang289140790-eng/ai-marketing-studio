import { createServiceClient, handleGatewayError, jsonResponse, requireUser, signBody } from '../_shared/ops-gateway.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return jsonResponse(request, { ok: true });

  try {
    await requireUser(request);
    const client = createServiceClient();
    const status: Record<string, unknown> = {
      supabase: true,
      edge_function: true,
      bridge_configured: Boolean(Deno.env.get('OPS_MCP_BRIDGE_URL') && Deno.env.get('OPS_MCP_BRIDGE_SECRET')),
      bridge: false,
      mcp: false,
      x_mcp: 'unknown',
      autodl: 'unknown',
      comfyui: 'unknown',
      publish_adapter: 'unknown',
    };

    const { error } = await client.from('ops_runs').select('id', { head: true, count: 'exact' }).limit(1);
    status.supabase = !error;

    const bridgeUrl = Deno.env.get('OPS_MCP_BRIDGE_URL');
    const bridgeSecret = Deno.env.get('OPS_MCP_BRIDGE_SECRET');
    if (bridgeUrl && bridgeSecret) {
      const body = JSON.stringify({ probe: true, timestamp: new Date().toISOString() });
      const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/health`, {
        method: 'GET',
        headers: {
          'X-Ops-Signature': await signBody(body, bridgeSecret),
          'X-Ops-Probe': body,
        },
      }).catch(() => null);
      if (response?.ok) {
        const health = await response.json().catch(() => ({}));
        status.bridge = true;
        status.mcp = Boolean(health.mcp);
        status.x_mcp = health.x_mcp || 'unknown';
        status.autodl = health.autodl || 'unknown';
        status.comfyui = health.comfyui || 'unknown';
        status.publish_adapter = health.publish_adapter || 'unknown';
      }
    }

    return jsonResponse(request, { ok: true, status });
  } catch (error) {
    return handleGatewayError(request, error);
  }
});
