import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';
import { classifyDeliveryResponse, fixedGatewayBase, isAcceptedMessageReplay, signGatewayRequest, validateEdgeRequest, verifyGatewayCallback } from './edge-core.mjs';

const ALLOWED_ORIGINS = new Set([
  'https://jiang289140790-eng.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);
const MAX_BODY = 64 * 1024;
// Covers one complete valid gateway task: a 12,000-code-unit UTF-8 intent,
// 12 KiB final response, and 50 bounded 500-code-unit artifact references.
const MAX_RESPONSE = 192 * 1024;

function headers(request: Request) {
  const origin = request.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, last-event-id',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
}

function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: headers(request) });
  if (request.method !== 'POST' && request.method !== 'GET') return json(request, { ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const publishableKey = Deno.env.get('SB_PUBLISHABLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  const gatewaySecret = Deno.env.get('AMS_HARNESS_GATEWAY_HMAC_SECRET') || '';
  const gatewayRaw = Deno.env.get('AMS_HARNESS_GATEWAY_URL') || '';
  if (!supabaseUrl || !publishableKey || !serviceKey || gatewaySecret.length < 32 || !gatewayRaw) {
    return json(request, { ok: false, code: 'SERVICE_CONFIG_MISSING' }, 503);
  }
  const serviceClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const requestUrl = new URL(request.url);
  if (request.method === 'POST' && requestUrl.pathname.endsWith('/harness-command/internal/task-events')) {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_RESPONSE) return json(request, { ok: false, code: 'BODY_TOO_LARGE' }, 413);
    const userId = request.headers.get('x-ams-user-id') || '';
    const timestamp = request.headers.get('x-ams-timestamp') || '';
    const signature = request.headers.get('x-ams-signature') || '';
    const valid = await verifyGatewayCallback(gatewaySecret, {
      method: 'POST', path: '/functions/v1/harness-command/internal/task-events', userId, timestamp, rawBody, signature,
    });
    if (!valid) return json(request, { ok: false, code: 'UNAUTHORIZED' }, 401);
    let envelope: any;
    try { envelope = JSON.parse(rawBody); } catch { return json(request, { ok: false, code: 'INVALID_JSON' }, 400); }
    const event = envelope?.event;
    if (envelope?.schema_version !== 1 || event?.user_id !== userId || !event?.task || event.task.id !== event.task_id) {
      return json(request, { ok: false, code: 'PROJECTION_ENVELOPE_INVALID' }, 400);
    }
    const { data, error } = await serviceClient.schema('api').rpc('harness_project_task_event_v1', {
      p_user_id: userId, p_task: event.task, p_gateway_event: event.event, p_event_at: event.at,
    });
    if (error) return json(request, { ok: false, code: 'TASK_PROJECTION_FAILED' }, 503);
    if (!data?.projected) return json(request, { ok: false, code: 'THREAD_NOT_BOUND' }, 409);
    return json(request, { ok: true, ...data });
  }
  if (request.method === 'POST' && requestUrl.pathname.endsWith('/harness-command/internal/generation-events')) {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > MAX_RESPONSE) return json(request, { ok: false, code: 'BODY_TOO_LARGE' }, 413);
    const userId = request.headers.get('x-ams-user-id') || '';
    const timestamp = request.headers.get('x-ams-timestamp') || '';
    const signature = request.headers.get('x-ams-signature') || '';
    const callbackPath = '/functions/v1/harness-command/internal/generation-events';
    const valid = await verifyGatewayCallback(gatewaySecret, {
      method: 'POST', path: callbackPath, userId, timestamp, rawBody, signature,
    });
    if (!valid) return json(request, { ok: false, code: 'UNAUTHORIZED' }, 401);
    let envelope: any;
    try { envelope = JSON.parse(rawBody); } catch { return json(request, { ok: false, code: 'INVALID_JSON' }, 400); }
    const event = envelope?.event;
    const generationEventTypes = new Set([
      'generation_started', 'assistant_text_delta', 'assistant_text_completed',
      'tool_call_started', 'tool_call_completed', 'generation_completed',
      'generation_stopped', 'generation_failed',
    ]);
    if (envelope?.schema_version !== 1 || event?.user_id !== userId
      || !/^thr_[0-9a-f-]{36}$/.test(String(event?.thread_id || ''))
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(event?.generation_id || ''))
      || !/^[A-Za-z0-9._:-]{1,200}$/.test(String(event?.request_id || ''))
      || !generationEventTypes.has(String(event?.event_type || ''))
      || !/^[A-Za-z0-9._:-]{1,240}$/.test(String(event?.event_id || ''))) {
      return json(request, { ok: false, code: 'GENERATION_EVENT_INVALID' }, 400);
    }
    const { data, error } = await serviceClient.schema('api').rpc('harness_apply_generation_event_v1', {
      p_user_id: userId, p_thread_id: event.thread_id, p_generation_id: event.generation_id,
      p_request_id: event.request_id, p_event_id: event.event_id,
      p_event_type: event.event_type, p_payload: event.payload || {},
    });
    if (error) return json(request, { ok: false, code: 'GENERATION_PROJECTION_FAILED' }, 503);
    return json(request, { ok: true, ...data });
  }

  const authorization = request.headers.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) return json(request, { ok: false, code: 'AUTH_REQUIRED' }, 401);

  const authClient = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData?.user?.id) return json(request, { ok: false, code: 'AUTH_FAILED' }, 401);
  const userId = String(authData.user.id);
  const { data: roleData, error: roleError } = await serviceClient.schema('api').rpc('p19_staging_role', { p_user_id: userId });
  if (roleError) return json(request, { ok: false, code: 'ROLE_LOOKUP_FAILED' }, 503);
  const accessRole = String(roleData || '');

  let input: unknown;
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const match = url.pathname.match(/\/threads\/(thr_[0-9a-f-]{36})\/events$/);
    if (!match) return json(request, { ok: false, code: 'NOT_FOUND' }, 404);
    input = {
      schema_version: 'ams_harness_edge_v1', action: 'thread_events', thread_id: match[1],
      cursor: url.searchParams.get('cursor') || request.headers.get('last-event-id') || '0',
      limit: Number(url.searchParams.get('limit') || 200),
    };
  } else {
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY) return json(request, { ok: false, code: 'BODY_TOO_LARGE' }, 413);
      input = JSON.parse(raw);
    } catch {
      return json(request, { ok: false, code: 'INVALID_JSON' }, 400);
    }
  }
  const checked = validateEdgeRequest(input, { userId, accessRole });
  if (!checked.ok) return json(request, checked, checked.code === 'OPERATOR_REQUIRED' || checked.code === 'STAGING_ROLE_DENIED' ? 403 : 400);

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await serviceClient.schema('api').rpc(name, args);
    if (error) throw error;
    return data;
  };

  if (checked.contract === 'thread_create') {
    try {
      if (checked.body.project_id) {
        const project = await rpc('p19_get_project', { p_user_id: userId, p_project_id: checked.body.project_id });
        if (!project) return json(request, { ok: false, code: 'PROJECT_ACCESS_DENIED' }, 403);
      }
      const data = await rpc('harness_create_thread_v1', {
        p_user_id: userId, p_workspace_id: checked.body.workspace_id,
        p_project_id: checked.body.project_id, p_request_id: checked.body.request_id,
        p_title: checked.body.title,
      });
      return json(request, { ok: true, ...data }, 201);
    } catch { return json(request, { ok: false, code: 'THREAD_CREATE_FAILED' }, 503); }
  }
  if (checked.contract === 'thread_get') {
    try {
      const data = await rpc('harness_get_thread_v1', { p_user_id: userId, p_thread_id: checked.body.thread_id });
      return data ? json(request, { ok: true, ...data }) : json(request, { ok: false, code: 'THREAD_NOT_FOUND' }, 404);
    } catch { return json(request, { ok: false, code: 'THREAD_READ_FAILED' }, 503); }
  }
  if (checked.contract === 'thread_events' && request.method === 'GET') {
    const encoder = new TextEncoder();
    let cursor = checked.body.cursor;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (let tick = 0; tick < 25; tick += 1) {
            const threadState: any = await rpc('harness_get_thread_v1', { p_user_id: userId, p_thread_id: checked.body.thread_id });
            // Task projection is pushed durably by the Gateway projector.
            // The browser stream is read-only and can never drive execution or persistence.
            const data: any = await rpc('harness_list_events_v1', {
              p_user_id: userId, p_thread_id: checked.body.thread_id,
              p_after_cursor: cursor, p_limit: checked.body.limit,
            });
            for (const event of data?.events || []) {
              cursor = Number(event.cursor);
              controller.enqueue(encoder.encode(`id: ${event.cursor}\nevent: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`));
            }
            if (tick % 10 === 0) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            if (data?.events?.some((event: any) => ['task_completed', 'task_partial', 'task_failed', 'task_blocked', 'task_cancelled'].includes(event.event_type)
              && event.task_id === threadState?.currentTaskId)) break;
            // Real replay polling cadence; this delay never fabricates model output.
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        } catch {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ code: 'EVENT_STREAM_FAILED' })}\n\n`));
        } finally { controller.close(); }
      },
    });
    const cors = headers(request);
    return new Response(stream, { status: 200, headers: { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' } });
  }
  if (checked.contract === 'thread_messages' || checked.contract === 'thread_events') {
    try {
      const data = await rpc(checked.contract === 'thread_messages' ? 'harness_list_messages_v1' : 'harness_list_events_v1', {
        p_user_id: userId, p_thread_id: checked.body.thread_id,
        ...(checked.contract === 'thread_messages' ? { p_after_sequence: checked.body.cursor } : { p_after_cursor: checked.body.cursor }),
        p_limit: checked.body.limit,
      });
      return json(request, { ok: true, ...data });
    } catch { return json(request, { ok: false, code: 'THREAD_HISTORY_FAILED' }, 503); }
  }
  if (checked.contract === 'thread_stop') {
    try {
      const stop = await rpc('harness_request_stop_v1', { p_user_id: userId, p_thread_id: checked.body.thread_id });
      if (!stop?.accepted) return json(request, { ok: false, code: 'NO_ACTIVE_GENERATION' }, 409);
      const gateway = fixedGatewayBase(gatewayRaw);
      const path = `/v1/threads/${checked.body.thread_id}/stop`;
      const timestamp = String(Date.now());
      const rawBody = '{}';
      const { signature } = await signGatewayRequest(gatewaySecret, { method: 'POST', path, userId, timestamp, rawBody, delegatedAuthorization: authorization });
      const response = await fetch(new URL(path, `${gateway.toString()}/`), {
        method: 'POST', redirect: 'error', headers: {
          'content-type': 'application/json', 'x-ams-user-id': userId,
          'x-ams-timestamp': timestamp, 'x-ams-signature': signature,
          'x-ams-delegated-authorization': authorization,
        }, body: rawBody, signal: AbortSignal.timeout(20_000),
      });
      return json(request, { ok: response.ok, ...stop }, response.ok ? 202 : response.status);
    } catch { return json(request, { ok: false, code: 'STOP_FAILED' }, 503); }
  }
  if (checked.contract === 'thread_send') {
    let thread: any;
    let message: any;
    const generationId = `edge_${checked.body.request_id}`;
    try {
      thread = await rpc('harness_get_thread_v1', { p_user_id: userId, p_thread_id: checked.body.thread_id });
      if (!thread) return json(request, { ok: false, code: 'THREAD_NOT_FOUND' }, 404);
      message = await rpc('harness_append_message_v1', {
        p_user_id: userId, p_thread_id: checked.body.thread_id,
        p_request_id: checked.body.request_id, p_role: 'user', p_kind: 'text', p_status: 'completed',
        p_content: checked.body.content,
        p_structured_payload: { attachments: checked.body.attachments }, p_task_id: null,
        p_client_message_id: checked.body.client_message_id, p_parent_message_id: null,
      });
      const claim = await rpc('harness_claim_and_prepare_generation_v1', {
        p_user_id: userId, p_thread_id: checked.body.thread_id, p_generation_id: generationId,
        p_request_id: checked.body.request_id,
      });
      if (!claim?.claimed) {
        if (message?.replayed === true && claim?.deliveryStatus === 'pending') {
          // The prior Edge invocation ended after the atomic claim but before
          // Gateway acknowledgement. Re-run only the idempotent delivery path.
        } else {
        if (isAcceptedMessageReplay(message, claim)) return json(request, { ok: true, accepted: true, replayed: true, messageId: message.id }, 200);
        return json(request, { ok: false, code: 'THREAD_GENERATION_ACTIVE' }, 409);
        }
      }
    } catch { return json(request, { ok: false, code: 'MESSAGE_ACCEPT_FAILED' }, 503); }

    const processGeneration = async () => {
      let projectedEventIndex = 0;
      const appendEvent = (eventType: string, payload: unknown, messageId: string | null = null, taskId: string | null = null) => rpc('harness_append_event_v1', {
        p_user_id: userId, p_thread_id: checked.body.thread_id,
        p_request_id: `${message.id}:event:${(payload as any)?.nativeSeq ?? projectedEventIndex++}:${eventType}`,
        p_event_type: eventType,
        p_payload: payload, p_task_id: taskId, p_message_id: messageId,
      });
      try {
        const gateway = fixedGatewayBase(gatewayRaw);
        const signedGatewayFetch = async (path: string, body: unknown, timeout = 20_000, method = 'POST') => {
          const rawBody = method === 'POST' ? JSON.stringify(body) : '';
          const timestamp = String(Date.now());
          const { signature } = await signGatewayRequest(gatewaySecret, { method, path, userId, timestamp, rawBody, delegatedAuthorization: authorization });
          return fetch(new URL(path, `${gateway.toString()}/`), {
            method, redirect: 'error', headers: {
              'content-type': 'application/json', 'x-ams-user-id': userId,
              'x-ams-timestamp': timestamp, 'x-ams-signature': signature,
              'x-ams-delegated-authorization': authorization,
            }, body: method === 'POST' ? rawBody : undefined, signal: AbortSignal.timeout(timeout),
          });
        };

        const confirmsCurrentPlan = /^(?:执行|确认执行|开始执行)[。！!]?$/u.test(checked.body.content);
        if (confirmsCurrentPlan && thread.currentTaskId) {
          const taskPath = `/v1/tasks/${thread.currentTaskId}`;
          const readResponse = await signedGatewayFetch(taskPath, null, 20_000, 'GET');
          const readPayload = await readResponse.json().catch(() => null);
          const task = readPayload?.task;
          if (!task?.plan?.fingerprint || task.state !== 'planned') throw new Error('current plan is not confirmable');
          const required = task.plan.approvals || {};
          const confirmResponse = await signedGatewayFetch(`${taskPath}/confirm`, {
            schema_version: 'ams_harness_gateway_v1', task_id: task.id,
            plan_fingerprint: task.plan.fingerprint,
            approval: {
              paid_external_calls: required.paid_external_calls === true,
              online_writes: required.online_writes === true,
              handoff_creation: required.handoff_creation === true,
            },
          });
          const confirmed = await confirmResponse.json().catch(() => null);
          if (!confirmed?.ok) throw new Error(`confirmation rejected: ${confirmed?.code || 'unknown'}`);
          const approvalMessage = await rpc('harness_append_message_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id,
            p_request_id: `${checked.body.request_id}:approval`, p_role: 'system', p_kind: 'approval', p_status: 'completed',
            p_content: '计划已确认，开始执行。', p_structured_payload: { taskId: task.id, approval: required },
            p_task_id: task.id, p_client_message_id: null, p_parent_message_id: message.id,
          });
          await rpc('harness_set_thread_runtime_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id, p_status: 'executing',
            p_native_session_id: thread.nativeSessionId, p_current_task_id: task.id, p_active_generation_id: generationId,
          });
          await appendEvent('task_progress', { state: confirmed.task?.state || 'queued', messageId: approvalMessage.id }, approvalMessage.id, task.id);
          await rpc('harness_close_generation_delivery_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id, p_generation_id: generationId,
            p_request_id: checked.body.request_id, p_status: 'completed',
          });
          await rpc('harness_release_generation_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id,
            p_generation_id: generationId, p_status: 'executing', p_clear_current_task: false,
          });
          return true;
        }

        // Existing deterministic planner is the authority for task intent. A
        // recognized task is persisted as a plan and never reaches the model or
        // a paid provider before confirmation. Only a genuinely unrecognized
        // intent enters the native Harness Q&A session.
        const explicitOrdinaryQuestion = /^(?:你能做什么|你可以做什么|你是谁|怎么使用|如何使用)[？?。!！]*$/u.test(checked.body.content);
        const planResponse = explicitOrdinaryQuestion ? null : await signedGatewayFetch('/v1/tasks/plan', {
          schema_version: 'ams_harness_gateway_v1', request_id: `${checked.body.request_id}:plan`,
          user_id: userId, project_id: thread.thread?.projectId || null, intent: checked.body.content,
        });
        const planPayload = planResponse ? await planResponse.json().catch(() => null) : { code: 'PLANNER_UNRECOGNIZED' };
        if (planPayload?.ok === true && planPayload.task?.plan) {
          const task = planPayload.task;
          await rpc('harness_set_thread_runtime_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id, p_status: 'waiting_confirmation',
            p_native_session_id: thread.nativeSessionId || checked.body.thread_id.replace(/^thr_/, 'session-'),
            p_current_task_id: task.id, p_active_generation_id: generationId,
          });
          await rpc('harness_project_task_event_v1', {
            p_user_id: userId, p_task: task, p_gateway_event: 'planned', p_event_at: task.updated_at,
          });
          await rpc('harness_close_generation_delivery_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id, p_generation_id: generationId,
            p_request_id: checked.body.request_id, p_status: 'completed',
          });
          await rpc('harness_release_generation_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id,
            p_generation_id: generationId, p_status: 'waiting_confirmation', p_clear_current_task: false,
          });
          return true;
        }
        if (planPayload?.code && planPayload.code !== 'PLANNER_UNRECOGNIZED') {
          throw new Error(`planner rejected: ${planPayload.code}`);
        }

        const path = `/v1/threads/${checked.body.thread_id}/deliveries`;
        const deliveryBody = {
          schema_version: 1, thread_id: checked.body.thread_id,
          native_session_id: thread.nativeSessionId || checked.body.thread_id.replace(/^thr_/, 'session-'),
          generation_id: generationId,
          request_id: checked.body.request_id, user_id: userId,
          workspace_id: thread.thread.workspaceId, project_id: thread.thread.projectId,
          content: checked.body.content,
        };
        let response: Response;
        try {
          response = await signedGatewayFetch(path, deliveryBody, 20_000);
        } catch {
          // The Gateway may have fsynced the stable delivery before the ACK
          // connection was lost. Keep the lease and pending row so the exact
          // requestId can be redelivered without a second model invocation.
          return 'confirmation_unknown';
        }
        const delivery = await response.json().catch(() => null);
        const deliveryOutcome = classifyDeliveryResponse(response.status, delivery);
        if (deliveryOutcome === 'confirmation_unknown') {
          return 'confirmation_unknown';
        }
        if (deliveryOutcome === 'rejected') {
          throw Object.assign(new Error('gateway delivery not acknowledged'), { code: delivery?.code || 'GENERATION_DELIVERY_FAILED' });
        }
        try {
          await rpc('harness_ack_generation_delivery_v1', {
            p_user_id: userId, p_thread_id: checked.body.thread_id, p_generation_id: generationId,
            p_request_id: checked.body.request_id, p_gateway_delivery_id: delivery.deliveryId,
          });
        } catch {
          // Gateway has already durably accepted ownership. Its signed,
          // replayable generation_started callback reconciles the DB state;
          // releasing here could permit a duplicate model call.
        }
        return true;
      } catch (error) {
        await rpc('harness_fail_generation_delivery_v1', {
          p_user_id: userId, p_thread_id: checked.body.thread_id, p_generation_id: generationId,
          p_request_id: checked.body.request_id,
          p_error_code: (error as any)?.code || 'GENERATION_DELIVERY_FAILED',
        });
        return false;
      }
    };
    const delivered = await processGeneration();
    if (delivered === 'confirmation_unknown') {
      return json(request, {
        ok: false, code: 'GENERATION_DELIVERY_CONFIRMATION_UNKNOWN',
        message: 'Gateway acknowledgement was interrupted. Retry this same message to reconcile safely.',
        messageId: message.id,
      }, 503);
    }
    return delivered
      ? json(request, { ok: true, accepted: true, replayed: message?.replayed === true, messageId: message.id }, message?.replayed ? 200 : 202)
      : json(request, { ok: false, code: 'GENERATION_DELIVERY_FAILED', messageId: message.id }, 503);
  }

  try {
    const gateway = fixedGatewayBase(gatewayRaw);
    const rawBody = checked.body == null ? '' : JSON.stringify(checked.body);
    const timestamp = String(Date.now());
    const { signature } = await signGatewayRequest(gatewaySecret, {
      method: checked.method,
      path: checked.path,
      userId,
      timestamp,
      rawBody,
      delegatedAuthorization: authorization,
    });
    const target = new URL(checked.path, `${gateway.toString()}/`);
    const response = await fetch(target, {
      method: checked.method,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'x-ams-user-id': userId,
        'x-ams-timestamp': timestamp,
        'x-ams-signature': signature,
        'x-ams-delegated-authorization': authorization,
      },
      body: checked.method === 'POST' ? rawBody : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE) throw new Error('GATEWAY_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_RESPONSE) throw new Error('GATEWAY_RESPONSE_TOO_LARGE');
    let body;
    try { body = JSON.parse(text); } catch { body = { ok: false, code: 'GATEWAY_RESPONSE_INVALID' }; }
    return json(request, body, response.status);
  } catch {
    return json(request, { ok: false, code: 'HARNESS_GATEWAY_UNAVAILABLE' }, 503);
  }
});
