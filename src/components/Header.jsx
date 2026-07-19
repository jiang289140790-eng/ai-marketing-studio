import { signInWithGitHub, signOut } from '../services/auth-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function Header({ session, profile, title }) {
  const user = session?.user;
  const displayName = profile?.username || user?.user_metadata?.user_name || user?.user_metadata?.preferred_username || user?.email;
  const avatarUrl = profile?.avatar_url || user?.user_metadata?.avatar_url;

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
          <button className="primary-button" type="button" onClick={signInWithGitHub} disabled={!isSupabaseConfigured}>
            GitHub 登录
          </button>
        )}
      </div>
    </header>
  );
}
