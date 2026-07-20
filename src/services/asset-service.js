import { createAuditLog } from './stability-service';
import { fetchWithSafeHeaders, requireSupabase, sanitizeHttpHeaderValue } from './supabase-client';

const BUCKET = 'marketing-assets';
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
  const extension = sanitizeExtension(file.name.split('.').pop());
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const publicUrl = await uploadFileToStorage(client, path, file);

  const asset = {
    user_id: userId,
    name: metadata.name || file.name,
    type: metadata.type || (file.type.startsWith('video/') ? 'video' : 'image'),
    url: publicUrl,
    thumbnail: metadata.thumbnail || publicUrl,
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

async function uploadFileToStorage(client, path, file) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('请先登录后再上传素材。');

  const encodedPath = path.split('/').map((part) => encodeURIComponent(part)).join('/');
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${BUCKET}/${encodedPath}`;
  const response = await fetchWithSafeHeaders(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': sanitizeHttpHeaderValue(file.type || 'application/octet-stream') || 'application/octet-stream',
      'cache-control': '3600',
      'x-upsert': 'false',
    },
    body: file,
  });

  if (!response.ok) {
    const message = await readStorageError(response);
    throw new Error(message || `素材上传失败：HTTP ${response.status}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${encodedPath}`;
}

async function readStorageError(response) {
  try {
    const payload = await response.json();
    return payload.error || payload.message || payload.msg || '';
  } catch {
    return response.statusText || '';
  }
}

function sanitizeExtension(extension) {
  const safe = String(extension || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return safe || 'bin';
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
