import { useState } from 'react';
import { useAuth } from '../contexts/auth-context';
import { isSupabaseConfigured } from '../services/supabase-client';

export function Header({ title }) {
  const { authUrl, loading, loginWithGitHub, logout, profile, user } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [signInError, setSignInError] = useState('');
  const displayName = profile?.username || user?.user_metadata?.user_name || user?.user_metadata?.preferred_username || user?.email;
  const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url;

  async function handleGitHubSignIn() {
    setSignInError('');
    setIsSigningIn(true);

    try {
      await loginWithGitHub();
      window.setTimeout(() => {
        setIsSigningIn(false);
        setSignInError('如果没有自动跳转，请点击下方“继续 GitHub 授权”。');
      }, 1800);
    } catch (error) {
      setIsSigningIn(false);
      setSignInError(error.message || 'GitHub 登录启动失败，请稍后重试。');
    }
  }

  return (
    <header className="header">
      <div>
        <p className="eyebrow">个人 AI 运营工作台</p>
        <h1>{title}</h1>
      </div>

      <div className="header-actions">
        {!isSupabaseConfigured && <span className="config-pill warning">等待数据服务配置</span>}
        {user ? (
          <>
            <span className="status-badge connected">已登录</span>
            <div className="user-chip">
              {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{user.email?.[0]?.toUpperCase() || 'U'}</span>}
              <div>
                <strong>{displayName || 'GitHub 用户'}</strong>
                <small>{user.email}</small>
              </div>
            </div>
            <button className="ghost-button" type="button" onClick={logout}>
              退出
            </button>
          </>
        ) : (
          <div className="login-stack">
            <button className="primary-button" type="button" onClick={handleGitHubSignIn} disabled={!isSupabaseConfigured || isSigningIn || loading}>
              {isSigningIn ? '正在跳转...' : 'GitHub 登录'}
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
