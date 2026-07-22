import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { normalizeList, readRows } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { compactNumber, formatDate } from '../utils/formatters';

const EMPTY = {
  contentMetrics: [],
  publishMetrics: [],
  publishTasks: [],
  contentMemory: [],
  strategyMemory: [],
};

const DATA_REQUESTS = [
  ['contentMetrics', { limit: 100, orderBy: 'fetched_at' }],
  ['publishMetrics', { limit: 100, orderBy: 'last_sync' }],
  ['publishTasks', { limit: 100, orderBy: 'created_at' }],
  ['contentMemory', { limit: 50, orderBy: 'success_rate' }],
  ['strategyMemory', { limit: 50, orderBy: 'created_at' }],
];

export function AnalyticsPage({ userId, onNavigate }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState([]);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return;

    let cancelled = false;
    setLoading(true);
    setErrors([]);

    Promise.allSettled(DATA_REQUESTS.map(([key, options]) => readRows(key, options)))
      .then((results) => {
        if (cancelled) return;
        const next = { ...EMPTY };
        const nextErrors = [];

        results.forEach((result, index) => {
          const key = DATA_REQUESTS[index][0];
          if (result.status === 'fulfilled') next[key] = result.value;
          else nextErrors.push(result.reason?.message || `${key} 读取失败`);
        });

        setData(next);
        setErrors(nextErrors);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const metrics = useMemo(() => [...data.contentMetrics, ...data.publishMetrics], [data.contentMetrics, data.publishMetrics]);

  const summary = useMemo(() => {
    const published = data.publishTasks.filter((item) => ['published', 'completed', 'success'].includes(String(item.status).toLowerCase()));
    return {
      published: published.length,
      exposure: metrics.reduce((sum, item) => sum + getExposure(item), 0),
      interactions: metrics.reduce((sum, item) => sum + getInteractions(item), 0),
      clicks: metrics.reduce((sum, item) => sum + getMetric(item, 'clicks'), 0),
    };
  }, [data.publishTasks, metrics]);

  const recentMetrics = useMemo(() => [...metrics]
    .sort((left, right) => new Date(getMetricDate(right) || 0) - new Date(getMetricDate(left) || 0))
    .slice(0, 12), [metrics]);

  if (!userId) {
    return <EmptyState title="请先登录" description="登录后才能查看运营分析和 Agent 学习记忆。" />;
  }

  return (
    <section className="page-stack analytics-page">
      <div className="hero-panel analytics-hero">
        <div>
          <p className="eyebrow">ANALYTICS / LEARNING LOOP</p>
          <h2>把真实表现沉淀成下一轮内容与策略的生成依据</h2>
          <p>发布指标负责回答“发生了什么”，Content Memory 与 Strategy Memory 负责记录“为什么有效、下次怎么复用”。</p>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('campaigns')}>返回 Campaign 与策略</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>打开知识库</button>
        </div>
      </div>

      <div className="analytics-loop" aria-label="运营学习闭环">
        <span>发布内容</span><i>→</i><span>回传指标</span><i>→</i><span>识别高表现模式</span><i>→</i><span>沉淀策略记忆</span><i>→</i><span>指导下一轮生成</span>
      </div>

      <div className="stat-grid compact">
        <StatCard label="已发布" value={loading ? '-' : summary.published} hint="进入数据学习闭环" />
        <StatCard label="总曝光" value={loading ? '-' : compactNumber(summary.exposure)} hint="impressions / views / reach" />
        <StatCard label="总互动" value={loading ? '-' : compactNumber(summary.interactions)} hint="点赞、评论与分享" />
        <StatCard label="点击" value={loading ? '-' : compactNumber(summary.clicks)} hint="内容引导点击" />
      </div>

      {errors.length > 0 && (
        <div className="notice error">
          部分数据暂时无法读取：{errors.join('；')}
        </div>
      )}

      <section className="table-card analytics-performance-section">
        <div className="panel-title">
          <div>
            <p className="eyebrow">PERFORMANCE SIGNALS</p>
            <h3>最近内容表现</h3>
            <p>优先显示最新回传的内容与发布指标。</p>
          </div>
          <span>{metrics.length} 条指标</span>
        </div>

        {recentMetrics.length > 0 ? (
          <div className="performance-table" role="table" aria-label="最近内容表现">
            <div className="performance-row performance-head" role="row">
              <span>内容 / 平台</span><span>曝光</span><span>互动</span><span>点击</span><span>回传时间</span>
            </div>
            {recentMetrics.map((item, index) => (
              <div className="performance-row" role="row" key={item.id || index}>
                <strong>{getMetricTitle(item)}</strong>
                <span>{compactNumber(getExposure(item))}</span>
                <span>{compactNumber(getInteractions(item))}</span>
                <span>{compactNumber(getMetric(item, 'clicks'))}</span>
                <time>{formatDate(getMetricDate(item))}</time>
              </div>
            ))}
          </div>
        ) : !loading ? (
          <div className="empty-card-inline">发布内容并回传指标后，最近表现会显示在这里。</div>
        ) : null}
      </section>

      <div className="analytics-memory-grid">
        <MemorySection
          eyebrow="CONTENT MEMORY"
          title="🏆 高表现内容模式"
          description="记录经过验证的 Hook、标题、CTA、结构与视觉模板，供 Content Agent 直接复用。"
          count={data.contentMemory.length}
        >
          {data.contentMemory.length > 0 ? data.contentMemory.slice(0, 8).map((memory, index) => (
            <ContentMemoryCard memory={memory} key={memory.id || index} />
          )) : !loading ? <div className="empty-card-inline">暂无 Content Memory，完成内容表现分析后会自动沉淀。</div> : null}
        </MemorySection>

        <MemorySection
          eyebrow="STRATEGY MEMORY"
          title="📋 策略学习结果"
          description="记录策略目标、执行结果与经验教训，供 Strategy Agent 在下一轮决策时调用。"
          count={data.strategyMemory.length}
        >
          {data.strategyMemory.length > 0 ? data.strategyMemory.slice(0, 8).map((memory, index) => (
            <StrategyMemoryCard memory={memory} key={memory.id || index} />
          )) : !loading ? <div className="empty-card-inline">暂无 Strategy Memory，策略复盘后会在这里形成长期记忆。</div> : null}
        </MemorySection>
      </div>
    </section>
  );
}

function MemorySection({ children, count, description, eyebrow, title }) {
  return (
    <section className="table-card memory-section">
      <div className="panel-title">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <span>{count} 条</span>
      </div>
      <div className="memory-card-list">{children}</div>
    </section>
  );
}

function ContentMemoryCard({ memory }) {
  const tags = normalizeList(memory.tags);
  const examples = normalizeList(memory.examples);

  return (
    <article className="memory-card content-memory-card">
      <div className="memory-card-head">
        <strong>{memory.pattern || memory.content_type || '内容模式'}</strong>
        {memory.platform && <span className="memory-platform">{memory.platform}</span>}
      </div>
      <div className="memory-facts">
        <span>{memory.content_type || 'content'}</span>
        <span>成功率 {formatRate(memory.success_rate)}</span>
        <span>{memory.source || 'analysis'}</span>
      </div>
      {examples.length > 0 && <p className="memory-example">示例：{examples.slice(0, 2).join('；')}</p>}
      {tags.length > 0 && (
        <div className="tag-row">
          {tags.slice(0, 8).map((tag) => <span className="tag" key={String(tag)}>#{tag}</span>)}
        </div>
      )}
    </article>
  );
}

function StrategyMemoryCard({ memory }) {
  const rating = Math.max(0, Math.min(5, Math.round(Number(memory.effectiveness_rating || 0))));

  return (
    <article className="memory-card strategy-memory-card">
      <div className="memory-card-head">
        <strong>{memory.strategy_name || memory.strategy_type || '策略复盘'}</strong>
        <StatusBadge status={memory.status || 'completed'} />
      </div>
      {memory.goal && <p className="memory-goal">目标：{memory.goal}</p>}
      <p>{memory.lessons_learned || memory.description || '策略执行结果已记录，等待补充复盘结论。'}</p>
      <div className="memory-footer">
        <span className="effectiveness" aria-label={`有效性 ${rating || 0} 星`}>有效性 {rating ? '★'.repeat(rating) : '—'}</span>
        <time>{formatDate(memory.updated_at || memory.created_at)}</time>
      </div>
    </article>
  );
}

function getMetric(item, key) {
  const value = item[key] ?? item.metrics?.[key] ?? item.metrics_json?.[key] ?? item.raw_payload?.[key] ?? item.raw_response?.[key] ?? 0;
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function getExposure(item) {
  return getMetric(item, 'impressions') || getMetric(item, 'views') || getMetric(item, 'reach');
}

function getInteractions(item) {
  return getMetric(item, 'likes') + getMetric(item, 'comments') + getMetric(item, 'shares') + getMetric(item, 'reposts');
}

function getMetricDate(item) {
  return item.fetched_at || item.last_sync || item.published_at || item.metric_date || item.collected_at || item.created_at || item.updated_at;
}

function getMetricTitle(item) {
  return item.title || item.content_ref || item.external_post_id || item.platform || item.metric_type || '内容表现';
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const percentage = number > 1 ? number : number * 100;
  return `${Math.round(percentage)}%`;
}
