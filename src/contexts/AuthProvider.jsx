import { useCallback, useEffect, useMemo, useState } from 'react';
import { createGitHubSignInUrl, initializeAuthSession, signOut, upsertProfile } from '../services/auth-service';
import { isSupabaseConfigured, supabase } from '../services/supabase-client';
import { AuthContext } from './auth-context';

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');

  const syncProfile = useCallback(async (user) => {
    if (!user) {
      setProfile(null);
      return;
    }

    try {
      setProfile(await upsertProfile(user));
    } catch (profileError) {
      console.warn('Profile sync failed; continuing with auth session.', profileError);
      setProfile(null);
    }
  }, []);

  const applySession = useCallback(async (nextSession) => {
    setSession(nextSession);
    await syncProfile(nextSession?.user);
  }, [syncProfile]);

  const loginWithGitHub = useCallback(async () => {
    setError('');
    const nextUrl = await createGitHubSignInUrl();
    setAuthUrl(nextUrl);
    window.location.assign(nextUrl);
    return nextUrl;
  }, []);

  const logout = useCallback(async () => {
    setError('');
    setAuthUrl('');
    await signOut();
    await applySession(null);
  }, [applySession]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return undefined;
    }

    let mounted = true;

    async function bootAuth() {
      setLoading(true);
      setError('');

      try {
        const callbackSession = await initializeAuthSession();
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;

        if (!mounted) return;
        await applySession(callbackSession || data.session);
      } catch (authError) {
        if (!mounted) return;
        setError(authError.message || '登录状态初始化失败。');
        await applySession(null);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (!mounted) return;
      setError('');
      setAuthUrl('');
      await applySession(nextSession);
      setLoading(false);
    });

    bootAuth();

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [applySession]);

  const value = useMemo(
    () => ({
      authUrl,
      error,
      isAuthenticated: Boolean(session?.user),
      loading,
      loginWithGitHub,
      logout,
      profile,
      session,
      user: session?.user || null,
      userId: session?.user?.id || null,
    }),
    [authUrl, error, loading, loginWithGitHub, logout, profile, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
