import { signInWithGitHub, signOut } from '../services/auth-service';
import { isSupabaseConfigured } from '../services/supabase-client';

export function Header({ session, profile, title }) {
  const user = session?.user;

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
              {profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : <span>{user.email?.[0]?.toUpperCase()}</span>}
              <div>
                <strong>{profile?.username || user.email}</strong>
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
