import { useCallback, useEffect, useMemo, useState } from 'react';
import { StatusBadge } from '../components/StatusBadge';
import { StatCard } from '../components/StatCard';
import { platformConnectionCards } from '../data/platform-connections';
import {
  connectTelegramPlatform,
  connectXPlatform,
  disconnectTelegramPlatform,
  disconnectXPlatform,
  getTelegramPlatformStatus,
  getXPlatformStatus,
  listPlatformConnections,
  preparePlatformConnection,
  reconnectTelegramPlatform,
  reconnectXPlatform,
  summarizeConnections,
} from '../services/platform-connection-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const initialTelegramForm = {
  account_name: '',
  chat_id: '',
};

function getConnectionsByPlatform(connections, platform) {
  return connections
    .filter((item) => item.platform === platform)
    .sort((a, b) => {
      if (a.status === 'connected' && b.status !== 'connected') return -1;
      if (a.status !== 'connected' && b.status === 'connected') return 1;
      return new Date(b.connected_at || b.created_at || 0) - new Date(a.connected_at || a.created_at || 0);
    });
}

function getConnectionName(connection) {
  return (
    connection?.social_accounts?.account_name ||
    connection?.metadata?.x?.username ||
    connection?.metadata?.telegram?.chat_id ||
    connection?.metadata?.chat_id ||
    '等待授权'
  );
}

function isErrorMessage(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('missing') || text.includes('failed') || text.includes('error') || text.includes('失败');
}

export function SettingsPage({ userId }) {
  const [connections, setConnections] = useState([]);
  const [telegramForm, setTelegramForm] = useState(initialTelegramForm);
  const [message, setMessage] = useState('');
  const [setupInfo, setSetupInfo] = useState(null);
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
    setSetupInfo(null);
    setLoading(true);
    try {
      const result = await connectTelegramPlatform(telegramForm);
      setTelegramForm(initialTelegramForm);
      if (result.mode === 'telegram_connect_code') {
        setMessage(`请在 Telegram 频道/群里发送：${result.instruction}`);
      } else {
        setMessage(`Telegram 已连接：${result.bot?.username ? `@${result.bot.username}` : result.account?.account_name}`);
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleTelegramAction(action, connection) {
    setMessage('');
    setSetupInfo(null);
    setLoading(true);
    try {
      if (action === 'disconnect') {
        await disconnectTelegramPlatform(connection.id);
        setMessage('Telegram 连接已断开。');
      }
      if (action === 'reconnect') {
        await reconnectTelegramPlatform(connection.id);
        setMessage('Telegram 已重新连接。');
      }
      if (action === 'status') {
        const result = await getTelegramPlatformStatus(connection.id);
        const status = result.connections?.[0]?.status || connection.status;
        setMessage(`Telegram 当前状态：${status}`);
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleXConnect() {
    setMessage('');
    setSetupInfo(null);
    setLoading(true);
    try {
      const result = await connectXPlatform();
      if (result.auth_url) {
        window.open(result.auth_url, 'ai-marketing-studio-x-oauth', 'width=760,height=820');
        setMessage('已打开 X 授权窗口。授权完成后请刷新平台连接状态。');
      } else {
        setMessage('X OAuth 初始化完成，但没有返回授权地址。');
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleXAction(action, connection) {
    setMessage('');
    setSetupInfo(null);
    setLoading(true);
    try {
      if (action === 'disconnect') {
        await disconnectXPlatform(connection.id);
        setMessage('X 连接已断开。');
      }
      if (action === 'reconnect') {
        const result = await reconnectXPlatform(connection.id);
        if (result.auth_url) window.open(result.auth_url, 'ai-marketing-studio-x-oauth', 'width=760,height=820');
        setMessage('已打开 X 重新授权窗口。');
      }
      if (action === 'status') {
        const result = await getXPlatformStatus(connection.id);
        const status = result.connections?.[0]?.status || connection.status;
        setMessage(`X 当前状态：${status}`);
      }
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePreparedPlatform(card) {
    setMessage('');
    setSetupInfo(null);
    setLoading(true);
    try {
      const result = await preparePlatformConnection(card.platform);
      setSetupInfo({
        title: card.title,
        platform: card.platform,
        setup: result.setup || {
          required_secrets: card.requiredSecrets,
          missing_secrets: card.requiredSecrets,
          callback_url: card.callbackUrl,
          auth_type: card.authType,
          multi_account: true,
        },
      });
      const missing = result.setup?.missing_secrets || card.requiredSecrets || [];
      setMessage(missing.length
        ? `${card.title} 配置入口已完成，还缺少：${missing.join(', ')}`
        : `${card.title} Secrets 已配置，下一步可以接真实 OAuth handler。`);
    } catch (error) {
      setSetupInfo({
        title: card.title,
        platform: card.platform,
        setup: {
          required_secrets: card.requiredSecrets,
          missing_secrets: card.requiredSecrets,
          callback_url: card.callbackUrl,
          auth_type: card.authType,
          multi_account: true,
        },
      });
      setMessage(`${card.title} 配置入口已准备，但请求返回：${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  function renderSetupInfo() {
    if (!setupInfo) return null;
    const setup = setupInfo.setup || {};
    return (
      <article className="setup-panel">
        <div>
          <p className="eyebrow">Connection Setup</p>
          <h3>{setupInfo.title || setupInfo.platform} 接入配置</h3>
          <p>真实授权前，把平台开发者后台的密钥放进 Supabase Edge Function Secrets。前端只显示状态，不保存 token。</p>
        </div>
        <div className="setup-grid">
          <div><span>授权方式</span><strong>{setup.auth_type || 'oauth2'}</strong></div>
          <div><span>多账号</span><strong>{setup.multi_account ? '支持，每个账号一条连接' : '未开启'}</strong></div>
          <div><span>回调地址</span><code>{setup.callback_url || setup.redirect_uri || '—'}</code></div>
          <div><span>Token存储</span><strong>{setup.token_storage || 'platform_credentials_only'}</strong></div>
        </div>
        <div className="secret-list">
          <strong>需要配置的 Secrets</strong>
          {(setup.required_secrets || []).map((secret) => {
            const missing = (setup.missing_secrets || []).includes(secret);
            return <span className={missing ? 'tag warning' : 'tag success'} key={secret}>{secret}{missing ? ' · 缺少' : ' · 已配置'}</span>;
          })}
        </div>
      </article>
    );
  }

  function renderPlatformActions(card, platformConnections) {
    const firstConnection = platformConnections[0];
    const busy = loading || !userId || !isSupabaseConfigured;

    if (card.platform === 'X') {
      if (!firstConnection) {
        return <button type="button" className="primary-button" disabled={busy} onClick={handleXConnect}>连接 X</button>;
      }
      return (
        <div className="card-actions">
          <button type="button" className="ghost-button" disabled={loading} onClick={() => handleXAction('status', firstConnection)}>检查状态</button>
          <button type="button" className="ghost-button" disabled={loading} onClick={() => handleXAction('reconnect', firstConnection)}>重连</button>
          <button type="button" className="ghost-button danger" disabled={loading} onClick={() => handleXAction('disconnect', firstConnection)}>断开</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={handleXConnect}>添加另一个</button>
        </div>
      );
    }

    if (card.platform === 'Telegram') {
      if (!firstConnection) return <span className="tag">请用上方表单连接</span>;
      return (
        <div className="card-actions">
          <button type="button" className="ghost-button" disabled={loading} onClick={() => handleTelegramAction('status', firstConnection)}>检查状态</button>
          <button type="button" className="ghost-button" disabled={loading} onClick={() => handleTelegramAction('reconnect', firstConnection)}>重连</button>
          <button type="button" className="ghost-button danger" disabled={loading} onClick={() => handleTelegramAction('disconnect', firstConnection)}>断开</button>
        </div>
      );
    }

    return (
      <button type="button" className="ghost-button" disabled={busy} onClick={() => handlePreparedPlatform(card)}>
        查看接入配置
      </button>
    );
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>设置</h2>
          <p>集中管理基础配置和平台连接状态。敏感 Token 不进入前端，只由 Supabase Edge Function 读取和处理。</p>
        </div>
      </div>

      <div className="settings-grid">
        <article className="settings-card">
          <h3>Supabase</h3>
          <p>{isSupabaseConfigured ? '已检测到前端 Supabase URL 和 anon/publishable key。' : '未配置 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY。'}</p>
        </article>
        <article className="settings-card">
          <h3>AI 服务</h3>
          <p>AI Gateway、ComfyUI、Agent Runtime 仍通过后端安全层代理，不在浏览器暴露模型 API Key。</p>
        </article>
        <article className="settings-card">
          <h3>真实发布</h3>
          <p>Telegram 与 X 已进入真实连接链路；Instagram、YouTube、TikTok、Discord 已建立配置入口。</p>
        </article>
      </div>

      <form className="form-card" onSubmit={handleTelegramConnect}>
        <p className="eyebrow">Telegram Bot</p>
        <h3>连接 Telegram 发布账号</h3>
        <p className="muted-text">先把 Bot 加为频道/群管理员。Chat ID 可填频道用户名，例如 @your_channel；也可填 -100 开头的频道 ID。Bot Token 只从 Edge Function Secret 读取。</p>
        <div className="form-grid">
          <label>
            显示名称
            <input value={telegramForm.account_name} onChange={(event) => updateTelegramForm('account_name', event.target.value)} placeholder="例如：AI Creative Studio" required />
          </label>
          <label>
            Chat ID / 频道用户名
            <input value={telegramForm.chat_id} onChange={(event) => updateTelegramForm('chat_id', event.target.value)} placeholder="@your_channel 或 -100..." required />
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
          <p>这里展示所有平台连接状态。每个平台可以保存多个账号；未接入的平台会显示完整配置说明，不再停留在灰色占位按钮。</p>
        </div>
      </div>

      <div className="stat-grid compact">
        <StatCard label="连接记录" value={loading ? '—' : stats.total} hint="platform_connections" />
        <StatCard label="已连接" value={loading ? '—' : stats.connected} hint="connected" />
        <StatCard label="待授权" value={loading ? '—' : stats.pending} hint="pending" />
        <StatCard label="异常" value={loading ? '—' : stats.errors} hint="error" />
      </div>

      {message && <div className={isErrorMessage(message) ? 'notice error' : 'notice'}>{message}</div>}
      {renderSetupInfo()}

      <div className="content-grid">
        {platformConnectionCards.map((card) => {
          const platformConnections = getConnectionsByPlatform(connections, card.platform);
          const connectedCount = platformConnections.filter((item) => item.status === 'connected').length;
          const status = connectedCount ? 'connected' : platformConnections[0]?.status || 'not_connected';
          const firstConnection = platformConnections[0];
          return (
            <article className="content-card" key={card.platform}>
              <div className="card-meta">
                <StatusBadge status={status} />
                <span className="tag">{card.platform}</span>
              </div>
              <h3>{firstConnection?.social_accounts?.account_name || `${card.title} 未连接`}</h3>
              <p>{firstConnection ? '连接记录已保存，凭证由 Edge Function 管理。' : card.description}</p>
              <div className="metric-row">
                <span>连接数</span>
                <strong>{connectedCount}/{platformConnections.length}</strong>
              </div>
              <div className="metric-row">
                <span>连接时间</span>
                <strong>{formatDate(firstConnection?.connected_at)}</strong>
              </div>
              <div className="metric-row">
                <span>最后同步</span>
                <strong>{formatDate(firstConnection?.last_sync)}</strong>
              </div>
              <div className="connection-record-list">
                {platformConnections.length ? platformConnections.map((connection) => (
                  <div className="connection-record" key={connection.id}>
                    <div>
                      <strong>{getConnectionName(connection)}</strong>
                      <small>{formatDate(connection.connected_at || connection.created_at)}</small>
                    </div>
                    <StatusBadge status={connection.status || 'pending'} />
                  </div>
                )) : <div className="connection-empty">暂无连接账号</div>}
              </div>
              <div className="card-actions">
                {renderPlatformActions(card, platformConnections)}
              </div>
              <small>{card.priority} · {card.authType}</small>
            </article>
          );
        })}
      </div>
    </section>
  );
}
