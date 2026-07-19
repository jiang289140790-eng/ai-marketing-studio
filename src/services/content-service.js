import { requireSupabase } from './supabase-client';

export async function listContent(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('content_library')
    .select('*, assets(name,type), characters(name), prompts(title)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.status) query = query.eq('pipeline_stage', filters.status);
  if (filters.platform) query = query.eq('platform', filters.platform);
  if (filters.contentType) query = query.eq('content_type', filters.contentType);
  if (filters.accountCategory) query = query.eq('account_category', filters.accountCategory);
  if (filters.search) query = query.ilike('title', `%${filters.search}%`);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createContentItem(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('content_library')
    .insert({ ...payload, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateContentItem(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('content_library').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteContentItem(id) {
  const client = requireSupabase();
  const { error } = await client.from('content_library').delete().eq('id', id);
  if (error) throw error;
}

export async function listPublishTasks(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('publish_tasks')
    .select('*, content_library(title)')
    .eq('user_id', userId)
    .order('scheduled_time', { ascending: true });

  if (error) throw error;
  return data || [];
}
