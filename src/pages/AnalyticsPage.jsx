import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
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

const METRIC_LABELS = {
  impressions: '曝光 / 浏览',
  likes: '点赞',
  comments: '回复 / 评论',
  shares: '转发 / 分享',
  saves: '收藏',
  profile_visits: '主页访问',
  link_clicks: '链接点击',
  follows: '新增关注',
  registrations: '注册',
  conversions: '转化',
};

export function AnalyticsPage({ userId, onNavigate, campaignContext, refreshCampaignContext }) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setReloadKey((value) => value + 1);
    refreshCampaignContext?.();
  }, [refreshCampaignContext]);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
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
    return () => { cancelled = true; };
  }, [userId, reloadKey]);

  const scopedTaskIds = useMemo(
    () => new Set((campaignContext?.publishTasks || []).map((item) => String(item.id))),
    [campaignContext?.publishTasks],
  );
  const scopedPackageIds = useMemo(
    () => new Set((campaignContext?.contentPackages || []).map((item) => String(item.id))),
    [campaignContext?.contentPackages],
  );
  const scopedPublishTasks = useMemo(
    () => data.publishTasks.filter((item) => scopedTaskIds.has(String(item.id))),
    [data.publishTasks, scopedTaskIds],
  );
  const metrics = useMemo(() => [
    ...data.contentMetrics.filter((item) => (
      scopedPackageIds.has(String(item.content_package_id || ''))
      || scopedTaskIds.has(String(item.publish_task_id || ''))
    )),
    ...data.publishMetrics.filter((item) => scopedTaskIds.has(String(item.publish_task_id || item.id))),
  ], [data.contentMetrics, data.publishMetrics, scopedPackageIds, scopedTaskIds]);

  const summary = useMemo(() => {
    const published = scopedPublishTasks.filter((item) => ['published', 'completed', 'success'].includes(String(item.status).toLowerCase()));
    return {
      published: published.length,
      exposure: metrics.reduce((sum, item) => sum + getExposure(item), 0),
      interactions: metrics.reduce((sum, item) => sum + getInteractions(item), 0),
      clicks: metrics.reduce((sum, item) => sum + getMetric(item, 'link_clicks'), 0),
    };
  }, [metrics, scopedPublishTasks]);

  const dayOne = useMemo(
    () => getDayOneContext(campaignContext, scopedPublishTasks, data.contentMetrics),
    [campaignContext, scopedPublishTasks, data.contentMetrics],
  );

  const recentMetrics = useMemo(() => [...metrics]
    .sort((left, right) => new Date(getMetricDate(right) || 0) - new Date(getMetricDate(left) || 0))
    .slice(0, 12), [metrics]);

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看运营分析和学习记忆。" />;

  return (
    <section className="page-stack analytics-page">
      <div className="hero-panel analytics-hero">
        <div>
          <p className="eyebrow">数据复盘与知识闭环</p>
          <h2>把真实表现沉淀为下一条内容的依据</h2>
          <p>只使用平台真实返回的数据。无法获取的指标会标记为“暂不可用”，不会被解释成 0。</p>
        </div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={() => onNavigate('workspace')}>返回内容工作台</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>打开知识库</button>
        </div>
      </div>

      <div className="analytics-loop" aria-label="运营学习闭环">
        <span>发布内容</span><i>→</i><span>回收指标</span><i>→</i><span>AI 复盘</span><i>→</i><span>人工确认</span><i>→</i><span>沉淀知识</span>
      </div>

      <DayOneReviewPanel campaignContext={campaignContext} dayOne={dayOne} onCompleted={reload} />

      <div className="stat-grid compact">
        <StatCard label="已发布" value={loading ? '-' : summary.published} hint="进入数据学习闭环" />
        <StatCard label="总曝光" value={loading ? '-' : compactNumber(summary.exposure)} hint="只汇总可用指标" />
        <StatCard label="总互动" value={loading ? '-' : compactNumber(summary.interactions)} hint="点赞、评论与分享" />
        <StatCard label="链接点击" value={loading ? '-' : compactNumber(summary.clicks)} hint="平台可用时显示" />
      </div>

      {errors.length > 0 && <div className="notice error">部分数据暂时无法读取：{errors.join('；')}</div>}

      <section className="table-card analytics-performance-section">
        <div className="panel-title">
          <div><p className="eyebrow">表现信号</p><h3>最近内容表现</h3><p>优先显示最新回传的内容与发布指标。</p></div>
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
                <span>{formatMetricNumber(item, 'impressions')}</span>
                <span>{compactNumber(getInteractions(item))}</span>
                <span>{formatMetricNumber(item, 'link_clicks')}</span>
                <time>{formatDate(getMetricDate(item))}</time>
              </div>
            ))}
          </div>
        ) : !loading ? <div className="empty-card-inline">发布内容并回传指标后，最近表现会显示在这里。</div> : null}
      </section>

      <div className="analytics-memory-grid">
        <MemorySection eyebrow="内容记忆" title="高表现内容模式" description="仅沉淀经过验证或明确标记为初步观察的模式。" count={data.contentMemory.length}>
          {data.contentMemory.length > 0 ? data.contentMemory.slice(0, 8).map((memory, index) => (
            <ContentMemoryCard memory={memory} key={memory.id || index} />
          )) : !loading ? <div className="empty-card-inline">暂无内容记忆。</div> : null}
        </MemorySection>
        <MemorySection eyebrow="策略记忆" title="策略学习结果" description="新的调整先作为待审核建议，不覆盖已批准策略。" count={data.strategyMemory.length}>
          {data.strategyMemory.length > 0 ? data.strategyMemory.slice(0, 8).map((memory, index) => (
            <StrategyMemoryCard memory={memory} key={memory.id || index} />
          )) : !loading ? <div className="empty-card-inline">暂无策略记忆。</div> : null}
        </MemorySection>
      </div>
    </section>
  );
}

function DayOneReviewPanel({ campaignContext, dayOne, onCompleted }) {
  const campaignId = campaignContext?.campaign?.id || campaignContext?.id;
  const payload = {
    campaign_id: campaignId,
    day: 1,
    content_package_id: dayOne.package?.id,
    publish_task_id: dayOne.task?.id,
  };
  const isPublished = dayOne.task?.status === 'published';
  const hasMetrics = Boolean(dayOne.metric);
  const hasReview = Boolean(dayOne.review?.id);

  return (
    <section className="table-card day1-review-panel">
      <div className="panel-title">
        <div>
          <p className="eyebrow">Day 1 发布后复盘</p>
          <h3>{dayOne.package?.title || 'Day 1 尚未进入数据回收'}</h3>
          <p>{dayOne.accountLabel} · {dayOne.task?.platform || dayOne.package?.platform || '平台未确定'}</p>
        </div>
        <StatusBadge status={isPublished ? (hasReview ? 'completed' : 'published') : dayOne.task?.status || 'not_started'} />
      </div>

      {!isPublished ? (
        <div className="empty-card-inline">
          Day 1 真实发布完成后才能回收指标。dry_run 只表示预检或测试完成，不会生成虚假数据。
        </div>
      ) : (
        <>
          <div className="day1-metric-grid">
            {Object.keys(METRIC_LABELS).map((key) => (
              <div className="day1-metric-card" key={key}>
                <span>{METRIC_LABELS[key]}</span>
                <strong>{dayOne.metric ? formatMetricNumber(dayOne.metric, key) : '待同步'}</strong>
                <small>{getMetricAvailability(dayOne.metric, key) === 'unavailable' ? '平台暂不可用' : '真实回传'}</small>
              </div>
            ))}
          </div>

          <div className="day1-review-actions">
            <ExecutionButton
              action="collect_content_metrics"
              resourceType="campaign"
              resourceId={campaignId}
              payload={payload}
              onCompleted={onCompleted}
              ready={Boolean(campaignId && dayOne.task?.id)}
            >
              {hasMetrics ? '重新同步指标' : '回收 Day 1 指标'}
            </ExecutionButton>
            <ExecutionButton
              action="review_content_performance"
              resourceType="campaign"
              resourceId={campaignId}
              payload={payload}
              onCompleted={onCompleted}
              ready={hasMetrics}
              reason={hasMetrics ? '' : '请先回收指标'}
            >
              {hasReview ? '重新生成 AI 复盘' : '生成 AI 复盘'}
            </ExecutionButton>
          </div>

          {hasReview && (
            <div className="day1-review-body">
              <div className="notice warning">{dayOne.review.sample_notice || '样本不足，仅作为初步观察'}</div>
              <section><h4>执行概况</h4><p>{dayOne.review.execution_overview}</p></section>
              <section>
                <h4>判断与证据</h4>
                <div className="review-findings">
                  {(dayOne.review.findings || []).map((finding, index) => (
                    <article key={`${finding.title}-${index}`}>
                      <span className={`evidence-label ${finding.classification}`}>{classificationLabel(finding.classification)}</span>
                      <strong>{finding.title}</strong>
                      <p>{finding.conclusion}</p>
                      <small>{finding.evidence}</small>
                    </article>
                  ))}
                </div>
              </section>
              <section><h4>下一步建议</h4><ol>{(dayOne.review.next_steps || []).map((item) => <li key={item}>{item}</li>)}</ol></section>
              <div className="day1-review-actions">
                <ExecutionButton action="create_strategy_adjustment_suggestion" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>
                  应用到下一天（待审核建议）
                </ExecutionButton>
                <ExecutionButton action="save_campaign_insight" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>
                  保存为知识
                </ExecutionButton>
                <ExecutionButton action="update_account_memory" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>
                  加入账号 Brain 待审核观察
                </ExecutionButton>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function getDayOneContext(campaignContext, tasks, contentMetrics) {
  const packages = campaignContext?.contentPackages || [];
  const dayPackage = packages.find((item) => getPackageDay(item) === 1) || null;
  const task = tasks.find((item) => String(item.content_package_id) === String(dayPackage?.id) && item.status === 'published')
    || tasks.find((item) => String(item.content_package_id) === String(dayPackage?.id))
    || null;
  const metric = [...contentMetrics]
    .filter((item) => String(item.publish_task_id || '') === String(task?.id || '') || String(item.content_package_id || '') === String(dayPackage?.id || ''))
    .sort((a, b) => new Date(getMetricDate(b) || 0) - new Date(getMetricDate(a) || 0))[0] || null;
  const rawPackage = dayPackage?.raw || dayPackage || {};
  const review = rawPackage.source_insights?.day1_review
    || rawPackage.image_requirements?.day1_review
    || dayPackage?.source_insights?.day1_review
    || dayPackage?.image_requirements?.day1_review
    || null;
  const account = campaignContext?.primaryAccount;
  return {
    package: dayPackage,
    task,
    metric,
    review,
    accountLabel: account?.account_name || account?.username || account?.name || '运营账号未关联',
  };
}

function getPackageDay(item = {}) {
  const raw = item.raw || item;
  const explicit = Number(raw.source_insights?.day_index || raw.source_insights?.day || raw.dayIndex || raw.day_index);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const match = String(raw.title || item.title || '').match(/day\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function MemorySection({ children, count, description, eyebrow, title }) {
  return (
    <section className="table-card memory-section">
      <div className="panel-title"><div><p className="eyebrow">{eyebrow}</p><h3>{title}</h3><p>{description}</p></div><span>{count} 条</span></div>
      <div className="memory-card-list">{children}</div>
    </section>
  );
}

function ContentMemoryCard({ memory }) {
  const tags = normalizeList(memory.tags);
  return (
    <article className="memory-card">
      <div className="memory-card-head"><strong>{memory.pattern || memory.content_type || '内容模式'}</strong>{memory.platform && <span className="memory-platform">{memory.platform}</span>}</div>
      <div className="memory-facts"><span>{memory.content_type || '内容'}</span><span>成功率 {formatRate(memory.success_rate)}</span><span>{memory.source || '分析'}</span></div>
      {tags.length > 0 && <div className="tag-row">{tags.slice(0, 8).map((tag) => <span className="tag" key={String(tag)}>#{tag}</span>)}</div>}
    </article>
  );
}

function StrategyMemoryCard({ memory }) {
  return (
    <article className="memory-card">
      <div className="memory-card-head"><strong>{memory.strategy_name || memory.strategy_type || '策略复盘'}</strong><StatusBadge status={memory.status || 'completed'} /></div>
      <p>{memory.lessons_learned || memory.description || '策略执行结果已记录。'}</p>
      <div className="memory-footer"><span>{memory.results?.suggestion_status === 'pending_review' ? '待审核建议' : '策略记忆'}</span><time>{formatDate(memory.updated_at || memory.created_at)}</time></div>
    </article>
  );
}

function metricContainer(item) {
  return item?.metrics?.values || item?.metrics_json?.values || item?.metrics || item?.metrics_json || {};
}

function getMetric(item, key) {
  const values = metricContainer(item);
  const aliases = key === 'impressions' ? ['impressions', 'views', 'reach'] : key === 'link_clicks' ? ['link_clicks', 'clicks'] : [key];
  for (const alias of aliases) {
    const value = values?.[alias] ?? item?.[alias];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function getMetricAvailability(item, key) {
  return item?.metrics?.availability?.[key]?.status || item?.metrics_json?.availability?.[key]?.status || 'unknown';
}

function formatMetricNumber(item, key) {
  return getMetricAvailability(item, key) === 'unavailable' ? '暂不可用' : compactNumber(getMetric(item, key));
}

function getExposure(item) {
  return getMetric(item, 'impressions');
}

function getInteractions(item) {
  return getMetric(item, 'likes') + getMetric(item, 'comments') + getMetric(item, 'shares');
}

function getMetricDate(item) {
  return item?.fetched_at || item?.last_sync || item?.collected_at || item?.created_at || item?.updated_at;
}

function getMetricTitle(item) {
  return item?.title || item?.content_ref || item?.platform_post_id || item?.platform || '内容表现';
}

function formatRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${Math.round(number > 1 ? number : number * 100)}%`;
}

function classificationLabel(value) {
  return {
    verified_conclusion: '已验证结论',
    initial_signal: '初步信号',
    hypothesis: '待验证假设',
    insufficient_data: '无足够数据',
  }[value] || '待验证假设';
}
