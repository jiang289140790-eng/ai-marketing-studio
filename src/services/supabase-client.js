import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const authStorageKey = 'ai-marketing-studio-auth-session';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function toAsciiHeaderValue(value) {
  return String(value ?? '').replace(/[^\x20-\x7E]/g, '');
}

function toAsciiHeaderName(name) {
  return String(name ?? '').replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, '');
}

function createSafeHeaders(headers) {
  const safeHeaders = new globalThis.Headers();

  if (!headers) return safeHeaders;

  const setSafeHeader = (key, value) => {
    const safeKey = toAsciiHeaderName(key);
    if (!safeKey) return;
    safeHeaders.set(safeKey, toAsciiHeaderValue(value));
  };

  if (headers instanceof globalThis.Headers) {
    headers.forEach((value, key) => setSafeHeader(key, value));
    return safeHeaders;
  }

  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => setSafeHeader(key, value));
    return safeHeaders;
  }

  Object.entries(headers).forEach(([key, value]) => setSafeHeader(key, value));

  return safeHeaders;
}

async function safeFetch(input, init = {}) {
  const safeInit = {
    ...init,
    headers: createSafeHeaders(init.headers),
  };

  return globalThis.fetch(input, safeInit);
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: 'pkce',
        storageKey: authStorageKey,
      },
      global: {
        fetch: safeFetch,
        headers: {
          'X-Client-Info': 'ai-marketing-studio-web',
        },
      },
    })
  : null;

export function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }

  return supabase;
}
