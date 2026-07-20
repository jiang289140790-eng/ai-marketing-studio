import { createClient } from '@supabase/supabase-js';
import {
  buildSafeHeadersObject,
  installSafeHeadersPatch,
  sanitizeHttpHeaderName,
  sanitizeHttpHeaderValue,
} from '../utils/safe-headers';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const authStorageKey = 'ai-marketing-studio-auth-session';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

installSafeHeadersPatch();

export { buildSafeHeadersObject, sanitizeHttpHeaderName, sanitizeHttpHeaderValue };

function mergeSafeHeaders(...headerSources) {
  const merged = {};

  for (const source of headerSources) {
    Object.assign(merged, buildSafeHeadersObject(source));
  }

  return merged;
}

export async function fetchWithSafeHeaders(input, init = {}) {
  const request = input instanceof globalThis.Request ? input : null;
  const requestInit = request
    ? {
        method: request.method,
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
        signal: request.signal,
      }
    : {};
  const safeInit = {
    ...requestInit,
    ...init,
    headers: mergeSafeHeaders(request?.headers, init.headers),
  };

  return globalThis.fetch(request?.url || input, safeInit);
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
        fetch: fetchWithSafeHeaders,
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
