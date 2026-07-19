import { useCallback, useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { platforms } from '../data/navigation';
import { connectTelegramPlatform, listPlatformConnections, summarizeConnections } from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const initialTelegramForm = {
  account_name: '',
  chat_id: '',
  bot_token: '',
};

export function SettingsPage({ userId }) {
  const [connections, setConnections] = useState([]);
  const [telegramForm, setTelegramForm] = useState(initialTelegramForm);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const stats = useMemo(() => summarizeConnections(connections), [connections]);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const nextConnections = await listPlatformConnections(userId);
    setConnections(nextConnections);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  function updateTelegramForm(field, value) {
    setTelegramForm((current) => ({ ...current, [field]: value }));
  }

  async function handleTelegramConnect(event) {
    event.preventDefault();
    setMessage('');
    setLoading(true);
    try {
      const result = await connectTelegramPlatform(telegramForm);
      setTelegramForm(initialTelegramForm);
      setMessage(`Telegram 已连接：${result.bot?.username ? `@${result.bot.username}` : result.account?.account_name}`);
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>设置</h2>
          <p>集中管理基础配置和平台连接状态。敏感 token 不读取、不展示；Telegram Bot Token 只提交给 Supabase Edge Function 写入凭证表。</p>
        </div>
      </div>

      <div className="settings-grid">
        <article className="settings-card">
          <h3>Supabase</h3>
          <p>{isSupabaseConfigured ? '已检测到前端 Supabase URL 和 anon/publishable key。' : '未配置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY。'}</p>
        </article>
        <article className="settings-card">
          <h3>AI 服务</h3>
          <p>GPT、Claude、Qwen、ComfyUI、n8n 仍保留接口位，后续建议通过后端或 Edge Function 代理。</p>
        </article>
        <article className="settings-card">
          <h3>真实发布</h3>
          <p>当前只接入 Telegram。X、Instagram、TikTok、YouTube 仍是占位 adapter。</p>
        </article>
      </div>

      <form className="form-card" onSubmit={handleTelegramConnect}>
        <p className="eyebrow">Telegram Bot</p>
        <h3>连接 Telegram 发布账号</h3>
        <p className="muted-text">需要先把 Bot 加为频道/群管理员。chat_id 可填频道用户名，例如 @your_channel；也可填 -100 开头的频道 ID。</p>
        <div className="form-grid">
          <label>
            显示名称
            <input value={telegramForm.account_name} onChange={(event) => updateTelegramForm('account_name', event.target.value)} placeholder="例如：Luravyn Telegram" required />
          </label>
          <label>
            Chat ID / 频道用户名
            <input value={telegramForm.chat_id} onChange={(event) => updateTelegramForm('chat_id', event.target.value)} placeholder="@your_channel 或 -100..." required />
          </label>
          <label className="wide-field">
            Bot Token
            <input type="password" value={telegramForm.bot_token} onChange={(event) => updateTelegramForm('bot_token', event.target.value)} placeholder="123456:ABC..." required />
          </label>
        </div>
        <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId || loading}>
          连接 Telegram
        </button>
      </form>

      <div className="section-head">
        <div>
          <p className="eyebrow">Social Connections</p>
          <h2>平台连接</h2>
          <p>这里只展示连接状态和非敏感账号信息，不读取、不显示明文 token。</p>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="连接记录" value={loading ? '—' : stats.total} hint="platform_connections" />
        <StatCard label="已连接" value={loading ? '—' : stats.connected} hint="connected" />
        <StatCard label="待授权" value={loading ? '—' : stats.pending} hint="pending" />
        <StatCard label="异常" value={loading ? '—' : stats.errors} hint="error" />
      </div>

      {message && <div className={message.includes('Missing') || message.includes('failed') || message.includes('error') ? 'notice error' : 'notice'}>{message}</div>}

      <div className="content-grid">
        {platforms.map((platform) => {
          const connection = connections.find((item) => item.platform === platform);
          return (
            <article className="content-card" key={platform}>
              <div className="card-meta">
                <StatusBadge status={connection?.status || 'disconnected'} />
                <span className="tag">{platform}</span>
              </div>
              <h3>{connection?.social_accounts?.account_name || `${platform} 未连接`}</h3>
              <p>{connection ? '连接记录已保存，凭证由 Edge Function 管理。' : '等待后续 OAuth / Bot / API 连接流程。'}</p>
              <div className="metric-row">
                <span>连接时间</span>
                <strong>{formatDate(connection?.connected_at)}</strong>
              </div>
              <div className="metric-row">
                <span>最后同步</span>
                <strong>{formatDate(connection?.last_sync)}</strong>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
