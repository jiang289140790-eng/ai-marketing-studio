import { requireSupabase } from './supabase-client';

export async function listViralAnalysis(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('viral_analysis')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}
