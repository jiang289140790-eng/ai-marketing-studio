import { useEffect, useMemo, useState } from 'react';
import { EmptyState } from '../components/EmptyState';
import { readRows } from '../services/ops-service';
import { isSupabaseConfigured } from '../services/supabase-client';
import { filterRecordsForAuxiliaryScope } from '../utils/auxiliary-page-scope';
import {
  aggregateMetrics,
  ANALYTICS_DIMENSIONS,
  ANALYTICS_METRICS,
  filterAnalyticsRows,
  isSmallSample,
  normalizeAnalyticsRow,
} from '../utils/analytics-review-model';
import { compactNumber, formatDate } from '../utils/formatters';
import { buildHarnessContextParams } from '../utils/app-route';

const EMPTY = { contentMetrics: [], publishMetrics: [], publishTasks: [] };

export function DataAnalyticsPage({
  activeCampaignId,
  campaignContext,
  dataScope = 'campaign',
  userId,
  onNavigate,
}) {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [dimension, setDimension] = useState('all');
  const [dimensionValue, setDimensionValue] = useState('all');

  useEffect(() => {
    if (!userId || !isSupabaseConfigured) return undefined;
    let cancelled = false;
    setLoading(true);
    Promise.allSettled([
      readRows('contentMetrics', { limit: 200, orderBy: 'fetched_at' }),
      readRows('publishMetrics', { limit: 200, orderBy: 'last_sync' }),
      readRows('publishTasks', { limit: 200, orderBy: 'created_at' }),
    ]).then((results) => {
      if (cancelled) return;
      setData({
        contentMetrics: results[0].status === 'fulfilled' ? results[0].value : [],
        publishMetrics: results[1].status === 'fulfilled' ? results[1].value : [],
        publishTasks: results[2].status === 'fulfilled' ? results[2].value : [],
      });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [userId]);

  const scopedTasks = useMemo(() => filterRecordsForAuxiliaryScope(data.publishTasks, {
    scope: dataScope,
    campaignContext,
    activeCampaignId,
  }), [activeCampaignId, campaignContext, data.publishTasks, dataScope]);
  const taskIds = useMemo(() => new Set(scopedTasks.map((task) => String(task.id))), [scopedTasks]);
  const packageIds = useMemo(() => new Set((campaignContext?.contentPackages || []).map((item) => String(item.id))), [campaignContext?.contentPackages]);
  const metricRows = useMemo(() => [...data.contentMetrics, ...data.publishMetrics].filter((item) => (
    !['campaign', 'account'].includes(dataScope)
    || taskIds.has(String(item.publish_task_id || ''))
    || packageIds.has(String(item.content_package_id || ''))
  )), [data.contentMetrics, data.publishMetrics, dataScope, packageIds, taskIds]);

  const packageById = useMemo(() => new Map((campaignContext?.contentPackages || []).map((item) => [String(item.id), item.raw || item])), [campaignContext?.contentPackages]);
  const taskById = useMemo(() => new Map(scopedTasks.map((item) => [String(item.id), item])), [scopedTasks]);
  const rows = useMemo(() => metricRows.map((item) => normalizeAnalyticsRow(item, {
    campaignName: campaignContext?.campaign?.name || '当前运营活动',
    accountName: campaignContext?.primaryAccount?.account_name || campaignContext?.primaryAccount?.username || '运营账号未关联',
    packageById,
    taskById,
  })), [campaignContext, metricRows, packageById, taskById]);
  const dimensionOptions = useMemo(() => (
    dimension === 'all' ? [] : [...new Set(rows.map((row) => row[dimension]).filter(Boolean))]
  ), [dimension, rows]);
  const filteredRows = useMemo(() => filterAnalyticsRows(rows, dimension, dimensionValue), [dimension, dimensionValue, rows]);
  const totals = useMemo(() => aggregateMetrics(filteredRows.map((row) => row.raw)), [filteredRows]);

  useEffect(() => setDimensionValue('all'), [dimension]);

  if (!userId) return <EmptyState title="请先登录" description="登录后才能查看数据分析。" />;

  return (
    <section className="page-stack data-analytics-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">数据分析</p>
          <h2>回答发生了什么</h2>
          <p>只展示平台真实返回的数据。平台未提供的指标显示“平台暂不提供”，不会用 0 代替。</p>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => onNavigate('ai', '', buildHarnessContextParams({
            source: 'data-analytics',
            entity: 'analytics-summary',
            campaignId: activeCampaignId,
            intent: activeCampaignId ? `查看运营表现摘要 campaign_id=${activeCampaignId}` : '查看运营表现摘要',
          }))}>交给 AI 汇总</button>
          <button className="primary-button" type="button" onClick={() => onNavigate('analytics')}>进入 AI 复盘</button>
        </div>
      </div>

      <section className="analytics-dimension-bar">
        <label><span>分析维度</span><select value={dimension} onChange={(event) => setDimension(event.target.value)}><option value="all">全部内容</option>{ANALYTICS_DIMENSIONS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
        <label><span>维度值</span><select value={dimensionValue} disabled={dimension === 'all'} onChange={(event) => setDimensionValue(event.target.value)}><option value="all">全部</option>{dimensionOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <div><span>真实样本</span><strong>{filteredRows.length}</strong></div>
      </section>

      {isSmallSample(filteredRows) && <div className="notice warning">当前只有 {filteredRows.length} 条真实样本，统计结果仅作为初步观察。</div>}

      <div className="analytics-metric-grid">
        {ANALYTICS_METRICS.map((metric) => {
          const result = totals[metric.key];
          return (
            <article className="analytics-metric-card" key={metric.key}>
              <span>{metric.label}</span>
              <strong>{result.status === 'available' ? compactNumber(result.value) : '平台暂不提供'}</strong>
              <small>{result.status === 'available' ? `${result.sampleCount} 个可用样本` : '未返回该字段'}</small>
            </article>
          );
        })}
      </div>

      <section className="table-card">
        <div className="panel-title"><div><p className="eyebrow">内容明细</p><h3>真实回传记录</h3></div><span>{filteredRows.length} 条</span></div>
        {filteredRows.length ? (
          <div className="analytics-record-list">
            {filteredRows.slice(0, 24).map((row) => (
              <article key={row.id}>
                <div><strong>{row.content}</strong><span>{row.campaign} · {row.account} · {row.day}</span></div>
                <dl>
                  <div><dt>平台</dt><dd>{row.platform}</dd></div>
                  <div><dt>类型</dt><dd>{row.contentType}</dd></div>
                  <div><dt>Hook</dt><dd>{row.hook}</dd></div>
                  <div><dt>素材</dt><dd>{row.assetType}</dd></div>
                  <div><dt>发布时间</dt><dd>{formatDate(row.publishedAt)}</dd></div>
                </dl>
              </article>
            ))}
          </div>
        ) : !loading ? (
          <EmptyState
            title="当前 Campaign 暂无真实指标"
            reason="当前只有安全预演、待发布任务，或平台尚未回传指标。"
            prerequisite="完成正式发布并执行一次指标回收。"
            actionHref="#/publish"
            actionLabel="查看发布中心"
          />
        ) : null}
      </section>
    </section>
  );
}
