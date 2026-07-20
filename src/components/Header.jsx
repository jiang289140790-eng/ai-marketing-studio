import { useState } from 'react';
import { createGitHubSignInUrl, signOut } from '../services/auth-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function Header({ session, profile, title }) {
  const user = session?.user;
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const displayName = profile?.username || user?.user_metadata?.user_name || user?.user_metadata?.preferred_username || user?.email;
  const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url;

  async function handleGitHubSignIn() {
    setSignInError('');
    setAuthUrl('');
    setIsSigningIn(true);

    try {
      const nextUrl = await createGitHubSignInUrl();
      setAuthUrl(nextUrl);
      window.location.assign(nextUrl);

      window.setTimeout(() => {
        setIsSigningIn(false);
        setSignInError('如果页面没有自动跳转，请点击下面的“继续 GitHub 授权”。');
      }, 1800);
    } catch (error) {
      setIsSigningIn(false);
      setSignInError(error.message || 'GitHub 登录启动失败，请稍后重试。');
    }
  }

  return (
    <header className="header">
      <div>
        <p className="eyebrow">Personal AI Ops Workspace</p>
        <h1>{title}</h1>
      </div>

      <div className="header-actions">
        {!isSupabaseConfigured && <span className="config-pill">等待 Supabase 配置</span>}
        {user ? (
          <>
            <span className="status-badge connected">已登录</span>
            <div className="user-chip">
              {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{user.email?.[0]?.toUpperCase()}</span>}
              <div>
                <strong>{displayName}</strong>
                <small>{user.email}</small>
              </div>
            </div>
            <button className="ghost-button" type="button" onClick={signOut}>
              退出
            </button>
          </>
        ) : (
          <div className="login-stack">
            <button className="primary-button" type="button" onClick={handleGitHubSignIn} disabled={!isSupabaseConfigured || isSigningIn}>
              {isSigningIn ? '正在跳转…' : 'GitHub 登录'}
            </button>
            {authUrl && (
              <a className="auth-fallback-link" href={authUrl}>
                继续 GitHub 授权
              </a>
            )}
            {signInError && <span className="inline-error">{signInError}</span>}
          </div>
        )}
      </div>
    </header>
  );
}
