import { requireSupabase } from './supabase-client';

export async function getCurrentSession() {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data.session;
}

function isCorruptedAuthStorageError(error) {
  return String(error?.message || error).includes('non ISO-8859-1 code point');
}

export function resetStoredAuthSession() {
  if (typeof window === 'undefined') return;

  const storageKeys = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key) continue;
    if (key.includes('supabase') || key.includes('sb-') || key.includes('qtrlymiqohbjvklwegsw')) {
      storageKeys.push(key);
    }
  }

  storageKeys.forEach((key) => window.localStorage.removeItem(key));
  window.sessionStorage.clear();
  cleanAuthParamsFromUrl();
}

function cleanAuthParamsFromUrl() {
  const cleanUrl = new window.URL(window.location.href);
  [
    'code',
    'error',
    'error_code',
    'error_description',
    'access_token',
    'expires_at',
    'expires_in',
    'provider_token',
    'refresh_token',
    'token_type',
    'sb',
  ].forEach((key) => cleanUrl.searchParams.delete(key));
  cleanUrl.hash = '';
  window.history.replaceState({}, document.title, cleanUrl.toString());
}

export async function initializeAuthSession() {
  try {
    const client = requireSupabase();
    const url = new window.URL(window.location.href);
    const code = url.searchParams.get('code');
    const hashParams = new window.URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    if (code) {
      const { data, error } = await client.auth.exchangeCodeForSession(code);
      cleanAuthParamsFromUrl();
      if (error) {
        const currentSession = await getCurrentSession();
        if (currentSession) return currentSession;
        throw error;
      }
      return data.session;
    }

    if (accessToken && refreshToken) {
      const { data, error } = await client.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });
      cleanAuthParamsFromUrl();
      if (error) throw error;
      return data.session;
    }

    return await getCurrentSession();
  } catch (error) {
    if (isCorruptedAuthStorageError(error)) {
      resetStoredAuthSession();
      return null;
    }
    throw error;
  }
}

export function onAuthStateChange(callback) {
  const client = requireSupabase();
  const { data } = client.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

export async function signInWithGitHub() {
  const client = requireSupabase();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
  if (error) throw error;
}

export async function signOut() {
  const client = requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}

export async function upsertProfile(user) {
  const client = requireSupabase();
  if (!user) return null;

  const profile = {
    id: user.id,
    email: user.email,
    username: user.user_metadata?.full_name || user.email?.split('@')[0],
    avatar_url: user.user_metadata?.avatar_url,
  };

  const { data, error } = await client
    .from('profiles')
    .upsert(profile, { onConflict: 'id' })
    .select()
    .single();

  if (error) throw error;
  return data;
}
