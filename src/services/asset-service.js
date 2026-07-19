import { createAuditLog } from './stability-service';
import { requireSupabase } from './supabase-client';

const BUCKET = 'marketing-assets';

export async function listAssets(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('assets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function searchAssets(userId, filters = {}) {
  const client = requireSupabase();
  let query = client
    .from('assets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.type) query = query.eq('type', filters.type);
  if (filters.search) query = query.or(`name.ilike.%${filters.search}%,prompt.ilike.%${filters.search}%,model.ilike.%${filters.search}%`);
  if (filters.tag) query = query.contains('tags', [filters.tag]);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function createAsset(userId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('assets')
    .insert({ ...payload, user_id: userId })
    .select()
    .single();

  if (error) throw error;
  await createAuditLog(userId, {
    entity_type: payload.type === 'workflow' ? 'workflow' : 'asset',
    entity_id: data.id,
    action: 'create',
    after_data: data,
  });
  return data;
}

export async function deleteAsset(id) {
  const client = requireSupabase();
  const { data: before } = await client.from('assets').select('*').eq('id', id).single();
  const { error } = await client.from('assets').delete().eq('id', id);
  if (error) throw error;
  if (before?.user_id) {
    await createAuditLog(before.user_id, {
      entity_type: before.type === 'workflow' ? 'workflow' : 'asset',
      entity_id: id,
      action: 'delete',
      before_data: before,
    });
  }
}

export async function uploadAsset(userId, file, metadata = {}) {
  const client = requireSupabase();
  const extension = file.name.split('.').pop();
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;

  const { error: uploadError } = await client.storage.from(BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = client.storage.from(BUCKET).getPublicUrl(path);
  const asset = {
    user_id: userId,
    name: metadata.name || file.name,
    type: metadata.type || (file.type.startsWith('video/') ? 'video' : 'image'),
    url: publicUrlData.publicUrl,
    thumbnail: metadata.thumbnail || publicUrlData.publicUrl,
    prompt: metadata.prompt || null,
    model: metadata.model || null,
    workflow: metadata.workflow || null,
    tags: metadata.tags || [],
    source: 'upload',
  };

  const { data, error } = await client.from('assets').insert(asset).select().single();
  if (error) throw error;
  return data;
}

export async function savePromptAsset(userId, prompt) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('assets')
    .insert({ user_id: userId, name: prompt.slice(0, 80) || 'Prompt asset', type: 'prompt', prompt, source: 'manual' })
    .select()
    .single();

  if (error) throw error;
  return data;
}
