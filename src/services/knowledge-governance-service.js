import { requireSupabase } from './supabase-client';

export async function listKnowledgeHistory(userId, knowledgeId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('audit_logs')
    .select('id,action,before_data,after_data,metadata,created_at')
    .eq('user_id', userId)
    .eq('entity_type', 'knowledge_entry')
    .eq('entity_id', knowledgeId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
