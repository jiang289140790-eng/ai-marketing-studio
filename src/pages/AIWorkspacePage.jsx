import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/auth-context.js';
import {
  HARNESS_ACTIVE_PROJECT_KEY,
  createHarnessClient,
  newHarnessRequestId,
  readHarnessActiveProject,
} from '../services/harness-client.js';
import './AIWorkspacePage.css';

const DEFAULT_HARNESS_WEB_URL = 'https://harness-web.47-251-244-196.sslip.io';

function getHarnessWebUrl() {
  return String(
    import.meta.env.VITE_DSH_WEB_URL
      || import.meta.env.VITE_DEEPSEEK_HARNESS_WEB_URL
      || DEFAULT_HARNESS_WEB_URL,
  ).trim().replace(/\/$/, '');
}

export function AIWorkspacePage() {
  const harnessWebUrl = getHarnessWebUrl();
  const { authUrl, error: authError, isAuthenticated, loading: authLoading, loginWithGitHub } = useAuth();
  const [bootstrapError, setBootstrapError] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!harnessWebUrl || authLoading || !isAuthenticated) return;
    let active = true;

    async function openHarness() {
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
        }
        if (!active) return;
        if (projectId) {
          try { globalThis.localStorage?.removeItem?.(HARNESS_ACTIVE_PROJECT_KEY); } catch { /* best effort */ }
        }
      }

      if (active) {
        setBootstrapError(
          lastError?.code
            ? `${lastError.code}: ${lastError.message || 'Native bootstrap failed.'}`
            : 'NATIVE_BOOTSTRAP_FAILED: Native bootstrap failed.',
        );
      }
    }

    openHarness();
    return () => { active = false; };
  }, [authLoading, harnessWebUrl, isAuthenticated]);

  async function signIn() {
    setLoginError('');
    setIsSigningIn(true);
    try {
      await loginWithGitHub();
    } catch (error) {
      setIsSigningIn(false);
      setLoginError(error?.message || 'GitHub 登录启动失败，请稍后重试。');
    }
  }

  if (authLoading || (isAuthenticated && !bootstrapError)) {
    return null;
  }

  return (
    <main className="official-harness-auth-gate">
      <section>
        <p className="official-harness-kicker">AMS × DEEPSEEK HARNESS</p>
        <h1>探索未至之境</h1>
        <p>先登录 AMS，再进入官方 Harness。AMS 只负责授权和结果沉淀。</p>
        <button type="button" onClick={signIn} disabled={isSigningIn}>
          {isSigningIn ? '正在跳转 GitHub…' : 'GitHub 登录并进入 Harness'}
        </button>
        {authUrl ? <p className="official-harness-auth-link"><a href={authUrl}>继续 GitHub 授权</a></p> : null}
        {authError || loginError || bootstrapError
          ? <p className="official-harness-error">{authError || loginError || bootstrapError}</p>
          : null}
      </section>
    </main>
  );
}
