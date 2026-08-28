import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/auth-context.js';
import {
  HARNESS_ACTIVE_PROJECT_KEY,
  createHarnessClient,
  newHarnessRequestId,
  readHarnessActiveProject,
} from '../services/harness-client.js';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function getHarnessWebUrl() {
  return String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim().replace(/\/$/, '');
}

/**
 * The AI workspace is the official DeepSeek Harness Web application itself.
 * AMS must not reproduce, wrap, decorate, or productize the Harness homepage.
 */
export function AIWorkspacePage() {
  const harnessWebUrl = getHarnessWebUrl();
  const { authUrl, error: authError, isAuthenticated, loading: authLoading, loginWithGitHub } = useAuth();
  const [bootstrapError, setBootstrapError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!harnessWebUrl || authLoading || !isAuthenticated) return;
    let active = true;
    const openHarness = async () => {
      setBootstrapError('');
      const client = createHarnessClient();
      const activeProjectId = readHarnessActiveProject();
      const bootstrapProjectIds = activeProjectId ? [activeProjectId, null] : [null];
      let lastError = null;

      for (const projectId of bootstrapProjectIds) {
        try {
          const result = await client.createNativeBootstrap({
            projectId,
            requestId: newHarnessRequestId(),
          });
          if (active && result?.bootstrapId) {
            globalThis.location?.replace?.(`${harnessWebUrl}#ams-bootstrap=${encodeURIComponent(result.bootstrapId)}`);
            return;
          }
        } catch (error) {
          lastError = error;
          /* Try a user-only bootstrap if the remembered project no longer exists. */
        }
        if (!active) return;
        if (projectId) {
          try { globalThis.localStorage?.removeItem?.(HARNESS_ACTIVE_PROJECT_KEY); } catch { /* Storage is best-effort. */ }
        }
      }
      if (active) setBootstrapError(
        lastError?.code
          ? `${lastError.code}: ${lastError.message || 'Native bootstrap failed.'}`
          : 'NATIVE_BOOTSTRAP_FAILED: Native bootstrap failed.',
      );
    };
    openHarness();
    return () => { active = false; };
  }, [authLoading, harnessWebUrl, isAuthenticated]);

  if (authLoading || (isAuthenticated && !bootstrapError)) return null;

  const signIn = async () => {
    setLoginError('');
    setIsSigningIn(true);
    try {
      await loginWithGitHub();
    } catch (error) {
      setIsSigningIn(false);
      setLoginError(error?.message || 'GitHub 登录启动失败，请稍后重试。');
    }
  };

  return (
    <main className="official-harness-auth-gate" style={{
      alignItems: 'center',
      background: '#fff',
      color: '#0f172a',
      display: 'flex',
      minHeight: '100vh',
      justifyContent: 'center',
      padding: 24,
    }}>
      <section style={{ maxWidth: 720, textAlign: 'center' }}>
        <p style={{ color: '#0f766e', fontWeight: 800, letterSpacing: '0.08em', marginBottom: 12 }}>AMS × DEEPSEEK HARNESS</p>
        <h1 style={{ fontSize: 'clamp(40px, 8vw, 72px)', lineHeight: 1, margin: 0 }}>探索未至之境</h1>
        <p style={{ color: '#475569', fontSize: 18, margin: '20px 0 28px' }}>先登录 AMS，再进入 Harness。这样插件才能读取当前项目和业务结果。</p>
        <button
          type="button"
          onClick={signIn}
          disabled={isSigningIn}
          style={{
            background: '#0f172a',
            border: 0,
            borderRadius: 999,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 16,
            fontWeight: 800,
            padding: '14px 28px',
          }}
        >
          {isSigningIn ? '正在跳转 GitHub...' : 'GitHub 登录并进入 Harness'}
        </button>
        {authUrl ? <p style={{ marginTop: 16 }}><a href={authUrl}>继续 GitHub 授权</a></p> : null}
        {authError || loginError || bootstrapError
          ? <p style={{ color: '#dc2626', marginTop: 16 }}>{authError || loginError || bootstrapError}</p>
          : null}
      </section>
    </main>
  );
}
