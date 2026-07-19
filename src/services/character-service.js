import { requireSupabase } from './supabase-client';

export async function listCharacters(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('characters')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.search) {
    query = query.or(`name.ilike.%${filters.search}%,description.ilike.%${filters.search}%,personality.ilike.%${filters.search}%`);
  }

  if (filters.tag) {
    query = query.contains('tags', [filters.tag]);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createCharacter(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('characters')
    .insert({ ...payload, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateCharacter(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('characters').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteCharacter(id) {
  const client = requireSupabase();
  const { error } = await client.from('characters').delete().eq('id', id);
  if (error) throw error;
}
