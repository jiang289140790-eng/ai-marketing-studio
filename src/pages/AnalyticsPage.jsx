import { useCallback, useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { ExecutionButton } from '../components/ExecutionButton';
import { StatusBadge } from '../components/StatusBadge';
import { readRows } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import { buildReviewSuggestions } from '../utils/analytics-review-model';
import { formatDate } from '../utils/formatters';

const EMPTY = {
  contentMetrics: [],
  publishMetrics: [],
  publishTasks: [],
  contentMemory: [],
  strategyMemory: [],
};

const REQUESTS = [
  ['contentMetrics', { limit: 100, orderBy: 'fetched_at' }],
  ['publishMetrics', { limit: 100, orderBy: 'last_sync' }],
  ['publishTasks', { limit: 100, orderBy: 'created_at' }],
  ['contentMemory', { limit: 50, orderBy: 'created_at' }],
  ['strategyMemory', { limit: 50, orderBy: 'created_at' }],
];

export function AnalyticsPage({
  activeCampaignId,
  auxiliaryMode = 'normal',
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
  refreshCampaignContext,
}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setReloadKey((value) => value + 1);
    refreshCampaignContext?.();
  }, [refreshCampaignContext]);

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    let cancelled = false;
    setLoading(true);
    Promise.allSettled(REQUESTS.map(([key, options]) => readRows(key, options)))
      .then((results) => {
        if (cancelled) return;
        const next = { ...EMPTY };
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') next[REQUESTS[index][0]] = result.value;
        });
        setData(next);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [reloadKey, userId]);

  const scoped = useMemo(() => Object.fromEntries(Object.entries(data).map(([key, rows]) => [
    key,
    filterRecordsForAuxiliaryScope(rows, {
      scope: dataScope,
      campaignContext,
      activeCampaignId,
    }),
  ])), [activeCampaignId, campaignContext, data, dataScope]);

  const dayOne = useMemo(
    () => getDayOneReviewContext(campaignContext, scoped.publishTasks, scoped.contentMetrics, scoped.publishMetrics),
    [campaignContext, scoped.contentMetrics, scoped.publishMetrics, scoped.publishTasks],
  );
  const suggestions = useMemo(() => buildReviewSuggestions(dayOne.review || {}), [dayOne.review]);
  const hasRealData = dayOne.realMetrics.length > 0;
  const hasReview = suggestions.length > 0 || Boolean(dayOne.review?.execution_overview);
  const campaignId = campaignContext?.campaign?.id || activeCampaignId;
  const executionPayload = {
    campaign_id: campaignId,
    day: 1,
    content_package_id: dayOne.package?.id,
    publish_task_id: dayOne.task?.id,
  };

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看 AI 复盘。" />;

  return (
    <section className="page-stack ai-review-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">AI 复盘</p>
          <h2>解释为什么发生，并给出下一步动作</h2>
          <p>这里只解释真实数据和证据，不重复展示数据分析表，也不会用一条内容自动改写正式策略。</p>
        </div>
        <div className="button-row">
          <button className="ghost-button" type="button" onClick={() => onNavigate('data-analytics')}>查看数据分析</button>
          <button className="ghost-button" type="button" onClick={() => onNavigate('knowledge')}>打开知识库</button>
        </div>
      </div>

      {message && <div className="notice">{message}</div>}

      <section className="table-card review-status-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow">本轮复盘状态</p>
            <h3>{dayOne.package?.title || 'Day 1 尚未形成可复盘内容'}</h3>
            <p>{dayOne.accountLabel} · {dayOne.task?.platform || dayOne.package?.platform || '平台未确定'}</p>
          </div>
          <StatusBadge status={hasReview ? 'completed' : hasRealData ? 'review' : 'blocked'} />
        </div>
        {!hasRealData ? (
          <div className="review-blocker-card">
            <strong>当前阻塞：尚无真实发布指标</strong>
            <p>{dayOne.task?.status === 'published'
              ? '内容已经发布，但指标尚未回收。'
              : '当前只有安全预演或待发布任务，不能据此生成表现结论。'}</p>
            <div className="button-row">
              {dayOne.task?.status === 'published' ? (
                <ExecutionButton
                  action="collect_content_metrics"
                  resourceType="campaign"
                  resourceId={campaignId}
                  payload={executionPayload}
                  ready={Boolean(campaignId && dayOne.task?.id)}
                  onCompleted={reload}
                >
                  回收 Day 1 指标
                </ExecutionButton>
              ) : <button className="primary-button" type="button" onClick={() => onNavigate('publish')}>查看发布任务</button>}
              <button type="button" onClick={() => onNavigate('workspace')}>返回内容工作台</button>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <ExecutionButton
              action="review_content_performance"
              resourceType="campaign"
              resourceId={campaignId}
              payload={executionPayload}
              onCompleted={reload}
            >
              {hasReview ? '重新生成复盘' : '生成 AI 复盘'}
            </ExecutionButton>
          </div>
        )}
      </section>

      {hasRealData && (
        <>
          {dayOne.realMetrics.length < 3 && <div className="notice warning">样本不足，仅作为初步观察；当前真实样本数为 {dayOne.realMetrics.length}。</div>}

          <section className="table-card">
            <div className="panel-title"><div><p className="eyebrow">核心结论</p><h3>本轮最值得处理的 3 条结论</h3></div><span>{suggestions.length} 条</span></div>
            {suggestions.length ? (
              <div className="review-suggestion-grid">
                {suggestions.map((suggestion) => (
                  <ReviewSuggestion
                    campaignId={campaignId}
                    key={suggestion.id}
                    payload={executionPayload}
                    suggestion={suggestion}
                    onCompleted={reload}
                    onDismiss={() => setMessage('已暂不采用；该结论没有写入正式策略。')}
                  />
                ))}
              </div>
            ) : <div className="empty-card-inline">指标已经回收，下一步请生成 AI 复盘。</div>}
          </section>

          <div className="review-aspect-grid">
            <ReviewAspect title="文案表现" value={dayOne.review?.copy_review} fallback="尚未形成文案归因。" />
            <ReviewAspect title="素材表现" value={dayOne.review?.asset_review} fallback="尚未形成素材归因。" />
            <ReviewAspect title="CTA 表现" value={dayOne.review?.cta_review} fallback="平台未提供足够点击或转化数据。" />
            <ReviewAspect title="发布时间表现" value={dayOne.review?.timing_review} fallback="样本不足，暂不能判断最佳发布时间。" />
          </div>

          <section className="table-card">
            <div className="panel-title"><div><p className="eyebrow">建议动作</p><h3>下一步怎么做</h3></div></div>
            <ol className="review-action-list">
              {(dayOne.review?.next_steps || suggestions.map((item) => item.recommendedAction)).slice(0, 5).map((item) => <li key={item}>{item}</li>)}
            </ol>
          </section>

          <details className="table-card review-memory-details">
            <summary>历史经验库（默认折叠）</summary>
            <p>仅显示当前范围内最近使用的已验证或初步信号；测试记忆需切换“测试数据”范围。</p>
            <div className="analytics-memory-grid">
              <MemoryList title="内容经验" rows={filterMemory(scoped.contentMemory).slice(0, 6)} />
              <MemoryList title="策略经验" rows={filterMemory(scoped.strategyMemory).slice(0, 6)} />
            </div>
            {auxiliaryMode === 'advanced' && <small>高级模式：原始记录仍保留在数据库，当前仅展示经过范围筛选的摘要。</small>}
          </details>
        </>
      )}

      {!loading && !hasRealData && (
        <EmptyState
          title="没有可以解释的真实发布数据"
          reason="AI 复盘不会用 dry-run、测试记录或无关历史 Memory 代替当前 Campaign 的真实表现。"
          prerequisite="先完成 Day 1 正式发布并回收至少一条指标。"
          actionHref="#/publish"
          actionLabel="查看发布中心"
        />
      )}
    </section>
  );
}

function ReviewSuggestion({ campaignId, onCompleted, onDismiss, payload, suggestion }) {
  return (
    <article className="review-suggestion-card">
      <div className="card-meta"><span>{suggestion.dataStatus}</span><span>置信度 {suggestion.confidence == null ? '待评估' : `${suggestion.confidence}%`}</span></div>
      <h3>{suggestion.conclusion}</h3>
      <dl>
        <div><dt>证据</dt><dd>{suggestion.evidence}</dd></div>
        <div><dt>样本数</dt><dd>{suggestion.sampleCount || '不足'}</dd></div>
        <div><dt>适用范围</dt><dd>{suggestion.scope}</dd></div>
        <div><dt>推荐动作</dt><dd>{suggestion.recommendedAction}</dd></div>
      </dl>
      <div className="button-row">
        <ExecutionButton action="create_strategy_adjustment_suggestion" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>应用到下一条内容</ExecutionButton>
        <ExecutionButton action="create_strategy_adjustment_suggestion" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>创建策略调整草稿</ExecutionButton>
        <ExecutionButton action="save_campaign_insight" resourceType="campaign" resourceId={campaignId} payload={payload} onCompleted={onCompleted}>保存为待验证假设</ExecutionButton>
        <button type="button" onClick={onDismiss}>暂不采用</button>
      </div>
    </article>
  );
}

function ReviewAspect({ fallback, title, value }) {
  return <article className="table-card review-aspect-card"><h3>{title}</h3><p>{readReviewText(value) || fallback}</p></article>;
}

function MemoryList({ rows, title }) {
  return (
    <section>
      <h4>{title}</h4>
      {rows.length ? rows.map((row, index) => (
        <article className="memory-card" key={row.id || index}>
          <strong>{row.pattern || row.strategy_name || row.title || '历史经验'}</strong>
          <p>{row.lessons_learned || row.description || row.summary || '已记录的运营经验。'}</p>
          <small>{formatDate(row.last_used_at || row.updated_at || row.created_at)}</small>
        </article>
      )) : <div className="empty-card-inline">当前 Campaign 暂无符合条件的历史经验。</div>}
    </section>
  );
}

function getDayOneReviewContext(campaignContext, publishTasks, contentMetrics, publishMetrics) {
  const packages = campaignContext?.contentPackages || [];
  const packageItem = packages.find((item) => getPackageDay(item) === 1) || null;
  const task = publishTasks.find((item) => String(item.content_package_id) === String(packageItem?.id) && item.status === 'published')
    || publishTasks.find((item) => String(item.content_package_id) === String(packageItem?.id))
    || campaignContext?.publishTasks?.find((item) => String(item.content_package_id) === String(packageItem?.id))
    || null;
  const realMetrics = [...contentMetrics, ...publishMetrics].filter((item) => (
    String(item.publish_task_id || '') === String(task?.id || '')
    || String(item.content_package_id || '') === String(packageItem?.id || '')
  ));
  const rawPackage = packageItem?.raw || packageItem || {};
  const review = rawPackage.source_insights?.day1_review
    || rawPackage.image_requirements?.day1_review
    || packageItem?.source_insights?.day1_review
    || packageItem?.image_requirements?.day1_review
    || null;
  const account = campaignContext?.primaryAccount;
  return {
    package: packageItem,
    task,
    realMetrics,
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

function filterMemory(rows = []) {
  return [...rows]
    .filter((row) => {
      const status = String(row.status || row.results?.suggestion_status || '').toLowerCase();
      return !/phase[2789]|debug|test|marker/i.test(`${row.strategy_name || ''} ${row.pattern || ''}`)
        && (!status || ['approved', 'completed', 'success', 'validated', 'verified', 'planned', 'pending_review'].includes(status));
    })
    .sort((a, b) => new Date(b.last_used_at || b.updated_at || b.created_at || 0) - new Date(a.last_used_at || a.updated_at || a.created_at || 0));
}

function readReviewText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join('；');
  return value.conclusion || value.summary || value.observation || '';
}
