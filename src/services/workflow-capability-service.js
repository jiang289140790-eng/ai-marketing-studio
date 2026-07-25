import { createAuditLog } from './stability-service';
import { requireSupabase } from './supabase-client';

export async function setWorkflowProductionEnabled(userId, workflow, enabled) {
  const client = requireSupabase();
  const nextStatus = enabled ? 'active' : 'inactive';
  const { data, error } = await client
    .from('comfy_workflows')
    .update({ status: nextStatus, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', workflow.id)
    .select('*')
    .single();
  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'comfy_workflow',
    entity_id: workflow.id,
    action: enabled ? 'enable' : 'disable',
    before_data: { status: workflow.status },
    after_data: { status: data.status },
  });
  return data;
}

export async function bindPromptTemplateToWorkflow(userId, workflow, promptId) {
  const client = requireSupabase();
  const defaultParams = {
    ...(workflow.default_params || {}),
    prompt_template_id: promptId || null,
  };
  const { data, error } = await client
    .from('comfy_workflows')
    .update({ default_params: defaultParams, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', workflow.id)
    .select('*')
    .single();
  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'comfy_workflow',
    entity_id: workflow.id,
    action: 'bind_prompt_template',
    before_data: { prompt_template_id: workflow.default_params?.prompt_template_id || null },
    after_data: { prompt_template_id: promptId || null },
  });
  return data;
}

export async function bindCharacterToWorkflow(userId, workflow, character) {
  const client = requireSupabase();
  const existing = Array.isArray(character.recommended_workflows) ? character.recommended_workflows : [];
  const alreadyBound = existing.some((entry) => (
    String(typeof entry === 'object' ? entry.id || entry.workflow_id : entry) === String(workflow.id)
    || String(typeof entry === 'object' ? entry.name || entry.workflow_name : entry) === String(workflow.name)
  ));
  const recommendedWorkflows = alreadyBound ? existing : [
    ...existing,
    {
      id: workflow.id,
      name: workflow.name,
      provider: workflow.default_params?.provider || 'autodl',
      status: workflow.status,
    },
  ];
  const { data, error } = await client
    .from('characters')
    .update({ recommended_workflows: recommendedWorkflows })
    .eq('user_id', userId)
    .eq('id', character.id)
    .select('*')
    .single();
  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'character',
    entity_id: character.id,
    action: 'bind_workflow',
    before_data: { recommended_workflows: existing },
    after_data: { recommended_workflows: recommendedWorkflows },
    metadata: { workflow_id: workflow.id },
  });
  return data;
}

