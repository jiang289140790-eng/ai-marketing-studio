import {
  assertAction,
  assertUuid,
  createServiceClient,
  enforceRateLimit,
  handleGatewayError,
  jsonResponse,
  parseJsonBody,
  publicRun,
  requireUser,
  signBody,
  verifyResourceOwnership,
} from '../_shared/ops-gateway.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return jsonResponse(request, { ok: true });
  if (request.method !== 'POST') return jsonResponse(request, { ok: false, code: 'INVALID_INPUT', message: '只支持 POST。' }, 405);

  try {
    const user = await requireUser(request);
    const client = createServiceClient();
    const body = await parseJsonBody(request);
    const action = assertAction(body.action);
    const resourceType = typeof body.resourceType === 'string' ? body.resourceType : undefined;
    const resourceId = assertUuid(body.resourceId, 'resourceId', false);
    const payload = typeof body.payload === 'object' && body.payload !== null ? body.payload : {};
    const idempotencyKey = String(body.idempotencyKey || request.headers.get('x-idempotency-key') || `${action}:${resourceType || 'none'}:${resourceId || 'none'}:${user.id}`);

    await enforceRateLimit(client, user.id);
    await verifyResourceOwnership(client, user.id, resourceType, resourceId);

    const { data: existingRun, error: existingRunError } = await client
      .from('ops_runs')
      .select('*')
      .eq('user_id', user.id)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingRunError) throw existingRunError;
    if (existingRun) {
      return jsonResponse(request, {
        ok: existingRun.status !== 'failed',
        run_id: existingRun.id,
        status: existingRun.status,
        idempotent: true,
        run: publicRun(existingRun),
      }, existingRun.status === 'failed' ? 409 : 200);
    }

    const inputSummary = {
      action,
      resourceType: resourceType || null,
      resourceId: resourceId || null,
      payloadKeys: Object.keys(payload).slice(0, 30),
    };

    const { data: run, error: insertError } = await client
      .from('ops_runs')
      .insert({
        user_id: user.id,
        action,
        resource_type: resourceType || null,
        resource_id: resourceId,
        status: 'queued',
        progress: 0,
        input_summary: inputSummary,
        idempotency_key: idempotencyKey,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError || !run) throw insertError || new Error('无法创建执行记录。');

    const bridgeUrl = Deno.env.get('OPS_MCP_BRIDGE_URL');
    const bridgeSecret = Deno.env.get('OPS_MCP_BRIDGE_SECRET');
    if (!bridgeUrl || !bridgeSecret) {
      await client.from('ops_runs').update({
        status: 'failed',
        progress: 100,
        error_code: 'GATEWAY_UNAVAILABLE',
        error_message: 'MCP Runtime Bridge 尚未配置。',
        retryable: true,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', run.id);
      return jsonResponse(request, {
        ok: false,
        code: 'GATEWAY_UNAVAILABLE',
        message: 'MCP Runtime Bridge 尚未配置。',
        run_id: run.id,
        retryable: true,
      }, 503);
    }

    const bridgeBody = JSON.stringify({
      run_id: run.id,
      user_id: user.id,
      action,
      resource_type: resourceType || null,
      resource_id: resourceId,
      payload,
      idempotency_key: idempotencyKey,
    });

    const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ops-Signature': await signBody(bridgeBody, bridgeSecret),
        'X-Ops-Gateway': 'supabase-edge',
      },
      body: bridgeBody,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      await client.from('ops_runs').update({
        status: 'failed',
        progress: 100,
        error_code: 'MCP_UNAVAILABLE',
        error_message: errorText.slice(0, 800) || 'MCP Runtime Bridge 拒绝执行。',
        retryable: true,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', run.id);
      return jsonResponse(request, {
        ok: false,
        code: 'MCP_UNAVAILABLE',
        message: 'MCP Runtime Bridge 暂不可用。',
        run_id: run.id,
        retryable: true,
      }, 503);
    }

    const bridgeResult = await response.json().catch(() => ({}));
    await client.from('ops_runs').update({
      status: bridgeResult.status || 'queued',
      progress: bridgeResult.progress ?? 5,
      bridge_run_id: bridgeResult.bridge_run_id || null,
      updated_at: new Date().toISOString(),
    }).eq('id', run.id);

    return jsonResponse(request, {
      ok: true,
      run_id: run.id,
      status: bridgeResult.status || 'queued',
      run: publicRun({ ...run, status: bridgeResult.status || 'queued', progress: bridgeResult.progress ?? 5 }),
    });
  } catch (error) {
    return handleGatewayError(request, error);
  }
});
