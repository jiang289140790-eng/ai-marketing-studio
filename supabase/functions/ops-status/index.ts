import {
  assertUuid,
  createServiceClient,
  handleGatewayError,
  jsonResponse,
  publicRun,
  requireUser,
} from '../_shared/ops-gateway.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return jsonResponse(request, { ok: true });
  if (request.method !== 'GET' && request.method !== 'POST') return jsonResponse(request, { ok: false, code: 'INVALID_INPUT', message: '只支持 GET 或 POST。' }, 405);

  try {
    const user = await requireUser(request);
    const client = createServiceClient();
    const url = new URL(request.url);
    let runId = url.searchParams.get('run_id');
    if (!runId && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      runId = body.run_id;
    }
    runId = assertUuid(runId, 'run_id', true);

    const { data, error } = await client
      .from('ops_runs')
      .select('*')
      .eq('id', runId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error || !data) {
      return jsonResponse(request, {
        ok: false,
        code: 'RESOURCE_NOT_FOUND',
        message: '没有找到该执行记录，或你无权查看。',
        retryable: false,
      }, 404);
    }

    return jsonResponse(request, { ok: true, run: publicRun(data) });
  } catch (error) {
    return handleGatewayError(request, error);
  }
});
