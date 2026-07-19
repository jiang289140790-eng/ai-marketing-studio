import { createAuditLog } from './stability-service';
import { requireSupabase } from './supabase-client';

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

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createPrompt(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('prompts')
    .insert({ ...payload, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: 'prompt',
    entity_id: data.id,
    action: 'create',
    after_data: data,
  });
  return data;
}

export async function updatePrompt(id, payload) {
  const client = requireSupabase();
  const { data: before } = await client.from('prompts').select('*').eq('id', id).single();
  const { data, error } = await client.from('prompts').update(payload).eq('id', id).select().single();
  if (error) throw error;
  await createAuditLog(data.user_id, {
    entity_type: 'prompt',
    entity_id: id,
    action: 'update',
    before_data: before,
    after_data: data,
  });
  return data;
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
