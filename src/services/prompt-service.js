import { createAuditLog } from './stability-service';
import { requireSupabase } from './supabase-client';
import {
  calculatePromptSuccessRate,
  extractPromptVariables,
} from '../utils/prompt-template-model';

const PROMPT_FIELDS = ['title', 'category', 'content', 'platform', 'character'];

function databasePayload(payload = {}) {
  return Object.fromEntries(
    PROMPT_FIELDS
      .filter((field) => payload[field] !== undefined)
      .map((field) => [
        field,
        payload[field] || (['character', 'platform'].includes(field) ? null : payload[field]),
      ]),
  );
}

function templateMetadata(payload = {}, fallback = {}) {
  return {
    ...fallback,
    purpose: payload.purpose ?? fallback.purpose ?? '',
    campaign_id: payload.campaign_id ?? fallback.campaign_id ?? null,
    workflow_id: payload.workflow_id ?? fallback.workflow_id ?? null,
    source: payload.source ?? fallback.source ?? 'manual',
    status: payload.status ?? fallback.status ?? 'active',
    change_reason: payload.change_reason ?? fallback.change_reason ?? '',
    variables: extractPromptVariables(payload.content || fallback.content || '').map((item) => item.name),
  };
}

export async function listPrompts(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('prompts')
    .select('*, characters(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.category) query = query.eq('category', filters.category);
  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.character) query = query.eq('character', filters.character);
  if (filters.search) query = query.or(`title.ilike.%${filters.search}%,content.ilike.%${filters.search}%`);

  const [{ data, error }, { data: auditLogs, error: auditError }, { data: runs, error: runsError }] = await Promise.all([
    query,
    client
      .from('audit_logs')
      .select('entity_id,action,metadata,created_at')
      .eq('user_id', userId)
      .eq('entity_type', 'prompt')
      .order('created_at', { ascending: true }),
    client
      .from('workflow_runs')
      .select('id,prompt_id,status,created_at,completed_at')
      .eq('user_id', userId)
      .not('prompt_id', 'is', null),
  ]);
  if (error) throw error;
  if (auditError) throw auditError;
  if (runsError) throw runsError;

  return (data || []).map((prompt) => {
    const promptLogs = (auditLogs || []).filter((log) => String(log.entity_id) === String(prompt.id));
    const latestLog = promptLogs.at(-1);
    const promptRuns = (runs || []).filter((run) => String(run.prompt_id) === String(prompt.id));
    const updateCount = promptLogs.filter((log) => log.action === 'update').length;
    const templateMeta = {
      ...(latestLog?.metadata || {}),
      version: Number(latestLog?.metadata?.version || updateCount + 1),
    };
    return {
      ...prompt,
      campaign_id: templateMeta.campaign_id || null,
      workflow_id: templateMeta.workflow_id || null,
      templateMeta,
      variables: extractPromptVariables(prompt.content),
      usageCount: promptRuns.length,
      successRate: calculatePromptSuccessRate(promptRuns),
      lastUsedAt: [...promptRuns]
        .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))[0]?.completed_at
        || promptRuns[0]?.created_at
        || null,
    };
  });
}

export async function createPrompt(userId, payload, options = {}) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('prompts')
    .insert({ ...databasePayload(payload), user_id: userId })
    .select()
    .single();

  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'prompt',
    entity_id: data.id,
    action: 'create',
    after_data: data,
    metadata: {
      ...templateMetadata(payload),
      version: 1,
      creation_source: options.source || payload.source || 'manual',
    },
  });
  return data;
}

export async function updatePrompt(id, payload) {
  const client = requireSupabase();
  const { data: before } = await client.from('prompts').select('*').eq('id', id).single();
  const { data: history } = await client
    .from('audit_logs')
    .select('metadata,action')
    .eq('entity_type', 'prompt')
    .eq('entity_id', id)
    .order('created_at', { ascending: true });
  const previousMeta = history?.at(-1)?.metadata || {};
  const version = Number(previousMeta.version || history?.filter((item) => item.action === 'update').length + 1) + 1;
  const { data, error } = await client.from('prompts').update(databasePayload(payload)).eq('id', id).select().single();
  if (error) throw error;
  await createAuditLog(data.user_id, {
    entity_type: 'prompt',
    entity_id: id,
    action: 'update',
    before_data: before,
    after_data: data,
    metadata: {
      ...templateMetadata(payload, { ...previousMeta, content: data.content }),
      version,
      previous_version: version - 1,
    },
  });
  return data;
}

export async function listPromptVersions(userId, promptId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('audit_logs')
    .select('id,action,before_data,after_data,metadata,created_at')
    .eq('user_id', userId)
    .eq('entity_type', 'prompt')
    .eq('entity_id', promptId)
    .in('action', ['create', 'update'])
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((entry, index) => ({
    ...entry,
    version: Number(entry.metadata?.version || (data.length - index)),
    snapshot: entry.after_data || entry.before_data || {},
    changeReason: entry.metadata?.change_reason || (entry.action === 'create' ? '初始创建' : '未填写修改原因'),
    source: entry.metadata?.source || entry.metadata?.creation_source || 'manual',
  }));
}

export async function deletePrompt(id) {
  const client = requireSupabase();
  const { data: before } = await client.from('prompts').select('*').eq('id', id).single();
  const { error } = await client.from('prompts').delete().eq('id', id);
  if (error) throw error;
  if (before?.user_id) {
    await createAuditLog(before.user_id, {
      entity_type: 'prompt',
      entity_id: id,
      action: 'delete',
      before_data: before,
    });
  }
}
