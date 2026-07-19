import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { contentTypes, platforms } from '../data/navigation';
import {
  analyzeViralContent,
  createCompetitorAccount,
  createViralContent,
  deleteCompetitorAccount,
  deleteViralContent,
  listCompetitorAccounts,
  listContentAnalysis,
  listViralContents,
} from '../services/intelligence-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { compactNumber, formatDate } from '../utils/formatters';

const defaultAccount = {
  platform: 'Instagram',
  username: '',
  url: '',
  category: '',
  audience: '',
  followers: '',
  content_strategy: '',
  posting_frequency: '',
  notes: '',
};

const defaultViral = {
  account_id: '',
  platform: 'Instagram',
  url: '',
  title: '',
  content_text: '',
  media_url: '',
  views: '',
  likes: '',
  comments: '',
  content_type: 'text',
  viral_reason: '',
  ai_recommendation: '',
  published_at: '',
};

export function ContentIntelligence({ userId }) {
  const [accounts, setAccounts] = useState([]);
  const [viralContents, setViralContents] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [accountForm, setAccountForm] = useState(defaultAccount);
  const [viralForm, setViralForm] = useState(defaultViral);
  const [filters, setFilters] = useState({ search: '', platform: '', category: '', accountId: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextAccounts, nextViralContents, nextAnalyses] = await Promise.all([
      listCompetitorAccounts(userId, filters),
      listViralContents(userId, filters),
      listContentAnalysis(userId),
    ]);
    setAccounts(nextAccounts);
    setViralContents(nextViralContents);
    setAnalyses(nextAnalyses);
    setLoading(false);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const stats = useMemo(() => {
    const topItem = [...viralContents].sort((a, b) => Number(b.engagement_score || 0) - Number(a.engagement_score || 0))[0];
    const platformCounts = new Map();
    for (const item of viralContents) platformCounts.set(item.platform, (platformCounts.get(item.platform) || 0) + 1);
    return {
      accounts: accounts.length,
      viral: viralContents.length,
      analyses: analyses.length,
      topPlatform: [...platformCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '—',
      topItem: topItem?.title || '—',
      topScore: Number(topItem?.engagement_score || 0),
    };
  }, [accounts, viralContents, analyses]);

  function setAccountField(field, value) {
    setAccountForm((current) => ({ ...current, [field]: value }));
  }

  function setViralField(field, value) {
    setViralForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateAccount(event) {
    event.preventDefault();
    try {
      await createCompetitorAccount(userId, accountForm);
      setAccountForm(defaultAccount);
      setMessage('竞争/灵感账号已保存。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleCreateViralContent(event) {
    event.preventDefault();
    try {
      await createViralContent(userId, viralForm);
      setViralForm(defaultViral);
      setMessage('内容机会已保存。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleAnalyze(item) {
    try {
      await analyzeViralContent(userId, item);
      setMessage('已生成分析：为什么爆、如何复刻、是否适合你的账号。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Content Intelligence</p>
          <h2>内容情报中心</h2>
          <p>每天沉淀竞品/灵感账号和高表现内容，让 Analysis Agent 发现内容机会，再进入内容生成。</p>
        </div>
      </div>

      <div className="stat-grid">
        <StatCard label="参考账号" value={loading ? '—' : stats.accounts} hint="competitor_accounts" />
        <StatCard label="内容机会" value={loading ? '—' : stats.viral} hint="viral_contents" />
        <StatCard label="AI分析" value={loading ? '—' : stats.analyses} hint="content_analysis" />
        <StatCard label="热门平台" value={loading ? '—' : stats.topPlatform} hint="机会来源" />
        <StatCard label="最高分内容" value={loading ? '—' : stats.topItem} hint={`Score ${compactNumber(stats.topScore)}`} />
      </div>

      <div className="filter-bar">
        <input placeholder="搜索账号、内容、爆点原因" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <input placeholder="分类" value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })} />
        <select value={filters.accountId} onChange={(event) => setFilters({ ...filters, accountId: event.target.value })}>
          <option value="">全部账号</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.username}</option>)}
        </select>
      </div>

      <div className="studio-grid">
        <form className="form-card" onSubmit={handleCreateAccount}>
          <p className="eyebrow">Competitor / Inspiration</p>
          <h3>添加参考账号</h3>
          <label>平台<select value={accountForm.platform} onChange={(event) => setAccountField('platform', event.target.value)}>{platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
          <label>用户名<input value={accountForm.username} onChange={(event) => setAccountField('username', event.target.value)} required /></label>
          <label>URL<input value={accountForm.url} onChange={(event) => setAccountField('url', event.target.value)} /></label>
          <label>分类<input value={accountForm.category} onChange={(event) => setAccountField('category', event.target.value)} placeholder="竞品 / 灵感 / 同赛道" /></label>
          <label>受众<input value={accountForm.audience} onChange={(event) => setAccountField('audience', event.target.value)} /></label>
          <label>粉丝数<input type="number" value={accountForm.followers} onChange={(event) => setAccountField('followers', event.target.value)} /></label>
          <label>内容策略<textarea value={accountForm.content_strategy} onChange={(event) => setAccountField('content_strategy', event.target.value)} /></label>
          <label>发布频率<input value={accountForm.posting_frequency} onChange={(event) => setAccountField('posting_frequency', event.target.value)} /></label>
          <label>备注<textarea value={accountForm.notes} onChange={(event) => setAccountField('notes', event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存账号</button>
        </form>

        <form className="form-card" onSubmit={handleCreateViralContent}>
          <p className="eyebrow">Content Opportunity</p>
          <h3>保存内容机会</h3>
          <label>参考账号<select value={viralForm.account_id} onChange={(event) => setViralField('account_id', event.target.value)}><option value="">不关联账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.username} · {account.platform}</option>)}</select></label>
          <label>平台<select value={viralForm.platform} onChange={(event) => setViralField('platform', event.target.value)}>{platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
          <label>内容类型<select value={viralForm.content_type} onChange={(event) => setViralField('content_type', event.target.value)}>{contentTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
          <label>标题<input value={viralForm.title} onChange={(event) => setViralField('title', event.target.value)} required /></label>
          <label>内容URL<input value={viralForm.url} onChange={(event) => setViralField('url', event.target.value)} /></label>
          <label>媒体URL<input value={viralForm.media_url} onChange={(event) => setViralField('media_url', event.target.value)} /></label>
          <label>发布时间<input type="datetime-local" value={viralForm.published_at} onChange={(event) => setViralField('published_at', event.target.value)} /></label>
          <div className="form-grid">
            <label>Views<input type="number" value={viralForm.views} onChange={(event) => setViralField('views', event.target.value)} /></label>
            <label>Likes<input type="number" value={viralForm.likes} onChange={(event) => setViralField('likes', event.target.value)} /></label>
            <label>Comments<input type="number" value={viralForm.comments} onChange={(event) => setViralField('comments', event.target.value)} /></label>
          </div>
          <label>为什么爆<textarea value={viralForm.viral_reason} onChange={(event) => setViralField('viral_reason', event.target.value)} /></label>
          <label>AI 推荐<textarea value={viralForm.ai_recommendation} onChange={(event) => setViralField('ai_recommendation', event.target.value)} /></label>
          <label>正文<textarea value={viralForm.content_text} onChange={(event) => setViralField('content_text', event.target.value)} /></label>
          <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存内容机会</button>
        </form>
      </div>

      {message && <div className="notice">{message}</div>}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后这里会读取内容情报数据。" />
      ) : viralContents.length === 0 ? (
        <EmptyState title="暂无内容机会" description="先保存一个参考账号，再把值得学习的内容放进内容机会库。" />
      ) : (
        <div className="analysis-list">
          {viralContents.map((item) => (
            <article className="analysis-card" key={item.id}>
              <div className="card-meta">
                <span className="tag">{item.platform}</span>
                <span>{item.competitor_accounts?.username || '未关联账号'}</span>
                <span>{formatDate(item.published_at)}</span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.content_text || '暂无正文'}</p>
              {item.media_url && <img src={item.media_url} alt={item.title} />}
              <div className="metric-row">
                <span>Score {compactNumber(item.engagement_score)}</span>
                <span>Views {compactNumber(item.views)}</span>
                <span>Likes {compactNumber(item.likes)}</span>
                <span>Comments {compactNumber(item.comments)}</span>
              </div>
              <p><strong>为什么爆：</strong>{item.viral_reason || '待分析'}</p>
              <p><strong>AI建议：</strong>{item.ai_recommendation || '点击生成分析后补全'}</p>
              <div className="status-actions">
                {item.url && <a className="ghost-button" href={item.url} target="_blank" rel="noreferrer">打开内容</a>}
                <button type="button" onClick={() => handleAnalyze(item)}>生成分析</button>
                <button type="button" onClick={() => deleteViralContent(item.id).then(refresh)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>分析对象</th>
              <th>为什么爆</th>
              <th>是否适合我</th>
              <th>适合度</th>
            </tr>
          </thead>
          <tbody>
            {analyses.slice(0, 10).map((analysis) => (
              <tr key={analysis.id}>
                <td>{analysis.viral_contents?.title || '未关联内容'}</td>
                <td>{analysis.viral_reason || analysis.hook || '—'}</td>
                <td>{analysis.ai_recommendation || '—'}</td>
                <td>{Number(analysis.fit_score || 0).toFixed(0)}</td>
              </tr>
            ))}
            {analyses.length === 0 && <tr><td colSpan="4">暂无 AI 分析</td></tr>}
          </tbody>
        </table>
      </div>

      {accounts.length > 0 && (
        <div className="content-grid">
          {accounts.map((account) => (
            <article className="content-card" key={account.id}>
              <div className="card-meta">
                <span className="tag">{account.platform}</span>
                <span className="tag">{account.category || '未分类'}</span>
              </div>
              <h3>{account.username}</h3>
              <p>{account.audience || account.notes || '暂无受众与备注'}</p>
              <p>{account.content_strategy || '暂无内容策略'}</p>
              <div className="metric-row">
                <span>粉丝</span>
                <strong>{compactNumber(account.followers)}</strong>
              </div>
              <div className="status-actions">
                {account.url && <a className="ghost-button" href={account.url} target="_blank" rel="noreferrer">打开账号</a>}
                <button type="button" onClick={() => deleteCompetitorAccount(account.id).then(refresh)}>删除</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
