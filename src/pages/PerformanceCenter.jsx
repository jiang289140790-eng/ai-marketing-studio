import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { platforms } from '../data/navigation';
import { listContent } from '../services/content-service';
import { listViralContents } from '../services/intelligence-service';
import {
  buildRoiOptimizationStrategy,
  createCampaignLink,
  createContentMetric,
  createContentStrategy,
  deleteCampaignLink,
  deleteContentMetric,
  listCampaignLinks,
  listContentMetrics,
  listContentStrategies,
  listPublishMetrics,
  summarizeConversions,
  summarizePerformance,
  updateCampaignLink,
} from '../services/performance-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { compactNumber, formatDate } from '../utils/formatters';

const initialMetric = {
  content_id: '',
  platform: 'Telegram',
  views: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  clicks: 0,
  registrations: 0,
  revenue: 0,
};

const initialLink = {
  content_id: '',
  platform: 'Telegram',
  utm_source: 'telegram',
  utm_campaign: '',
  url: '',
  clicks: 0,
  registrations: 0,
  revenue: 0,
};

export function PerformanceCenter({ userId }) {
  const [metrics, setMetrics] = useState([]);
  const [publishMetrics, setPublishMetrics] = useState([]);
  const [campaignLinks, setCampaignLinks] = useState([]);
  const [contentItems, setContentItems] = useState([]);
  const [viralContents, setViralContents] = useState([]);
  const [strategies, setStrategies] = useState([]);
  const [filters, setFilters] = useState({ platform: '' });
  const [metricForm, setMetricForm] = useState(initialMetric);
  const [linkForm, setLinkForm] = useState(initialLink);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    const [nextMetrics, nextPublishMetrics, nextCampaignLinks, nextContent, nextViral, nextStrategies] = await Promise.all([
      listContentMetrics(userId, filters),
      listPublishMetrics(userId),
      listCampaignLinks(userId, filters),
      listContent(userId),
      listViralContents(userId),
      listContentStrategies(userId),
    ]);
    setMetrics(nextMetrics);
    setPublishMetrics(nextPublishMetrics);
    setCampaignLinks(nextCampaignLinks);
    setContentItems(nextContent);
    setViralContents(nextViral);
    setStrategies(nextStrategies);
    setLoading(false);
  }, [userId, filters]);

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(error.message);
      setLoading(false);
    });
  }, [refresh]);

  const summary = useMemo(() => summarizePerformance(metrics, publishMetrics), [metrics, publishMetrics]);
  const conversions = useMemo(() => summarizeConversions(campaignLinks), [campaignLinks]);

  function updateMetricForm(field, value) {
    const next = { ...metricForm, [field]: value };
    if (field === 'content_id') {
      const selected = contentItems.find((item) => item.id === value);
      if (selected?.platform) next.platform = selected.platform;
    }
    setMetricForm(next);
  }

  function updateLinkForm(field, value) {
    const next = { ...linkForm, [field]: value };
    if (field === 'content_id') {
      const selected = contentItems.find((item) => item.id === value);
      if (selected?.platform) next.platform = selected.platform;
      if (selected?.title && !next.utm_campaign) next.utm_campaign = slugify(selected.title);
    }
    setLinkForm(next);
  }

  async function handleCreateMetric(event) {
    event.preventDefault();
    try {
      await createContentMetric(userId, metricForm);
      setMetricForm(initialMetric);
      setMessage('内容表现数据已保存。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleCreateCampaignLink(event) {
    event.preventDefault();
    try {
      await createCampaignLink(userId, linkForm);
      setLinkForm(initialLink);
      setMessage('转化追踪链接已创建，可在发布中心绑定到 Telegram 发布任务。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleQuickUpdateLink(link, patch) {
    try {
      await updateCampaignLink(link.id, patch);
      setMessage('转化数据已更新。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleCreateStrategy() {
    try {
      const optimizationStrategy = buildRoiOptimizationStrategy(metrics, viralContents, campaignLinks);
      await createContentStrategy(userId, {
        title: `Telegram ROI 优化策略 · ${new Date().toLocaleDateString('zh-CN')}`,
        source: 'performance-center',
        input_data: {
          metrics_count: metrics.length,
          viral_contents_count: viralContents.length,
          campaign_links_count: campaignLinks.length,
          top_content: summary.topContentTitle,
          conversions,
        },
        optimization_strategy: optimizationStrategy,
      });
      setMessage('已根据浏览、互动、点击、注册和收入生成 ROI 优化策略。');
      await refresh();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <section className="page-stack">
      <div className="section-head">
        <div>
          <p className="eyebrow">Telegram Performance Loop</p>
          <h2>Performance Center</h2>
          <p>把 Telegram 发布后的浏览、互动、点击、注册和收入沉淀下来，形成“帖子 → 链接 → 点击 → 注册 → ROI策略”的运营闭环。</p>
        </div>
        <button className="primary-button" type="button" onClick={handleCreateStrategy} disabled={!isSupabaseConfigured || (metrics.length === 0 && campaignLinks.length === 0)}>
          生成 ROI 策略
        </button>
      </div>

      <div className="stat-grid compact">
        <StatCard label="总浏览" value={loading ? '—' : compactNumber(summary.totals.views)} hint="content_metrics.views" />
        <StatCard label="总互动" value={loading ? '—' : compactNumber(summary.totals.likes + summary.totals.comments + summary.totals.shares)} hint="reactions + comments + forwards" />
        <StatCard label="点击" value={loading ? '—' : compactNumber(conversions.clicks || summary.totals.clicks)} hint="campaign_links.clicks" />
        <StatCard label="注册" value={loading ? '—' : compactNumber(conversions.registrations || summary.totals.registrations)} hint="campaign_links.registrations" />
        <StatCard label="收入" value={loading ? '—' : Number(conversions.revenue || summary.totals.revenue).toFixed(2)} hint="campaign_links.revenue" />
        <StatCard label="转化率" value={loading ? '—' : `${conversions.conversionRate}%`} hint="registrations / clicks" />
      </div>

      <div className="stat-grid compact">
        <StatCard label="最高表现内容" value={summary.topContentTitle} hint={`Score ${summary.topContentScore}`} />
        <StatCard label="最高转化账号" value={summary.topAccount} hint="按账号分类汇总" />
        <StatCard label="平台ROI" value={conversions.revenuePerClick || summary.platformRoi} hint="revenue / clicks" />
        <StatCard label="内容类型排行" value={summary.topContentType} hint="按浏览、点击、注册加权" />
      </div>

      {!isSupabaseConfigured ? (
        <EmptyState title="等待 Supabase 配置" description="配置后会读取 content_metrics、publish_metrics、campaign_links 和 content_strategies。" />
      ) : (
        <>
          <div className="studio-grid">
            <form className="form-card" onSubmit={handleCreateCampaignLink}>
              <p className="eyebrow">Campaign Link</p>
              <h3>创建转化追踪链接</h3>
              <div className="form-grid">
                <label>
                  内容
                  <select value={linkForm.content_id} onChange={(event) => updateLinkForm('content_id', event.target.value)}>
                    <option value="">可选：关联内容</option>
                    {contentItems.map((item) => (
                      <option key={item.id} value={item.id}>{item.title}</option>
                    ))}
                  </select>
                </label>
                <label>
                  平台
                  <select value={linkForm.platform} onChange={(event) => updateLinkForm('platform', event.target.value)}>
                    {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
                  </select>
                </label>
                <label>
                  UTM Source
                  <input value={linkForm.utm_source} onChange={(event) => updateLinkForm('utm_source', event.target.value)} />
                </label>
                <label>
                  UTM Campaign
                  <input value={linkForm.utm_campaign} onChange={(event) => updateLinkForm('utm_campaign', event.target.value)} />
                </label>
                <label className="wide-field">
                  落地页 URL
                  <input value={linkForm.url} onChange={(event) => updateLinkForm('url', event.target.value)} placeholder="https://..." required />
                </label>
              </div>
              <button className="primary-button" type="submit">保存追踪链接</button>
            </form>

            <form className="form-card" onSubmit={handleCreateMetric}>
              <p className="eyebrow">Manual Metrics</p>
              <h3>录入内容表现</h3>
              <div className="form-grid">
                <label>
                  内容
                  <select value={metricForm.content_id} onChange={(event) => updateMetricForm('content_id', event.target.value)} required>
                    <option value="">选择内容</option>
                    {contentItems.map((item) => (
                      <option key={item.id} value={item.id}>{item.title} · {item.platform || '未选平台'}</option>
                    ))}
                  </select>
                </label>
                <label>
                  平台
                  <select value={metricForm.platform} onChange={(event) => updateMetricForm('platform', event.target.value)}>
                    {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
                  </select>
                </label>
                {['views', 'likes', 'comments', 'shares', 'clicks', 'registrations', 'revenue'].map((field) => (
                  <label key={field}>
                    {field}
                    <input type="number" min="0" step={field === 'revenue' ? '0.01' : '1'} value={metricForm[field]} onChange={(event) => updateMetricForm(field, event.target.value)} />
                  </label>
                ))}
              </div>
              <button className="primary-button" type="submit" disabled={!userId || !metricForm.content_id}>保存表现数据</button>
            </form>
          </div>

          {message && <div className="notice">{message}</div>}

          <div className="filter-bar">
            <select value={filters.platform} onChange={(event) => setFilters({ ...filters, platform: event.target.value })}>
              <option value="">全部平台</option>
              {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
            </select>
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>内容</th>
                  <th>URL</th>
                  <th>点击</th>
                  <th>注册</th>
                  <th>收入</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {campaignLinks.map((link) => (
                  <tr key={link.id}>
                    <td>{link.utm_campaign || '—'}</td>
                    <td>{link.content_library?.title || '未关联'}</td>
                    <td><a href={link.url} target="_blank" rel="noreferrer">打开</a></td>
                    <td>{compactNumber(link.clicks)}</td>
                    <td>{compactNumber(link.registrations)}</td>
                    <td>{Number(link.revenue || 0).toFixed(2)}</td>
                    <td>
                      <div className="table-actions">
                        <button type="button" onClick={() => handleQuickUpdateLink(link, { clicks: Number(link.clicks || 0) + 1 })}>+点击</button>
                        <button type="button" onClick={() => handleQuickUpdateLink(link, { registrations: Number(link.registrations || 0) + 1 })}>+注册</button>
                        <button type="button" onClick={() => deleteCampaignLink(link.id).then(refresh)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {campaignLinks.length === 0 && <tr><td colSpan="7">暂无转化追踪链接</td></tr>}
              </tbody>
            </table>
          </div>

          {metrics.length === 0 ? (
            <EmptyState title="暂无内容表现数据" description="Telegram webhook、发布指标同步或手动录入的数据会出现在这里。" />
          ) : (
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>平台</th>
                    <th>浏览</th>
                    <th>互动</th>
                    <th>点击</th>
                    <th>注册</th>
                    <th>收入</th>
                    <th>采集时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((metric) => (
                    <tr key={metric.id}>
                      <td>{metric.content_library?.title || '未关联内容'}</td>
                      <td>{metric.platform}</td>
                      <td>{compactNumber(metric.views)}</td>
                      <td>{compactNumber(Number(metric.likes) + Number(metric.comments) + Number(metric.shares))}</td>
                      <td>{compactNumber(metric.clicks)}</td>
                      <td>{compactNumber(metric.registrations)}</td>
                      <td>{Number(metric.revenue || 0).toFixed(2)}</td>
                      <td>{formatDate(metric.collected_at)}</td>
                      <td><button type="button" onClick={() => deleteContentMetric(metric.id).then(refresh)}>删除</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="content-grid">
            <PerformancePanel title="平台表现" rows={summary.platformRows} nameKey="platform" />
            <PerformancePanel title="账号表现" rows={summary.accountRows} nameKey="account" />
            <PerformancePanel title="内容类型排行" rows={summary.contentTypeRows} nameKey="contentType" />
          </div>

          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>策略</th>
                  <th>来源</th>
                  <th>重点</th>
                  <th>ROI</th>
                  <th>建议</th>
                  <th>创建时间</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((strategy) => (
                  <tr key={strategy.id}>
                    <td>{strategy.title}</td>
                    <td>{strategy.source}</td>
                    <td>{strategy.optimization_strategy?.focus || '—'}</td>
                    <td>{strategy.optimization_strategy?.roi ? `${strategy.optimization_strategy.roi.conversion_rate}% / ${strategy.optimization_strategy.roi.revenue_per_click}` : '—'}</td>
                    <td>{strategy.optimization_strategy?.recommendations?.join(' / ') || '—'}</td>
                    <td>{formatDate(strategy.created_at)}</td>
                  </tr>
                ))}
                {strategies.length === 0 && <tr><td colSpan="6">暂无优化策略</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function PerformancePanel({ title, rows, nameKey }) {
  return (
    <article className="analysis-card">
      <p className="eyebrow">{title}</p>
      {rows.length === 0 ? (
        <p>暂无数据</p>
      ) : (
        rows.slice(0, 5).map((row) => (
          <div className="metric-row" key={row[nameKey]}>
            <span>{row[nameKey]}</span>
            <strong>{compactNumber(row.views)} / {Number(row.revenue || 0).toFixed(2)}</strong>
          </div>
        ))
      )}
    </article>
  );
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
