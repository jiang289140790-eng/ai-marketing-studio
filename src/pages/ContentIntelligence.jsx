import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { useConfirmation } from '../contexts/confirmation-context';
import { contentTypes, platforms } from '../data/navigation';
import {
  analyzeViralContentWithAI,
  createViralContent,
  deleteViralContent,
  generateContentFromAnalysis,
  listCompetitorAccounts,
  listContentAnalysis,
  listViralContents,
} from '../services/intelligence-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { compactNumber, formatDate } from '../utils/formatters';

const defaultViral = {
  social_account_id: '',
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

function getAnalysisValue(analysis, key, fallback = '—') {
  return analysis.analysis_result?.[key] || analysis[key] || fallback;
}

function getAnalysisScore(analysis) {
  return Number(analysis.analysis_result?.ai_score || analysis.fit_score || 0).toFixed(0);
}

export function ContentIntelligence({ userId, detailId, onNavigate }) {
  const { confirm } = useConfirmation();
  const [accounts, setAccounts] = useState([]);
  const [viralContents, setViralContents] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [viralForm, setViralForm] = useState(defaultViral);
  const [filters, setFilters] = useState({ search: '', platform: '', category: '', accountId: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [analyzingId, setAnalyzingId] = useState('');
  const [generatingAnalysisId, setGeneratingAnalysisId] = useState('');
  const [generatedDraft, setGeneratedDraft] = useState(null);
  const [aiModel, setAIModel] = useState('qwen-plus');

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

  useEffect(() => {
    if (!detailId || loading) return;
    window.setTimeout(() => document.getElementById(`intelligence-${detailId}`)?.scrollIntoView({ block: 'center' }), 0);
  }, [detailId, loading, viralContents]);

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

  const intelligenceAccountIds = useMemo(
    () => new Set(accounts.map((account) => account.id)),
    [accounts],
  );

  function setViralField(field, value) {
    setViralForm((current) => {
      const next = { ...current, [field]: value };
      if (field === 'social_account_id') {
        const account = accounts.find((item) => item.id === value);
        if (account?.platform) next.platform = account.platform;
      }
      return next;
    });
  }

  async function handleCreateViralContent(event) {
    event.preventDefault();
    if (!intelligenceAccountIds.has(viralForm.social_account_id)) {
      setMessage('请选择账号矩阵中的竞品账号或灵感账号。');
      return;
    }
    try {
      await createViralContent(userId, viralForm);
      setViralForm(defaultViral);
      setMessage('内容机会已保存，并已关联账号矩阵中的账号。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleAnalyze(item) {
    setAnalyzingId(item.id);
    try {
      await analyzeViralContentWithAI(userId, item, { model: aiModel });
      setMessage('AI 分析已完成，结果已保存并关联到账号画像。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setAnalyzingId('');
    }
  }

  async function handleGenerateContent(analysis) {
    setGeneratingAnalysisId(analysis.id);
    setGeneratedDraft(null);
    try {
      const result = await generateContentFromAnalysis(userId, analysis, { model: aiModel });
      setGeneratedDraft(result);
      setMessage('内容生成完成：已写入 content_library，状态为 draft。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setGeneratingAnalysisId('');
    }
  }

  async function handleDelete(item) {
    const accepted = await confirm({
      title: '删除内容机会？',
      message: `将删除“${item.title || '未命名内容机会'}”。对应的分析记录可能无法继续追溯来源。`,
      confirmLabel: '确认删除',
      danger: true,
    });
    if (!accepted) return;
    try {
      await deleteViralContent(item.id);
      if (String(detailId) === String(item.id)) onNavigate('intelligence');
      setMessage('内容机会已删除。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="hero-panel intelligence-hero">
        <div>
          <p className="eyebrow">内容情报</p>
          <h2>内容情报中心</h2>
          <p>从账号矩阵发现值得学习的内容，交给 AI 拆解爆点，再把分析结果转成可审核的内容草稿。</p>
        </div>
        <button className="ghost-button" type="button" onClick={() => onNavigate('accounts')}>管理情报账号</button>
      </div>

      <section className="intelligence-pipeline" aria-label="内容情报工作流">
        <div><span>1</span><strong>发现机会</strong><small>选择竞品或灵感账号，保存原始内容与数据</small></div>
        <b>→</b>
        <div><span>2</span><strong>AI 拆解</strong><small>提炼开场钩子、结构、用户心理和可复刻策略</small></div>
        <b>→</b>
        <div><span>3</span><strong>生成草稿</strong><small>把验证后的分析转成内容库草稿继续生产</small></div>
      </section>

      <div className="stat-grid">
        <StatCard label="情报账号" value={loading ? '—' : stats.accounts} hint="竞品账号与灵感账号" />
        <StatCard label="内容机会" value={loading ? '—' : stats.viral} hint="值得分析的内容" />
        <StatCard label="AI 分析" value={loading ? '—' : stats.analyses} hint="已完成的智能分析" />
        <StatCard label="热门平台" value={loading ? '—' : stats.topPlatform} hint="机会来源" />
        <StatCard label="最高分内容" value={loading ? '—' : stats.topItem} hint={`评分 ${compactNumber(stats.topScore)}`} />
      </div>

      <div className="filter-bar">
        <select value={aiModel} onChange={(event) => setAIModel(event.target.value)} aria-label="AI 模型">
          <option value="qwen-plus">Qwen Plus（默认）</option>
          <option value="qwen-max">Qwen Max</option>
          <option value="qwen3.6-plus">Qwen 3.6 Plus</option>
          <option value="deepseek-chat">DeepSeek Chat（保留）</option>
        </select>
        <input placeholder="搜索账号、内容、爆点原因" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} />
        <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
          <option value="">全部平台</option>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
        <select value={filters.accountId} onChange={(event) => setFilters({ ...filters, accountId: event.target.value })}>
          <option value="">全部账号</option>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.username || account.account_name} · {account.platform}</option>)}
        </select>
      </div>

      <details className="form-card intelligence-create-panel">
        <summary>
          <span><strong>添加新的内容机会</strong><small>从 X、Instagram 或其他平台录入一条值得分析的内容</small></span>
          <span className="primary-button">开始录入</span>
        </summary>
        <form className="intelligence-form" onSubmit={handleCreateViralContent}>
          <div className="form-card-heading">
            <p className="eyebrow">内容机会</p>
            <h3>保存内容机会</h3>
            <p>记录值得学习的内容，后续交给分析智能体提炼爆点与复刻建议。</p>
          </div>
          <div className="intelligence-fields">
            <label className="wide">
              来源账号
              <select value={viralForm.social_account_id} onChange={(event) => setViralField('social_account_id', event.target.value)} required>
                <option value="">从账号矩阵选择账号</option>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.username || account.account_name} · {account.platform}</option>)}
              </select>
            </label>
            <label>平台<select value={viralForm.platform} onChange={(event) => setViralField('platform', event.target.value)}>{platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select></label>
            <label>内容类型<select value={viralForm.content_type} onChange={(event) => setViralField('content_type', event.target.value)}>{contentTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
            <label className="wide">标题<input value={viralForm.title} onChange={(event) => setViralField('title', event.target.value)} required /></label>
            <label>内容 URL<input value={viralForm.url} onChange={(event) => setViralField('url', event.target.value)} /></label>
            <label>媒体 URL<input value={viralForm.media_url} onChange={(event) => setViralField('media_url', event.target.value)} /></label>
            <label className="wide published-field">发布时间<input type="datetime-local" value={viralForm.published_at} onChange={(event) => setViralField('published_at', event.target.value)} /></label>
            <div className="intelligence-metrics wide">
              <label>Views<input type="number" min="0" value={viralForm.views} onChange={(event) => setViralField('views', event.target.value)} /></label>
              <label>Likes<input type="number" min="0" value={viralForm.likes} onChange={(event) => setViralField('likes', event.target.value)} /></label>
              <label>Comments<input type="number" min="0" value={viralForm.comments} onChange={(event) => setViralField('comments', event.target.value)} /></label>
            </div>
            <label>为什么爆<textarea value={viralForm.viral_reason} onChange={(event) => setViralField('viral_reason', event.target.value)} /></label>
            <label>AI 推荐<textarea value={viralForm.ai_recommendation} onChange={(event) => setViralField('ai_recommendation', event.target.value)} /></label>
            <label className="wide">正文<textarea className="content-textarea" value={viralForm.content_text} onChange={(event) => setViralField('content_text', event.target.value)} /></label>
            <div className="form-actions wide">
              <button className="primary-button" type="submit" disabled={!isSupabaseConfigured || !userId}>保存内容机会</button>
            </div>
          </div>
        </form>
      </details>

      {message && <div className="notice">{message}</div>}

      {generatedDraft && (
        <article className="analysis-card">
          <div className="card-meta">
            <span className="tag">内容生成智能体</span>
            <span>{generatedDraft.model || 'deepseek-chat'}</span>
            <span>成本 {Number(generatedDraft.cost || 0).toFixed(6)}</span>
            <span>耗时 {Number(generatedDraft.duration || 0)}ms</span>
          </div>
          <h3>{generatedDraft.content?.title || generatedDraft.generated?.title || 'AI 内容草稿'}</h3>
          <p>{generatedDraft.generated?.body || generatedDraft.content?.content_text || ''}</p>
          {generatedDraft.generated?.cta && <p><strong>行动引导：</strong>{generatedDraft.generated.cta}</p>}
        </article>
      )}

      {!isSupabaseConfigured ? (
        <EmptyState title="等待数据服务配置" description="配置后这里会读取内容情报数据。" />
      ) : viralContents.length === 0 ? (
        <EmptyState title="暂无内容机会" description="先在账号矩阵添加竞品/灵感账号，再保存值得学习的内容。" />
      ) : (
        <section className="intelligence-stage-panel">
          <div className="section-head compact-head">
            <div><p className="eyebrow">机会收集箱</p><h3>待分析内容机会</h3></div>
            <span>{viralContents.length} 条</span>
          </div>
          <div className="intelligence-card-grid">
          {viralContents.map((item) => (
            <article className={`analysis-card ${String(detailId) === String(item.id) ? 'route-selected' : ''}`} id={`intelligence-${item.id}`} key={item.id}>
              <div className="card-meta">
                <span className="tag">{item.platform}</span>
                <span>{item.social_accounts?.username || item.social_accounts?.account_name || '未关联账号'}</span>
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
              <p><strong>AI建议：</strong>{item.ai_recommendation || '点击 AI分析 后补全'}</p>
              <div className="status-actions">
                <button className="ghost-button" type="button" onClick={() => onNavigate('intelligence', item.id)}>打开直达链接</button>
                {item.url && <a className="ghost-button" href={item.url} target="_blank" rel="noreferrer">打开内容</a>}
                <button type="button" onClick={() => handleAnalyze(item)} disabled={analyzingId === item.id}>
                  {analyzingId === item.id ? 'AI分析中...' : 'AI分析'}
                </button>
                <button type="button" onClick={() => handleDelete(item)}>删除内容</button>
              </div>
            </article>
          ))}
          </div>
        </section>
      )}

      {analyses.length > 0 && (
        <section className="intelligence-stage-panel">
          <div className="section-head compact-head">
            <div><p className="eyebrow">分析完成</p><h3>已完成的 AI 拆解</h3></div>
            <span>{analyses.length} 条</span>
          </div>
          <div className="intelligence-card-grid">
          {analyses.slice(0, 6).map((analysis) => (
            <article className="analysis-card" key={analysis.id}>
              <div className="card-meta">
                <span className="tag">{analysis.provider || 'AI 服务'}</span>
                <span>{analysis.model || 'deepseek-chat'}</span>
                <span>成本 {Number(analysis.cost || 0).toFixed(6)}</span>
                <span>耗时 {Number(analysis.duration_ms || 0)}ms</span>
              </div>
              <h3>{analysis.viral_contents?.title || 'AI 内容分析'}</h3>
              <p><strong>爆款原因：</strong>{getAnalysisValue(analysis, 'viral_reason')}</p>
              <p><strong>内容结构：</strong>{getAnalysisValue(analysis, 'structure')}</p>
              <p><strong>用户心理：</strong>{getAnalysisValue(analysis, 'user_psychology')}</p>
              <p><strong>复刻建议：</strong>{getAnalysisValue(analysis, 'replication_notes', analysis.recommendation || analysis.ai_recommendation || '—')}</p>
              <div className="metric-row">
                <span>AI评分</span>
                <strong>{getAnalysisScore(analysis)}</strong>
              </div>
              <div className="status-actions">
                <button type="button" onClick={() => handleGenerateContent(analysis)} disabled={generatingAnalysisId === analysis.id}>
                  {generatingAnalysisId === analysis.id ? '内容生成中...' : '根据分析生成内容'}
                </button>
              </div>
            </article>
          ))}
          </div>
        </section>
      )}
    </section>
  );
}
