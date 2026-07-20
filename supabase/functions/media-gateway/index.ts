import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7';

type MediaAction = 'generateImage';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return jsonResponse({ ok: true });

  try {
    if (request.method !== 'POST') {
      return jsonResponse({ status: 'failed', error: { code: 'method_not_allowed', message: 'Use POST.' } }, 405);
    }

    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return jsonResponse({ status: 'failed', error: { code: 'unauthorized', message: 'Missing Authorization header.' } }, 401);
    }

    const { client, user } = await createAuthorizedClient(authHeader);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action || 'generateImage') as MediaAction;

    if (action !== 'generateImage') {
      return jsonResponse({ status: 'failed', error: { code: 'unsupported_action', message: 'Only generateImage is supported in this MVP.' } }, 400);
    }

    const result = await generateImage(client, user.id, String(body.workflow_run_id || ''));
    return jsonResponse(result);
  } catch (error) {
    const normalized = normalizeMediaError(error);
    return jsonResponse({ status: 'failed', error: normalized }, normalized.status);
  }
});

async function generateImage(client: ReturnType<typeof createClient>, userId: string, workflowRunId: string) {
  const startedAt = Date.now();
  if (!workflowRunId) throw new Error('Missing workflow_run_id.');

  const run = await loadWorkflowRun(client, userId, workflowRunId);
  await updateWorkflowRun(client, workflowRunId, {
    status: 'running',
    error_message: null,
    last_error: null,
  });

  try {
    const content = await loadContent(client, userId, String(run.input_data?.content_id || ''));
    const comfyWorkflow = await loadComfyWorkflow(client, userId, String(run.input_data?.comfy_workflow_id || ''));
    const prompt = content.prompt_id ? await loadPrompt(client, userId, content.prompt_id) : null;
    const character = content.character_id ? await loadCharacter(client, userId, content.character_id) : null;
    const finalPrompt = buildPositivePrompt(content, prompt, character, run.input_data || {});
    const resolvedLoras = resolveLoras(character, comfyWorkflow, run.input_data?.options || {});
    const workflowJson = buildComfyWorkflowPayload(comfyWorkflow, {
      positive_prompt: finalPrompt,
      negative_prompt: String(run.input_data?.options?.negative_prompt || comfyWorkflow.default_params?.negative_prompt || ''),
      seed: run.input_data?.options?.seed ?? comfyWorkflow.default_params?.seed ?? -1,
      width: run.input_data?.options?.width ?? comfyWorkflow.default_params?.width,
      height: run.input_data?.options?.height ?? comfyWorkflow.default_params?.height,
      steps: run.input_data?.options?.steps ?? comfyWorkflow.default_params?.steps,
      cfg: run.input_data?.options?.cfg ?? comfyWorkflow.default_params?.cfg,
      checkpoint: run.input_data?.options?.checkpoint || comfyWorkflow.checkpoint,
      lora: firstLoraName(resolvedLoras),
    });

    const comfyResult = await runComfyWorkflow(workflowJson);
    const outputFile = extractFirstImage(comfyResult.history, comfyResult.prompt_id);
    if (!outputFile) throw new Error('comfyui_generation_failed: ComfyUI finished but no image output was found.');

    const fileBlob = await fetchComfyOutput(outputFile);
    const storagePath = `${userId}/generated/${workflowRunId}/${safeFilename(outputFile.filename || 'comfyui-output.png')}`;
    const publicUrl = await uploadOutput(client, storagePath, fileBlob, contentTypeForFile(outputFile.filename || 'output.png'));
    const durationMs = Math.max(0, Date.now() - startedAt);

    const { data: asset, error: assetError } = await client
      .from('assets')
      .insert({
        user_id: userId,
        name: `${content.title || 'ComfyUI'} 素材`,
        type: 'image',
        url: publicUrl,
        thumbnail: publicUrl,
        prompt: finalPrompt,
        model: comfyWorkflow.model || comfyWorkflow.checkpoint || null,
        workflow: {
          provider: 'comfyui',
          workflow_run_id: workflowRunId,
          comfy_workflow_id: comfyWorkflow.id,
          workflow_version: comfyWorkflow.version,
          category: comfyWorkflow.category || 'character_generation',
          comfy_prompt_id: comfyResult.prompt_id,
          checkpoint: comfyWorkflow.checkpoint,
          loras: resolvedLoras,
          output_file: outputFile,
        },
        tags: ['ai-generated', 'comfyui', 'image', `content:${content.id}`],
        source: 'workflow-runtime',
      })
      .select('*')
      .single();
    if (assetError) throw assetError;

    await client
      .from('content_library')
      .update({
        asset_id: asset.id,
        media_url: publicUrl,
        generation_brief: {
          ...(content.generation_brief || {}),
          asset_generation: {
            provider: 'comfyui',
            workflow_run_id: workflowRunId,
            comfy_workflow_id: comfyWorkflow.id,
            asset_id: asset.id,
            url: publicUrl,
            completed_at: new Date().toISOString(),
          },
        },
      })
      .eq('id', content.id)
      .eq('user_id', userId);

    await updateWorkflowRun(client, workflowRunId, {
      status: 'success',
      cost: Number(run.cost || 0),
      completed_at: new Date().toISOString(),
      output_data: {
        provider: 'comfyui',
        mode: 'image',
        comfy_prompt_id: comfyResult.prompt_id,
        asset_id: asset.id,
        content_id: content.id,
        url: publicUrl,
        thumbnail: publicUrl,
        storage_path: storagePath,
        model: comfyWorkflow.model,
        category: comfyWorkflow.category || 'character_generation',
        checkpoint: comfyWorkflow.checkpoint,
        duration_ms: durationMs,
        output_file: outputFile,
      },
      error_message: null,
      last_error: null,
    });

    await client.from('cost_records').insert({
      user_id: userId,
      category: 'workflow',
      source: 'comfyui',
      amount: Number(run.cost || 0),
      metadata: {
        workflow_run_id: workflowRunId,
        asset_id: asset.id,
        content_id: content.id,
        comfy_workflow_id: comfyWorkflow.id,
        duration_ms: durationMs,
      },
    });

    return {
      status: 'success',
      provider: 'comfyui',
      mode: 'image',
      workflow_run_id: workflowRunId,
      asset_id: asset.id,
      content_id: content.id,
      url: publicUrl,
      thumbnail: publicUrl,
      model: comfyWorkflow.model || comfyWorkflow.checkpoint || null,
      cost: { amount: Number(run.cost || 0), currency: 'local' },
      duration_ms: durationMs,
    };
  } catch (error) {
    const normalized = normalizeMediaError(error);
    await updateWorkflowRun(client, workflowRunId, {
      status: 'failed',
      error_message: normalized.message,
      last_error: normalized.message,
      completed_at: new Date().toISOString(),
    });
    throw error;
  }
}

async function loadWorkflowRun(client: ReturnType<typeof createClient>, userId: string, id: string) {
  const { data, error } = await client
    .from('workflow_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function loadContent(client: ReturnType<typeof createClient>, userId: string, id: string) {
  if (!id) throw new Error('Missing content_id in workflow run.');
  const { data, error } = await client
    .from('content_library')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function loadComfyWorkflow(client: ReturnType<typeof createClient>, userId: string, id: string) {
  if (!id) throw new Error('Missing comfy_workflow_id in workflow run.');
  const { data, error } = await client
    .from('comfy_workflows')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();
  if (error) throw error;
  if (data.status !== 'active') throw new Error('Selected ComfyUI workflow is not active.');
  if (data.mode !== 'image') throw new Error('Only image workflows are supported in this MVP.');
  if (!data.workflow_json || Object.keys(data.workflow_json).length === 0) {
    throw new Error('Selected ComfyUI workflow has no workflow_json.');
  }
  return data;
}

async function loadPrompt(client: ReturnType<typeof createClient>, userId: string, id: string) {
  const { data, error } = await client.from('prompts').select('*').eq('user_id', userId).eq('id', id).single();
  if (error) throw error;
  return data;
}

async function loadCharacter(client: ReturnType<typeof createClient>, userId: string, id: string) {
  const { data, error } = await client.from('characters').select('*').eq('user_id', userId).eq('id', id).single();
  if (error) throw error;
  return data;
}

function buildPositivePrompt(content: Record<string, any>, prompt: Record<string, any> | null, character: Record<string, any> | null, inputData: Record<string, any>) {
  return [
    prompt?.content,
    character?.prompt,
    character?.appearance ? `Character appearance: ${character.appearance}` : '',
    content.title ? `Content title: ${content.title}` : '',
    content.content_text || content.idea_notes || '',
    inputData?.options?.positive_prompt || '',
  ].filter(Boolean).join('\n\n').trim();
}

function resolveLoras(character: Record<string, any> | null, workflow: Record<string, any>, options: Record<string, any>) {
  if (Array.isArray(options.loras) && options.loras.length) return options.loras;
  if (character?.lora) {
    return [{
      name: character.lora,
      strength_model: Number(options.lora_strength_model ?? 0.8),
      strength_clip: Number(options.lora_strength_clip ?? 0.8),
      source: 'character',
    }];
  }
  return Array.isArray(workflow.loras) ? workflow.loras : [];
}

function firstLoraName(loras: unknown[]) {
  const first = loras[0];
  if (!first) return '';
  if (typeof first === 'string') return first;
  if (typeof first === 'object' && first !== null && 'name' in first) return String((first as Record<string, unknown>).name || '');
  return String(first);
}

function buildComfyWorkflowPayload(workflow: Record<string, any>, inputs: Record<string, any>) {
  const payload = structuredClone(workflow.workflow_json || {});
  const mappings = workflow.node_mappings || {};
  const schemaFields = workflow.input_schema?.fields || {};

  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null || value === '') continue;
    const mapping = mappings[key] || schemaFields[key];
    if (mapping?.node_id && Array.isArray(mapping.path)) {
      setPath(payload, [String(mapping.node_id), ...mapping.path], value);
    } else if (mapping?.node_id && typeof mapping.input === 'string') {
      setPath(payload, [String(mapping.node_id), 'inputs', mapping.input], value);
    } else if (typeof mapping?.target === 'string') {
      const match = mapping.target.match(/^node:([^.]+)\.(.+)$/);
      if (match) setPath(payload, [match[1], ...match[2].split('.')], value);
    }
  }

  return payload;
}

function setPath(target: Record<string, any>, path: string[], value: unknown) {
  let cursor: Record<string, any> = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
}

async function runComfyWorkflow(workflowJson: Record<string, any>) {
  const baseUrl = String(Deno.env.get('COMFYUI_BASE_URL') || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('COMFYUI_BASE_URL is not configured in Supabase Edge Function Secrets.');
  const clientId = crypto.randomUUID();
  const response = await fetchWithTimeout(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify({
      client_id: clientId,
      prompt: workflowJson,
    }),
  }, Number(Deno.env.get('COMFYUI_TIMEOUT_MS') || 60000));

  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json?.error?.message || json?.error || `comfyui_generation_failed: /prompt failed with ${response.status}.`);
  const promptId = String(json.prompt_id || '');
  if (!promptId) throw new Error('comfyui_generation_failed: /prompt did not return prompt_id.');

  const history = await pollComfyHistory(baseUrl, promptId);
  return { prompt_id: promptId, history };
}

async function pollComfyHistory(baseUrl: string, promptId: string) {
  const pollInterval = Number(Deno.env.get('COMFYUI_POLL_INTERVAL_MS') || 2000);
  const maxPoll = Number(Deno.env.get('COMFYUI_MAX_POLL_MS') || 300000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxPoll) {
    const response = await fetchWithTimeout(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
      method: 'GET',
      headers: comfyHeaders(),
    }, Number(Deno.env.get('COMFYUI_TIMEOUT_MS') || 60000));
    const history = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(history?.error?.message || `comfyui_generation_failed: /history failed with ${response.status}.`);
    if (history?.[promptId]?.outputs && Object.keys(history[promptId].outputs).length > 0) return history;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`comfyui_timeout: ComfyUI generation timed out after ${maxPoll}ms.`);
}

function extractFirstImage(history: Record<string, any>, promptId: string) {
  const outputs = history?.[promptId]?.outputs || {};
  for (const output of Object.values(outputs) as Record<string, any>[]) {
    const images = output.images || [];
    if (Array.isArray(images) && images[0]) return images[0];
  }
  return null;
}

async function fetchComfyOutput(file: Record<string, any>) {
  const baseUrl = String(Deno.env.get('COMFYUI_BASE_URL') || '').replace(/\/$/, '');
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set('filename', String(file.filename || ''));
  url.searchParams.set('subfolder', String(file.subfolder || ''));
  url.searchParams.set('type', String(file.type || 'output'));
  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: comfyHeaders(),
  }, Number(Deno.env.get('COMFYUI_TIMEOUT_MS') || 60000));
  if (!response.ok) throw new Error(`comfyui_generation_failed: /view failed with ${response.status}.`);
  return response.blob();
}

async function uploadOutput(client: ReturnType<typeof createClient>, path: string, blob: Blob, contentType: string) {
  const { error } = await client.storage.from('marketing-assets').upload(path, blob, {
    contentType,
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw new Error(`storage_upload_failed: ${error.message}`);
  const { data } = client.storage.from('marketing-assets').getPublicUrl(path);
  return data.publicUrl;
}

async function updateWorkflowRun(client: ReturnType<typeof createClient>, id: string, payload: Record<string, unknown>) {
  const { error } = await client.from('workflow_runs').update(payload).eq('id', id);
  if (error) throw error;
}

function comfyHeaders() {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const apiKey = Deno.env.get('COMFYUI_API_KEY');
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`comfyui_timeout: ComfyUI request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  return {
    client: createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  };
}

function normalizeMediaError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown Media Gateway error.';
  const lower = message.toLowerCase();
  if (lower.includes('comfyui_base_url')) return { code: 'comfyui_not_configured', message, status: 500, retryable: false };
  if (lower.includes('timeout') || lower.includes('aborted')) return { code: 'comfyui_timeout', message, status: 504, retryable: true };
  if (lower.includes('missing') && (lower.includes('model') || lower.includes('checkpoint'))) return { code: 'comfyui_missing_model', message, status: 400, retryable: false };
  if (lower.includes('lora')) return { code: 'comfyui_missing_lora', message, status: 400, retryable: false };
  if (lower.includes('storage_upload_failed')) return { code: 'storage_upload_failed', message, status: 500, retryable: true };
  if (lower.includes('invalid user session') || lower.includes('unauthorized')) return { code: 'unauthorized', message, status: 401, retryable: false };
  return { code: 'comfyui_generation_failed', message, status: 500, retryable: true };
}

function safeFilename(filename: string) {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || `${crypto.randomUUID()}.png`;
}

function contentTypeForFile(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
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
