import { requireSupabase } from './supabase-client';

export function getAccountRole(account = {}) {
  const roles = [
    account.account_role,
    account.account_type,
    account.account_category,
  ].map((role) => String(role || '').trim()).filter(Boolean);

  return roles.find((role) => ['competitor', 'inspiration'].includes(role.toLowerCase()))
    || roles[0]
    || 'owned';
}

function normalizeAccountRole(payload = {}) {
  const role = getAccountRole(payload);
  if (role === 'brand' || role === 'personal') return 'owned';
  return role;
}

export async function listSocialAccounts(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('social_accounts')
    .select('*, account_profiles(*), platform_connections(*)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function createSocialAccount(userId, payload) {
  const client = requireSupabase();
  const accountRole = normalizeAccountRole(payload);
  const { data, error } = await client
    .from('social_accounts')
    .insert({
      ...payload,
      user_id: userId,
      username: payload.username || payload.account_name,
      account_name: payload.account_name || payload.username,
      account_role: accountRole,
      account_type: accountRole,
      account_category: accountRole,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateSocialAccount(id, payload) {
  const client = requireSupabase();
  const accountRole = normalizeAccountRole(payload);
  const update = {
    ...payload,
    username: payload.username || payload.account_name,
    account_name: payload.account_name || payload.username,
    account_role: accountRole,
    account_type: accountRole,
    account_category: accountRole,
  };

  const { data, error } = await client.from('social_accounts').update(update).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function deleteSocialAccount(id) {
  const client = requireSupabase();
  const { error } = await client.from('social_accounts').delete().eq('id', id);
  if (error) throw error;
}

export async function listAccountProfiles(userId) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('account_profiles')
    .select('*, social_accounts(account_name,username,platform,account_role)')
    .eq('user_id', userId)
    .order('last_analyzed_at', { ascending: false, nullsFirst: false });

  if (error) throw error;
  return data || [];
}

export async function upsertAccountProfile(userId, accountId, payload) {
  const client = requireSupabase();
  const { data, error } = await client
    .from('account_profiles')
    .upsert({
      ...payload,
      user_id: userId,
      account_id: accountId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,account_id' })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function analyzeAccountWithAI() {
  throw new Error('账号 AI 分析入口已预留；请先迁移本地 Command Center 的 Account Intelligence Agent。');
}

export async function generateDailyStrategy() {
  throw new Error('今日策略入口已预留；请先迁移本地 Command Center 的 Strategy Agent。');
}
