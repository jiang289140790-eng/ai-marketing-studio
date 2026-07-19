import { requireSupabase } from './supabase-client';

export async function listSocialAccounts(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('social_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createSocialAccount(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('social_accounts')
    .insert({ ...payload, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSocialAccount(id, payload) {
  const client = requireSupabase();
  const { data, error } = await client.from('social_accounts').update(payload).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSocialAccount(id) {
  const client = requireSupabase();
  const { error } = await client.from('social_accounts').delete().eq('id', id);
  if (error) throw error;
}
