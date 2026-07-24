import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { loadKeys } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { formatDate } from '../utils/formatters';

const EMPTY = { contentMetrics: [], publishMetrics: [], insights: [], accountReports: [], publishTasks: [], contentMemory: [], strategyMemory: [] };

export function AnalyticsOptimizationPage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;
    setLoading(true);
    loadKeys(['contentMetrics', 'publishMetrics', 'insights', 'accountReports', 'publishTasks', 'contentMemory', 'strategyMemory'])
      .then((next) => setData({ ...EMPTY, ...next }))
      .finally(() => setLoading(false));
  }, [userId]);

  const metrics = useMemo(() => [...data.contentMetrics, ...data.publishMetrics], [data]);
  const published = data.publishTasks.filter((item) => ['published', 'completed', 'success'].includes(String(item.status).toLowerCase()));
  const views = metrics.reduce((sum, item) => sum + Number(item.views || item.impressions || item.reach || 0), 0);
  const interactions = metrics.reduce((sum, item) => sum + Number(item.likes || 0) + Number(item.comments || 0) + Number(item.shares || item.reposts || 0), 0);

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看运营分析。" />;

  return (
    <section className="page-stack">
      <div className="hero-panel">
        <p className="eyebrow">ANALYTICS / 学习闭环</p>
        <h2>用真实发布结果反向优化策略、Hook 和内容生成</h2>
        <p>发布数据、内容指标、账号洞察与 AI 建议集中在这里，供策略智能体和内容智能体下一轮生成时复用。</p>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('campaigns')}>返回运营活动与策略</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>查看知识库</button>
        </div>
      </div>
      <div className="stat-grid compact">
        <StatCard label="指标记录" value={loading ? '-' : metrics.length} hint="内容与发布指标" />
        <StatCard label="累计曝光" value={loading ? '-' : views.toLocaleString('zh-CN')} hint="views / impressions / reach" />
        <StatCard label="累计互动" value={loading ? '-' : interactions.toLocaleString('zh-CN')} hint="点赞、评论与分享" />
        <StatCard label="已发布" value={loading ? '-' : published.length} hint="进入学习闭环的内容" />
      </div>
      {metrics.length ? (
        <section className="table-card">
          <div className="panel-title"><h3>最近表现</h3><span>{metrics.length} 条</span></div>
          <div className="record-list">
            {metrics.slice(0, 20).map((item, index) => (
              <article className="record-row" key={item.id || index}>
                <div><strong>{item.title || item.platform || item.metric_type || '内容表现'}</strong><small>曝光 {item.views || item.impressions || item.reach || 0} · 互动 {Number(item.likes || 0) + Number(item.comments || 0) + Number(item.shares || item.reposts || 0)}</small></div>
                <span>{formatDate(item.collected_at || item.last_sync || item.created_at)}</span>
              </article>
            ))}
          </div>
        </section>
      ) : <EmptyState title="暂无分析数据" description="内容发布并回传指标后，这里会形成可用于下一轮生成的优化依据。" />}

      <div className="analytics-memory-grid">
        <section className="table-card memory-section">
          <div className="panel-title"><div><p className="eyebrow">CONTENT MEMORY</p><h3>高表现内容模式</h3></div><span>{data.contentMemory.length} 条</span></div>
          <div className="memory-card-list">
            {data.contentMemory.length ? data.contentMemory.slice(0, 20).map((memory, index) => (
              <article className="memory-card" key={memory.id || index}>
                <div className="memory-card-head">
                  <strong>{memory.pattern || memory.winning_pattern || memory.content_type || memory.title || '内容模式'}</strong>
                  <StatusBadge status={memory.status || 'success'} />
                </div>
                <div className="tag-row">
                  {memory.platform && <span className="tag">{memory.platform}</span>}
                  <span className="tag">成功率 {formatRate(memory.success_rate || memory.score)}</span>
                </div>
                <p>{memory.recommendation || memory.summary || memory.description || '该模式已保存，可供内容智能体下一轮生成参考。'}</p>
              </article>
            )) : <div className="empty-card-inline">发布内容回传表现后，高成功率模式会沉淀到这里。</div>}
          </div>
        </section>

        <section className="table-card memory-section">
          <div className="panel-title"><div><p className="eyebrow">STRATEGY MEMORY</p><h3>策略学习结果</h3></div><span>{data.strategyMemory.length} 条</span></div>
          <div className="memory-card-list">
            {data.strategyMemory.length ? data.strategyMemory.slice(0, 20).map((memory, index) => (
              <article className="memory-card" key={memory.id || index}>
                <div className="memory-card-head">
                  <strong>{memory.strategy_name || memory.title || memory.name || '策略复盘'}</strong>
                  <StatusBadge status={memory.status || 'completed'} />
                </div>
                <p>{memory.lessons_learned || memory.learning || memory.summary || memory.description || '策略学习结果已保存。'}</p>
              </article>
            )) : <div className="empty-card-inline">策略执行并完成复盘后，经验和教训会显示在这里。</div>}
          </div>
        </section>
      </div>
    </section>
  );
}

function formatRate(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round((number > 1 ? number / 100 : number) * 100)}%`;
}
