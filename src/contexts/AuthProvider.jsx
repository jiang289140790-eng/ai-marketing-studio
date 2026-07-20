import { useCallback, useEffect, useMemo, useState } from 'react';
import { createGitHubSignInUrl, signOut, upsertProfile } from '../services/auth-service';
import { isSupabaseConfigured, supabase } from '../services/supabase-client';
import { AuthContext } from './auth-context';

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState('');
  const [authUrl, setAuthUrl] = useState('');

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
    setSession(null);
    setProfile(null);
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return undefined;
    }

    let mounted = true;

    async function restoreSession() {
      setLoading(true);
      setError('');

      try {
        const { data, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (mounted) setSession(data.session);
      } catch (authError) {
        if (mounted) {
          setError(authError.message || '登录状态恢复失败。');
          setSession(null);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }

    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      setError('');
      setAuthUrl('');
      setSession(nextSession);
      setLoading(false);

      if (event === 'SIGNED_OUT') {
        setProfile(null);
      }
    });

    restoreSession();

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      return undefined;
    }

    let mounted = true;

    upsertProfile(session.user)
      .then((nextProfile) => {
        if (mounted) setProfile(nextProfile);
      })
      .catch((profileError) => {
        console.warn('Profile sync failed; continuing with auth session.', profileError);
        if (mounted) setProfile(null);
      });

    return () => {
      mounted = false;
    };
  }, [session]);

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
